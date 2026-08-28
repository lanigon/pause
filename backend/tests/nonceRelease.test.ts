import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TxStatus } from '../src/lib/web3/types.js'
import type { BatchItem, SignPayloadFn } from '../src/lib/web3/types.js'
import type { Chain } from '../src/models/chain.model.js'

/**
 * 卡死交易的 nonce 让位。
 *
 * 这是整个批量执行里最危险的一条路径。nonce 严格递增，N 悬着不动，
 * N+1、N+2 就永远不会被打包 —— 界面上每一笔都显示「已广播」，
 * 实际上一个合约都没暂停。紧急暂停时这比单笔失败危险得多。
 *
 * 让位的手段是同 nonce 发自转账，本质是「取消」，所以最要命的风险反过来了：
 * **绝不能把一次已经生效的暂停给取消掉**。下面第一个测试守的就是这条。
 */
const provider = {
  getFeeData: vi.fn(async () => ({
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    gasPrice: 1_000_000_000n,
  })),
  waitForTransaction: vi.fn(async () => null),
  estimateGas: vi.fn(async () => 50_000n),
  broadcastTransaction: vi.fn(async () => ({ hash: '0xclear' })),
  getTransactionCount: vi.fn(async () => 5),
}

const readBatch = vi.fn()

vi.mock('../src/lib/web3/evm/client.js', () => ({
  getProvider: () => provider,
  readBatch: (...args: unknown[]) => readBatch(...args),
  encodeCall: () => '0xdeadbeef',
  decodeCall: (_m: string, v: string) => v,
}))

const CHAIN = { key: 'morph', type: 'evm', chainId: 2818, explorer: 'https://e', symbol: 'ETH', decimals: 18 } as Chain

const ITEM: BatchItem = {
  id: 'c1',
  request: {
    contractAddress: '0x' + '1'.repeat(40),
    fromAddress: '0x' + '2'.repeat(40),
    method: 'pause',
    args: [],
  },
  stateCheck: { method: 'paused', expected: true },
} as unknown as BatchItem

/** 让 stateCheck 读到指定结果 */
const stateIs = (paused: boolean | 'error') =>
  readBatch.mockImplementation(async () => {
    if (paused === 'error') throw new Error('RPC 挂了')
    return [{ id: 'c1', success: true, value: paused }]
  })

async function loadTx() {
  vi.resetModules()
  const mod = await import('../src/lib/web3/evm/tx.js')
  return mod
}

beforeEach(() => {
  vi.clearAllMocks()
  provider.waitForTransaction.mockResolvedValue(null as never)
})

describe('卡死交易让出 nonce', () => {
  it('★ 状态已达成时绝不发自转账 —— 不能把生效了的暂停取消掉', async () => {
    const { confirmWithEscalation } = await loadTx()
    // 回执一直不来，但链上其实已经暂停了（回执慢，或者别人先做了）
    stateIs(true)

    const result = await confirmWithEscalation({
      chain: CHAIN,
      item: ITEM,
      hash: '0xorig',
      nonce: 7,
      sign: vi.fn(),
    })

    expect(result.status).toBe(TxStatus.CONFIRMED)
    // 一笔取消交易都不能发出去
    expect(provider.broadcastTransaction).not.toHaveBeenCalled()
  })

  it('★ 状态没达成才让位，且自转账必须是 to=from、value=0、不带 data', async () => {
    const { confirmWithEscalation } = await loadTx()
    stateIs(false)
    const sign = (async (payload) => {
      // 检查发出去的确实是一笔自转账，而不是又一次合约调用
      expect(payload.payload.to).toBe(ITEM.request.fromAddress)
      expect(payload.payload.value).toBe('0')
      expect(payload.payload.data).toBe('0x')
      expect(payload.payload.gasLimit).toBe('21000')
      return { rawTx: '0xsigned' }
    }) as SignPayloadFn

    const result = await confirmWithEscalation({ chain: CHAIN, item: ITEM, hash: '0xorig', nonce: 7, sign })

    expect(result.status).toBe(TxStatus.TIMEOUT)
    expect(result.reason).toContain('让出 nonce 7')
    // 报告里要说清楚：这个合约要重做，别的不受影响
    expect(result.reason).toContain('同批其余合约不受影响')
  })

  it('★ 自转账用的 nonce 必须和卡住那笔一样 —— 不然是新发一笔，堵得更死', async () => {
    const { confirmWithEscalation } = await loadTx()
    stateIs(false)
    const seen: number[] = []
    const sign = (async (payload) => {
      seen.push((payload.payload as { nonce: number }).nonce)
      return { rawTx: '0xsigned' }
    }) as SignPayloadFn

    await confirmWithEscalation({ chain: CHAIN, item: ITEM, hash: '0xorig', nonce: 7, sign })

    expect(new Set(seen)).toEqual(new Set([7]))
  })

  it('★ 替换是竞争关系 —— 原交易反而赢了要认成功，不能误报失败', async () => {
    const { confirmWithEscalation } = await loadTx()
    // 状态只在自转账发出去之后才变 —— 模拟"原交易在竞争中赢了"
    let selfTransferSent = false
    readBatch.mockImplementation(async () => [{ id: 'c1', success: true, value: selfTransferSent }])

    const result = await confirmWithEscalation({
      chain: CHAIN,
      item: ITEM,
      hash: '0xorig',
      nonce: 7,
      // 只有自转账（to = from）才置位；gas 阶梯重发那几次不算
      sign: (async (payload) => {
        if ((payload.payload as { to: string }).to === ITEM.request.fromAddress) {
          selfTransferSent = true
        }
        return { rawTx: '0xsigned' }
      }) as SignPayloadFn,
    })

    expect(result.status).toBe(TxStatus.CONFIRMED)
    expect(result.reason).toContain('原交易先一步生效')
  })

  it('★ 自转账本身也失败时，要明说这条链后续交易会被堵住', async () => {
    const { confirmWithEscalation } = await loadTx()
    stateIs(false)

    const result = await confirmWithEscalation({
      chain: CHAIN,
      item: ITEM,
      hash: '0xorig',
      nonce: 7,
      sign: vi.fn(async () => {
        throw new Error('签名子进程没了')
      }),
    })

    expect(result.status).toBe(TxStatus.TIMEOUT)
    expect(result.reason).toContain('后续交易会被堵住')
    expect(result.reason).toContain('人工介入')
  })

  it('回执正常返回时根本不该走到让位这一步', async () => {
    const { confirmWithEscalation } = await loadTx()
    provider.waitForTransaction.mockResolvedValue({ status: 1, blockNumber: 100, gasUsed: 21000n } as never)
    const sign = vi.fn()

    const result = await confirmWithEscalation({ chain: CHAIN, item: ITEM, hash: '0xorig', nonce: 7, sign })

    expect(result.status).toBe(TxStatus.CONFIRMED)
    expect(sign).not.toHaveBeenCalled()
  })
})
