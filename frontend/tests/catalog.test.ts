import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Registry } from '../src/types'

/**
 * 目录状态：看得见什么、能操作什么、同步失败时还能不能用。
 *
 * 最后一条最重要 —— 这是紧急暂停工具，
 * 同步接口挂了必须还能拿到本地配置，否则真出事的时候打不开控制台。
 */
const syncRegistry = vi.fn()
const getRegistry = vi.fn()
const getLogs = vi.fn(async () => ({ items: [] }))
const getStates = vi.fn(async () => ({}))
const readStates = vi.fn(async () => new Map())

vi.mock('../src/store/api', () => ({
  syncRegistry: (...args: unknown[]) => syncRegistry(...args),
  getRegistry: () => getRegistry(),
  getLogs: () => getLogs(),
  getStates: (...args: unknown[]) => getStates(...args),
  setToken: vi.fn(),
  login: vi.fn(),
  randomNonce: () => 'n',
  buildLoginMessage: () => 'm',
  runBatch: vi.fn(),
  cancelBatch: vi.fn(),
  postLog: vi.fn(),
}))
vi.mock('../src/chain/multicall', () => ({ readStates: (...args: unknown[]) => readStates(...args) }))
vi.mock('../src/chain/wallet', () => ({ walletFor: vi.fn() }))

const REGISTRY: Registry = {
  configVersion: 'v1',
  businessLines: [
    { id: 'pay', name: '支付' },
    { id: 'bridge', name: '跨链桥' },
  ],
  chains: [
    { key: 'morph', name: 'Morph', type: 'evm', chainId: 2818, rpcs: [] },
    { key: 'tron', name: 'Tron', type: 'tron', chainId: 728126428, rpcs: [] },
  ] as Registry['chains'],
  contracts: [
    { id: 'a', name: 'A', businessLine: 'pay', chain: 'morph', address: '0xa' },
    { id: 'b', name: 'B', businessLine: 'pay', chain: 'tron', address: 'Tb' },
    { id: 'c', name: 'C', businessLine: 'bridge', chain: 'morph', address: '0xc' },
  ],
  signers: [],
  operations: [],
}

async function store() {
  const { useStore } = await import('../src/store')
  return useStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  syncRegistry.mockResolvedValue({ ...REGISTRY, synced: { changed: false, fromLark: true } })
  getRegistry.mockResolvedValue(REGISTRY)
})

describe('加载与降级', () => {
  it('正常时走同步接口，进度事件都收下来', async () => {
    syncRegistry.mockImplementation(async (onProgress: (e: unknown) => void) => {
      onProgress({ phase: 'source', at: 1, ok: true, message: '拉取中' })
      onProgress({ phase: 'apply', at: 2, ok: true, message: '已更新', changes: ['新增合约 X'] })
      return { ...REGISTRY, synced: { changed: true, fromLark: true } }
    })

    const s = await store()
    await s.bootstrap()

    expect(s.syncEvents).toHaveLength(2)
    expect(s.syncResult).toEqual({ changed: true, fromLark: true })
    expect(s.registry?.configVersion).toBe('v1')
  })

  it('★ 同步接口挂了要退回本地配置 —— 数据比进度重要', async () => {
    syncRegistry.mockRejectedValue(new Error('502 Bad Gateway'))

    const s = await store()
    await s.bootstrap()

    // 关键：还是拿到了配置
    expect(s.registry?.configVersion).toBe('v1')
    expect(getRegistry).toHaveBeenCalledOnce()
    // 而且要告诉用户走的是降级路径，不能静默
    expect(s.syncEvents[0]?.code).toBe('SYNC_UNAVAILABLE')
  })

  it('默认勾上第一条业务线，不然进来是一片空白', async () => {
    const s = await store()
    await s.bootstrap()
    expect([...s.selectedLines]).toEqual(['pay'])
  })
})

describe('勾选与派生', () => {
  it('只显示勾选业务线下的合约，按业务线分块', async () => {
    const s = await store()
    await s.bootstrap()
    s.toggleLine('bridge')

    expect(s.visibleContracts.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(s.groups.map((g) => g.line.id)).toEqual(['pay', 'bridge'])
  })

  it('★ 取消勾选业务线时，要把它下面已选中的合约一并清掉', async () => {
    const s = await store()
    await s.bootstrap()
    s.toggle('a')
    s.toggle('b')
    expect(s.selected.size).toBe(2)

    s.toggleLine('pay') // 取消勾选

    // 否则会对着看不见的合约发交易 —— 用户根本不知道自己在操作什么
    expect(s.selected.size).toBe(0)
  })

  it('钱包模式下只能操作已连接链族的合约；GPG 模式不受限', async () => {
    const s = await store()
    await s.bootstrap()

    s.mode = 'wallet'
    expect(s.canOperate(REGISTRY.contracts[0]!)).toBe(false)

    s.connected = { evm: '0xme', tron: null }
    expect(s.canOperate(REGISTRY.contracts[0]!)).toBe(true) // morph
    expect(s.canOperate(REGISTRY.contracts[1]!)).toBe(false) // tron 没连

    s.mode = 'gpg'
    expect(s.canOperate(REGISTRY.contracts[1]!)).toBe(true)
  })

  it('★ 按状态快捷勾选时，状态未知的一律不勾', async () => {
    const s = await store()
    await s.bootstrap()
    s.states = new Map([
      ['a', { paused: false }],
      ['b', { paused: true }],
      // c 状态未知（RPC 挂了）
    ])
    s.toggleLine('bridge')

    s.selectByState('needPause')
    expect([...s.selected]).toEqual(['a'])

    s.selectByState('needResume')
    // 不确定的事情不替用户做决定 —— c 不在里面
    expect([...s.selected]).toEqual(['b'])
  })
})

describe('链上状态', () => {
  it('multicall 一个都没读到时退回后端代读', async () => {
    // 公开 RPC 常常不带 CORS 头，浏览器会直接拦掉
    readStates.mockResolvedValue(new Map([['a', {}]]) as never)
    getStates.mockResolvedValue({ a: { paused: true } } as never)

    const s = await store()
    await s.bootstrap()

    expect(getStates).toHaveBeenCalled()
    expect(s.states.get('a')?.paused).toBe(true)
  })

  it('读到值时不打后端，省 RPC 配额', async () => {
    readStates.mockResolvedValue(new Map([['a', { paused: false }]]) as never)

    const s = await store()
    await s.bootstrap()

    expect(getStates).not.toHaveBeenCalled()
  })
})
