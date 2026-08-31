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
const getLogs = vi.fn(async () => ({ items: [] }))
const readStates = vi.fn(async () => new Map())

vi.mock('../src/store/api', () => ({
  syncRegistry: (...args: unknown[]) => syncRegistry(...args),
  getLogs: () => getLogs(),
  setToken: vi.fn(),
  login: vi.fn(),
  randomNonce: () => 'n',
  buildLoginMessage: () => 'm',
  runBatch: vi.fn(),
  cancelBatch: vi.fn(),
  postLog: vi.fn(),
}))
vi.mock('../src/chain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chain')>()),
  readStates: (...args: unknown[]) => readStates(...args),
}))
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

  /**
   * 取数就是这条状态流本身，没有第二条路了（GET /registry 已并入 /registry/sync）。
   * 所以失败时必须让调用方知道，并且原因要摆进同步面板 ——
   * 静默失败会让界面停在空白，用户不知道该点什么。
   */
  it('★ 同步接口挂了要抛出，并把原因记进同步面板', async () => {
    syncRegistry.mockRejectedValue(new Error('502 Bad Gateway'))

    const s = await store()
    await expect(s.bootstrap()).rejects.toThrow('502')

    expect(s.registry).toBeNull()
    expect(s.syncEvents[0]?.code).toBe('SYNC_UNAVAILABLE')
    expect(s.syncEvents[0]?.message).toContain('重新同步')
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
    s.mode = 'gpg' // 默认是钱包模式，没连钱包时什么都勾不动；这里测的是勾选逻辑
    s.states = new Map([
      ['a', { paused: false }],
      ['b', { paused: true }],
      // c 状态未知（RPC 挂了）
    ])
    s.toggleLine('bridge')

    // a、b 都在 pay 业务线下
    s.selectByState('needPause', 'pay')
    expect([...s.selected]).toEqual(['a'])

    s.selectByState('needResume', 'pay')
    // 不确定的事情不替用户做决定 —— c 不在里面
    expect([...s.selected]).toEqual(['b'])
  })

  it('★ 只动本业务线 —— 别的业务线已勾的不能被冲掉', async () => {
    const s = await store()
    await s.bootstrap()
    s.mode = 'gpg' // 默认是钱包模式，没连钱包时什么都勾不动；这里测的是勾选逻辑
    s.states = new Map([
      ['a', { paused: false }],
      ['c', { paused: false }],
    ])
    s.toggleLine('bridge')

    // 先在 bridge 里手动勾一个
    s.toggle('c')
    expect([...s.selected]).toEqual(['c'])

    // 再点 pay 的「需暂停」—— c 必须还在
    s.selectByState('needPause', 'pay')
    expect([...s.selected].sort()).toEqual(['a', 'c'])
  })

  it('同一业务线内重复点会替换，不会越选越多', async () => {
    const s = await store()
    await s.bootstrap()
    s.mode = 'gpg' // 默认是钱包模式，没连钱包时什么都勾不动；这里测的是勾选逻辑
    s.states = new Map([
      ['a', { paused: false }],
      ['b', { paused: true }],
    ])

    s.selectByState('needPause', 'pay')
    s.selectByState('needResume', 'pay')
    expect([...s.selected]).toEqual(['b'])
  })
})

describe('操作清单来自后端', () => {
  it('后端下发什么就渲染什么 —— 加一种操作前端不用改', async () => {
    syncRegistry.mockResolvedValue({
      ...REGISTRY,
      operations: [
        { kind: 'pause', label: '暂停' },
        { kind: 'unpause', label: '恢复' },
        { kind: 'freeze', label: '冻结' },
      ],
      synced: { changed: false, fromLark: true },
    })

    const s = await store()
    await s.bootstrap()

    // 顺序由风险等级决定（另有测试），这里只关心后端下发的都在
    expect([...s.operations.map((op) => op.kind)].sort()).toEqual(['freeze', 'pause', 'unpause'])
    expect(s.operationLabel('freeze')).toBe('冻结')
  })

  it('★ 清单为空时退回内置的两个 —— 老后端不下发，界面不能连按钮都没有', async () => {
    const s = await store()
    await s.bootstrap() // REGISTRY.operations 是空的

    expect([...s.operations.map((op) => op.kind)].sort()).toEqual(['pause', 'unpause'])
    expect(s.operationLabel('pause')).toBe('暂停')
  })

  it('配置还没加载时也有按钮可点', async () => {
    const s = await store()
    expect(s.operations).toHaveLength(2)
  })

  it('★ 认不出的操作显示原始名，不能默认当成"恢复"', async () => {
    // 历史日志里可能有已经下线的操作，二选一的老写法会把它们全篡改成"恢复"
    const s = await store()
    await s.bootstrap()

    expect(s.operationLabel('freeze')).toBe('freeze')
  })
})

describe('分组只看得见的合约', () => {
  it('★ 分组内容 = visibleContracts，两处过滤不能各写一份', async () => {
    const s = await store()
    await s.bootstrap()
    s.toggleLine('bridge')

    const grouped = s.groups.flatMap((g) => g.contracts.map((c) => c.id))
    expect(grouped.sort()).toEqual(s.visibleContracts.map((c) => c.id).sort())
  })
})

describe('次要数据不拖垮启动', () => {
  it('★ /logs 挂了照样要能看到合约列表 —— 这是紧急暂停工具', async () => {
    getLogs.mockRejectedValueOnce(new Error('500'))

    const s = await store()
    await s.bootstrap()

    expect(s.registry?.configVersion).toBe('v1')
    expect(s.logs).toEqual([])
    expect(s.loading).toBe(false)
  })
})

describe('链上状态', () => {

  it('★ 读不到就是"未知"，不再有后端兜底 —— 那条兜底实测从未触发过', async () => {
    // 判定曾经是整体性的（有一个合约读到就算读到），所以只要有一条链能读，
    // 其余链读不到也永远不会走兜底。而真走到时后端在那几条链上同样读不到。
    readStates.mockResolvedValue(new Map([['a', { paused: false }]]) as never)

    const s = await store()
    await s.bootstrap()

    expect(s.states.get('a')?.paused).toBe(false)
    // b、c 读不到 → 没有条目 → 界面显示"未知"，快捷勾选也不会勾它们
    expect(s.states.get('b')?.paused).toBeUndefined()
  })
})

describe('操作按钮的排序（位置即防误触）', () => {
  it('★ 暂停永远在最右 —— 顺序不能被后端清单左右', async () => {
    // 后端把 pause 排在前面（bootstrap 走的是 syncRegistry）
    syncRegistry.mockResolvedValue({
      ...REGISTRY,
      operations: [
        { kind: 'pause', label: '暂停' },
        { kind: 'unpause', label: '恢复' },
      ],
      synced: { changed: false, fromLark: true },
    })

    const s = await store()
    await s.bootstrap()

    // 运维的肌肉记忆是"最右边那个是暂停"，后端排在前面也得给它挪到最后
    expect(s.operations.map((o) => o.kind)).toEqual(['unpause', 'pause'])
  })

  it('认不出的新操作排在中间，不占最危险那个位置', async () => {
    syncRegistry.mockResolvedValue({
      ...REGISTRY,
      operations: [
        { kind: 'pause', label: '暂停' },
        { kind: 'freeze', label: '冻结' },
        { kind: 'unpause', label: '恢复' },
      ],
      synced: { changed: false, fromLark: true },
    })

    const s = await store()
    await s.bootstrap()

    expect(s.operations.map((o) => o.kind)).toEqual(['unpause', 'freeze', 'pause'])
  })
})
