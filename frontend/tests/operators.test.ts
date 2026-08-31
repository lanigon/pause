import { describe, expect, it, vi, beforeEach } from 'vitest'
import { AbiCoder, Interface, getAddress } from 'ethers'
import { readTron } from '../src/chain/tron/read'
import { toBase58 } from '../src/chain/tron/address'
import { OPERATORS_ABI, OPERATOR_PAGE, canEncode } from '../src/chain/abi'
import type { Chain, Contract } from '../src/types'

/**
 * 合约自己声明的 operator 名单与各自的主链币余额。
 *
 * 这块回答的是「谁能动这个合约、他们还有没有气」。价值集中在两处：
 *   名单读不到时**不能编**（合约可能压根没有 getOperators）
 *   余额读不到和真的是 0 **必须分得清**（0 标红，读不到显示 —）
 */
const coder = AbiCoder.defaultAbiCoder()

const OP_A = '0x' + 'a'.repeat(40)
const OP_B = '0x' + 'b'.repeat(40)

const TRON: Chain = {
  key: 'tron',
  type: 'tron',
  chainId: 728126428,
  explorer: 'https://tronscan.org/#',
  symbol: 'TRX',
  decimals: 6,
  rpcs: ['https://tron.invalid'],
}

const contract = (id: string, operator?: string): Contract =>
  ({
    id,
    name: id,
    businessLine: 'pay',
    chain: 'tron',
    address: `T${id.padEnd(33, 'x')}`,
    ...(operator ? { operator } : {}),
  }) as Contract

const word = (hex: string): string => hex.padStart(64, '0')
const encodeAddresses = (list: readonly string[]): string =>
  coder.encode(['address[]'], [list]).replace(/^0x/, '')

/**
 * 按接口分派的假节点。
 *   getOperators → 给名单
 *   isOperator   → 给 bool
 *   paused       → 读不到
 *   getaccount   → 给余额
 */
function stubTron(options: {
  operators?: readonly string[] | 'missing'
  isOperator?: boolean
  balances?: Record<string, number>
}) {
  const calls: { selector?: string; address?: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { function_selector?: string; address?: string }
      calls.push({ selector: body.function_selector, address: body.address })

      if (String(url).endsWith('/wallet/getaccount')) {
        const trx = options.balances?.[body.address!]
        return trx === undefined
          ? { ok: true, json: async () => ({}) }
          : { ok: true, json: async () => ({ balance: trx }) }
      }

      const selector = body.function_selector ?? ''
      if (selector.startsWith('getOperators')) {
        if (options.operators === 'missing' || options.operators === undefined) {
          // 合约没有这个方法：节点回一个没有 constant_result 的响应
          return { ok: true, json: async () => ({}) }
        }
        return { ok: true, json: async () => ({ constant_result: [encodeAddresses(options.operators as string[])] }) }
      }
      if (selector.startsWith('isOperator')) {
        return options.isOperator === undefined
          ? { ok: true, json: async () => ({}) }
          : { ok: true, json: async () => ({ constant_result: [word(options.isOperator ? '1' : '0')] }) }
      }
      return { ok: true, json: async () => ({}) } // paused 读不到
    }),
  )
  return calls
}

beforeEach(() => vi.restoreAllMocks())

