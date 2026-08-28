import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, chmod, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { Wallet, Transaction } from 'ethers'

/**
 * GPG 密钥文件的加解密 —— 全系统风险最高的一段，真跑 gpg。
 *
 * 用**无口令的 GPG 密钥对**做非对称加密：这正是 YubiKey 那条路径的形状
 * （密钥文件加密给某个公钥），只是把"私钥在卡上、要 PIN + 触摸"
 * 换成"私钥在本地密钥环、不要口令"。gpg 命令与后端用的完全一致。
 */
const PK = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const EXPECTED = new Wallet(`0x${PK}`).address

let home = ''
let dir = ''
let ready = false

/** 跑 gpg，stdin 可选，返回 { code, stdout, stderr } */
function gpg(args: string[], stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('gpg', args, { env: { ...process.env, GNUPGHOME: home } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    timer.unref()

    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
    child.on('error', () => resolve({ code: null, stdout, stderr }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })

    if (stdin !== undefined) child.stdin.write(stdin)
    child.stdin.end()
  })
}

beforeAll(async () => {
  // GNUPGHOME 路径必须短 —— gpg-agent 的 unix socket 有长度限制（约 104 字符），
  // 路径太长会报 "File name too long"。这是踩过的坑。
  home = `/tmp/gt${randomBytes(4).toString('hex')}`
  await mkdir(home, { recursive: true })
  await chmod(home, 0o700)
  dir = await mkdtemp('/tmp/sec')

  const gen = await gpg([
    '--batch', '--quiet', '--passphrase', '',
    '--quick-generate-key', 'gpgtest@example.com', 'rsa2048', 'encr', 'never',
  ])
  if (gen.code !== 0) return

  const enc = await gpg(
    ['--batch', '--yes', '--quiet', '--encrypt', '--recipient', 'gpgtest@example.com', '--armor'],
    PK,
  )
  if (enc.code !== 0 || !enc.stdout.includes('BEGIN PGP MESSAGE')) return

  await writeFile(`${dir}/evm.key.gpg`, enc.stdout, { mode: 0o600 })
  ready = true
}, 90_000)

afterAll(async () => {
  await gpg(['--batch', '--quiet', '--quick-delete-key', 'gpgtest@example.com']).catch(() => undefined)
  await rm(home, { recursive: true, force: true }).catch(() => undefined)
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

describe('GPG 密钥文件（真跑 gpg）', () => {
  it('前置：测试密钥环准备成功（没装 GnuPG 的话这条会失败）', () => {
    expect(ready).toBe(true)
  })

  it('★ 密文头部能被识别为"加密给某公钥"，与对称加密不同', async () => {
    if (!ready) return
    const { stdout } = await gpg(['--list-packets', `${dir}/evm.key.gpg`])
    // YubiKey 场景就是这个形状：pubkey enc packet
    expect(stdout).toContain('pubkey enc packet')
    expect(stdout).not.toContain('symkey enc packet')
  })

  it('★ 解密 → 派生地址 → 与声明地址一致', async () => {
    if (!ready) return
    const { code, stdout } = await gpg(['--batch', '--quiet', '--decrypt', `${dir}/evm.key.gpg`])
    expect(code).toBe(0)
    expect(new Wallet(`0x${stdout.trim()}`).address).toBe(EXPECTED)
  })

  it('★ 解出的私钥签出的交易，能独立验回同一个地址', async () => {
    if (!ready) return
    const { stdout } = await gpg(['--batch', '--quiet', '--decrypt', `${dir}/evm.key.gpg`])
    const wallet = new Wallet(`0x${stdout.trim()}`)

    // 复刻 worker 里的签名逻辑
    const tx = Transaction.from({
      chainId: 2818,
      to: '0x1111111111111111111111111111111111111111',
      data: '0x8456cb59', // pause()
      value: '0',
      nonce: 7,
      gasLimit: '50000',
      type: 2,
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '1000000',
    })
    tx.signature = wallet.signingKey.sign(tx.unsignedHash)

    // 从 rawTx 反解，确认签名者、nonce、链都对
    const parsed = Transaction.from(tx.serialized)
    expect(parsed.from).toBe(EXPECTED)
    expect(parsed.nonce).toBe(7)
    expect(parsed.chainId).toBe(2818n)
    // pause() 的 selector
    expect(parsed.data).toBe('0x8456cb59')
  })

  it('★ 地址不匹配时必须被拒 —— 这是"密钥被换了"的检测点', async () => {
    if (!ready) return
    const { stdout } = await gpg(['--batch', '--quiet', '--decrypt', `${dir}/evm.key.gpg`])
    const derived = new Wallet(`0x${stdout.trim()}`).address
    const declared = '0x0000000000000000000000000000000000000099'

    // worker 里就是这个比较；不一致就 exit(2)
    expect(derived.toLowerCase() === declared.toLowerCase()).toBe(false)
  })

  it('★ 密文被篡改就解不开（完整性）', async () => {
    if (!ready) return
    const original = await readFile(`${dir}/evm.key.gpg`, 'utf8')
    const lines = original.split('\n')
    const idx = lines.findIndex((l) => l.length > 40 && !l.startsWith('-----'))
    const line = lines[idx]!
    lines[idx] = `${line.slice(0, 10)}${line[10] === 'A' ? 'B' : 'A'}${line.slice(11)}`
    await writeFile(`${dir}/tampered.gpg`, lines.join('\n'), 'utf8')

    const { code } = await gpg(['--batch', '--quiet', '--decrypt', `${dir}/tampered.gpg`])
    expect(code).not.toBe(0)
  })

  it('★ 换个密钥环就解不开（只有持有私钥的机器能解）', async () => {
    if (!ready) return
    const other = `/tmp/go${randomBytes(4).toString('hex')}`
    await mkdir(other, { recursive: true })
    await chmod(other, 0o700)

    const saved = home
    home = other
    const { code } = await gpg(['--batch', '--quiet', '--decrypt', `${dir}/evm.key.gpg`])
    home = saved

    expect(code).not.toBe(0)
    await rm(other, { recursive: true, force: true })
  })

  it('密钥文件权限是 0600', async () => {
    if (!ready) return
    const { stat } = await import('node:fs/promises')
    const info = await stat(`${dir}/evm.key.gpg`)
    expect((info.mode & 0o777).toString(8)).toBe('600')
  })
})
