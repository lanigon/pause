/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  运维私钥管理 CLI
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npm run keys encrypt   |  pnpm keys encrypt    加密私钥到固定文件
 *   npm run keys verify    |  pnpm keys verify     解密验证并比对 secrets/<链族>.address
 *   npm run keys status    |  pnpm keys status     查看密钥文件状态（不解密）
 *   npm run keys doctor    |  pnpm keys doctor     一条命令验完整条链路
 *
 * 固定约定：secrets/evm.key.gpg · secrets/tron.key.gpg
 *
 * 两种解锁方式，**探测出来的、不是配置项**（看密钥文件本身加上卡在不在）：
 *   passphrase  gpg 对称加密（AES256），口令解锁
 *   yubikey     加密给 YubiKey 上的 OpenPGP 密钥，PIN + 触摸解锁
 *
 * 安全保证：
 * - 私钥与口令/PIN 只走 TTY 隐藏输入，绝不进 argv / 环境变量 / shell history
 * - 秘密走独立 fd(3)，明文走 stdin，两者不混用
 * - 明文只在 Buffer 中流转，用完立即清零，绝不落临时文件
 * - gpg 用独立进程组，超时杀整组，防孤儿进程持有密钥
 * - 输出文件权限 0600
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { stdin, stdout } from 'node:process'
import { Wallet } from 'ethers'
import { utils as tronUtils } from 'tronweb'
import {
  UnlockMethod,
  GpgKey,
  LOW_PIN_RETRIES,
  decryptArgsWithSecret,
  isCardBlocked,
  encryptArgs,
  gpgBinary,
  gpgEnv,
  readCardStatus,
  remainingPinAttempts,
} from '../src/lib/keys/gpg.js'
import { env } from '../src/config/env.js'

type Family = 'evm' | 'tron'

const FAMILIES: readonly Family[] = ['evm', 'tron']
// 路径与 gpg 位置都从 env 取，不在这里另写一份 —— 两条取值路径迟早会分叉
const SECRETS_DIR = env.SECRETS_DIR
const GPG = gpgBinary()

const secretPath = (family: Family): string => `${SECRETS_DIR}/${family}.key.gpg`
const addressFile = (family: Family): string => `${SECRETS_DIR}/${family}.address`

/** 声明地址存在密钥旁边（secrets/<链族>.address），不再有 signers.json */
async function readDeclaredAddress(family: Family): Promise<string | null> {
  try {
    return (await readFile(addressFile(family), 'utf8')).trim() || null
  } catch {
    return null
  }
}

/* ══ 隐藏输入 ══════════════════════════════════════════════════════════ */

/**
 * TTY 隐藏输入。
 * 私钥与 PIN 绝不能出现在命令行参数里 —— `ps` 能看到 argv，shell history 也会留档。
 */
async function promptHidden(question: string): Promise<Buffer> {
  if (!stdin.isTTY) {
    throw new Error('需要交互式终端，不要用管道或重定向')
  }

  stdout.write(question)
  const wasRaw = stdin.isRaw ?? false
  stdin.setRawMode(true)
  stdin.resume()

  const bytes: number[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stdin.off('data', onData)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write('\n')
      }
      const onData = (data: Buffer): void => {
        for (const byte of data) {
          if (byte === 0x03) return cleanup(), reject(new Error('已取消')) // Ctrl+C
          if (byte === 0x0d || byte === 0x0a) return cleanup(), resolve()
          if (byte === 0x7f || byte === 0x08) {
            bytes.pop()
            continue
          }
          bytes.push(byte)
        }
      }
      stdin.on('data', onData)
    })
    return Buffer.from(bytes)
  } finally {
    bytes.fill(0)
  }
}

async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve))
  } finally {
    rl.close()
  }
}

const confirm = async (question: string): Promise<boolean> =>
  (await promptVisible(`${question} (yes/no) `)).trim().toLowerCase() === 'yes'

/* ══ gpg 调用 ══════════════════════════════════════════════════════════ */

interface GpgResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly code: number | null
}

/** 秘密走 fd(3)，明文走 stdin。detached 建独立进程组，超时杀整组。 */
function runGpg(
  args: readonly string[],
  secret: Buffer | null,
  input: Buffer | null,
  timeoutMs: number,
): Promise<GpgResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(GPG, args, {
      stdio: secret ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: gpgEnv(),
    })

    const chunks: Buffer[] = []
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
      reject(new Error(`gpg 执行超时（${timeoutMs}ms），已杀掉整个进程组`))
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`无法执行 ${GPG}：${error.message}。请先安装 GnuPG。`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks), stderr, code })
    })

    if (secret) {
      const fd = child.stdio[3]
      if (fd && typeof fd !== 'number' && 'write' in fd) {
        fd.write(secret)
        fd.end()
      }
    }
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
}

