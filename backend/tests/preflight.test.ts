import { describe, expect, it, vi, beforeEach } from 'vitest'
import { OperationKind } from '../src/services/operations.js'
import { BatchItemStatus } from '../src/lib/web3/types.js'

/**
 * 执行前的检查与授权。
 *
 * 前置检查决定"哪些合约该跳过"，判断错的代价很不对称：
 *  - 该跳的没跳 → 白花一笔 gas（可接受）
 *  - 不该跳的跳了 → **紧急暂停被静默漏掉**（不可接受）
 * 所以状态读不到时必须放行，交给链上判断。
 */
const contracts = [
  { id: 'running', name: '运行中的', businessLine: 'payment', chain: 'morph', address: '0x1' },
  { id: 'paused', name: '已暂停的', businessLine: 'payment', chain: 'morph', address: '0x2' },
  { id: 'unknown', name: '状态读不到的', businessLine: 'payment', chain: 'morph', address: '0x3' },
]

const states = new Map([
  ['running', { contractId: 'running', chainKey: 'morph', paused: false, fetchedAt: 0 }],
  ['paused', { contractId: 'paused', chainKey: 'morph', paused: true, fetchedAt: 0 }],
  ['unknown', { contractId: 'unknown', chainKey: 'morph', fetchedAt: 0 }], // 没有 paused 字段
])

// 只替掉「配置从哪来」这三个查询，其余（如纯函数 groupBy）用真的
vi.mock('../src/services/registry.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/registry.service.js')>()),
  getChain: (key: string) => ({ key, name: 'Morph', type: 'evm', chainId: 2818, explorer: 'https://e', confirmations: 1, symbol: 'E', decimals: 18, multicall3: null }),
  getContract: (id: string) => contracts.find((c) => c.id === id),
  contractsOf: () => contracts,
}))

// 只让 readBatch 返回预设状态，其余走真实实现
vi.mock('../src/lib/web3/chains.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/web3/chains.js')>('../src/lib/web3/chains.js')
  return {
    ...actual,
    tx: () => ({
      ...actual.tx('evm'),
      readBatch: async (_chain: unknown, calls: { id: string }[]) =>
        calls.map((call) => {
          const [contractId, key] = call.id.split('::')
          const state = states.get(contractId!)
          if (key === 'paused' && state && 'paused' in state) {
            return { id: call.id, success: true, value: state.paused }
          }
          return { id: call.id, success: false }
        }),
      executeBatch: async (_c: unknown, items: { id: string }[]) =>
        items.map((i) => ({ id: i.id, status: BatchItemStatus.CONFIRMED, hash: `0x${i.id}` })),
    }),
  }
})

const { execute, assertAuthorized } = await import('../src/services/execution.service.js')
// 只读状态查询已拆到 contractState.service
const { readStates } = await import('../src/services/contractState.service.js')

const signer = { chainType: 'evm', address: '0xSIGNER', unlock: 'passphrase' } as never
const actor = { address: '0xALICE', label: 'Alice', role: 'admin' } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('读状态', () => {
  it('把 paused 读出来', async () => {
    const result = await readStates(['running', 'paused'])
    expect(result.get('running')?.paused).toBe(false)
    expect(result.get('paused')?.paused).toBe(true)
  })

  it('读不到就是 undefined，不瞎猜成 false', async () => {
    const result = await readStates(['unknown'])
    expect(result.get('unknown')?.paused).toBeUndefined()
  })
})

describe('★ 前置检查：pause', () => {
  it('已经暂停的跳过，运行中的执行', async () => {
    const events: { phase: string; contractId?: string; message: string }[] = []
    const summary = await execute({
      operation: OperationKind.PAUSE,
      contracts: contracts as never,
      signers: new Map([['evm', signer]]),
      actor,
      signFor: () => async () => ({}),
      emit: (e) => events.push(e as never),
    })

    const skipped = summary.items.filter((i) => i.status === BatchItemStatus.SKIPPED)
    expect(skipped.map((i) => i.contractId)).toEqual(['paused'])
    expect(skipped[0]?.reason).toMatch(/已处于暂停状态/)
  })

  it('★ 状态读不到的**不跳过** —— 宁可白花 gas，也不能漏掉紧急暂停', async () => {
    const summary = await execute({
      operation: OperationKind.PAUSE,
      contracts: contracts as never,
      signers: new Map([['evm', signer]]),
      actor,
      signFor: () => async () => ({}),
      emit: () => undefined,
    })

    const skippedIds = summary.items
      .filter((i) => i.status === BatchItemStatus.SKIPPED)
      .map((i) => i.contractId)
    expect(skippedIds).not.toContain('unknown')
  })
})

