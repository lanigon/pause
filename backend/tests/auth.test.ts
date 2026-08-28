import { describe, expect, it, beforeEach, vi } from 'vitest'
import { Wallet } from 'ethers'

/**
 * 登录与 JWT。
 *
 * 这是唯一的对外无鉴权入口，每条防线都得测：
 *  - 验签：签名对不上就进不来
 *  - 白名单：签名对了但不在名单里也进不来
 *  - 时间窗：老签名不能用
 *  - 重放：同一个签名不能用两次
 *  - JWT：篡改任何一段都要失败
 */

// registry 是模块级单例，登录会去查它 —— 用 mock 隔离掉
const whitelist = new Map<string, { label: string; role: string }>()
vi.mock('../src/services/registry.service.js', () => ({
  findOperator: (addr: string) => whitelist.get(addr.toLowerCase()),
  getConfigVersion: () => 'sha256:test',
}))

const { login, verifyToken, toAuthContext, __clearUsedSignatures } = await import(
  '../src/services/auth.service.js'
)

const wallet = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')

const message = (address: string, timestamp: number, nonce: string): string =>
  [
    '合约管理平台 登录',
    '',
    `地址: ${address}`,
    `时间: ${new Date(timestamp).toISOString()}`,
    `随机数: ${nonce}`,
    '',
    '签名此消息即可登录',
  ].join('\n')

async function loginAs(over: { timestamp?: number; nonce?: string; address?: string } = {}) {
  const timestamp = over.timestamp ?? Date.now()
  const nonce = over.nonce ?? Math.random().toString(16).slice(2).padEnd(16, '0')
  const address = over.address ?? wallet.address
  const signature = await wallet.signMessage(message(address, timestamp, nonce))
  return login({ address, timestamp, nonce, signature })
}

beforeEach(() => {
  __clearUsedSignatures()
  whitelist.clear()
  whitelist.set(wallet.address.toLowerCase(), { label: 'Alice', role: 'admin' })
})

describe('登录', () => {
  it('白名单内、签名有效 → 发 token', async () => {
    const result = await loginAs()
    expect(result.operator.label).toBe('Alice')
    expect(result.operator.role).toBe('admin')
    expect(result.accessToken.split('.')).toHaveLength(3)
  })

  it('★ 签名对不上就拒绝', async () => {
    const timestamp = Date.now()
    const other = Wallet.createRandom()
    // 用别人的私钥签，却声称是 wallet 的地址
    const signature = await other.signMessage(message(wallet.address, timestamp, 'abcdef1234567890'))

    await expect(
      login({ address: wallet.address, timestamp, nonce: 'abcdef1234567890', signature }),
    ).rejects.toThrow(/签名验证失败/)
  })

  it('★ 签名有效但不在白名单 → 403', async () => {
    whitelist.clear()
    await expect(loginAs()).rejects.toThrow(/不在操作员白名单/)
  })

  it('★ 时间戳太旧 → 拒绝（防止捡到老签名重放）', async () => {
    await expect(loginAs({ timestamp: Date.now() - 10 * 60_000 })).rejects.toThrow(/签名已过期/)
  })

  it('★ 时间戳来自未来太多也拒绝', async () => {
    await expect(loginAs({ timestamp: Date.now() + 10 * 60_000 })).rejects.toThrow(/签名已过期/)
  })

  it('时间窗内的偏差可以接受（客户端时钟总有点飘）', async () => {
    await expect(loginAs({ timestamp: Date.now() - 60_000 })).resolves.toBeDefined()
  })

  it('★ 同一个签名不能用第二次', async () => {
    const timestamp = Date.now()
    const nonce = 'fixednonce123456'
    const signature = await wallet.signMessage(message(wallet.address, timestamp, nonce))
    const params = { address: wallet.address, timestamp, nonce, signature }

    await expect(login(params)).resolves.toBeDefined()
    await expect(login(params)).rejects.toThrow(/已被使用/)
  })

  it('地址大小写不影响白名单匹配', async () => {
    const result = await loginAs({ address: wallet.address.toLowerCase() })
    expect(result.operator.label).toBe('Alice')
  })
})

describe('JWT', () => {
  it('签发的 token 能验回来', async () => {
    const { accessToken } = await loginAs()
    const payload = verifyToken(accessToken)
    expect(payload.sub).toBe(wallet.address)
    expect(payload.role).toBe('admin')
    expect(payload.cv).toBe('sha256:test')
  })

  it('★ 改了 payload 就验不过（签名保护完整性）', async () => {
    const { accessToken } = await loginAs()
    const [header, claims, sig] = accessToken.split('.')
    const tampered = JSON.parse(Buffer.from(claims!, 'base64url').toString())
    tampered.role = 'admin'
    tampered.sub = '0x0000000000000000000000000000000000000000'
    const forged = `${header}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${sig}`

    expect(() => verifyToken(forged)).toThrow(/签名无效/)
  })

  it('格式不对直接拒绝', () => {
    expect(() => verifyToken('not-a-jwt')).toThrow(/格式非法/)
    expect(() => verifyToken('a.b')).toThrow(/格式非法/)
  })

  it('过期的 token 报 TOKEN_EXPIRED，前端据此引导重新登录', async () => {
    const { accessToken } = await loginAs()
    const [header, claims] = accessToken.split('.')
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString())
    payload.exp = Math.floor(Date.now() / 1000) - 10

    // 用同一个密钥重新签，模拟一个"合法但过期"的 token
    const { createHmac } = await import('node:crypto')
    const { env } = await import('../src/config/env.js')
    const newClaims = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const data = `${header}.${newClaims}`
    const sig = createHmac('sha256', env.JWT_SECRET).update(data).digest('base64url')

    expect(() => verifyToken(`${data}.${sig}`)).toThrow(/登录已过期/)
  })

  it('AuthContext 只带该带的字段', async () => {
    const { accessToken } = await loginAs()
    const ctx = toAuthContext(verifyToken(accessToken))
    expect(Object.keys(ctx).sort()).toEqual(['address', 'label', 'role'])
  })
})
