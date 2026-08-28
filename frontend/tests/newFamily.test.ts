import { describe, expect, it, vi } from 'vitest'
import { byFamily, discoverWallets, FAMILIES, signsIn } from '../src/chain/wallet'
import { readStates } from '../src/chain/multicall'
import type { Chain, Contract } from '../src/types'

/**
 * 接入异构链的准备度。
 *
 * Solana 还没接，但代码得先站得住。这组测试锁的是三条 ——
 * 都是"漏了不会报错、只会静默做错事"的那种，最难在 review 里看出来：
 *
 *   ① 没注册的链族不能被 EVM 的读取逻辑套住（拿 multicall 去打 Solana）
 *   ② 没注册的链族不能让钱包栏崩（模板里 found[家族].some 对 undefined 会抛）
 *   ③ 链族清单只有一处，各处的初始状态都从它生成
 */
const UNKNOWN: Chain = {
  key: 'mockchain',
  type: 'mockchain',
  chainId: 999_999,
  explorer: 'https://example.invalid',
  symbol: 'MOCK',
  decimals: 9,
  rpcs: ['https://rpc.invalid'],
}

const CONTRACT: Contract = {
  id: 'c1',
  name: 'Mock 合约',
  businessLine: 'pay',
  chain: 'mockchain',
  address: 'MoCkAddr1111111111111111111111111111111111',
}

describe('① 没注册的链族不会被别的链族的逻辑套住', () => {
  it('★ 读状态时返回空，而不是拿 EVM 的 multicall 去打它', async () => {
    // 真去打的话这里会走 ethers，对着一个 invalid RPC 发请求
    const states = await readStates([UNKNOWN], [CONTRACT])

    expect(states.get('c1')?.paused).toBeUndefined()
    // 状态未知 → 界面显示 Unknown → 快捷勾选不会勾它，不会被误操作
    expect([...states.values()].every((s) => s.paused === undefined)).toBe(true)
  })

  it('★ 找钱包时返回空列表，不抛错', async () => {
    await expect(discoverWallets('mockchain')).resolves.toEqual([])
  })
})

describe('② 按链族建表时不会漏掉谁', () => {
  it('byFamily 覆盖 FAMILIES 里的每一族', () => {
    const table = byFamily<string | null>(() => null)
    for (const entry of FAMILIES) expect(table).toHaveProperty(entry.family)
    expect(Object.keys(table)).toHaveLength(FAMILIES.length)
  })

  it('★ 每一族拿到的是各自独立的初值，不是共享同一个对象', () => {
    // 共享的话，往一个族里塞东西会串到别的族
    const table = byFamily<string[]>(() => [])
    const first = FAMILIES[0]!.family
    const second = FAMILIES[1]?.family
    table[first]!.push('x')
    if (second) expect(table[second]).toEqual([])
  })

  it('遍历 FAMILIES 拿到的每一项都能安全取到表里的值（模板就是这么用的）', () => {
    const table = byFamily<readonly unknown[]>(() => [])
    // WalletBar 模板里是 found[entry.family].some(...)，取到 undefined 就崩
    for (const entry of FAMILIES) {
      expect(() => (table[entry.family] as unknown[]).some(() => true)).not.toThrow()
    }
  })
})

describe('③ 登录资格由清单决定，不是硬编码', () => {
  it('只有标了 signsIn 的链族参与签名登录', () => {
    expect(signsIn('evm')).toBe(true)
    expect(signsIn('tron')).toBe(false)
    expect(signsIn('mockchain')).toBe(false)
  })

  it('★ 清单里恰好有一个能登录的链族 —— 多于一个的话身份就有歧义了', () => {
    expect(FAMILIES.filter((f) => f.signsIn)).toHaveLength(1)
  })
})

describe('已注册的链族照常工作（别把上面那些改成"全都返回空"）', () => {
  it('evm 和 tron 都在清单里', () => {
    expect(FAMILIES.map((f) => f.family).sort()).toEqual(['evm', 'tron'])
  })

  it('evm 会真的去找钱包（没装就是空，但走的是 EVM 那条路）', async () => {
    const spy = vi.spyOn(window, 'dispatchEvent')
    await discoverWallets('evm')
    // EIP-6963 的探测事件发出去了，说明确实走了 EVM 的发现逻辑
    expect(spy.mock.calls.some(([e]) => e.type === 'eip6963:requestProvider')).toBe(true)
    spy.mockRestore()
  })
})
