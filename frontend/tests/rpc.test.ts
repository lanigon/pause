import { describe, expect, it, beforeEach, vi } from 'vitest'
import { rpcFor, __resetRpcMemory } from '../src/chain/rpc'
import type { Chain } from '../src/types'

/**
 * 一条链的 RPC 降级。
 *
 * 后端每条链下发 2–4 个候选（`publicUrlsFor`，已按探活排过序），
 * 而前端以前只用 `rpcs[0]` —— 第一个挂了或被 CORS 拦掉，这条链的状态、
 * operator 名单、余额就全部读不到，且后端代读那条兜底路已经删了。
 *
 * 这组测试锁三件事：
 *   挨个试到通为止
 *   通了之后记住，下次别再从挂掉的那个开始撞
 *   候选列表变了，记忆要作废
 */
const chain = (rpcs: string[], key = 'morph'): Chain =>
  ({ key, type: 'evm', chainId: 2818, explorer: 'https://e', symbol: 'ETH', decimals: 18, rpcs }) as Chain

beforeEach(() => __resetRpcMemory())

describe('挨个试到通为止', () => {
  it('第一个就通时不碰后面的', async () => {
    const tried: string[] = []
    const out = await rpcFor(chain(['a', 'b', 'c'])).use(async (url) => {
      tried.push(url)
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(tried).toEqual(['a'])
  })

  it('★ 前面的挂了就往后走，第一个能用的即为结果', async () => {
    const tried: string[] = []
    const out = await rpcFor(chain(['dead1', 'dead2', 'alive'])).use(async (url) => {
      tried.push(url)
      if (url.startsWith('dead')) throw new Error('CORS')
      return url
    })
    expect(out).toBe('alive')
    expect(tried).toEqual(['dead1', 'dead2', 'alive'])
  })

  it('★ 全挂了要抛，不能静默返回空 —— 上层得知道这条链是读不到还是真没数据', async () => {
    await expect(
      rpcFor(chain(['x', 'y'])).use(async () => {
        throw new Error('节点炸了')
      }),
    ).rejects.toThrow('节点炸了')
  })

  it('一个候选都没有时直接抛，不去发请求', async () => {
    const run = vi.fn()
    await expect(rpcFor(chain([])).use(run)).rejects.toThrow(/没有可用的 RPC/)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('记住上次跑通的那个', () => {
  it('★ 下次从记住的开始，不再撞已知挂掉的 —— 否则每次切业务线都白撞一轮', async () => {
    const c = chain(['dead', 'alive'])

    const first: string[] = []
    await rpcFor(c).use(async (url) => {
      first.push(url)
      if (url === 'dead') throw new Error('down')
      return url
    })
    expect(first).toEqual(['dead', 'alive'])

    const second: string[] = []
    await rpcFor(c).use(async (url) => {
      second.push(url)
      return url
    })
    expect(second).toEqual(['alive'])
  })

  it('记住的那个后来也挂了，会绕回去把其余的都试一遍', async () => {
    const c = chain(['a', 'b'])

    // 先让 b 成为记住的那个
    await rpcFor(c).use(async (url) => {
      if (url === 'a') throw new Error('down')
      return url
    })

    const tried: string[] = []
    const out = await rpcFor(c).use(async (url) => {
      tried.push(url)
      if (url === 'b') throw new Error('轮到 b 挂了')
      return url
    })
    expect(tried).toEqual(['b', 'a'])
    expect(out).toBe('a')
  })

  it('候选列表变了，记忆作废 —— 下标对应的已经不是同一个节点了', async () => {
    await rpcFor(chain(['a', 'b'])).use(async (url) => {
      if (url === 'a') throw new Error('down')
      return url
    })

    // 后端重新下发了一份不一样的列表
    const tried: string[] = []
    await rpcFor(chain(['x', 'y', 'z'])).use(async (url) => {
      tried.push(url)
      return url
    })
    expect(tried).toEqual(['x'])
  })

  it('每条链各记各的，互不干扰', async () => {
    const morph = chain(['m1', 'm2'], 'morph')
    const bsc = chain(['b1', 'b2'], 'bsc')

    await rpcFor(morph).use(async (url) => {
      if (url === 'm1') throw new Error('down')
      return url
    })

    const tried: string[] = []
    await rpcFor(bsc).use(async (url) => {
      tried.push(url)
      return url
    })
    // bsc 没有记忆，照常从头开始
    expect(tried).toEqual(['b1'])
  })
})
