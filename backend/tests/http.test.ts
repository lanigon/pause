import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import type { Express } from 'express'

/**
 * HTTP 层集成测试：路由 → 中间件 → 控制器。
 * 重点是**鉴权边界**：没 token 进不来、viewer 不能写、配置漂移要拦。
 */
const ADMIN = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const VIEWER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const OUTSIDER = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')

const EVM_ADDR = '0x1111111111111111111111111111111111111111'

let app: Express
let dir: string

const message = (address: string, timestamp: number, nonce: string): string =>
  [
    '合约管理平台 登录', '',
    `地址: ${address}`,
    `时间: ${new Date(timestamp).toISOString()}`,
    `随机数: ${nonce}`, '',
    '签名此消息即可登录',
  ].join('\n')

async function tokenFor(wallet: Wallet): Promise<string> {
  const timestamp = Date.now()
  const nonce = Math.random().toString(16).slice(2).padEnd(16, '0')
  const signature = await wallet.signMessage(message(wallet.address, timestamp, nonce))
  const res = await request(app)
    .post('/api/auth/login')
    .send({ address: wallet.address, timestamp, nonce, signature })
  return res.body.data.accessToken as string
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'http-'))

  await writeFile(join(dir, 'chains.json'), JSON.stringify({
    chains: [{ key: 'morph', name: 'Morph', type: 'evm', chainId: 2818, explorer: 'https://e.io', confirmations: 2, symbol: 'ETH', decimals: 18, multicall3: null }],
  }))
  await writeFile(join(dir, 'contracts.json'), JSON.stringify({
    businessLines: [{ id: 'payment', name: '支付' }],
    contracts: [{ id: 'vault', name: 'Vault', businessLine: 'payment', chain: 'morph', address: EVM_ADDR }],
  }))
  await writeFile(join(dir, 'operators.json'), JSON.stringify([
    { address: ADMIN.address, label: 'Alice', role: 'admin', enabled: true },
    { address: VIEWER.address, label: 'Vic', role: 'viewer', enabled: true },
  ]))
  await writeFile(join(dir, 'signers.json'), JSON.stringify([
    { chainType: 'evm', address: EVM_ADDR, unlock: 'passphrase' },
  ]))
  const { rpcProvider } = await import('../src/lib/rpc/rpcProvider.js')
  // RPC 直接传结构，不用落盘 —— provider 不读文件
  rpcProvider.load(
    { syncedAt: '', lark: {}, chainlist: { morph: ['https://rpc.morphl2.io'] } },
    '',
  )
  const { loadRegistry } = await import('../src/services/registry.service.js')
  await loadRegistry(dir)
  const { createApp } = await import('../src/app.js')
  app = createApp()
}, 30_000)

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('无需鉴权的接口', () => {
  it('/health 不用 token', async () => {
    const res = await request(app).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.data.ok).toBe(true)
  })

  it('★ 未认证访问未知路径回 401 而不是 404 —— 不向外人暴露 API 有哪些端点', async () => {
    const res = await request(app).get('/api/nope')
    expect(res.status).toBe(401)
  })

  it('已认证访问未知路径才回 404，且是统一封装', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).get('/api/nope').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
  })
})

describe('★ 鉴权边界', () => {
  it('没有 token → 401', async () => {
    const res = await request(app).get('/api/registry')
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('乱写的 token → 401', async () => {
    const res = await request(app).get('/api/registry').set('Authorization', 'Bearer garbage')
    expect(res.status).toBe(401)
  })

  it('★ 不在白名单的地址签名有效也进不来 → 403', async () => {
    const timestamp = Date.now()
    const nonce = 'outsider12345678'
    const signature = await OUTSIDER.signMessage(message(OUTSIDER.address, timestamp, nonce))
    const res = await request(app)
      .post('/api/auth/login')
      .send({ address: OUTSIDER.address, timestamp, nonce, signature })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/白名单/)
  })

  it('参数不合法 → 400 且指出哪个字段', async () => {
    const res = await request(app).post('/api/auth/login').send({ address: 'not-an-address' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BAD_REQUEST')
  })

  it('非 EVM 地址登录直接被 schema 挡掉', async () => {
    const res = await request(app).post('/api/auth/login').send({
      address: 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ',
      timestamp: Date.now(), nonce: 'x'.repeat(16), signature: '0x00',
    })
    expect(res.status).toBe(400)
  })
})

describe('配置下发', () => {
  it('登录后能拿到 registry', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.contracts).toHaveLength(1)
    expect(res.body.data.chains[0].rpcs).toEqual(['https://rpc.morphl2.io'])
  })

  it('★ 带 ETag 再拉回 304，前端轮询零传输', async () => {
    const token = await tokenFor(ADMIN)
    const first = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)
    const etag = first.headers.etag ?? ''

    const second = await request(app)
      .get('/api/registry')
      .set('Authorization', `Bearer ${token}`)
      .set('If-None-Match', etag)

    expect(second.status).toBe(304)
  })

  it('★ 不下发 operators 名单', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)
    expect(Object.keys(res.body.data)).not.toContain('operators')
  })
})

