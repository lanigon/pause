import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * registry.service —— controller 与 core 之间的编排层。
 *
 * 这层没有算法，价值全在**分派与拒绝**：参数怎么落到不同的 core 能力上、
 * 什么情况该直接拒。这两件事错了，表现是「查不到状态」或「viewer 也能重载配置」，
 * 都不会有任何报错提示。
 */
const readStates = vi.fn(async () => new Map([['c1', { contractId: 'c1' }]]))
const readBusinessLineStates = vi.fn(async () => new Map([['c2', { contractId: 'c2' }]]))
const loadRegistry = vi.fn(async () => ({ configVersion: 'sha256:new' }))

vi.mock('../src/core/contractState.js', () => ({
  readStates: (...a: unknown[]) => readStates(...(a as [])),
  readBusinessLineStates: (...a: unknown[]) => readBusinessLineStates(...(a as [])),
}))
vi.mock('../src/core/config.js', () => ({
  dto: () => ({ configVersion: 'sha256:x' }),
  getRegistry: () => ({
    configVersion: 'sha256:x',
    loadedAt: 0,
    chains: new Map(),
    contracts: new Map(),
  }),
  loadRegistry: () => loadRegistry(),
}))
vi.mock('../src/core/sync.js', () => ({
  SyncPhase: { SOURCE: 'source', DIFF: 'diff', APPLY: 'apply' },
  syncFromLark: vi.fn(),
}))
vi.mock('../src/services/gpg.service.js', () => ({ activeCount: () => 3 }))
vi.mock('../src/services/log.service.js', () => ({ count: async () => 42 }))

const service = await import('../src/services/registry.service.js')

const actor = (role: string) => ({ address: '0xabc', label: 'A', role }) as never

beforeEach(() => vi.clearAllMocks())

describe('GET /states 的参数分派', () => {
  it('给了 businessLine 就整条线读', async () => {
    await service.states({ businessLine: 'payment' })
    expect(readBusinessLineStates).toHaveBeenCalledWith('payment')
    expect(readStates).not.toHaveBeenCalled()
  })

  it('给了 ids 就按 id 读，逗号分隔并去掉空白', async () => {
    await service.states({ ids: ' a , b ,, c ' })
    expect(readStates).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('★ 两个都没给要报错，不能静默返回空 —— 前端会以为「一个合约都没有」', () => {
    expect(() => service.states({})).toThrow('需要 businessLine 或 ids 参数')
  })

  it('★ ids 全是空白等同没给', () => {
    expect(() => service.states({ ids: ' , , ' })).toThrow('需要 businessLine 或 ids 参数')
  })

  it('businessLine 优先于 ids（两个都给时不会读两次链）', async () => {
    await service.states({ businessLine: 'payment', ids: 'a,b' })
    expect(readBusinessLineStates).toHaveBeenCalledOnce()
    expect(readStates).not.toHaveBeenCalled()
  })
})

describe('POST /registry/reload 的角色门', () => {
  it('★ admin 才能重载', async () => {
    await expect(service.reload(actor('admin'))).resolves.toEqual({ configVersion: 'sha256:new' })
    expect(loadRegistry).toHaveBeenCalledOnce()
  })

  it('★ operator 不行 —— 热重载会换掉全局配置，不是普通写操作', async () => {
    await expect(service.reload(actor('operator'))).rejects.toThrow('只有 admin')
    expect(loadRegistry).not.toHaveBeenCalled()
  })

  it('★ viewer 更不行', async () => {
    await expect(service.reload(actor('viewer'))).rejects.toThrow('只有 admin')
    expect(loadRegistry).not.toHaveBeenCalled()
  })

  it('拒绝时绝不能已经把配置重载了（检查必须在动作之前）', async () => {
    await service.reload(actor('viewer')).catch(() => undefined)
    expect(loadRegistry).not.toHaveBeenCalled()
  })
})

describe('系统状态', () => {
  it('/health 返回运行时长', () => {
    const health = service.health()
    expect(health.ok).toBe(true)
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('/state 汇总各来源的计数', async () => {
    expect(await service.state()).toMatchObject({
      configVersion: 'sha256:x',
      activeJobs: 3,
      logCount: 42,
    })
  })
})
