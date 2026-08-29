import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { env } from '../../config/env.js'
import { AppError, ErrorCode, type ErrorCodeValue } from '../utils/errors.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  本地 GPG 密钥
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一把密钥就是 secrets/ 下的两个文件，路径固定，由 `npm run keys encrypt` 生成：
 *
 *   secrets/<链族>.key.gpg    GPG 加密的私钥
 *   secrets/<链族>.address    对应地址，明文
 *
 * 存地址是为了防掉包：解密后派生出来的地址必须和它一致。由加密脚本顺手写出，
 * 没有人工填写的环节。路径固定也就不存在路径穿越。
 *
 * 私钥**只在子进程里出现**（见 worker.ts）。这个类在父进程里只做不碰私钥的事：
 * 找密钥、读声明地址、探解锁方式、预检设备。
 */
export class GpgKey {
  private constructor(
    readonly family: string,
    private readonly dir: string,
  ) {}

  /* ── 找 ── */

  /** secrets/ 下有哪些链族的密钥。目录不存在就是一把都没有 */
  static async available(dir: string = env.SECRETS_DIR): Promise<readonly GpgKey[]> {
    const files = await readdir(dir).catch(() => [] as string[])
    return files
      .filter((name) => name.endsWith(KEY_SUFFIX))
      .map((name) => new GpgKey(name.slice(0, -KEY_SUFFIX.length), dir))
      .sort((a, b) => a.family.localeCompare(b.family))
  }

  static async of(family: string, dir: string = env.SECRETS_DIR): Promise<GpgKey> {
    const key = (await GpgKey.available(dir)).find((k) => k.family === family)
    if (!key) {
      throw new KeyError(
        ErrorCode.GPG_KEY_MISSING,
        `没有 ${family} 链族的密钥。先跑 npm run keys encrypt 生成 ${dir}/${family}${KEY_SUFFIX}`,
      )
    }
    return key
  }

  get path(): string {
    return `${this.dir}/${this.family}${KEY_SUFFIX}`
  }

  get addressPath(): string {
    return `${this.dir}/${this.family}.address`
  }

  /**
   * 声明地址。解密后派生的地址必须与它一致，不一致说明密钥被换了。
   *
   * 缺这个文件不能放行 —— 没有它就没法核对身份，
   * 等于把「密钥被掉包」这个检查静默关掉了。
   */
  async address(): Promise<string> {
    const raw = await readFile(this.addressPath, 'utf8').catch(() => {
      throw new KeyError(
        ErrorCode.GPG_KEY_MISSING,
        `${this.path} 存在但缺少 ${this.addressPath}。这个文件用于核对密钥有没有被换过，` +
          '不能省。重跑 npm run keys encrypt 生成。',
      )
    })

    const address = raw.trim()
    if (!address) throw new KeyError(ErrorCode.GPG_KEY_MISSING, `${this.addressPath} 是空的`)
    return address
  }

  /* ── 怎么解锁 ── */

  /**
   * 探测这把密钥怎么解锁。**不是配置项**。
   *
   * 看密钥文件本身（gpg --list-packets，不需要口令）加上卡在不在：
   *   对称加密                    → 口令
   *   加密给公钥 + 卡在且有解密密钥 → YubiKey（要触摸、要独占、超时给足）
   *   加密给公钥 + 卡不在          → 口令（密钥在钥匙环里，gpg-agent 会问它的口令）
   *
   * 最后一条是配置做不到的：配置写死 yubikey 的话，卡拔了照样按 YubiKey 处理，
   * 白等 120 秒还提示用户去摸一个不存在的设备。
   */
  async unlock(): Promise<UnlockMethod> {
    let form = encryptionForm.get(this.path)
    if (!form) {
      const packets = (await run(['--list-packets', this.path], PROBE_TIMEOUT_MS)) ?? ''
      form = packets.includes('symkey enc packet') ? 'symmetric' : 'asymmetric'
      encryptionForm.set(this.path, form)
    }
    if (form === 'symmetric') return UnlockMethod.PASSPHRASE

    const card = await readCardStatus().catch(() => ABSENT_CARD)
    return card.present && card.hasDecryptKey ? UnlockMethod.YUBIKEY : UnlockMethod.PASSPHRASE
  }

