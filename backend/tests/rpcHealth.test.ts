import { describe, expect, it } from 'vitest'
import { RpcProvider } from '../src/lib/rpc/rpcProvider.js'
import type { Chain } from '../src/models/chain.model.js'

/**
 * RPC 探活。
 *
 * 加载时把不可用的探出来，降到候选列表最后 —— 而不是删掉。
 * 删掉的话，一次网络抖动就可能让某条链一个 RPC 都不剩，
 * 紧急暂停时按不下去，代价远大于多试一个死节点。
 */
const CHAIN = {
  key: 'morph',
  type: 'evm',
  chainId: 2818,
  explorer: 'https://e',
  symbol: 'ETH',
  decimals: 18,
} as Chain

function providerWith(urls: string[]): RpcProvider {
  const provider = new RpcProvider()
  // 不带 Alchemy，避免混入别的来源
  provider.load({ syncedAt: '2026-01-01T00:00:00Z', lark: { morph: urls }, chainlist: {} }, '')
  return provider
}

const probe = (alive: Record<string, boolean>, latency: Record<string, number> = {}) =>
  async () =>
    Object.entries(alive).map(([url, ok]) => ({
      url,
      ok,
      ...(latency[url] === undefined ? {} : { latencyMs: latency[url] }),
    }))

describe('探活结果影响候选顺序', () => {
  it('★ 死的降到最后，但不删 —— 删了可能一个都不剩', async () => {
    const provider = providerWith(['https://a', 'https://b', 'https://c'])
    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': true, 'https://c': true }))

    const urls = provider.urlsFor(CHAIN)
    expect(urls).toHaveLength(3) // 一个都没少
    expect(urls[urls.length - 1]).toBe('https://a') // 死的垫底
  })

  it('活的之间按延迟排 —— 快的先用，少触发 FallbackProvider 的重试', async () => {
    const provider = providerWith(['https://slow', 'https://fast'])
    await provider.probeAll(
      [CHAIN],
      probe({ 'https://slow': true, 'https://fast': true }, { 'https://slow': 900, 'https://fast': 30 }),
    )

    expect(provider.urlsFor(CHAIN)[0]).toBe('https://fast')
  })

  it('★ 一条链全探失败时忽略本次结果 —— 那多半是我们自己出不去网', async () => {
    const provider = providerWith(['https://a', 'https://b'])
    const before = [...provider.urlsFor(CHAIN)]

    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': false }))

    // 顺序原封不动 —— 一个都没被降权
    expect(provider.urlsFor(CHAIN)).toEqual(before)
  })

  it('没探过时保持来源优先级顺序，不乱动', async () => {
    const provider = providerWith(['https://first', 'https://second'])
    expect(provider.urlsFor(CHAIN)).toEqual(['https://first', 'https://second'])
  })

  it('探活函数自己抛错也不能影响服务', async () => {
    const provider = providerWith(['https://a'])
    await expect(
      provider.probeAll([CHAIN], async () => {
        throw new Error('网络炸了')
      }),
    ).resolves.toBeUndefined()
    expect(provider.urlsFor(CHAIN)).toEqual(['https://a'])
  })

  it('★ 没探过的排在活的后面、死的前面 —— 不确定好过已知不可用', async () => {
    const provider = providerWith(['https://dead', 'https://unknown', 'https://alive'])
    // 只探了其中两个，unknown 那个没被探到
    await provider.probeAll([CHAIN], probe({ 'https://dead': false, 'https://alive': true }))

    expect(provider.urlsFor(CHAIN)).toEqual(['https://alive', 'https://unknown', 'https://dead'])
  })

  it('★ 重新 load 之后探活结果作废 —— 换了配置，旧结论不作数', async () => {
    const provider = providerWith(['https://a', 'https://b'])
    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': true }))
    expect(provider.urlsFor(CHAIN)).toEqual(['https://b', 'https://a']) // a 被降权了

    provider.load({ syncedAt: '', lark: { morph: ['https://a', 'https://b'] }, chainlist: {} }, '')

    // 回到来源优先级的原始顺序
    expect(provider.urlsFor(CHAIN)).toEqual(['https://a', 'https://b'])
  })

  it('公开与私有分得清 —— 含密钥的绝不下发前端', () => {
    const provider = new RpcProvider()
    provider.load(
      { syncedAt: '', lark: { morph: ['https://node/?apikey=secret', 'https://plain'] }, chainlist: {} },
      '',
    )

    expect(provider.urlsFor(CHAIN)).toHaveLength(2)
    expect(provider.publicUrlsFor(CHAIN)).toEqual(['https://plain'])
  })
})

describe('★ 原始 URL 绝不外泄', () => {
  it('publicUrlsFor 只给纯净 URL —— 含 apiKey 的那些永远留在后端', () => {
    const provider = new RpcProvider()
    provider.load(
      {
        syncedAt: '',
        lark: {},
        chainlist: { [CHAIN.key]: ['https://plain'] },
      } as never,
      'SECRET_KEY',
    )

    for (const url of provider.publicUrlsFor(CHAIN)) {
      expect(url).not.toContain('SECRET_KEY')
      expect(url).not.toMatch(/\/v2\//) // Alchemy 的 key 在这个路径段后面
    }
  })
})
