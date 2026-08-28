import { describe, expect, it } from 'vitest'
import { multiplierAt, policyFor, scaleFee } from '../src/lib/web3/evm/tx.js'
import { decodeCall, redactRpcUrl } from '../src/lib/web3/evm/client.js'
import { meta, tx, assertRegistered, supportedFamilies } from '../src/lib/web3/chains.js'
import type { Chain } from '../src/models/chain.model.js'

const chain = (chainId: number): Chain =>
  ({ key: 'x', name: 'X', type: 'evm', chainId, explorer: 'https://e.io/', confirmations: 1, symbol: 'E', decimals: 18, multicall3: null }) as Chain

/**
 * gas 阶梯重发策略。
 * 运维操作卡在内存池 = 没执行，所以首发就给高倍数，超时再翻倍。
 */
describe('gas 策略', () => {
  it('★ 以太坊主网首发 8 倍，其它链 2 倍（主网出块慢、竞争激烈）', () => {
    expect(policyFor(chain(1)).initialMultiplier).toBe(8)
    expect(policyFor(chain(2818)).initialMultiplier).toBe(2)
    expect(policyFor(chain(137)).initialMultiplier).toBe(2)
  })

  it('主网等回执时间更长（30s vs 10s）', () => {
    expect(policyFor(chain(1)).receiptTimeoutMs).toBe(30_000)
    expect(policyFor(chain(2818)).receiptTimeoutMs).toBe(10_000)
  })

  it('★ 每次重发翻倍：主网 8→16→32→64，其它 2→4→8→16', () => {
    const mainnet = policyFor(chain(1))
    expect([0, 1, 2, 3].map((n) => multiplierAt(mainnet, n))).toEqual([8, 16, 32, 64])

    const l2 = policyFor(chain(2818))
    expect([0, 1, 2, 3].map((n) => multiplierAt(l2, n))).toEqual([2, 4, 8, 16])
  })

  it('有重试上限，不会无限翻倍烧光余额', () => {
    expect(policyFor(chain(1)).maxAttempts).toBeLessThanOrEqual(5)
    expect(policyFor(chain(2818)).maxAttempts).toBeLessThanOrEqual(5)
  })

  it('★ 放大 fee 用整数运算，不引入浮点误差', () => {
    expect(scaleFee(1000n, 2)).toBe(2000n)
    expect(scaleFee(1000n, 8)).toBe(8000n)
    // 1.5 倍也要精确
    expect(scaleFee(1000n, 1.5)).toBe(1500n)
    // 大数不丢精度
    expect(scaleFee(123456789012345678n, 2)).toBe(246913578024691356n)
  })
})

/**
 * bool 严格解码。
 * 这里挡的是一个真实事故：合约地址误配成预编译地址（0x…0002），
 * 它对任意 calldata 都返回哈希，ethers 会把非零值解成 true，
 * 于是"合约已暂停"，紧急暂停被静默跳过。
 */
describe('★ bool 严格解码', () => {
  const TRUE = `0x${'0'.repeat(63)}1`
  const FALSE = `0x${'0'.repeat(64)}`

  it('正常的 0 / 1 能解出来', () => {
    expect(decodeCall('paused', TRUE)).toBe(true)
    expect(decodeCall('paused', FALSE)).toBe(false)
  })

  it('★ 返回值不是 0 或 1 就抛错，不当成 true', () => {
    // 预编译合约（如 sha256）会返回一个哈希，长度对但值不是 0/1
    const hash = '0x' + 'ab'.repeat(32)
    expect(() => decodeCall('paused', hash)).toThrow(/不是预期的合约/)
  })

  it('长度不对也抛错', () => {
    expect(() => decodeCall('paused', '0x01')).toThrow()
  })

  it('非 bool 返回值不受这条限制（address 该怎样还怎样）', () => {
    const addr = `0x${'0'.repeat(24)}${'11'.repeat(20)}`
    expect(decodeCall('owner', addr)).toBe('0x1111111111111111111111111111111111111111')
  })
})

