import { describe, expect, it } from 'vitest'
import { fromBase58, toBase58, toHex41 } from '../src/chain/tron/address'

/**
 * Tron 地址的两种形态互转。
 *
 * 这块错了是**静默**的：转出来的还是个合法地址，只是不是原来那个。
 * 拿它去查余额会查到别人头上，显示成"这个 operator 没气了"。
 * 所以用已知的真实地址做基准。
 */
// Tron 主网 USDT，是最容易独立核对的一个已知地址
const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_HEX20 = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'

describe('base58 ↔ hex20', () => {
  it('★ hex20 → base58 对得上已知地址', () => {
    expect(toBase58(USDT_HEX20)).toBe(USDT_BASE58)
  })

  it('★ base58 → hex20 对得上', () => {
    expect(fromBase58(USDT_BASE58)).toBe(USDT_HEX20)
  })

  it('往返不丢信息', () => {
    expect(toBase58(fromBase58(USDT_BASE58)!)).toBe(USDT_BASE58)
  })

  it('不带 0x 前缀也认', () => {
    expect(toBase58(USDT_HEX20.slice(2))).toBe(USDT_BASE58)
  })

  it('大小写不影响结果', () => {
    expect(toBase58(USDT_HEX20.toUpperCase().replace('0X', '0x'))).toBe(USDT_BASE58)
  })

  it('hex41 是 41 加 20 字节', () => {
    expect(toHex41(USDT_HEX20)).toBe(`41${USDT_HEX20.slice(2)}`)
  })
})

describe('★ 非法输入必须返回 undefined，不能返回一个"看起来对"的地址', () => {
  it('校验和不对的 base58', () => {
    // 改最后一个字符 → 校验和不匹配
    expect(fromBase58(USDT_BASE58.slice(0, -1) + 'a')).toBeUndefined()
  })

  it('把 EVM 地址传进来', () => {
    expect(fromBase58('0x1111111111111111111111111111111111111111')).toBeUndefined()
  })

  it('空串', () => {
    expect(fromBase58('')).toBeUndefined()
  })

  it('根本不是 base58 的字符', () => {
    expect(fromBase58('T0OIl' + '1'.repeat(29))).toBeUndefined()
  })
})
