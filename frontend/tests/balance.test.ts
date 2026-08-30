import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readEvm } from '../src/chain/evm/read'
import { readTron } from '../src/chain/tron/read'
import type { Chain, Contract } from '../src/types'

/**
 * operator 余额。
 *
 * 紧急暂停时最怕的是按下去才发现那个地址没气了，所以这一列要能一眼看出来。
 *
 * 全部价值集中在**三种情况必须分得清**：
 *   没配 operator  → 不读，也不显示
 *   读不到         → 不写字段（界面显示"读取中…"）
 *   真的是 0       → 写 0（界面标红）
 * 把"读不到"显示成 0，运维会跑去给一个其实好好的地址充值；
 * 而真没气时又和读不到长得一样，反倒没人当回事。
 */
const CHAIN: Chain = {
  key: 'morph',
  type: 'evm',
  chainId: 2818,
  explorer: 'https://e',
  symbol: 'ETH',
  decimals: 18,
  rpcs: ['https://rpc.invalid'],
}

const contract = (id: string, operator?: string): Contract =>
  ({ id, name: id, businessLine: 'pay', chain: 'morph', address: `0x${id}`, ...(operator ? { operator } : {}) }) as Contract

const OP_A = '0x' + 'a'.repeat(40)
const OP_B = '0x' + 'b'.repeat(40)

/** 32 字节的字 */
const word = (hex: string) => '0x' + hex.padStart(64, '0')

describe('EVM：余额与 paused 同一批读回', () => {
  it('★ 余额查询打给 Multicall3 自己，不额外多一次 RPC 往返', async () => {
    const calls: { target: string }[] = []
    const staticCall = vi.fn(async (batch: { target: string }[]) => {
      calls.push(...batch)
      return batch.map(() => [true, word('1')] as [boolean, string])
    })
    vi.doMock('ethers', async (orig) => {
      const actual = await orig<typeof import('ethers')>()
      return {
        ...actual,
        JsonRpcProvider: class {},
        Contract: class {
          aggregate3 = { staticCall }
        },
      }
    })
    vi.resetModules()
    const { readEvm: read } = await import('../src/chain/evm/read')

    await read(CHAIN, [contract('c1', OP_A)])

    // 两条调用：一条打合约（paused），一条打 Multicall3（getEthBalance）
    expect(calls).toHaveLength(2)
    expect(calls.filter((c) => c.target.toLowerCase() === '0xca11bde05977b3631167028862be2a173976ca11')).toHaveLength(1)
    vi.doUnmock('ethers')
    vi.resetModules()
  })
})

describe('Tron：按地址去重', () => {
  const host = 'https://tron.invalid'
  const tronChain = { ...CHAIN, key: 'tron', type: 'tron', symbol: 'TRX', decimals: 6, rpcs: [host] }

  beforeEach(() => vi.restoreAllMocks())

  const stubFetch = (balances: Record<string, unknown>) => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { address?: string }
      if (String(url).endsWith('/wallet/getaccount')) {
        seen.push(body.address!)
        return { ok: true, json: async () => balances[body.address!] ?? {} }
      }
      return { ok: true, json: async () => ({}) } // paused 读不到
    }))
    return seen
  }

  it('★ 同一个 operator 管多个合约时只问一次 —— 读 N 次是白费', async () => {
    const seen = stubFetch({ [OP_A]: { balance: 5_000_000 } })

    await readTron(tronChain, [contract('c1', OP_A), contract('c2', OP_A), contract('c3', OP_B)])

    expect(seen.filter((a) => a === OP_A)).toHaveLength(1)
    expect(seen.sort()).toEqual([OP_A, OP_B].sort())
  })

  it('余额摊回每个用到它的合约', async () => {
    stubFetch({ [OP_A]: { balance: 5_000_000 } })

    const states = await readTron(tronChain, [contract('c1', OP_A), contract('c2', OP_A)])

    expect(states.get('c1')?.operatorBalance).toBe('5')
    expect(states.get('c2')?.operatorBalance).toBe('5')
  })

  it('★ 从没上过链的地址返回空对象 —— 那是真的 0，要写进去', async () => {
    stubFetch({ [OP_A]: {} })

    const states = await readTron(tronChain, [contract('c1', OP_A)])

    expect(states.get('c1')?.operatorBalance).toBe('0')
  })

  it('★ 请求失败时不写字段 —— 不能和"真的 0"混为一谈', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/wallet/getaccount')
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => ({}) },
    ))

    const states = await readTron(tronChain, [contract('c1', OP_A)])

    expect(states.get('c1')?.operatorBalance).toBeUndefined()
  })

  it('没配 operator 的合约根本不去读', async () => {
    const seen = stubFetch({})

    await readTron(tronChain, [contract('c1')])

    expect(seen).toHaveLength(0)
  })
})