describe('RPC URL 脱敏', () => {
  it('只暴露 host，不泄露路径里的 key', () => {
    expect(redactRpcUrl('https://eth.g.alchemy.com/v2/SECRETKEY')).toBe('https://eth.g.alchemy.com')
  })
  it('query 里的 key 也不会漏', () => {
    expect(redactRpcUrl('https://node.io/rpc?apikey=SECRET')).toBe('https://node.io')
  })
  it('非法 URL 不抛错', () => {
    expect(redactRpcUrl('not a url')).toBe('[invalid-url]')
  })
})

describe('链族注册表', () => {
  it('evm 与 tron 都已注册', () => {
    expect([...supportedFamilies()].sort()).toEqual(['evm', 'tron'])
  })

  it('★ 未注册的链族在启动校验时就报错', () => {
    expect(() => assertRegistered(['evm', 'solana'])).toThrow(/未注册的链族: solana/)
    expect(() => assertRegistered(['evm', 'tron'])).not.toThrow()
  })

  it('取未注册链族的 adapter 抛错，不返回 undefined', () => {
    expect(() => meta('solana')).toThrow(/未注册的链族/)
    expect(() => tx('solana')).toThrow(/未注册的链族/)
  })

  it('两个链族都实现了 meta 与 tx 的全部方法（结构对齐）', () => {
    for (const family of supportedFamilies()) {
      const m = meta(family)
      expect(m.isValidAddress).toBeTypeOf('function')
      expect(m.normalizeAddress).toBeTypeOf('function')
      expect(m.displayAddress).toBeTypeOf('function')
      expect(m.explorerTxUrl).toBeTypeOf('function')

      const t = tx(family)
      for (const method of ['readBatch', 'simulate', 'getTransaction', 'executeBatch', 'checkHealth', 'reset']) {
        expect(t[method as keyof typeof t]).toBeTypeOf('function')
      }
    }
  })
})

describe('地址处理', () => {
  const EVM = '0x1111111111111111111111111111111111111111'
  const TRON = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ'

  it('EVM 归一化为 checksum', () => {
    expect(meta('evm').normalizeAddress(EVM.toLowerCase())).toBe(
      meta('evm').normalizeAddress(EVM.toUpperCase().replace('0X', '0x')),
    )
  })

  it('★ Tron 比较用 hex41，展示用 base58 —— 两者不同', () => {
    const compare = meta('tron').normalizeAddress(TRON)
    const display = meta('tron').displayAddress(TRON)
    expect(compare).toMatch(/^41[0-9a-f]{40}$/)
    expect(display).toBe(TRON)
    expect(compare).not.toBe(display)
  })

  it('★ 两个链族互不认对方的地址', () => {
    expect(meta('evm').isValidAddress(TRON)).toBe(false)
    expect(meta('tron').isValidAddress(EVM)).toBe(false)
  })

  it('explorer 链接不会出现双斜杠', () => {
    const c = { ...chain(1), explorer: 'https://etherscan.io/' }
    expect(meta('evm').explorerTxUrl(c, '0xabc')).toBe('https://etherscan.io/tx/0xabc')
    expect(meta('tron').explorerTxUrl(c, '0xabc')).toBe('https://etherscan.io/transaction/0xabc')
  })
})

describe('★ 回归：一条链没有可用 RPC 时不能拖垮健康检查', () => {
  it('checkHealth 是 async，同步抛错也能被 .catch 接住', async () => {
    // 非 async 的话，urlsFor 的同步抛错会在 Promise 创建前逃出去，
    // 调用方的 .catch() 接不到 —— 一条链没 RPC 就能让整个健康接口 500
    const noRpc = { ...chain(999_999), key: 'ghost' } as Chain
    await expect(tx('evm').checkHealth(noRpc)).rejects.toThrow(/没有可用的 RPC/)
  })
})
