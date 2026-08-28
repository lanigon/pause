import { describe, expect, it } from 'vitest'
import { adapterOf, assertRegistered, meta, supportedFamilies, tx } from '../src/lib/web3/chains.js'
import { runBatch, requireSingleSigner, serializePerSigner } from '../src/lib/web3/runner.js'
import type { BatchStrategy } from '../src/lib/web3/runner.js'
import { BatchItemStatus, TxStatus } from '../src/lib/web3/types.js'
import type { BatchItem } from '../src/lib/web3/types.js'

/**
 * 接入异构链的准备度。
 *
 * Solana 还没接，但代码得先站得住。这组测试锁的是"漏了不会报错、
 * 只会静默做错事"的那几处 —— 最难在 review 里看出来的那种。
 *
 * 核心一条：**runner 里不能再有任何 EVM 专属的概念**。
 * nonce 只有 EVM 有（Tron 靠 ref_block 时间窗，Solana 靠 recent blockhash），
 * 让每条异构链都去实现一个空的 nextSequence/commitSequence 是纯负担。
 */

const item = (id: string, from = '0xabc'): BatchItem =>
  ({
    id,
    request: { fromAddress: from, contractAddress: '0xc', method: 'pause', args: [] },
  }) as BatchItem

const sign = async () => ({ raw: '0xsigned' })

describe('① 没注册的链族要明确报错，不能静默走别人的路', () => {
  it('adapterOf 抛错，并告诉你去哪注册', () => {
    expect(() => adapterOf('solana')).toThrow(/未注册的链族: solana/)
    expect(() => adapterOf('solana')).toThrow(/web3\/chains\.ts/)
  })

  it('★ 启动时就拦下来 —— chains.json 里有未注册的链族直接起不来', () => {
    expect(() => assertRegistered(['evm', 'solana'])).toThrow(/solana/)
    // 已注册的正常通过
    expect(() => assertRegistered(['evm', 'tron'])).not.toThrow()
  })

  it('meta 和 tx 走的是同一个注册表，不会一个通过一个失败', () => {
    expect(() => meta('solana')).toThrow(/未注册/)
    expect(() => tx('solana')).toThrow(/未注册/)
  })
})

describe('② runner 对链族一无所知 —— 这是接异构链的前提', () => {
  /** 一个完全不像 EVM 的假链族：没有 nonce，没有 gas，句柄是字符串 */
  function makeAlienStrategy() {
    const log: string[] = []
    const strategy: BatchStrategy = {
      simulate: async (i) => {
        log.push(`simulate:${i.id}`)
        return { ok: true }
      },
      build: async (i) => {
        log.push(`build:${i.id}`)
        // 注意：没有 sequence 字段，异构链根本没有这个概念
        return { family: 'alien', payload: { blockhash: 'FaKeBlockHash', id: i.id } }
      },
      broadcast: async (signed) => {
        log.push(`broadcast:${(signed as { raw?: string }).raw}`)
        return 'AlienTxSignature111'
      },
      settle: async (i, hash) => {
        log.push(`settle:${i.id}`)
        return { status: TxStatus.CONFIRMED, hash, blockNumber: 1 }
      },
    }
    return { strategy, log }
  }

  it('★ 一个没有 nonce 概念的链族能完整跑通 4 个方法', async () => {
    const { strategy, log } = makeAlienStrategy()

    const results = await runBatch([item('a'), item('b')], sign, strategy)

    expect(results.every((r) => r.status === BatchItemStatus.CONFIRMED)).toBe(true)
    // 顺序对，且从头到尾没有任何取号/提交序号的步骤
    expect(log).toEqual([
      'simulate:a', 'build:a', 'broadcast:0xsigned',
      'simulate:b', 'build:b', 'broadcast:0xsigned',
      'settle:a', 'settle:b',
    ])
  })

  it('★ BatchStrategy 就 4 个方法 —— 多一个都是在给异构链加负担', () => {
    const { strategy } = makeAlienStrategy()
    expect(Object.keys(strategy).sort()).toEqual(['broadcast', 'build', 'settle', 'simulate'])
  })

  it('规则对异构链一样生效：单笔失败不中断整批', async () => {
    const { strategy } = makeAlienStrategy()
    const failing: BatchStrategy = {
      ...strategy,
      build: async (i) => {
        if (i.id === 'b') throw new Error('拼装炸了')
        return { family: 'alien', payload: { id: i.id } }
      },
    }

    const results = await runBatch([item('a'), item('b'), item('c')], sign, failing)

    expect(results.find((r) => r.id === 'b')?.status).toBe(BatchItemStatus.FAILED)
    expect(results.filter((r) => r.status === BatchItemStatus.CONFIRMED)).toHaveLength(2)
  })
})

describe('③ 批次前置对所有链族通用', () => {
  it('同一签名地址：归一化函数由链族自己给（EVM 用 checksum，Tron 用 hex41）', () => {
    expect(requireSingleSigner([item('a', 'AbC'), item('b', 'aBc')], (s) => s.toLowerCase())).toBe('abc')
  })

  it('★ 混了不同地址就抛错 —— 这条和链族无关', () => {
    expect(() => requireSingleSigner([item('a', 'x'), item('b', 'y')], (s) => s)).toThrow(/同一个签名地址/)
  })

  it('★ 同一 (链, 地址) 的批次串行 —— 并发会各自读到同一个基准状态', async () => {
    const order: string[] = []
    const task = (tag: string) => async () => {
      order.push(`${tag}:进`)
      await new Promise((r) => setTimeout(r, 15))
      order.push(`${tag}:出`)
    }

    await Promise.all([
      serializePerSigner('alienchain', 'addr1', task('A')),
      serializePerSigner('alienchain', 'addr1', task('B')),
    ])

    expect(order).toEqual(['A:进', 'A:出', 'B:进', 'B:出'])
  })
})

describe('④ 现有两族没被改坏', () => {
  it('evm 和 tron 都注册着', () => {
    expect([...supportedFamilies()].sort()).toEqual(['evm', 'tron'])
  })

  it('两族的地址校验各管各的，不会互相认', () => {
    const evmAddr = '0x' + '1'.repeat(40)
    const tronAddr = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

    expect(meta('evm').isValidAddress(evmAddr)).toBe(true)
    expect(meta('evm').isValidAddress(tronAddr)).toBe(false)
    expect(meta('tron').isValidAddress(tronAddr)).toBe(true)
    expect(meta('tron').isValidAddress(evmAddr)).toBe(false)
  })
})