  /** 要人去摸一下设备。同时意味着这把密钥独占 scdaemon，会话必须串行打开 */
  async needsTouch(): Promise<boolean> {
    return (await this.unlock()) === UnlockMethod.YUBIKEY
  }

  /**
   * 开工前的预检。能提前发现的问题就别等输错 PIN 才发现 ——
   * 尤其是"只剩一两次"，输错第三次卡就锁了，要 PUK 才能解，代价很高。
   */
  async check(): Promise<void> {
    if (!(await this.exists())) {
      throw new KeyError(ErrorCode.GPG_KEY_MISSING, `密钥文件不存在: ${this.path}`)
    }
    if (!(await this.needsTouch())) return

    const card = await readCardStatus()
    if (!card.present) throw new KeyError(ErrorCode.GPG_CARD_ABSENT, '未检测到 YubiKey，请插入设备')
    if (card.pinRetriesLeft === 0) {
      throw new KeyError(ErrorCode.GPG_CARD_BLOCKED, 'PIN 已被锁定，需要用 PUK 解锁')
    }
    if (!card.hasDecryptKey) {
      throw new KeyError(ErrorCode.GPG_CARD_NO_KEY, '卡上没有解密密钥，请先把密钥导入 YubiKey')
    }
    if (card.pinRetriesLeft !== undefined && card.pinRetriesLeft <= LOW_PIN_RETRIES) {
      throw new KeyError(
        ErrorCode.GPG_CARD_LOW_RETRIES,
        `PIN 只剩 ${card.pinRetriesLeft} 次尝试机会，再错就锁卡。` +
          '请确认 PIN 无误后用 npm run keys verify 单独验证',
      )
    }
  }

  private exists(): Promise<boolean> {
    return readFile(this.path).then(
      () => true,
      () => false,
    )
  }

  /* ── 解密 ── */

  /**
   * 解密，把私钥交给回调，回调结束立即清零。
   *
   * **只在子进程里调**（worker.ts）—— 私钥的存活时间严格等于这个回调。
   * 返回值只能是签名结果，绝不能是私钥本身。
   */
  async withKey<T>(use: (privateKeyHex: string) => T | Promise<T>): Promise<T> {
    const timeoutMs = TIMEOUT_MS[await this.unlock()]
    const plaintext = await decrypt(this.path, timeoutMs)
    try {
      return await use(normalize(plaintext))
    } finally {
      plaintext.fill(0)
    }
  }
}

/* ══ 类型与常量 ══════════════════════════════════════════════════════════ */

export enum UnlockMethod {
  PASSPHRASE = 'passphrase',
  YUBIKEY = 'yubikey',
}

/** YubiKey 要留时间给人伸手摸一下 */
const TIMEOUT_MS: Readonly<Record<UnlockMethod, number>> = {
  [UnlockMethod.PASSPHRASE]: 60_000,
  [UnlockMethod.YUBIKEY]: 120_000,
}

const KEY_SUFFIX = '.key.gpg'
const PROBE_TIMEOUT_MS = 8_000
/** 剩这么少就该警告了 —— 再错就锁卡 */
export const LOW_PIN_RETRIES = 2

/** 加密形式只跟文件有关，探一次记住 */
const encryptionForm = new Map<string, 'symmetric' | 'asymmetric'>()

export class KeyError extends AppError {
  constructor(code: ErrorCodeValue, message: string) {
    super(code, message)
    this.name = 'KeyError'
  }
}

export const gpgBinary = (): string => env.GPG_BINARY

