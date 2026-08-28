import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { env } from '../../config/env.js'
import { fileExists } from '../utils/jsonFile.js'
import { KeyError, type KeyContext, type KeyProvider } from './provider.js'
import { LOW_PIN_RETRIES, parseCardStatus, type CardStatus } from './card.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  gpg —— 从本地 GPG 文件取密钥（目前唯一的 KeyProvider 实现）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 密钥文件路径按约定推导：secrets/<链族>.key.gpg，配置里不出现路径，
 * 也就不存在路径穿越的问题。
 *
 * 两种解锁方式，差别只在**要不要人在场**，其余完全一样：
 *
 *              passphrase              yubikey
 *   文件形态    对称加密（AES256）        加密给卡上的 OpenPGP 公钥
 *   解锁        pinentry 问口令          pinentry 问 PIN + 触摸设备
 *   重试        可以                    连错 3 次锁卡，绝不自动重试
 *   超时        60s                    120s（留时间给人伸手）
 *   前置检查    文件在不在               还要查卡在不在、PIN 还剩几次
 *
 * 两种方式都交给本机的 gpg-agent / pinentry —— 后端进程不持有任何口令。
 * 这也正是 YubiKey 本来的工作方式：插卡 → 输 PIN → 按一下。
 */
/** 要人触摸的解锁方式，超时得给足 */
/**
 * 解锁方式。**不再是配置项，而是探出来的**。
 *
 * 以前在 signers.json 里手填，填错了不会报错只会行为怪异 ——
 * 现在直接看密钥文件本身（gpg --list-packets，不需要口令）加上卡在不在：
 *
 *   对称加密                    → 口令
 *   加密给公钥 + 卡在且有解密密钥 → YubiKey（要触摸、要独占、超时给足）
 *   加密给公钥 + 卡不在          → 口令（密钥在钥匙环里，gpg-agent 会问它的口令）
 *
 * 最后一条是配置做不到的：配置写死 yubikey 的话，卡拔了照样按 YubiKey 处理，
 * 白等 120 秒还提示用户去摸一个不存在的设备。
 */
export enum UnlockMethod {
  PASSPHRASE = 'passphrase',
  YUBIKEY = 'yubikey',
}

const TIMEOUT_MS: Readonly<Record<UnlockMethod, number>> = {
  [UnlockMethod.PASSPHRASE]: 60_000,
  [UnlockMethod.YUBIKEY]: 120_000,
}

export const gpgBinary = (): string => env.GPG_BINARY

/**
 * 密钥文件路径按约定推导。
 *   EVM  → <SECRETS_DIR>/evm.key.gpg
 *   Tron → <SECRETS_DIR>/tron.key.gpg
 */
export function secretPathFor(family: string): string {
  if (!/^[a-z][a-z0-9]*$/.test(family)) {
    throw new KeyError('KEY_SOURCE_UNKNOWN', `非法的链族名: ${family}`)
  }
  return join(resolve(env.SECRETS_DIR), `${family}.key.gpg`)
}

export const secretExists = (family: string): Promise<boolean> => fileExists(secretPathFor(family))

const unlockOf = (context: KeyContext): UnlockMethod =>
  (context.options.unlock as UnlockMethod | undefined) ?? UnlockMethod.PASSPHRASE

/** 密钥文件的加密形式只跟文件有关，探一次记住 */
const encryptionForm = new Map<string, 'symmetric' | 'asymmetric'>()

/** 探测某个链族的密钥怎么解锁。不需要口令 */
export async function detectUnlock(family: string): Promise<UnlockMethod> {
  const file = secretPathFor(family)

  let form = encryptionForm.get(file)
  if (!form) {
    const packets = (await run(['--list-packets', file], 8_000)) ?? ''
    // 对称加密的文件里是 symkey enc packet，加密给公钥的是 pubkey enc packet
    form = packets.includes('symkey enc packet') ? 'symmetric' : 'asymmetric'
    encryptionForm.set(file, form)
  }

  if (form === 'symmetric') return UnlockMethod.PASSPHRASE

  // 加密给公钥：只有密钥真在卡上、卡也插着，才是 YubiKey 流程
  const card = await readCardStatus().catch(() => ({ present: false, hasDecryptKey: false }))
  return card.present && card.hasDecryptKey ? UnlockMethod.YUBIKEY : UnlockMethod.PASSPHRASE
}