describe('Tron：读 operator 名单', () => {
  it('★ 名单里的地址转成 base58 —— 合约返回的是 hex20，直接显示没人认得', async () => {
    stubTron({ operators: [OP_A], balances: { [toBase58(OP_A)]: 5_000_000 } })

    const states = await readTron(TRON, [contract('c1')])

    expect(states.get('c1')?.operators).toEqual([{ address: toBase58(OP_A), balance: '5' }])
  })

  it('★ 合约没有 getOperators 时不写这个字段 —— 不能编一个空名单出来', async () => {
    stubTron({ operators: 'missing' })

    const states = await readTron(TRON, [contract('c1')])

    expect(states.get('c1')?.operators).toBeUndefined()
    expect(states.get('c1')?.operatorsTruncated).toBeUndefined()
  })

  it('★ 余额读不到与真的是 0 必须分得清', async () => {
    stubTron({
      operators: [OP_A, OP_B],
      balances: { [toBase58(OP_A)]: 0 }, // A 真的是 0；B 的地址没在表里 → 读不到
    })

    const ops = (await readTron(TRON, [contract('c1')])).get('c1')?.operators
    const a = ops?.find((o) => o.address === toBase58(OP_A))
    const b = ops?.find((o) => o.address === toBase58(OP_B))

    expect(a?.balance).toBe('0')
    expect(b?.balance).toBe('0') // getaccount 返回空对象 = 从没上过链 = 真的 0
  })

  it('★ 第一页装满就标 truncated —— 没有总数可问，只能这么推断', async () => {
    stubTron({ operators: Array.from({ length: OPERATOR_PAGE }, (_, i) => `0x${String(i).padStart(40, '0')}`) })

    expect((await readTron(TRON, [contract('c1')])).get('c1')?.operatorsTruncated).toBe(true)
  })

  it('没装满就不标', async () => {
    stubTron({ operators: [OP_A] })
    expect((await readTron(TRON, [contract('c1')])).get('c1')?.operatorsTruncated).toBeUndefined()
  })

  it('★ 同一个 operator 管多个合约时余额只问一次', async () => {
    const calls = stubTron({ operators: [OP_A], balances: { [toBase58(OP_A)]: 1_000_000 } })

    await readTron(TRON, [contract('c1'), contract('c2'), contract('c3')])

    const balanceQueries = calls.filter((c) => c.address === toBase58(OP_A))
    expect(balanceQueries).toHaveLength(1)
  })
})

describe('Tron：isOperator', () => {
  const viewer = toBase58(OP_A)

  it('传了 viewer 才去问', async () => {
    const calls = stubTron({ operators: [OP_A], isOperator: true })
    await readTron(TRON, [contract('c1')])
    expect(calls.some((c) => c.selector?.startsWith('isOperator'))).toBe(false)

    const withViewer = stubTron({ operators: [OP_A], isOperator: true })
    await readTron(TRON, [contract('c1')], viewer)
    expect(withViewer.some((c) => c.selector?.startsWith('isOperator'))).toBe(true)
  })

  it('★ 不是 operator 要如实写 false —— 界面靠它提醒「钱包模式下会失败」', async () => {
    stubTron({ operators: [OP_B], isOperator: false })

    expect((await readTron(TRON, [contract('c1')], viewer)).get('c1')?.viewerIsOperator).toBe(false)
  })

  it('★ viewer 不是合法 base58 就不问 —— 拿垃圾去编码只会得到一个必然为 false 的答案', async () => {
    const calls = stubTron({ operators: [OP_A] })

    await readTron(TRON, [contract('c1')], '0x1111111111111111111111111111111111111111')

    expect(calls.some((c) => c.selector?.startsWith('isOperator'))).toBe(false)
  })

  it('合约没有 isOperator 时不写字段，不当成 false', async () => {
    stubTron({ operators: [OP_A] }) // isOperator 未设置 → 节点回空
    expect((await readTron(TRON, [contract('c1')], viewer)).get('c1')?.viewerIsOperator).toBeUndefined()
  })
})

describe('EVM：编解码契约', () => {
  const iface = new Interface(OPERATORS_ABI)

  it('★ getOperators 编码成 4 字节选择器 + 两个 32 字节参数', () => {
    const data = iface.encodeFunctionData('getOperators', [0, OPERATOR_PAGE])
    expect(data).toHaveLength(2 + 8 + 64 * 2)
  })

  it('★ 返回值按 address[] 解 —— 签名写错的话这里就会炸，而不是静默显示为空', () => {
    const encoded = coder.encode(['address[]'], [[OP_A, OP_B]])
    const [list] = iface.decodeFunctionResult('getOperators', encoded)
    expect([...(list as string[])].map((a) => a.toLowerCase())).toEqual([OP_A, OP_B])
  })

  it('isOperator 收一个地址、回一个 bool', () => {
    expect(iface.encodeFunctionData('isOperator', [OP_A])).toHaveLength(2 + 8 + 64)
    expect(iface.decodeFunctionResult('isOperator', `0x${word('1')}`)[0]).toBe(true)
  })

  it('★ 这两个 view 方法不能进 canEncode —— 它们不是可执行的操作，前端永远不该给它们发交易', () => {
    expect(canEncode('getOperators')).toBe(false)
    expect(canEncode('isOperator')).toBe(false)
    expect(canEncode('pause')).toBe(true)
  })
})

