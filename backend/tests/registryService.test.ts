import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * registry.service —— controller 与 core 之间的编排层。
 *
 * 这层没有算法，价值全在**兜底**：Lark 那边出任何问题，控制台都得照常打开。
 * 这是紧急暂停工具，可用性优先于数据新鲜度 —— 拿不到最新配置顶多是名单旧了，
 * 拿不到配置则是整个界面打不开，真出事的时候没有东西可点。
 */
const syncFromLark = vi.fn()

vi.mock('../src/core/config.js', () => ({
  dto: () => ({ configVersion: 'sha256:x', contracts: [{ id: 'c1' }] }),
}))
vi.mock('../src/core/sync.js', () => ({
  SyncPhase: { SOURCE: 'source', DIFF: 'diff', APPLY: 'apply' },
  syncFromLark: (...a: unknown[]) => syncFromLark(...(a as [])),
}))

const service = await import('../src/services/registry.service.js')

beforeEach(() => vi.clearAllMocks())

describe('syncAndSnapshot：同步归同步，配置照发', () => {
  it('正常时返回配置，并带上这次同步的结果', async () => {
    syncFromLark.mockResolvedValue({ changed: true, fromLark: true })

    const payload = await service.syncAndSnapshot(vi.fn(), false)

    expect(payload.configVersion).toBe('sha256:x')
    expect(payload.synced).toEqual({ changed: true, fromLark: true })
  })

  it('force 要透传下去 —— 手改了 data/*.json 就靠它绕过节流', async () => {
    syncFromLark.mockResolvedValue({ changed: false, fromLark: false })
    const emit = vi.fn()

    await service.syncAndSnapshot(emit, true)

    expect(syncFromLark).toHaveBeenCalledWith(emit, true)
  })

  it('★ 同步崩了也要把配置发出去 —— 界面打不开比名单旧了严重得多', async () => {
    syncFromLark.mockRejectedValue(new Error('lark 炸了'))
    const emit = vi.fn()

    const payload = await service.syncAndSnapshot(emit, false)

    expect(payload.configVersion).toBe('sha256:x')
    // 没拉到 Lark，本地也没被改动
    expect(payload.synced).toEqual({ changed: false, fromLark: false })
  })

  it('★ 崩了要说清楚原因，不能默默给一份看不出新旧的配置', async () => {
    syncFromLark.mockRejectedValue(new Error('lark 炸了'))
    const emit = vi.fn()

    await service.syncAndSnapshot(emit, false)

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, code: 'SYNC_CRASHED', message: 'lark 炸了' }),
    )
  })
})

describe('系统状态', () => {
  it('/health 返回运行时长', () => {
    const health = service.health()
    expect(health.ok).toBe(true)
    expect(health.uptimeMs).toBeGreaterThanOrEqual(0)
  })
})