const isCard = (context: KeyContext): boolean => unlockOf(context) === UnlockMethod.YUBIKEY

/* ══ Provider 实现 ═══════════════════════════════════════════════════════ */

export const gpgProvider: KeyProvider = {
  kind: 'gpg',
  label: '本地 GPG 密钥文件',

  // 口令模式不用人管；卡模式要触摸
  requiresPresence: isCard,
  // 卡是独占的：scdaemon 锁住之后别的进程碰不了
  requiresExclusiveDevice: isCard,

  timeoutMs: (context) => TIMEOUT_MS[unlockOf(context)],

  async check(context) {
    if (!(await secretExists(context.family))) {
      throw new KeyError('GPG_KEY_MISSING', `密钥文件不存在: secrets/${context.family}.key.gpg`)
    }
    if (!isCard(context)) return

    /**
     * 卡模式：先把卡的状态读出来。
     * 能提前发现的问题就别等输错 PIN 才发现 —— 尤其是"只剩一两次"，
     * 输错第三次卡就锁了，要 PUK 才能解，代价很高。
     */
    const card = await readCardStatus()

    if (!card.present) throw new KeyError('GPG_CARD_ABSENT', '未检测到 YubiKey，请插入设备')
    if (card.pinRetriesLeft === 0) {
      throw new KeyError('GPG_CARD_BLOCKED', 'PIN 已被锁定，需要用 PUK 解锁')
    }
    if (!card.hasDecryptKey) {
      throw new KeyError('GPG_CARD_NO_KEY', '卡上没有解密密钥，请先把密钥导入 YubiKey')
    }
    if (card.pinRetriesLeft !== undefined && card.pinRetriesLeft <= LOW_PIN_RETRIES) {
      throw new KeyError(
        'GPG_CARD_LOW_RETRIES',
        `PIN 只剩 ${card.pinRetriesLeft} 次尝试机会，再错就锁卡。请确认 PIN 无误后用 keys doctor 单独验证`,
      )
    }
  },

  async withKey(context, use) {
    const plaintext = await decrypt(secretPathFor(context.family), TIMEOUT_MS[unlockOf(context)])
    try {
      return await use(normalize(plaintext))
    } finally {
      plaintext.fill(0)
    }
  },
}

/* ══ gpg 调用 ════════════════════════════════════════════════════════════ */

/**
 * 服务端解密：**不带 loopback**。
 * 口令/PIN 由本机的 gpg-agent + pinentry 负责，后端进程不碰。
 */
const decryptArgs = (file: string): readonly string[] => ['--batch', '--quiet', '--decrypt', file]

/**
 * 脚本解密：口令从 fd 喂进去。
 * 脚本是交互式的，当场问当场用；服务端不走这条路。
 */
export const decryptArgsWithSecret = (file: string): readonly string[] => [
  '--batch',
  '--quiet',
  '--pinentry-mode',
  'loopback',
  '--passphrase-fd',
  '0',
  '--decrypt',
  file,
]

/** 加密：对称用口令，非对称给公钥（YubiKey 场景） */
export const encryptArgs = (recipient?: string): readonly string[] =>
  recipient
    ? ['--batch', '--yes', '--quiet', '--encrypt', '--recipient', recipient, '--armor']
    : [
        '--batch',
        '--yes',
        '--quiet',
        '--pinentry-mode',
        'loopback',
        '--passphrase-fd',
        '0',
        '--symmetric',
        '--cipher-algo',
        'AES256',
        '--digest-algo',
        'SHA512',
        '--s2k-mode',
        '3',
        // 提高 KDF 迭代次数，抬高离线爆破成本
        '--s2k-count',
        '65011712',
        '--armor',
      ]

/**
 * gpg 子进程的环境变量。
 *
 * 只留必需的：PATH 找 gpg 与 scdaemon，HOME 是默认密钥环位置，
 * GNUPGHOME 是自定义密钥环（YubiKey 常用独立密钥环，**必须转发**，
 * 不转发的话 gpg 会去找默认密钥环，永远解不开，而报错看起来像"口令错"）。
 * LC_ALL 固定英文输出，便于解析 stderr。
 */
