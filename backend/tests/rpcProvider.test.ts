import { describe, expect, it } from 'vitest'
import type { RpcFile } from '../src/lib/rpc/endpoint.js'
import { RpcProvider } from '../src/lib/rpc/rpcProvider.js'
import type { Chain } from '../src/models/chain.model.js'

/**
 * RPC 三级降级：Lark → Alchemy → ChainList。
 *
 * 两条关键不变量：
 *  - 顺序：前面的来源有货就排前面，FallbackProvider 会优先用它
 *  - 隔离：Alchemy 的 URL 含 API key，**永远不能下发前端**
 */
const chain = (over: Partial<Chain> = {}): Chain =>
  ({
    key: 'morph', name: 'Morph', type: 'evm', chainId: 2818,
    explorer: 'https://x', confirmations: 2, symbol: 'ETH', decimals: 18,
    multicall3: null, ...over,
  }) as Chain

/**
 * 注意传空串而不是 undefined —— undefined 会触发默认参数，
 * 把真实 .env 里的 key 带进来，那就隔离不掉 Alchemy 那一级了。
 */
function providerWith(rpcFile: RpcFile, alchemyKey = ''): RpcProvider {
  const p = new RpcProvider()
  p.load(rpcFile, alchemyKey)
  return p
}

describe('降级顺序', () => {
  it('Lark 排在 ChainList 前面', () => {
    const p = providerWith({
      syncedAt: '', lark: { morph: ['https://lark-node'] }, chainlist: { morph: ['https://public-node'] },
    })
    expect(p.urlsFor(chain())).toEqual(['https://lark-node', 'https://public-node'])
  })

  it('Lark 没配就直接用 ChainList', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: { morph: ['https://public'] } })
    expect(p.urlsFor(chain())).toEqual(['https://public'])
  })

  it('同一个 URL 在多个来源出现时只保留优先级最高的那次', () => {
    const p = providerWith({
      syncedAt: '', lark: { morph: ['https://same'] }, chainlist: { morph: ['https://same', 'https://other'] },
    })
    expect(p.urlsFor(chain())).toEqual(['https://same', 'https://other'])
  })

  it('一个 RPC 都没有时抛错，而不是返回空数组让上层莫名其妙', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: {} })
    expect(() => p.urlsFor(chain())).toThrow(/没有可用的 RPC/)
  })
})

describe('★ 私有 RPC 不下发前端', () => {
  it('带 query 参数的 Lark RPC 视为私有', () => {
    const p = providerWith({
      syncedAt: '',
      lark: { morph: ['https://node.example.com/?apikey=SECRET', 'https://clean.example.com'] },
      chainlist: {},
    })
    expect(p.urlsFor(chain())).toHaveLength(2)
    // 只有干净的那个下发前端
    expect(p.publicUrlsFor(chain())).toEqual(['https://clean.example.com'])
  })

  it('路径里像密钥的（长串标识符）也视为私有', () => {
    const p = providerWith({
      syncedAt: '',
      lark: { morph: ['https://eth-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwxyz123'] },
      chainlist: {},
    })
    expect(p.publicUrlsFor(chain())).toEqual([])
  })

  it('带 basic auth 的视为私有', () => {
    const p = providerWith({
      syncedAt: '', lark: { morph: ['https://user:pass@node.example.com'] }, chainlist: {},
    })
    expect(p.publicUrlsFor(chain())).toEqual([])
  })

  it('ChainList 的公开 RPC 全部可下发', () => {
    const p = providerWith({
      syncedAt: '', lark: {}, chainlist: { morph: ['https://a.example.com', 'https://b.example.com'] },
    })
    expect(p.publicUrlsFor(chain())).toHaveLength(2)
  })

  it('ChainList 里带 ${} 模板占位符的会被过滤（那不是能用的地址）', () => {
    const p = providerWith({
      syncedAt: '', lark: {}, chainlist: { morph: ['https://x/${API_KEY}', 'https://ok.example.com'] },
    })
    expect(p.publicUrlsFor(chain())).toEqual(['https://ok.example.com'])
  })
})

describe('没有任何 RPC 时', () => {
  it('★ urlsFor 抛错并说清怎么补 —— 静默返回空会让上层拿着空列表去发交易', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: {} })
    expect(() => p.urlsFor(chain())).toThrow(/没有可用的 RPC/)
    expect(() => p.urlsFor(chain())).toThrow(/npm run sync rpc/)
  })

  it('publicUrlsFor 返回空数组而不是抛 —— 前端没 RPC 只是退化到后端代读', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: {} })
    expect(p.publicUrlsFor(chain())).toEqual([])
  })

  it('还没同步过时 syncedAt 是空串', () => {
    expect(providerWith({ syncedAt: '', lark: {}, chainlist: {} }).syncedAt).toBe('')
  })
})

describe('Alchemy 那一级', () => {
  it('配了 key 就排在 Lark 之后、ChainList 之前', () => {
    const p = providerWith(
      { syncedAt: '', lark: { morph: ['https://lark'] }, chainlist: { morph: ['https://public'] } },
      'TESTKEY',
    )
    expect(p.urlsFor(chain())).toEqual([
      'https://lark',
      'https://morph-mainnet.g.alchemy.com/v2/TESTKEY',
      'https://public',
    ])
  })

  it('★ Alchemy 的 URL 含 key，永远不下发前端', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: {} }, 'TESTKEY')
    expect(p.urlsFor(chain())).toHaveLength(1)
    expect(p.publicUrlsFor(chain())).toEqual([])
  })

  it('Alchemy 不支持的链就不产出（不会拼一个必然 404 的地址）', async () => {
    const unknown = chain({ key: 'weird', chainId: 999_999 })
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: { weird: ['https://w'] } }, 'TESTKEY')
    expect(p.urlsFor(unknown)).toEqual(['https://w'])
  })

  it('没配 key 就整级跳过', () => {
    const p = providerWith({ syncedAt: '', lark: {}, chainlist: { morph: ['https://p'] } })
    expect(p.urlsFor(chain())).toEqual(['https://p'])
  })
})

describe('★ Tron 不走 Alchemy', () => {
  it('Alchemy 有 tron 端点，但它讲 JSON-RPC 而 TronWeb 要 TronGrid REST，所以不列入候选', async () => {
    const tron = chain({ key: 'tron', type: 'tron', chainId: 728126428 })
    const p = providerWith(
      { syncedAt: '', lark: {}, chainlist: { tron: ['https://api.trongrid.io'] } },
      'TESTKEY',
    )
    // 只有 TronGrid，一个 alchemy 的都没混进来
    expect(p.urlsFor(tron)).toEqual(['https://api.trongrid.io'])
    expect(p.urlsFor(tron).some((u) => u.includes('alchemy'))).toBe(false)
  })
})
