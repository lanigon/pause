import { describe, expect, it } from 'vitest'
import { RpcProvider } from '../src/lib/rpc/rpcProvider.js'
import type { Chain } from '../src/models/chain.model.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

async function providerWith(urls: string[]): Promise<RpcProvider> {
  const dir = await mkdtemp(join(tmpdir(), 'rpc-'))
  await writeFile(
    join(dir, 'rpc.json'),
    JSON.stringify({ syncedAt: '2026-01-01T00:00:00Z', lark: { morph: urls }, chainlist: {} }),
  )
  const provider = new RpcProvider()
  await provider.load(dir, '') // 不带 Alchemy，避免混入别的来源
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
    const provider = await providerWith(['https://a', 'https://b', 'https://c'])
    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': true, 'https://c': true }))

    const urls = provider.urlsFor(CHAIN)
    expect(urls).toHaveLength(3) // 一个都没少
    expect(urls[urls.length - 1]).toBe('https://a') // 死的垫底
  })

  it('活的之间按延迟排 —— 快的先用，少触发 FallbackProvider 的重试', async () => {
    const provider = await providerWith(['https://slow', 'https://fast'])
    await provider.probeAll(
      [CHAIN],
      probe({ 'https://slow': true, 'https://fast': true }, { 'https://slow': 900, 'https://fast': 30 }),
    )

    expect(provider.urlsFor(CHAIN)[0]).toBe('https://fast')
  })

  it('★ 一条链全探失败时忽略本次结果 —— 那多半是我们自己出不去网', async () => {
    const provider = await providerWith(['https://a', 'https://b'])
    const before = [...provider.urlsFor(CHAIN)]

    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': false }))

    // 顺序没变，也没有被标成死的
    expect(provider.urlsFor(CHAIN)).toEqual(before)
    expect(provider.healthOf('https://a')).toBeUndefined()
  })

  it('没探过时保持来源优先级顺序，不乱动', async () => {
    const provider = await providerWith(['https://first', 'https://second'])
    expect(provider.urlsFor(CHAIN)).toEqual(['https://first', 'https://second'])
  })

  it('探活函数自己抛错也不能影响服务', async () => {
    const provider = await providerWith(['https://a'])
    await expect(
      provider.probeAll([CHAIN], async () => {
        throw new Error('网络炸了')
      }),
    ).resolves.toBeUndefined()
    expect(provider.urlsFor(CHAIN)).toEqual(['https://a'])
  })

  it('健康摘要能报出各有几个 —— 运维要看得见哪条链在裸奔', async () => {
    const provider = await providerWith(['https://a', 'https://b', 'https://c'])
    await provider.probeAll([CHAIN], probe({ 'https://a': true, 'https://b': false }))

    expect(provider.healthSummary(CHAIN)).toEqual({ alive: 1, dead: 1, unknown: 1 })
  })

  it('重新 load 之后探活结果作废 —— 换了配置，旧结论不作数', async () => {
    const provider = await providerWith(['https://a', 'https://b'])
    await provider.probeAll([CHAIN], probe({ 'https://a': false, 'https://b': true }))
    expect(provider.healthOf('https://a')?.alive).toBe(false)

    const dir = await mkdtemp(join(tmpdir(), 'rpc2-'))
    await writeFile(join(dir, 'rpc.json'), JSON.stringify({ syncedAt: '', lark: {}, chainlist: {} }))
    await provider.load(dir, '')

    expect(provider.healthOf('https://a')).toBeUndefined()
  })
})

describe('★ 原始 URL 绝不外泄', () => {
  it('健康接口下发的每一项都不带 rawUrl —— 它含 Alchemy apiKey', async () => {
    const { createApp } = await import('../src/app.js')
    const request = (await import('supertest')).default

    const res = await request(createApp()).get('/api/state/rpc')

    const body = JSON.stringify(res.body)
    expect(body).not.toContain('rawUrl')
    // 更直接：整个响应里不能出现 apiKey 形状的长串路径
    for (const chain of res.body?.data?.chains ?? []) {
      for (const rpc of chain.rpcs ?? []) {
        expect(rpc).not.toHaveProperty('rawUrl')
        expect(rpc.url).not.toMatch(/\/v2\//) // Alchemy 的 key 在这个路径段后面
      }
    }
  })
})
