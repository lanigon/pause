import { describe, expect, it, vi } from 'vitest'
import {
  byFamily,
  discoverWallets,
  explorerAddressUrl,
  explorerTxUrl,
  FAMILIES,
  familyOf,
  readStates,
  signsIn,
} from '../src/chain'
import type { Chain, Contract } from '../src/types'

/**
 * 接入异构链的准备度。
 *
 * Solana 还没接，但结构得先站得住。加一条链族应该只有两步：
 * 新建 chain/<链族>/ 实现契约，然后在 chain/index.ts 的 FAMILIES 里加一项。
 *
 * 下面锁的都是"漏了不会报错、只会静默做错事"的那几处 —— 最难 review 出来的那种。
 */
const UNKNOWN: Chain = {
  key: 'mockchain',
  type: 'mockchain',
  chainId: 999_999,
  explorer: 'https://example.invalid/',
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

const EVM_CHAIN = { ...UNKNOWN, key: 'morph', type: 'evm', explorer: 'https://explorer.morphl2.io' }
const TRON_CHAIN = { ...UNKNOWN, key: 'tron', type: 'tron', explorer: 'https://tronscan.org/#' }

describe('① 没注册的链族不会被别人的逻辑套住', () => {
  it('★ 读状态时留空，而不是拿 EVM 的 multicall 去打一条异构链', async () => {
    // 真去打的话这里会走 ethers，对着一个 invalid RPC 发请求
    const states = await readStates([UNKNOWN], [CONTRACT])
    expect(states.size).toBe(0)
  })

  it('★ 找钱包返回空列表，不抛错（界面显示"没有检测到钱包"）', async () => {
    await expect(discoverWallets('mockchain')).resolves.toEqual([])
  })

  it('★ 浏览器链接返回 # 而不是瞎猜路径 —— 猜错了点开是 404', () => {
    expect(explorerTxUrl(UNKNOWN, '0xabc')).toBe('#')
    expect(explorerAddressUrl(UNKNOWN, 'addr')).toBe('#')
  })

  it('链不存在时也不崩', () => {
    expect(explorerTxUrl(undefined, '0xabc')).toBe('#')
  })

  it('familyOf 返回 undefined，让调用方自己决定怎么降级', () => {
    expect(familyOf('mockchain')).toBeUndefined()
  })
})

describe('② 链族知识全在 chain/ 里，组件不用知道', () => {
  it('★ 各链族的浏览器路径不一样，由链族自己拼', () => {
    // 拼成 /tx/ 的话 Tron 那边点开是 404
    expect(explorerTxUrl(EVM_CHAIN, '0xabc')).toBe('https://explorer.morphl2.io/tx/0xabc')
    expect(explorerTxUrl(TRON_CHAIN, '0xabc')).toBe('https://tronscan.org/#/transaction/0xabc')
  })

  it('末尾斜杠不会拼出双斜杠', () => {
    const trailing = { ...EVM_CHAIN, explorer: 'https://explorer.morphl2.io/' }
    expect(explorerTxUrl(trailing, '0xabc')).toBe('https://explorer.morphl2.io/tx/0xabc')
  })
})

describe('③ 注册表是唯一的链族清单', () => {
  it('byFamily 覆盖每一族，且各拿到独立初值', () => {
    const table = byFamily<string[]>(() => [])
    for (const entry of FAMILIES) expect(table).toHaveProperty(entry.family)
    expect(Object.keys(table)).toHaveLength(FAMILIES.length)

    // 共享同一个对象的话，往一族里塞东西会串到别族
    const first = FAMILIES[0]!.family
    table[first]!.push('x')
    const second = FAMILIES[1]?.family
    if (second) expect(table[second]).toEqual([])
  })

  it('遍历 FAMILIES 拿到的每一项都能安全取到表里的值（模板就这么用）', () => {
    const table = byFamily<readonly unknown[]>(() => [])
    for (const entry of FAMILIES) {
      expect(() => (table[entry.family] as unknown[]).some(() => true)).not.toThrow()
    }
  })

  it('★ 恰好一个链族能签名登录 —— 多于一个身份就有歧义了', () => {
    expect(FAMILIES.filter((f) => f.signsIn)).toHaveLength(1)
    expect(signsIn('evm')).toBe(true)
    expect(signsIn('tron')).toBe(false)
    expect(signsIn('mockchain')).toBe(false)
  })

  it('每一族都实现了完整契约（漏一个方法运行时才炸）', () => {
    for (const meta of FAMILIES) {
      expect(meta.discover).toBeTypeOf('function')
      expect(meta.readState).toBeTypeOf('function')
      expect(meta.explorerTxUrl).toBeTypeOf('function')
      expect(meta.explorerAddressUrl).toBeTypeOf('function')
    }
  })
})

describe('④ 已注册的链族照常工作', () => {
  it('evm 和 tron 都在', () => {
    expect(FAMILIES.map((f) => f.family).sort()).toEqual(['evm', 'tron'])
  })

  it('evm 走的确实是 EIP-6963 那条路', async () => {
    const spy = vi.spyOn(window, 'dispatchEvent')
    await discoverWallets('evm')
    expect(spy.mock.calls.some(([e]) => e.type === 'eip6963:requestProvider')).toBe(true)
    spy.mockRestore()
  })

  it('★ 单条链读失败不影响其它链', async () => {
    // mockchain 没有 reader，morph 有；结果应该是"两条都留空"而不是抛错
    await expect(readStates([UNKNOWN, EVM_CHAIN], [CONTRACT])).resolves.toBeInstanceOf(Map)
  })
})