describe('★ 前置检查：unpause（判断方向相反）', () => {
  it('运行中的跳过，已暂停的执行', async () => {
    const summary = await execute({
      operation: OperationKind.UNPAUSE,
      contracts: contracts as never,
      signers: new Map([['evm', signer]]),
      actor,
      signFor: () => async () => ({}),
      emit: () => undefined,
    })

    const skipped = summary.items.filter((i) => i.status === BatchItemStatus.SKIPPED)
    expect(skipped.map((i) => i.contractId)).toEqual(['running'])
    expect(skipped[0]?.reason).toMatch(/未暂停/)
  })
})

describe('汇总', () => {
  it('成功/失败/跳过分别计数，加起来等于总数', async () => {
    const summary = await execute({
      operation: OperationKind.PAUSE,
      contracts: contracts as never,
      signers: new Map([['evm', signer]]),
      actor,
      signFor: () => async () => ({}),
      emit: () => undefined,
    })

    expect(summary.succeeded + summary.failed + summary.skipped).toBe(contracts.length)
    expect(summary.items).toHaveLength(contracts.length)
  })

  it('全部被跳过时直接结束，不去碰密钥', async () => {
    let signCalled = false
    const summary = await execute({
      operation: OperationKind.PAUSE,
      contracts: [contracts[1]!] as never, // 只有已暂停的那个
      signers: new Map([['evm', signer]]),
      actor,
      signFor: () => async () => {
        signCalled = true
        return {}
      },
      emit: () => undefined,
    })

    expect(summary.skipped).toBe(1)
    expect(signCalled).toBe(false)
  })
})

describe('★ 授权', () => {
  it('链族配了密钥就放行', () => {
    expect(() => assertAuthorized({ contracts: contracts as never, signers: new Map([['evm', signer]]) })).not.toThrow()
  })

  it('★ 缺少该链族的密钥 → 整批拒绝（不做部分放行）', () => {
    expect(() => assertAuthorized({ contracts: contracts as never, signers: new Map() })).toThrow(/未配置这些链族的签名密钥/)
  })

  it('报错里点名是哪个链族缺密钥', () => {
    try {
      assertAuthorized({ contracts: contracts as never, signers: new Map() })
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain('evm')
    }
  })
})

describe('★ 回归：预演失败不能谎报"预演通过"', () => {
  it('onSimulate 在 ok=false 时不发 simulate 事件', async () => {
    const events: { phase: string; message: string }[] = []

    // 让 simulate 失败
    const { runBatch } = await import('../src/lib/web3/runner.js')
    await runBatch(
      [{ id: 'x', request: { contractAddress: '0x1', fromAddress: '0x2', method: 'pause', args: [] } }],
      async () => ({}),
      {
        simulate: async () => ({ ok: false, reason: 'REVERT' }),
        build: async () => ({ family: 'evm', payload: {} }),
        broadcast: async () => '0x',
        settle: async (_i, hash) => ({ status: 'confirmed' as never, hash }),
      },
      {
        // executor 的处理方式：ok=false 就不报"通过"
        onSimulate: (id, result) => {
          if (!result.ok) return
          events.push({ phase: 'simulate', message: `${id}：预演通过` })
        },
        onSkip: (id, reason) => events.push({ phase: 'skip', message: `${id}：${reason}` }),
      },
    )

    expect(events.map((e) => e.phase)).toEqual(['skip'])
    expect(events[0]?.message).toContain('REVERT')
  })
})