/* ══ 解锁方式 ══════════════════════════════════════════════════════════ */

const needsTouchOf = (method: UnlockMethod): boolean => method === UnlockMethod.YUBIKEY
const labelOf = (method: UnlockMethod): string => (needsTouchOf(method) ? 'PIN' : 'passphrase')
const timeoutOf = (method: UnlockMethod): number => (needsTouchOf(method) ? 120_000 : 60_000)

/** YubiKey 先确认卡在，免得输完私钥才发现设备没插 */
async function preflightCard(): Promise<void> {
  console.log('\n检查 YubiKey…')
  const status = await readCardStatus()
  if (!status.present) throw new Error('没检测到 YubiKey，请插入设备后重试')
  if (status.pinRetriesLeft === 0) throw new Error('YubiKey PIN 已锁定，需要用 Admin PIN 解锁')
  if (status.pinRetriesLeft !== undefined && status.pinRetriesLeft <= LOW_PIN_RETRIES) {
    console.log(`   ⚠️  PIN 只剩 ${status.pinRetriesLeft} 次尝试机会`)
  }
  console.log('   ✅ 设备已就绪')
}

/** worker 用 stdin 传口令；脚本里改成 fd 3 */
const onFd3 = (args: readonly string[]): string[] =>
  args.map((arg, index) => (args[index - 1] === '--passphrase-fd' ? '3' : arg))

/* ══ 私钥处理 ══════════════════════════════════════════════════════════ */

function normalizePrivateKey(raw: Buffer): string {
  const text = raw.toString('utf8').trim()
  const hex = text.replace(/^0[xX]/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('私钥格式不对：需要 64 位十六进制（可带 0x 前缀）')
  }
  return hex.toLowerCase()
}

function deriveAddress(family: Family, privateKeyHex: string): string {
  if (family === 'evm') return new Wallet(`0x${privateKeyHex}`).address
  const base58 = tronUtils.address.fromPrivateKey(privateKeyHex)
  if (base58 === false) throw new Error('无法从私钥派生 Tron 地址')
  return base58
}

/* ══ encrypt ═══════════════════════════════════════════════════════════ */

async function cmdEncrypt(): Promise<void> {
  const family = await pickFamily()
  const target = secretPath(family)

  if (await exists(target)) {
    console.log(`\n⚠️  ${target} 已存在。`)
    if (!(await confirm('覆盖它？旧密钥将无法恢复。'))) return console.log('已取消。')
  }

  const method = await pickUnlock(family)
  const needsTouch = needsTouchOf(method)

  if (needsTouch) await preflightCard()

  let recipient: string | undefined
  if (method === UnlockMethod.YUBIKEY) {
    recipient = (await promptVisible('\nYubiKey 上 OpenPGP 密钥的 ID 或邮箱: ')).trim()
    if (!recipient) throw new Error('必须指定 recipient')
  }

  console.log(`\n请输入 ${family.toUpperCase()} 私钥（输入不会显示）：`)
  const keyBuffer = await promptHidden('  私钥: ')

  let privateKeyHex: string
  let address: string
  try {
    privateKeyHex = normalizePrivateKey(keyBuffer)
    address = deriveAddress(family, privateKeyHex)
  } finally {
    keyBuffer.fill(0)
  }

  console.log(`\n派生地址: ${address}`)
  if (!(await confirm('确认这是正确的地址？'))) return console.log('已取消。')

  // 对称加密要口令；YubiKey 是公钥加密，此刻不需要任何秘密
  let secret: Buffer | null = null
  let secretAgain: Buffer | null = null
  if (method === UnlockMethod.PASSPHRASE) {
    console.log('\n请设置 passphrase（每次执行批量操作都要输入）：')
    secret = await promptHidden('  passphrase: ')
    secretAgain = await promptHidden('  再输一次:   ')
  }

  try {
    if (secret && secretAgain) {
      if (!secret.equals(secretAgain)) throw new Error('两次输入不一致')
      if (secret.length < 12) throw new Error('passphrase 至少 12 个字符')
    }

    const plaintext = Buffer.from(privateKeyHex, 'utf8')
    try {
      const args = secret
        ? onFd3(encryptArgs(recipient))
        : [...encryptArgs(recipient)]
      const result = await runGpg(args, secret, plaintext, 30_000)
      if (result.code !== 0) {
        throw new Error(`GPG 加密失败：${firstLine(result.stderr)}`)
      }

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, result.stdout, { mode: 0o600 })
      await chmod(target, 0o600)
      console.log(`\n✅ 已写入 ${target}（权限 0600）`)

      /**
       * 地址写在密钥旁边。后端解密后会派生地址与它比对，不一致就拒绝 ——
       * 这是「密钥文件被掉包」的检测点。由这里顺手写出，没有人工填写的环节，
       * 也就不存在填错或忘填。
       */
      await writeFile(addressFile(family), `${address}\n`, 'utf8')
      console.log(`✅ 已写入 ${addressFile(family)}：${address}`)
    } finally {
      plaintext.fill(0)
    }
  } finally {
    secret?.fill(0)
    secretAgain?.fill(0)
  }

}