export function gpgEnv(): NodeJS.ProcessEnv {
  const vars: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LC_ALL: 'C',
  }
  if (process.env.GNUPGHOME) vars.GNUPGHOME = process.env.GNUPGHOME
  return vars
}

function decrypt(file: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gpg = spawn(gpgBinary(), [...decryptArgs(file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 独立进程组，超时可整组 kill，防 gpg 变孤儿进程持有密钥
      env: gpgEnv(),
    })

    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killGroup(gpg.pid)
      reject(new KeyError('GPG_TIMEOUT', '解密超时（YubiKey 可能在等触摸）'))
    }, timeoutMs)
    timer.unref()

    gpg.stdout.on('data', (c: Buffer) => chunks.push(c))
    // stderr 只用于归类错误，**绝不回显原文**（可能含路径、密钥 ID）
    gpg.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    gpg.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new KeyError('GPG_DECRYPT_FAILED', `无法执行 gpg：${error.message}`))
    })

    gpg.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code !== 0) {
        for (const c of chunks) c.fill(0)
        reject(classify(stderr))
        return
      }
      const merged = Buffer.concat(chunks)
      for (const c of chunks) c.fill(0)
      resolve(merged)
    })
  })
}

export async function readCardStatus(timeoutMs = 8_000): Promise<CardStatus> {
  const output = await run(['--card-status'], timeoutMs)
  return output === null ? { present: false, hasDecryptKey: false } : parseCardStatus(output)
}

function run(args: readonly string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(gpgBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: gpgEnv() })
    let stdout = ''
    let settled = false

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok ? stdout : null)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.resume()
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

/* ══ 错误归类 ════════════════════════════════════════════════════════════ */

/**
 * 分错了用户就会被引导去做错的事 —— 最坏是把"pinentry 弹不出来"
 * 误报成"PIN 错了"，用户一遍遍重试，三次之后 YubiKey 就锁了。
 */
function classify(stderr: string): KeyError {
  if (isPinentryUnavailable(stderr)) {
    return new KeyError(
      'GPG_PINENTRY_UNAVAILABLE',
      'gpg-agent 无法弹出输入框 —— 后端可能是无终端后台运行的',
    )
  }
  if (isCardBlocked(stderr)) {
    return new KeyError('GPG_CARD_BLOCKED', '设备已被锁定（PIN 连续输错次数过多）')
  }
  const remaining = remainingPinAttempts(stderr)
  if (remaining !== null) {
    return new KeyError(
      'GPG_WRONG_SECRET',
      `口令/PIN 错误，还剩 ${remaining} 次尝试${remaining <= 1 ? '（再错一次将锁定设备）' : ''}`,
    )
  }
  return new KeyError('GPG_WRONG_SECRET', '口令/PIN 错误或密钥文件损坏')
}

/** 从 stderr 提取还剩几次尝试。只取次数，不回显原文 */
export function remainingPinAttempts(stderr: string): number | null {
  const m = /(\d+)\s+(?:more\s+)?(?:attempts?|tries?)\s+(?:left|remaining)/i.exec(stderr)
  if (m?.[1]) return Number.parseInt(m[1], 10)
  const alt = /remaining\s+attempts?\s*:\s*(\d+)/i.exec(stderr)
  return alt?.[1] ? Number.parseInt(alt[1], 10) : null
}

export const isCardBlocked = (stderr: string): boolean =>
  /card.*(blocked|locked)|pin.*blocked/i.test(stderr)

/**
 * gpg-agent 弹不出输入框。
 *
 * 典型场景：后端当守护进程后台跑，没有终端，pinentry 无处显示，
 * gpg 报 "Inappropriate ioctl for device" 然后 "Bad session key" ——
 * 后者看起来像口令错，其实压根没机会输。这个误导必须消除。
 */
export const isPinentryUnavailable = (stderr: string): boolean =>
  /inappropriate ioctl|problem with the agent|no pinentry|cannot open.*tty/i.test(stderr)

function normalize(raw: Buffer): string {
  const hex = raw.toString('utf8').trim().replace(/^0[xX]/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new KeyError('GPG_DECRYPT_FAILED', '解密结果不是合法私钥（可能解错了文件）')
  }
  return hex.toLowerCase()
}

function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}