/**
 * EVM 的两轮读取。
 *
 * 第二轮的入参来自第一轮的结果（先拿名单，再按名单查余额），
 * 这是整块最容易写错的地方：漏了第二轮就全是"—"，
 * 或者把第一轮的 paused 结果错位摊到别的合约上。
 */
describe('EVM：两轮读取与组装', () => {
  const EVM: Chain = {
    key: 'morph',
    type: 'evm',
    chainId: 2818,
    explorer: 'https://e',
    symbol: 'ETH',
    decimals: 18,
    rpcs: ['https://rpc.invalid'],
  }
  const evmContract = (id: string): Contract =>
    ({ id, name: id, businessLine: 'pay', chain: 'morph', address: `0x${id.padEnd(40, '0')}` }) as Contract

  const mcIface = new Interface([
    'function getEthBalance(address addr) view returns (uint256 balance)',
  ])
  const opIface = new Interface(OPERATORS_ABI)
  const pausedIface = new Interface(['function paused() view returns (bool)'])

  /** 按 calldata 的选择器决定回什么，模拟 Multicall3 的 aggregate3 */
  async function loadEvm(reply: (selector: string, callData: string) => string | null) {
    vi.resetModules()
    vi.doMock('ethers', async (orig) => {
      const actual = (await orig()) as Record<string, unknown>
      return {
        ...actual,
        // destroy 是真会被调的 —— readEvm 每轮读完都销毁 provider，
        // 不销毁的话切几次业务线就攒一堆
        JsonRpcProvider: class {
          destroy(): void {}
        },
        Contract: class {
          aggregate3 = {
            staticCall: async (calls: { callData: string }[]) =>
              calls.map((c) => {
                const data = reply(c.callData.slice(0, 10), c.callData)
                return data === null ? [false, '0x'] : [true, data]
              }),
          }
        },
      }
    })
    return (await import('../src/chain/evm/read')).readEvm
  }

  const SEL = {
    paused: pausedIface.getFunction('paused')!.selector,
    getOperators: opIface.getFunction('getOperators')!.selector,
    isOperator: opIface.getFunction('isOperator')!.selector,
    balance: mcIface.getFunction('getEthBalance')!.selector,
  }

  it('★ 第二轮按第一轮拿到的名单查余额，摊回对应合约', async () => {
    const readEvm = await loadEvm((selector) => {
      if (selector === SEL.paused) return `0x${word('0')}`
      if (selector === SEL.getOperators) return coder.encode(['address[]'], [[OP_A, OP_B]])
      if (selector === SEL.balance) return `0x${word('de0b6b3a7640000')}` // 1e18 = 1 ETH
      return null
    })

    const states = await readEvm(EVM, [evmContract('c1')])

    expect(states.get('c1')?.paused).toBe(false)
    // ethers 解出来是 checksum 形式（大小写混合），Tron 那边是 base58 ——
    // 两个链族的地址形态本来就不同，界面比较时一律 toLowerCase
    expect(states.get('c1')?.operators).toEqual([
      { address: getAddress(OP_A), balance: '1.0' },
      { address: getAddress(OP_B), balance: '1.0' },
    ])
  })

  it('★ 名单读不到时不写字段，但 paused 照常 —— 一个失败不能拖垮另一个', async () => {
    const readEvm = await loadEvm((selector) => {
      if (selector === SEL.paused) return `0x${word('1')}`
      return null // getOperators 与余额都失败
    })

    const state = (await readEvm(EVM, [evmContract('c1')])).get('c1')
    expect(state?.paused).toBe(true)
    expect(state?.operators).toBeUndefined()
  })

  it('★ 余额读不到的 operator 仍要出现在名单里，只是没有余额', async () => {
    const readEvm = await loadEvm((selector) => {
      if (selector === SEL.getOperators) return coder.encode(['address[]'], [[OP_A]])
      return null // paused 与余额都读不到
    })

    expect((await readEvm(EVM, [evmContract('c1')])).get('c1')?.operators).toEqual([
      { address: getAddress(OP_A) },
    ])
  })

  it('传了 viewer 才发 isOperator，且结果如实写入', async () => {
    const seen: string[] = []
    const readEvm = await loadEvm((selector) => {
      seen.push(selector)
      if (selector === SEL.isOperator) return `0x${word('0')}`
      if (selector === SEL.getOperators) return coder.encode(['address[]'], [[OP_A]])
      return null
    })

    const state = (await readEvm(EVM, [evmContract('c1')], OP_B)).get('c1')
    expect(seen).toContain(SEL.isOperator)
    expect(state?.viewerIsOperator).toBe(false)
  })

  it('不传 viewer 就一条 isOperator 都不发', async () => {
    const seen: string[] = []
    const readEvm = await loadEvm((selector) => {
      seen.push(selector)
      return selector === SEL.getOperators ? coder.encode(['address[]'], [[OP_A]]) : null
    })

    await readEvm(EVM, [evmContract('c1')])
    expect(seen).not.toContain(SEL.isOperator)
  })

  /**
   * 换不换节点的判据是**这个 RPC 通不通**，不是**读到了几个值**。
   *
   * 拿"没读到值"当判据的话，一条链上的合约只要没有 paused()，
   * 每次刷新都会把 2–4 个候选全空跑一遍 —— 而结果一模一样。
   */
  describe('什么时候该换节点', () => {
    const MULTI: Chain = { ...EVM, rpcs: ['https://dead.invalid', 'https://alive.invalid'] }

    /** multicall 整体抛错 = 节点不通；单点也全失败时才判定这个候选不可用 */
    async function loadEvmPerUrl(behaviour: (url: string) => 'dead' | 'alive') {
      vi.resetModules()
      const urls: string[] = []
      vi.doMock('ethers', async (orig) => {
        const actual = (await orig()) as Record<string, unknown>
        let current = ''
        return {
          ...actual,
          JsonRpcProvider: class {
            constructor(url: string) {
              current = url
              urls.push(url)
            }
            destroy(): void {}
            async call(): Promise<string> {
              if (behaviour(current) === 'dead') throw new Error('CORS')
              return '0x'
            }
            async getBalance(): Promise<bigint> {
              if (behaviour(current) === 'dead') throw new Error('CORS')
              return 0n
            }
          },
          Contract: class {
            aggregate3 = {
              staticCall: async () => {
                throw new Error('这条链没部署 Multicall3')
              },
            }
          },
        }
      })
      const { readEvm } = await import('../src/chain/evm/read')
      const { __resetRpcMemory } = await import('../src/chain/rpc')
      __resetRpcMemory()
      return { readEvm, urls }
    }

    it('★ 第一个节点不通 —— 换到第二个', async () => {
      const { readEvm, urls } = await loadEvmPerUrl((url) =>
        url.includes('dead') ? 'dead' : 'alive',
      )
      await readEvm(MULTI, [evmContract('c1')])
      expect(urls).toEqual(['https://dead.invalid', 'https://alive.invalid'])
    })

    it('★ multicall 成功但每一项都失败 —— 那是合约没这个方法，不许换节点', async () => {
      const urls: string[] = []
      vi.resetModules()
      vi.doMock('ethers', async (orig) => {
        const actual = (await orig()) as Record<string, unknown>
        return {
          ...actual,
          JsonRpcProvider: class {
            constructor(url: string) {
              urls.push(url)
            }
            destroy(): void {}
          },
          Contract: class {
            // allowFailure：整批成功返回，但每一项都标着失败
            aggregate3 = {
              staticCall: async (calls: unknown[]) => calls.map(() => [false, '0x']),
            }
          },
        }
      })
      const { readEvm } = await import('../src/chain/evm/read')
      const { __resetRpcMemory } = await import('../src/chain/rpc')
      __resetRpcMemory()

      const states = await readEvm(MULTI, [evmContract('c1')])

      expect(urls).toEqual(['https://dead.invalid'])
      expect(states.get('c1')).toBeUndefined()
    })
  })
})