/* ══ verify ════════════════════════════════════════════════════════════ */

async function cmdVerify(): Promise<void> {
  const family = await pickFamily()
  const target = secretPath(family)

  if (!(await exists(target))) {
    console.error(`\n❌ ${target} 不存在。先运行 keys encrypt。`)
    process.exitCode = 1
    return
  }

  // 解锁方式是探出来的（看密钥文件本身 + 卡在不在），不用配
  const method = await (await GpgKey.of(family)).unlock()
  const needsTouch = needsTouchOf(method)
  const secretLabel = labelOf(method)

  if (needsTouch) await preflightCard()
  if (needsTouch) {
    console.log(`\n⚠️  ${secretLabel} 连错 3 次会锁定设备，请谨慎输入。`)
  }

  const secret = await promptHidden(`\n请输入 ${secretLabel}: `)
  let address: string

  try {
    if (needsTouch) console.log('\n请触摸 YubiKey…')
    const result = await runGpg(
      onFd3(decryptArgsWithSecret(target)),
      secret,
      null,
      timeoutOf(method),
    )
    if (result.code !== 0) {
      reportFailure(secretLabel, result.stderr)
      process.exitCode = 1
      return
    }
    try {
      address = deriveAddress(family, normalizePrivateKey(result.stdout))
    } finally {
      result.stdout.fill(0)
    }
  } finally {
    secret.fill(0)
  }

  console.log('\n✅ 解密成功')
  console.log(`   派生地址:       ${address}`)

  const declared = await readDeclaredAddress(family)
  if (!declared) {
    console.log(`   ⚠️  缺少 ${addressFile(family)}，无法核对。重跑 keys encrypt 可生成`)
    process.exitCode = 1
    return
  }

  const matched = declared.toLowerCase() === address.toLowerCase()
  console.log(`   ${addressFile(family)}: ${declared}`)
  console.log(matched ? '   ✅ 地址一致' : '   ❌ 地址不一致！后端会拒绝使用该密钥')
  if (!matched) process.exitCode = 1
}

/**
 * 解密失败的提示。
 * 只从 stderr 提取"还剩几次尝试"——对 YubiKey 这是必须让用户知道的（连错 3 次锁卡），
 * 但 stderr 原文可能含路径、密钥 ID，不直接展示。
 */
function reportFailure(secretLabel: string, stderr: string): void {
  if (isCardBlocked(stderr)) {
    console.error('\n❌ 设备已被锁定（PIN 连续输错次数过多），需要用 PUK 解锁')
    return
  }
  const remaining = remainingPinAttempts(stderr)
  console.error(
    remaining !== null
      ? `\n❌ ${secretLabel} 错误，还剩 ${remaining} 次尝试${remaining <= 1 ? '（再错一次将锁定设备）' : ''}`
      : `\n❌ 解密失败：${secretLabel} 错误或密钥文件损坏`,
  )
}

/* ══ status ════════════════════════════════════════════════════════════ */

async function cmdStatus(): Promise<void> {
  console.log(`\n密钥目录: ${SECRETS_DIR}\n`)

  for (const family of FAMILIES) {
    const target = secretPath(family)
    const info = await stat(target).catch(() => null)
    const declared = await readDeclaredAddress(family)

    if (!info) {
      console.log(`  ${family.padEnd(5)} ❌ 未配置   (${target})`)
      continue
    }
    const mode = (info.mode & 0o777).toString(8)
    const warn = mode === '600' ? '' : `  ⚠️ 权限 ${mode}，应为 600`
    console.log(
      `  ${family.padEnd(5)} ✅ 已配置   ${info.size} 字节  ${info.mtime.toISOString().slice(0, 19)}${warn}`,
    )
    console.log(`        解锁方式: ${await (await GpgKey.of(family)).unlock()}（探测得出）`)
    console.log(`        声明地址: ${declared ?? '(缺失，重跑 keys encrypt 生成)'}`)
  }
  console.log('\n提示：status 不解密。用 keys verify 做完整校验。\n')
}

