import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Lark 同步。
 *
 * 这块的价值全在**失败时的行为**：这是紧急暂停工具，
 * Lark 出任何问题都不能影响本地数据可用。三条硬约束各有一个测试守着：
 *
 *   ① Lark 挂了 → 用本地数据，不报错
 *   ② Lark 返回 0 个合约 → 绝不覆盖本地
 *   ③ 配置校验不过 → 回滚，不能在磁盘上留下跑不起来的配置
 */

const LOCAL = {
  businessLines: [{ id: 'bl-5d3ba34c', name: '支付' }],
  contracts: [
    {
      id: 'morph-11111111',
      name: 'A',
      businessLine: 'bl-5d3ba34c',
      chain: 'morph',
      address: '0x' + '1'.repeat(40),
    },
  ],
}

let dataDir: string
let events: { phase: string; ok: boolean; message: string; code?: string; changes?: readonly string[] }[]

const readTable = vi.fn()
const loadRegistry = vi.fn(async () => undefined)

vi.mock('../src/lib/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/lark/client.js')>()
  return { ...actual, readTable: (...args: unknown[]) => readTable(...args) }
})
// 链以 chainId 为准，同步时要从 registry 拿 chains.json
const CHAINS = [
  { key: 'morph', name: 'Morph Mainnet', type: 'evm', chainId: 2818 },
  { key: 'tron', name: 'Tron', type: 'tron', chainId: 728126428 },
]
vi.mock('../src/services/registry.service.js', () => ({
  loadRegistry: () => loadRegistry(),
  getRegistry: () => ({ chains: new Map(CHAINS.map((c) => [c.key, c])) }),
}))
vi.mock('../src/lib/rpc/rpcProvider.js', () => ({ rpcProvider: { load: async () => undefined } }))

async function loadService() {
  vi.resetModules()
  process.env.LARK_URL = 'https://demo.feishu.cn/base/AbC123?table=tblXYZ&view=vewABC'
  const env = await import('../src/config/env.js')
  vi.spyOn(env.env, 'DATA_DIR', 'get').mockReturnValue(dataDir as './data')
  return import('../src/services/sync.service.js')
}

const row = (over: Record<string, string> = {}) => ({
  业务线: '支付',
  链: 'morph',
  chainId: '2818',
  合约: '0x' + '1'.repeat(40),
  名称: 'A',
  ...over,
})

const emit = (event: (typeof events)[number]) => void events.push(event)

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'sync-'))
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'contracts.json'), JSON.stringify(LOCAL))
  await writeFile(join(dataDir, 'rpc.json'), JSON.stringify({ syncedAt: '', lark: {}, chainlist: {} }))
  events = []
  readTable.mockReset()
  loadRegistry.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const localContracts = async () =>
  JSON.parse(await readFile(join(dataDir, 'contracts.json'), 'utf8')) as typeof LOCAL

