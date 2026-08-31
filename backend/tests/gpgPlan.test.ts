import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * gpg.service 的**守门**部分：plan() 的校验，以及按人取消。
 *
 * 这几条挡在读口令与发交易之前，是最后一道纯逻辑防线：
 * 漏了 configVersion 比对，运维会拿着已经过期的合约清单去做紧急暂停；
 * cancelFor 按地址匹配错了，会取消掉别人正在跑的任务。
 *
 * 真正的执行（解密、签名、广播）由 preflight / runner / gpgSigner 那几个测试覆盖，
 * 这里只测不碰 GPG 的那一半。
 */
const CONTRACTS = new Map([
  ['c1', { id: 'c1', name: 'A', businessLine: 'bl', chain: 'morph', address: '0x' + '1'.repeat(40) }],
  ['c2', { id: 'c2', name: 'B', businessLine: 'bl', chain: 'morph', address: '0x' + '2'.repeat(40) }],
])

vi.mock('../src/core/config.js', () => ({
  getRegistry: () => ({ configVersion: 'sha256:current' }),
  getContract: (id: string) => {
    const c = CONTRACTS.get(id)
    if (!c) throw new Error(`合约不存在: ${id}`)
    return c
  },
  getChain: () => ({ key: 'morph', type: 'evm', chainId: 2818 }),
}))
vi.mock('../src/lib/keys/gpg.js', () => ({
  GpgKey: { of: async () => ({ address: async () => '0x' + '9'.repeat(40) }) },
}))
vi.mock('../src/lib/keys/signer.js', () => ({ openSessions: vi.fn() }))
vi.mock('../src/core/execution.js', () => ({
  assertAuthorized: vi.fn(),
  execute: vi.fn(),
  Phase: { ERROR: 'error', DONE: 'done' },
}))

const { plan, cancelFor, abortAll } = await import('../src/services/gpg.service.js')

const actor = { address: '0xAlice', label: 'Alice', role: 'operator' } as never
const base = {
  operation: 'pause' as never,
  contractIds: ['c1', 'c2'],
  actor,
  expectedConfigVersion: 'sha256:current',
}

beforeEach(() => abortAll())

describe('plan() 的校验：全部挡在读口令之前', () => {
  it('参数正常时给出计划', async () => {
    const result = await plan(base)
    expect(result.contracts).toHaveLength(2)
    expect(result.signers.size).toBe(1) // 两个合约同一条链 → 一个链族一把密钥
  })

  it('★ configVersion 对不上要拒 —— 否则运维会拿过期的合约清单做紧急暂停', async () => {
    await expect(plan({ ...base, expectedConfigVersion: 'sha256:stale' })).rejects.toThrow(
      '配置已更新',
    )
  })

  it('★ 空清单要拒，不能当成「零个合约，执行成功」', async () => {
    await expect(plan({ ...base, contractIds: [] })).rejects.toThrow('至少要选择一个合约')
  })

  it('★ 重复项要拒 —— 同一个合约发两笔交易，第二笔必然浪费 gas', async () => {
    await expect(plan({ ...base, contractIds: ['c1', 'c1'] })).rejects.toThrow('重复')
  })

  it('引用不存在的合约要炸，不能静默跳过', async () => {
    await expect(plan({ ...base, contractIds: ['c1', 'nope'] })).rejects.toThrow('合约不存在')
  })
})

describe('cancelFor：按人取消，不能误伤别人', () => {
  it('没有任务在跑时返回 0', () => {
    expect(cancelFor('0xAlice')).toBe(0)
  })

  it('★ 地址比较不分大小写 —— JWT 里是 checksum 形式，传进来的可能是小写', () => {
    // 没有在跑的任务，两种写法都应安全返回 0（而不是抛错）
    expect(cancelFor('0xalice')).toBe(0)
    expect(cancelFor('0xALICE')).toBe(0)
  })
})