/* ══ 辅助 ══════════════════════════════════════════════════════════════ */

async function pickFamily(): Promise<Family> {
  const fromArgs = process.argv.slice(3).find((arg) => (FAMILIES as string[]).includes(arg))
  if (fromArgs) return fromArgs as Family

  const answer = (await promptVisible(`选择链族 (${FAMILIES.join(' / ')}): `)).trim().toLowerCase()
  if (!(FAMILIES as string[]).includes(answer)) throw new Error(`无效的链族: ${answer}`)
  return answer as Family
}

/**
 * 加密时问一次：对称加密（口令），还是加密给 YubiKey 上的公钥。
 * 之后不用再记 —— 解锁时看文件本身就知道，见 detectUnlock。
 */
async function pickUnlock(_family: Family): Promise<UnlockMethod> {
  const answer = (await promptVisible('\n解锁方式 (passphrase / yubikey) [默认 passphrase]: '))
    .trim()
    .toLowerCase()

  if (answer === '') return UnlockMethod.PASSPHRASE
  if (answer !== UnlockMethod.PASSPHRASE && answer !== UnlockMethod.YUBIKEY) {
    throw new Error(`无效的解锁方式: ${answer}`)
  }
  return answer
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false)

const firstLine = (text: string): string =>
  text.split('\n').find((line) => line.trim() !== '') ?? 'unknown'

/* ══ doctor：一条命令验完整条链路 ═══════════════════════════════════════ */

/**
 * 插上 YubiKey 后跑这个，一次性验完所有环节。
 *
 * 每一步都单独报结果，哪一环断了一眼能看出来 ——
 * 不用再靠"解密失败"这种含糊的报错去猜。
 */