describe('Lark 同步', () => {
  it('★ Lark 挂了不能挡住控制台 —— 报告原因，本地数据原样保留', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockRejectedValue(new Error('connect ETIMEDOUT'))

    const result = await syncFromLark(emit, true)

    expect(result).toEqual({ changed: false, fromLark: false })
    // 必须明确告诉前端"用的是本地数据"，不能静默
    expect(events.at(-1)?.message).toContain('本地数据')
    expect(events.at(-1)?.ok).toBe(false)
    expect(await localContracts()).toEqual(LOCAL)
  })

  it('★ Lark 返回 0 个合约判定为异常，绝不覆盖本地', async () => {
    const { syncFromLark } = await loadService()
    // 表格权限掉了 / 视图筛选错了，都会返回空 —— 覆盖下去紧急时就没合约可暂停
    readTable.mockResolvedValue([])

    const result = await syncFromLark(emit, true)

    expect(result.changed).toBe(false)
    expect(events.some((e) => e.code === 'LARK_EMPTY')).toBe(true)
    expect(await localContracts()).toEqual(LOCAL)
  })

  it('★ 配置校验不过要回滚 —— 磁盘上不能留下跑不起来的配置', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([row({ 名称: 'B', 合约: '0x' + '2'.repeat(40) })])
    // 最常见的情况：Lark 上有 chains.json 里没有的链
    // 只失败第一次：回滚会再调一次，那次必须成功
    loadRegistry.mockRejectedValueOnce(new Error('引用了不存在的链 "unknown-chain"'))

    const result = await syncFromLark(emit, true)

    expect(result.changed).toBe(false)
    expect(events.at(-1)?.code).toBe('APPLY_ROLLED_BACK')
    // 关键断言：文件内容回到了同步前
    expect(await localContracts()).toEqual(LOCAL)
  })

  it('内容一致时不写盘，也不重载配置', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([row()])

    const result = await syncFromLark(emit, true)

    expect(result).toEqual({ changed: false, fromLark: true })
    expect(loadRegistry).not.toHaveBeenCalled()
    expect(events.some((e) => e.message.includes('与本地一致'))).toBe(true)
  })

  it('有差异时写盘 + 重载，并给出人能看懂的变更摘要', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([row(), row({ 名称: 'B', 合约: '0x' + '2'.repeat(40) })])

    const result = await syncFromLark(emit, true)

    expect(result).toEqual({ changed: true, fromLark: true })
    expect(loadRegistry).toHaveBeenCalledOnce()
    expect((await localContracts()).contracts).toHaveLength(2)

    const summary = events.flatMap((e) => e.changes ?? [])
    expect(summary.some((line) => line.includes('新增合约 B'))).toBe(true)
  })

  it('地址变更要单独点出来 —— 可能是升级，也可能是表格填错', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([row({ 合约: '0x' + '9'.repeat(40) })])

    await syncFromLark(emit, true)

    const summary = events.flatMap((e) => e.changes ?? [])
    expect(summary.some((line) => line.includes('地址变更'))).toBe(true)
  })

  it('★ 沿用本地已有的 id —— 同步不能冲掉手工维护的可读 id', async () => {
    // 本地是人手写的 payment / morph-pausable-live，Lark 只给内容
    await writeFile(
      join(dataDir, 'contracts.json'),
      JSON.stringify({
        businessLines: [{ id: 'payment', name: '支付' }],
        contracts: [
          {
            id: 'morph-pausable-live',
            name: 'A',
            businessLine: 'payment',
            chain: 'morph',
            address: '0x' + '1'.repeat(40),
          },
        ],
      }),
    )
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([row({ 名称: '改了个名' })])

    await syncFromLark(emit, true)
    const saved = await localContracts()

    // id 不变，只有内容变 —— operations.json 里的历史日志才对得上
    expect(saved.contracts[0]?.id).toBe('morph-pausable-live')
    expect(saved.contracts[0]?.name).toBe('改了个名')
    expect(saved.businessLines[0]?.id).toBe('payment')

    // 而且不该报成"新增 + 移除"，只是改名
    const summary = events.flatMap((e) => e.changes ?? [])
    expect(summary.some((line) => line.includes('新增合约'))).toBe(false)
    expect(summary.some((line) => line.includes('归属或名称变更'))).toBe(true)
  })

  it('★ 表格里有 chains.json 没有的链时，跳过那几行、其余照常同步', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockResolvedValue([
      row(),
      // Base（8453）不在 chains.json 里 —— 以前会写进去再整次回滚，一个合约都更新不了
      row({ 链: 'Base', chainId: '8453', 名称: 'Base Vault', 合约: '0x' + '2'.repeat(40) }),
      row({ 链: 'tron', chainId: '728126428', 名称: 'T', 合约: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' }),
    ])

    const result = await syncFromLark(emit, true)

    // 好行落盘了
    expect(result.changed).toBe(true)
    expect((await localContracts()).contracts.map((c) => c.name)).toEqual(['A', 'T'])

    // 坏行必须报出来，指名道姓，绝不能悄悄跳过
    const skip = events.find((e) => e.code === 'ROWS_SKIPPED')
    expect(skip?.changes?.[0]).toContain('Base Vault')
    expect(skip?.changes?.[0]).toContain('chainId 8453')
  })

  it('★ 并发请求共享同一次同步，不重复打 Lark', async () => {
    const { syncFromLark } = await loadService()
    readTable.mockImplementation(
      async () => new Promise((r) => setTimeout(() => r([row()]), 30)),
    )

    await Promise.all([syncFromLark(emit, true), syncFromLark(emit), syncFromLark(emit)])

    // 第一个真拉，后两个在锁上等，等到时已经在 TTL 内
    expect(readTable).toHaveBeenCalledOnce()
  })

  it('TTL 内的重复请求直接跳过，不打 Lark', async () => {
    const { syncFromLark, resetSyncThrottle } = await loadService()
    resetSyncThrottle()
    readTable.mockResolvedValue([row()])

    await syncFromLark(emit, true)
    events = []
    await syncFromLark(emit)

    expect(readTable).toHaveBeenCalledOnce()
    expect(events[0]?.code).toBe('THROTTLED')
  })

  it('未配置 LARK_URL 时安静降级，不当成错误', async () => {
    vi.resetModules()
    process.env.LARK_URL = ''
    const envModule = await import('../src/config/env.js')
    vi.spyOn(envModule.env, 'DATA_DIR', 'get').mockReturnValue(dataDir as './data')
    const { syncFromLark } = await import('../src/services/sync.service.js')

    const result = await syncFromLark(emit, true)

    expect(result).toEqual({ changed: false, fromLark: false })
    expect(events[0]?.code).toBe('LARK_NOT_CONFIGURED')
    expect(readTable).not.toHaveBeenCalled()
  })
})