describe('★ 角色权限', () => {
  it('viewer 能读', async () => {
    const token = await tokenFor(VIEWER)
    const res = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
  })

  it('★ viewer 不能发起批量执行 → 403', async () => {
    const token = await tokenFor(VIEWER)
    const res = await request(app)
      .post('/api/gpg/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ operation: 'pause', contractIds: ['vault'], expectedConfigVersion: 'x', confirm: 'CONFIRM' })

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/只读账号/)
  })

  it('★ viewer 也不能取消任务', async () => {
    const token = await tokenFor(VIEWER)
    const res = await request(app).post('/api/gpg/cancel').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })

  it('admin 可以取消（没有在跑的任务时返回 0）', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).post('/api/gpg/cancel').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.cancelled).toBe(0)
  })
})

describe('★ 批量执行的入参校验', () => {
  const batch = (token: string, body: Record<string, unknown>) =>
    request(app).post('/api/gpg/batch').set('Authorization', `Bearer ${token}`).send(body)

  it('少了 confirm 就拒绝（防误触）', async () => {
    const token = await tokenFor(ADMIN)
    const res = await batch(token, { operation: 'pause', contractIds: ['vault'], expectedConfigVersion: 'x' })
    expect(res.status).toBe(400)
  })

  it('confirm 写错也拒绝', async () => {
    const token = await tokenFor(ADMIN)
    const res = await batch(token, {
      operation: 'pause', contractIds: ['vault'], expectedConfigVersion: 'x', confirm: 'yes',
    })
    expect(res.status).toBe(400)
  })

  it('不认识的操作类型被枚举挡掉', async () => {
    const token = await tokenFor(ADMIN)
    const res = await batch(token, {
      operation: 'selfdestruct', contractIds: ['vault'], expectedConfigVersion: 'x', confirm: 'CONFIRM',
    })
    expect(res.status).toBe(400)
  })

  it('★ configVersion 对不上 → 409，让前端刷新', async () => {
    const token = await tokenFor(ADMIN)
    const res = await batch(token, {
      operation: 'pause', contractIds: ['vault'], expectedConfigVersion: 'sha256:stale', confirm: 'CONFIRM',
    })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFIG_CHANGED')
  })

  it('合约 id 不存在 → 404', async () => {
    const token = await tokenFor(ADMIN)
    const reg = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)
    const res = await batch(token, {
      operation: 'pause', contractIds: ['ghost'],
      expectedConfigVersion: reg.body.data.configVersion, confirm: 'CONFIRM',
    })
    expect(res.status).toBe(404)
  })

  it('合约列表重复 → 400', async () => {
    const token = await tokenFor(ADMIN)
    const reg = await request(app).get('/api/registry').set('Authorization', `Bearer ${token}`)
    const res = await batch(token, {
      operation: 'pause', contractIds: ['vault', 'vault'],
      expectedConfigVersion: reg.body.data.configVersion, confirm: 'CONFIRM',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/重复/)
  })

  it('空列表 → 400', async () => {
    const token = await tokenFor(ADMIN)
    const res = await batch(token, {
      operation: 'pause', contractIds: [], expectedConfigVersion: 'x', confirm: 'CONFIRM',
    })
    expect(res.status).toBe(400)
  })
})

describe('交易日志', () => {
  it('★ 上报的记录，地址一律用 JWT 里的，忽略请求体伪造的身份', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app)
      .post('/api/logs')
      .set('Authorization', `Bearer ${token}`)
      .send({
        operation: 'pause', contract: 'vault', chain: 'morph', hash: '0xabc', status: 'broadcast',
        address: '0xATTACKER', // 伪造，应被忽略
      })

    expect(res.status).toBe(201)
    expect(res.body.data.address).toBe(ADMIN.address)
  })

  it('非法状态被枚举挡掉', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).post('/api/logs').set('Authorization', `Bearer ${token}`)
      .send({ operation: 'pause', contract: 'v', chain: 'morph', hash: '0x1', status: 'whatever' })
    expect(res.status).toBe(400)
  })

  it('能查回来', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).get('/api/logs?limit=5').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data.items)).toBe(true)
  })
})

describe('系统状态', () => {
  it('/state 报出配置版本与规模', async () => {
    const token = await tokenFor(ADMIN)
    const res = await request(app).get('/api/state').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.chains).toBe(1)
    expect(res.body.data.contracts).toBe(1)
  })
})