async function cmdDoctor(): Promise<void> {
  const family = await pickFamily()
  // 解锁方式是探出来的（看密钥文件本身 + 卡在不在），不用配
  const method = await (await GpgKey.of(family)).unlock()
  const needsTouch = needsTouchOf(method)
  const secretLabel = labelOf(method)

  console.log(`\n检查 ${family.toUpperCase()} 密钥链路（解锁方式：${method}）\n`)

  let failed = 0
  const step = async (label: string, fn: () => Promise<string>): Promise<void> => {
    process.stdout.write(`  ${label.padEnd(24)}`)
    const startedAt = Date.now()
    try {
      const detail = await fn()
      console.log(`✓ ${detail}${detail ? '  ' : ''}(${Date.now() - startedAt}ms)`)
    } catch (error) {
      failed += 1
      console.log(`✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ① gpg 本身
  await step('gpg 可执行', async () => {
    const r = await runGpg(['--version'], null, null, 5_000)
    if (r.code !== 0) throw new Error('gpg 不可用，请安装 GnuPG')
    return r.stdout.toString('utf8').split('\n')[0] ?? ''
  })

  // ② 密钥环位置
  console.log(`  ${'GNUPGHOME'.padEnd(24)}${process.env.GNUPGHOME ?? '(默认 ~/.gnupg)'}`)
  if ((process.env.GNUPGHOME ?? '').length > 80) {
    console.log('     ⚠️  路径偏长，gpg-agent 的 socket 有长度限制（约 104 字符），可能起不来')
  }

  // ③ YubiKey：把卡的状态一次读全，再逐项报告
  if (method === UnlockMethod.YUBIKEY) {
    const card = await readCardStatus()

    await step('YubiKey 已插入', async () => {
      if (!card.present) {
        throw new Error(
          '未检测到设备。若装了 pcscd，它会和 scdaemon 抢卡 —— 停掉 pcscd，或在 scdaemon.conf 里设 disable-ccid',
        )
      }
      return `序列号 ${card.serial ?? '未知'}`
    })

    await step('卡上有解密密钥', async () => {
      if (!card.present) throw new Error('跳过（卡不在）')
      if (!card.hasDecryptKey) throw new Error('卡上没有解密密钥，先把密钥导入 YubiKey')
      return '有'
    })

    await step('PIN 剩余次数', async () => {
      if (!card.present) throw new Error('跳过（卡不在）')
      const left = card.pinRetriesLeft
      if (left === undefined) return '读不到（gpg 版本可能不报）'
      if (left === 0) throw new Error('已锁定，需要 PUK 解锁')
      if (left <= LOW_PIN_RETRIES) throw new Error(`只剩 ${left} 次，再错就锁卡 —— 先确认 PIN 无误`)
      return `${left} 次`
    })

  }

  // ④ 密钥文件
  const target = secretPath(family)
  await step('密钥文件存在', async () => {
    if (!(await exists(target))) throw new Error(`${target} 不存在，先跑 keys encrypt`)
    const { stat } = await import('node:fs/promises')
    const info = await stat(target)
    const mode = (info.mode & 0o777).toString(8)
    if (mode !== '600') throw new Error(`权限是 ${mode}，应为 600`)
    return `${info.size} 字节，权限 600`
  })

  // ⑤ 加密方式与配置是否一致 —— 这是最容易配错又最难查的地方
  await step('加密方式', async () => {
    const r = await runGpg(['--list-packets', target], null, null, 8_000)
    const out = r.stdout.toString('utf8')
    const asymmetric = out.includes('pubkey enc packet')

    // 对称/非对称与解锁方式是正交的：非对称也可以是"本地无口令密钥对"。
    // 只有一种组合确定是错的：配了 yubikey 但文件是对称加密的 ——
    // 卡上的私钥解不了对称密文。
    if (method === UnlockMethod.YUBIKEY && !asymmetric) {
      throw new Error('配了 yubikey 但文件是对称加密的 —— 卡解不了，需要重新加密给卡上的公钥')
    }
    return asymmetric ? '非对称（加密给某个公钥）' : '对称（口令）'
  })

  // ⑥ 真解密 —— YubiKey 会在这一步要 PIN 并要求触摸
  let derived = ''
  if (needsTouch) {
    console.log(`\n  ⚠️  下一步会要求输入 ${secretLabel} 并**触摸设备**，请留意。`)
    console.log(`     ${secretLabel} 连错 3 次会锁卡，谨慎输入。\n`)
  }
  await step('解密', async () => {
    const r = await runGpg(decryptArgsWithSecret(target), null, null, timeoutOf(method))
    if (r.code !== 0) {
      const stderr = r.stderr
      if (isCardBlocked(stderr)) throw new Error('设备已被锁定，需要 PUK 解锁')
      const left = remainingPinAttempts(stderr)
      if (left !== null) throw new Error(`${secretLabel} 错误，还剩 ${left} 次`)
      throw new Error(`失败（${secretLabel} 错误、或 pinentry 弹不出来）`)
    }
    derived = deriveAddress(family, normalizePrivateKey(r.stdout))
    return derived
  })

  // ⑦ 地址比对
  await step('地址与声明一致', async () => {
    if (!derived) throw new Error('跳过（上一步没解开）')
    const declared = await readDeclaredAddress(family)
    if (!declared) throw new Error(`缺少 ${addressFile(family)}，重跑 keys encrypt 可生成`)
    if (declared.toLowerCase() !== derived.toLowerCase()) {
      throw new Error(`不一致！${addressFile(family)} 里写的是 ${declared}`)
    }
    return declared
  })

  console.log(
    failed === 0
      ? '\n✅ 全部通过，这把密钥可以直接用于批量执行。\n'
      : `\n❌ ${failed} 项未通过，修完再试。\n`,
  )
  if (failed > 0) process.exitCode = 1
}

/* ══ 入口 ══════════════════════════════════════════════════════════════ */

const COMMANDS: Record<string, () => Promise<void>> = {
  encrypt: cmdEncrypt,
  verify: cmdVerify,
  status: cmdStatus,
  doctor: cmdDoctor,
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const handler = command ? COMMANDS[command] : undefined

  if (!handler) {
    console.log(`
用法（npm / pnpm 都支持）：

  npm run keys encrypt   |  pnpm keys encrypt    加密私钥到 secrets/<链族>.key.gpg
  npm run keys verify    |  pnpm keys verify     解密验证并比对 secrets/<链族>.address
  npm run keys status    |  pnpm keys status     查看密钥文件状态（不解密）
  npm run keys doctor    |  pnpm keys doctor     ★ 一条命令验完整条链路

指定链族跳过交互：  npm run keys encrypt evm

插上 YubiKey 后想快速确认能不能用，跑 doctor 就够了 ——
它会逐项检查 gpg、密钥环、卡是否插入、文件加密方式与配置是否匹配、
能不能解密（这一步会要 PIN 并要求触摸）、以及派生地址与配置是否一致。
`)
    process.exitCode = command ? 1 : 0
    return
  }
  await handler()
}

main().catch((error: unknown) => {
  console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