/* ══ gpg 参数 ════════════════════════════════════════════════════════════ */

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
        '--armor',
      ]

/**
 * 给 gpg 的环境变量，只留必需的。
 *
 * PATH 找 gpg 与 scdaemon，HOME 是默认密钥环位置，
 * GNUPGHOME 是自定义密钥环（YubiKey 常用独立密钥环，**必须转发** ——
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

/* ══ 跑 gpg ══════════════════════════════════════════════════════════════ */

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
      reject(new KeyError(ErrorCode.GPG_TIMEOUT, '解密超时（YubiKey 可能在等触摸）'))
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
      reject(new KeyError(ErrorCode.GPG_DECRYPT_FAILED, `无法执行 gpg：${error.message}`))
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

/** 跑一条只读的 gpg 命令，失败返回 null（探测用，不该因此中断流程） */
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

/* ══ YubiKey 卡状态 ══════════════════════════════════════════════════════ */

export interface CardStatus {
  readonly present: boolean
  readonly serial?: string
  /** 用户 PIN 还能试几次。0 = 已锁死 */
  readonly pinRetriesLeft?: number
  readonly hasDecryptKey: boolean
}

const ABSENT_CARD: CardStatus = { present: false, hasDecryptKey: false }

export async function readCardStatus(timeoutMs = PROBE_TIMEOUT_MS): Promise<CardStatus> {
  const output = await run(['--card-status'], timeoutMs)
  return output === null ? ABSENT_CARD : parseCardStatus(output)
}

/**
 * 解析 `gpg --card-status`。
 *
 * `PIN retry counter : 3 0 3` —— 三个数分别是用户 PIN、重置码、Admin PIN。
 * 第一个才是我们关心的（输错三次锁卡的那个）。
 */
export function parseCardStatus(output: string): CardStatus {
  const serial = /Serial number\s*\.*:\s*(\S+)/i.exec(output)?.[1]
  const retries = /PIN retry counter\s*\.*:\s*(\d+)\s+(\d+)\s+(\d+)/i.exec(output)
  const encKey = /Encryption key\s*\.*:\s*(\S+)/i.exec(output)?.[1]

  return {
    present: /Reader\s*\.*:|Application ID\s*\.*:/i.test(output),
    ...(serial ? { serial } : {}),
    ...(retries?.[1] ? { pinRetriesLeft: Number.parseInt(retries[1], 10) } : {}),
    hasDecryptKey: encKey !== undefined && encKey !== '[none]',
  }
}

/* ══ 错误归类 ════════════════════════════════════════════════════════════ */

/**
 * 分错了用户就会被引导去做错的事 —— 最坏是把"pinentry 弹不出来"
 * 误报成"PIN 错了"，用户一遍遍重试，三次之后 YubiKey 就锁了。
 */
function classify(stderr: string): KeyError {
  if (isPinentryUnavailable(stderr)) {
    return new KeyError(
      ErrorCode.GPG_PINENTRY_UNAVAILABLE,
      'gpg-agent 无法弹出输入框 —— 后端可能是无终端后台运行的',
    )
  }
  if (isCardBlocked(stderr)) {
    return new KeyError(ErrorCode.GPG_CARD_BLOCKED, '设备已被锁定（PIN 连续输错次数过多）')
  }
  const remaining = remainingPinAttempts(stderr)
  if (remaining !== null) {
    return new KeyError(
      ErrorCode.GPG_WRONG_SECRET,
      `口令/PIN 错误，还剩 ${remaining} 次尝试${remaining <= 1 ? '（再错一次将锁定设备）' : ''}`,
    )
  }
  return new KeyError(ErrorCode.GPG_WRONG_SECRET, '口令/PIN 错误或密钥文件损坏')
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
    throw new KeyError(ErrorCode.GPG_DECRYPT_FAILED, '解密结果不是合法私钥（可能解错了文件）')
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
