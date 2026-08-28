import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ExecutionEvent, Registry } from '../src/types'

/**
 * 批量执行。
 *
 * 关注两件事：进度事件怎么落到合约状态上（弹窗和列表都靠它），
 * 以及**失败时不能把已经发生的事情丢掉** —— 广播出去的交易是链上事实。
 */
const runBatch = vi.fn()
const cancelBatch = vi.fn(async () => ({ cancelled: 1 }))
const postLog = vi.fn(async () => ({}))
const sendTransaction = vi.fn()

vi.mock('../src/store/api', () => ({
  syncRegistry: vi.fn(async () => ({ ...REGISTRY, synced: { changed: false, fromLark: true } })),
  getRegistry: vi.fn(async () => REGISTRY),
  getLogs: vi.fn(async () => ({ items: [] })),
  getStates: vi.fn(async () => ({})),
  setToken: vi.fn(),
  login: vi.fn(),
  randomNonce: () => 'n',
  buildLoginMessage: () => 'm',
  runBatch: (...args: unknown[]) => runBatch(...args),
  cancelBatch: () => cancelBatch(),
  postLog: (...args: unknown[]) => postLog(...args),
}))
vi.mock('../src/chain/multicall', () => ({ readStates: vi.fn(async () => new Map()) }))
const MOCK_WALLET = {
  id: 'mock',
  family: 'evm',
  label: 'Mock',
  isInstalled: () => true,
  connect: vi.fn(),
  signMessage: vi.fn(),
  onAccountChange: vi.fn(),
  sendTransaction: (...args: unknown[]) => sendTransaction(...args),
}

vi.mock('../src/chain/wallet', () => ({
  discoverWallets: async () => [MOCK_WALLET],
  FAMILIES: [{ family: 'evm', label: 'EVM', signsIn: true }],
  shorten: (a: string) => a,
}))

const REGISTRY: Registry = {
  configVersion: 'v1',
  businessLines: [{ id: 'pay', name: '支付' }],
  chains: [{ key: 'morph', name: 'Morph', type: 'evm', chainId: 2818, rpcs: [] }] as Registry['chains'],
  contracts: [
    { id: 'a', name: 'A', businessLine: 'pay', chain: 'morph', address: '0xa' },
    { id: 'b', name: 'B', businessLine: 'pay', chain: 'morph', address: '0xb' },
  ],
  signers: [],
  operations: [],
}

async function ready() {
  const { useStore } = await import('../src/store')
  const s = useStore()
  await s.bootstrap()
  s.toggle('a')
  s.toggle('b')
  // 钱包模式要用用户连的那个钱包，这里直接塞进去
  s.wallets = { evm: MOCK_WALLET, tron: null } as never
  return s
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('GPG 批量执行', () => {
  it('把进度事件落到对应合约上：中间态标 pending，终态清掉', async () => {
    runBatch.mockImplementation(
      async (_op, _ids, _v, onEvent: (e: ExecutionEvent) => void) => {
        onEvent({ phase: 'sign', at: 1, contractId: 'a', message: '已签名' })
        onEvent({ phase: 'broadcast', at: 2, contractId: 'a', message: '已广播', hash: '0xhash' })
        onEvent({ phase: 'confirmed', at: 3, contractId: 'a', message: '已确认', hash: '0xhash' })
      },
    )

    const s = await ready()
    await s.runGpgBatch('pause')

    const state = s.states.get('a')
    expect(state?.pending).toBeUndefined() // 终态了，别再转圈
    expect(state?.hash).toBe('0xhash')
  })

  it('★ 后来的事件没带 hash 时，不能把先前记下的 hash 抹掉', async () => {
    runBatch.mockImplementation(
      async (_op, _ids, _v, onEvent: (e: ExecutionEvent) => void) => {
        onEvent({ phase: 'broadcast', at: 1, contractId: 'a', message: '已广播', hash: '0xhash' })
        // 失败事件可能不带 hash —— 但交易已经在链上了，哈希丢了就查不到
        onEvent({ phase: 'failed', at: 2, contractId: 'a', message: '超时' })
      },
    )

    const s = await ready()
    await s.runGpgBatch('pause')

    expect(s.states.get('a')?.hash).toBe('0xhash')
  })

  it('error 事件要带上错误码和建议，前端才能引导用户下一步', async () => {
    runBatch.mockImplementation(async (_op, _ids, _v, onEvent: (e: ExecutionEvent) => void) => {
      onEvent({
        phase: 'error',
        at: 1,
        message: '没检测到 YubiKey',
        code: 'CARD_ABSENT',
        hint: '把 YubiKey 插到运行后端的那台机器上',
      })
    })

    const s = await ready()
    await s.runGpgBatch('pause')

    expect(s.failure?.code).toBe('CARD_ABSENT')
    expect(s.failure?.hint).toContain('YubiKey')
  })

  it('用户主动取消不算失败，不该弹错误', async () => {
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    runBatch.mockRejectedValue(aborted)

    const s = await ready()
    await s.runGpgBatch('pause')

    expect(s.failure).toBeNull()
    expect(s.running).toBe(false)
  })

  it('没勾合约就直接报错，不发请求', async () => {
    const { useStore } = await import('../src/store')
    const s = useStore()
    await s.bootstrap()

    await expect(s.runGpgBatch('pause')).rejects.toThrow(/勾选/)
    expect(runBatch).not.toHaveBeenCalled()
  })

  it('无论成败都把 running 放下来，不能让弹窗永远关不掉', async () => {
    runBatch.mockRejectedValue(new Error('炸了'))

    const s = await ready()
    await s.runGpgBatch('pause')

    expect(s.running).toBe(false)
    expect(s.failure?.message).toBe('炸了')
  })
})

describe('钱包模式逐笔签名', () => {
  it('★ 一个合约失败不能中断后面的 —— 紧急暂停要尽可能多暂停几个', async () => {
    sendTransaction.mockRejectedValueOnce(new Error('用户拒绝签名')).mockResolvedValueOnce('0xok')

    const s = await ready()
    s.mode = 'wallet'
    await s.runWalletBatch('pause')

    expect(sendTransaction).toHaveBeenCalledTimes(2)
    expect(s.events.some((e) => e.phase === 'failed')).toBe(true)
    expect(s.events.some((e) => e.phase === 'broadcast')).toBe(true)
  })

  it('★ 只有广播成功了才上报日志 —— 没发出去的不能记成操作记录', async () => {
    sendTransaction.mockRejectedValue(new Error('用户拒绝签名'))

    const s = await ready()
    s.mode = 'wallet'
    await s.runWalletBatch('pause')

    expect(postLog).not.toHaveBeenCalled()
  })
})
