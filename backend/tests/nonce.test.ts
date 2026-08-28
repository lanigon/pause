import { describe, expect, it, vi } from 'vitest'
import { requireSingleSigner, serializePerSigner } from '../src/lib/web3/runner.js'
import { evmNonceManager } from '../src/lib/web3/evm/nonce.js'
import type { BatchItem } from '../src/lib/web3/types.js'

/**
 * 批次前置（所有链族共用）+ EVM nonce（只有 EVM 有）。
 *
 * 三条不变量：
 *   ① 一批交易来自同一个签名地址（不同地址有各自独立的账）
 *   ② 同一个 (链, 地址) 的批次串行（并发会各自读到同一个基准，互相覆盖）
 *   ③ nonce 只在广播成功后推进（失败要能原样复用，不留洞）—— 仅 EVM
 */
const item = (from: string): BatchItem =>
  ({ id: 'x', request: { fromAddress: from, contractAddress: '0xc', method: 'pause', args: [] } }) as BatchItem

const providerWith = (pending: number, mined: number) =>
  ({
    getTransactionCount: vi.fn(async (_a: string, tag: string) => (tag === 'pending' ? pending : mined)),
  }) as never

describe('① 同一签名地址', () => {
  it('全部来自同一地址时返回归一化后的地址', () => {
    const from = requireSingleSigner([item('0xAbC'), item('0xabc')], (a) => a.toLowerCase())
    expect(from).toBe('0xabc')
  })

  it('★ 混了不同地址就抛错 —— 序号空间是按地址分的，混着分配没有意义', () => {
    expect(() => requireSingleSigner([item('0xa'), item('0xb')], (a) => a)).toThrow(/同一个签名地址/)
  })
})

describe('② 按签名地址串行', () => {
  it('★ 同一个 (链, 地址) 的两批不会交叠', async () => {
    const order: string[] = []
    const task = (tag: string) => async () => {
      order.push(`${tag}:start`)
      await new Promise((r) => setTimeout(r, 20))
      order.push(`${tag}:end`)
    }

    await Promise.all([
      serializePerSigner('morph', '0xa', task('A')),
      serializePerSigner('morph', '0xa', task('B')),
    ])

    // 交叠的话会是 A:start B:start A:end B:end
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('不同地址之间不互相阻塞', async () => {
    const order: string[] = []
    await Promise.all([
      serializePerSigner('morph', '0xa', async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push('慢的')
      }),
      serializePerSigner('morph', '0xb', async () => {
        order.push('快的')
      }),
    ])
    expect(order).toEqual(['快的', '慢的'])
  })

  it('地址大小写不同视为同一个，照样串行', async () => {
    const order: string[] = []
    await Promise.all([
      serializePerSigner('morph', '0xAbC', async () => {
        await new Promise((r) => setTimeout(r, 20))
        order.push('第一')
      }),
      serializePerSigner('morph', '0xabc', async () => order.push('第二') as unknown as void),
    ])
    expect(order).toEqual(['第一', '第二'])
  })
})

describe('③ EVM 序号分配', () => {
  it('基准取链上 pending 值', async () => {
    const manager = await evmNonceManager(providerWith(5, 5), '0xa', 'morph')
    expect(manager.next()).toBe(5)
  })

  it('★ 不 commit 就一直是同一个 —— 拼装/签名失败要能原样复用，不留洞', async () => {
    const manager = await evmNonceManager(providerWith(5, 5), '0xa', 'morph')
    expect(manager.next()).toBe(5)
    expect(manager.next()).toBe(5) // 没广播成功，序号不动
    manager.commit()
    expect(manager.next()).toBe(6)
  })

  it('连续 commit 严格递增，不跳号', async () => {
    const manager = await evmNonceManager(providerWith(10, 10), '0xa', 'morph')
    const used: (number | undefined)[] = []
    for (let i = 0; i < 4; i += 1) {
      used.push(manager.next())
      manager.commit()
    }
    expect(used).toEqual([10, 11, 12, 13])
  })

  it('★ 开工前就有悬空交易要警告 —— 本批会排在它们后面，一起卡死', async () => {
    // pending 8、latest 5 → 有 3 笔已广播未打包
    const manager = await evmNonceManager(providerWith(8, 5), '0xa', 'morph')

    expect(manager.warnings).toHaveLength(1)
    expect(manager.warnings[0]).toContain('3 笔')
    expect(manager.warnings[0]).toContain('nonce 5~7')
    // 警告归警告，序号照常从 pending 开始，不阻断执行
    expect(manager.next()).toBe(8)
  })

  it('没有悬空交易时不warn，别制造噪音', async () => {
    const manager = await evmNonceManager(providerWith(5, 5), '0xa', 'morph')
    expect(manager.warnings).toEqual([])
  })
})

/**
 * Tron 那边不再有任何 nonce 词汇 —— 以前要写 `nextSequence: () => undefined`
 * 这种空实现来凑接口，现在 runner 压根不认识序号，所以没什么可测的了。
 */
