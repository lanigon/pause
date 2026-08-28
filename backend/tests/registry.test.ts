import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRegistry, getChain, getContract, findOperator, contractsOf, dto } from '../src/services/registry.service.js'
import { rpcProvider } from '../src/lib/rpc/rpcProvider.js'

/**
 * 配置加载与跨文件校验。
 *
 * 这一层的价值是**让配置错误在启动时就炸**，而不是等到有人点了暂停才发现。
 * 每个 it 都对应一种真实会犯的错。
 */
const EVM_ADDR = '0x1111111111111111111111111111111111111111'
const EVM_ADDR2 = '0x2222222222222222222222222222222222222222'
const TRON_ADDR = 'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ'

let dir: string

const base = {
  chains: {
    chains: [
      { key: 'morph', name: 'Morph', type: 'evm', chainId: 2818, explorer: 'https://e.io', confirmations: 2, symbol: 'ETH', decimals: 18, multicall3: null },
      { key: 'tron', name: 'Tron', type: 'tron', chainId: 728126428, explorer: 'https://t.io', confirmations: 19, symbol: 'TRX', decimals: 6, multicall3: null },
    ],
  },
  contracts: {
    businessLines: [{ id: 'payment', name: '支付' }],
    contracts: [{ id: 'vault', name: 'Vault', businessLine: 'payment', chain: 'morph', address: EVM_ADDR }],
  },
  operators: [{ address: EVM_ADDR2, label: 'Alice', role: 'admin', enabled: true }],
}

async function write(over: Partial<typeof base> = {}) {
  const merged = { ...base, ...over }
  await writeFile(join(dir, 'chains.json'), JSON.stringify(merged.chains), 'utf8')
  await writeFile(join(dir, 'contracts.json'), JSON.stringify(merged.contracts), 'utf8')
  await writeFile(join(dir, 'operators.json'), JSON.stringify(merged.operators), 'utf8')
  await writeFile(join(dir, 'rpc.json'), JSON.stringify({ syncedAt: '', lark: {}, chainlist: { morph: ['https://m'], tron: ['https://t'] } }), 'utf8')
  // rpc.json 写完才加载，否则 provider 读到的是空的
  await rpcProvider.load(dir, '')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cfg-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('正常加载', () => {
  it('装载后能按 id 查到东西', async () => {
    await write()
    await loadRegistry(dir)

    expect(getChain('morph').chainId).toBe(2818)
    expect(getContract('vault').name).toBe('Vault')
    expect(findOperator(EVM_ADDR2)?.label).toBe('Alice')
    expect(contractsOf('payment')).toHaveLength(1)
  })

  it('查不存在的东西抛 NOT_FOUND，不返回 undefined 让上层裸奔', async () => {
    await write()
    await loadRegistry(dir)
    expect(() => getChain('nope')).toThrow(/链不存在/)
    expect(() => getContract('nope')).toThrow(/合约不存在/)
  })

  it('configVersion 随内容变化', async () => {
    await write()
    const a = await loadRegistry(dir)
    await write({ contracts: { ...base.contracts, contracts: [{ ...base.contracts.contracts[0]!, name: '改了名' }] } })
    const b = await loadRegistry(dir)
    expect(b.configVersion).not.toBe(a.configVersion)
  })
})

describe('★ 跨文件引用校验', () => {
  it('合约指向不存在的链 → 启动失败', async () => {
    await write({ contracts: { ...base.contracts, contracts: [{ ...base.contracts.contracts[0]!, chain: 'ghost' }] } })
    await expect(loadRegistry(dir)).rejects.toThrow(/不存在的链/)
  })

  it('合约指向不存在的业务线 → 启动失败', async () => {
    await write({ contracts: { ...base.contracts, contracts: [{ ...base.contracts.contracts[0]!, businessLine: 'ghost' }] } })
    await expect(loadRegistry(dir)).rejects.toThrow(/不存在的业务线/)
  })

  it('★ Tron 地址配到 EVM 链上 → 启动失败（最常见的手滑）', async () => {
    await write({ contracts: { ...base.contracts, contracts: [{ ...base.contracts.contracts[0]!, address: TRON_ADDR }] } })
    await expect(loadRegistry(dir)).rejects.toThrow(/不符合 evm 链的格式/)
  })

  it('EVM 地址配到 Tron 链上 → 启动失败', async () => {
    await write({
      contracts: {
        ...base.contracts,
        contracts: [{ id: 'x', name: 'X', businessLine: 'payment', chain: 'tron', address: EVM_ADDR }],
      },
    })
    await expect(loadRegistry(dir)).rejects.toThrow(/不符合 tron 链的格式/)
  })

  it('合约 id 重复 → 启动失败', async () => {
    await write({
      contracts: {
        ...base.contracts,
        contracts: [base.contracts.contracts[0]!, { ...base.contracts.contracts[0]! }],
      },
    })
    await expect(loadRegistry(dir)).rejects.toThrow(/id 重复/)
  })

  it('★ 未注册的链族 → 启动失败（而不是运行时才发现没 adapter）', async () => {
    await write({
      chains: { chains: [{ ...base.chains.chains[0]!, type: 'solana' }] },
    })
    await expect(loadRegistry(dir)).rejects.toThrow(/未注册的链族/)
  })

  it('一次报出所有问题，不是修一个报一个', async () => {
    await write({
      contracts: {
        businessLines: [{ id: 'payment', name: '支付' }],
        contracts: [
          { id: 'a', name: 'A', businessLine: 'ghost', chain: 'ghost2', address: EVM_ADDR },
        ],
      },
    })
    await expect(loadRegistry(dir)).rejects.toThrow(/配置校验失败（2 项）/)
  })
})

describe('下发前端的 DTO', () => {
  it('只包含合约实际涉及的链', async () => {
    await write() // 只有 morph 上有合约，tron 没有
    await loadRegistry(dir)
    expect(dto().chains.map((c) => c.key)).toEqual(['morph'])
  })

  it('RPC 由后端填，前端不用配', async () => {
    await write()
    await loadRegistry(dir)
    expect(dto().chains[0]?.rpcs).toEqual(['https://m'])
  })

  it('不下发 operators 名单', async () => {
    await write()
    await loadRegistry(dir)
    expect(Object.keys(dto())).not.toContain('operators')
  })

  it('同一份 DTO 被缓存复用（前端频繁拉时零计算）', async () => {
    await write()
    await loadRegistry(dir)
    expect(dto()).toBe(dto())
  })

  it('重新加载后缓存作废', async () => {
    await write()
    await loadRegistry(dir)
    const first = dto()
    await loadRegistry(dir)
    expect(dto()).not.toBe(first)
  })
})
