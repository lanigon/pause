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
}))
vi.mock('../src/core/sync.js', () => ({
  SyncPhase: { SOURCE: 'source', DIFF: 'diff', APPLY: 'apply' },
  syncFromLark: vi.fn(),
}))

const service = await import('../src/services/registry.service.js')

beforeEach(() => vi.clearAllMocks())



describe('系统状态', () => {
  it('/health 返回运行时长', () => {
    const health = service.health()
    expect(health.ok).toBe(true)
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0)
  })

})
