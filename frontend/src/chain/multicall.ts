import { Contract, Interface, JsonRpcProvider } from 'ethers'
import type { Chain, Contract as ContractDef, ContractState } from '../types'

/**
 * 前端读链上状态。
 *
 * EVM 走 Multicall3：一条链上所有合约的 paused()/owner() 一次 RPC 读完，
 * 不占后端配额，切业务线时刷新很快。
 * Tron 没有 Multicall3，用受限并发替代（TronGrid 有 QPS 限制）。
 */
const PAUSABLE_ABI = [
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
]

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
]

const iface = new Interface(PAUSABLE_ABI)

/**
 * Multicall3 的规范地址，**每条链都一样** —— 它用确定性部署，
 * 所以在几乎所有 EVM 链上都落在这个地址，不需要按链配置。
 * 没部署的链由运行时发现：调一个没有代码的地址会失败，自动回退到单点调用。
 */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const TRON_CONCURRENCY = 5

/** 一次读：某个合约的某个字段 */
type Call = { id: string; key: 'paused' | 'owner'; target: string }

const decode = (key: 'paused' | 'owner', data: string): unknown =>
  iface.decodeFunctionResult(key, data)[0]

/** 按链分组并行读。返回 contractId → 状态 */
export async function readStates(
  chains: Chain[],
  contracts: ContractDef[],
): Promise<Map<string, ContractState>> {
  const byChain = new Map<string, ContractDef[]>()
  for (const contract of contracts) {
    const bucket = byChain.get(contract.chain)
    if (bucket) bucket.push(contract)
    else byChain.set(contract.chain, [contract])
  }

  const chainByKey = new Map(chains.map((c) => [c.key, c]))
  const results = await Promise.all(
    [...byChain.entries()].map(async ([chainKey, group]) => {
      const chain = chainByKey.get(chainKey)
      if (!chain) return new Map<string, ContractState>()
      try {
        return chain.type === 'tron' ? await readTron(chain, group) : await readEvm(chain, group)
      } catch {
        // 单条链读失败不影响其它链，该链的合约状态留空（显示 Unknown）
        return new Map<string, ContractState>()
      }
    }),
  )

  const merged = new Map<string, ContractState>()
  for (const map of results) for (const [id, state] of map) merged.set(id, state)
  return merged
}

async function readEvm(chain: Chain, contracts: ContractDef[]): Promise<Map<string, ContractState>> {
  const provider = new JsonRpcProvider(chain.rpcs[0], chain.chainId, { staticNetwork: true })

  const calls = contracts.flatMap((contract) => [
    { id: contract.id, key: 'paused' as const, target: contract.address },
    { id: contract.id, key: 'owner' as const, target: contract.address },
  ])

  try {
    return await readViaMulticall(provider, calls)
  } catch {
    // 这条链没部署 Multicall3，或者节点不支持 —— 退回并发单点调用，别整条链读不到
    return readOneByOne(provider, calls)
  }
}

/** 收集结果：一个合约的两个字段合到同一条状态上 */
function collect(states: Map<string, ContractState>, call: Call, data: string): void {
  try {
    states.set(call.id, { ...(states.get(call.id) ?? {}), [call.key]: decode(call.key, data) })
  } catch {
    /* 解码失败就当读不到 */
  }
}

async function readViaMulticall(
  provider: JsonRpcProvider,
  calls: Call[],
): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>()
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider)

  const raw = (await multicall.aggregate3!.staticCall(
    calls.map((call) => ({
      target: call.target,
      allowFailure: true, // 单个合约 revert 不能拖垮整批
      callData: iface.encodeFunctionData(call.key),
    })),
  )) as [boolean, string][]

  calls.forEach((call, index) => {
    const entry = raw[index]
    if (entry?.[0]) collect(states, call, entry[1])
  })
  return states
}

async function readOneByOne(
  provider: JsonRpcProvider,
  calls: Call[],
): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>()
  await Promise.all(
    calls.map(async (call) => {
      try {
        const data = await provider.call({
          to: call.target,
          data: iface.encodeFunctionData(call.key),
        })
        collect(states, call, data)
      } catch {
        /* 忽略单点失败 */
      }
    }),
  )
  return states
}

async function readTron(chain: Chain, contracts: ContractDef[]): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>()
  const endpoint = `${chain.rpcs[0]?.replace(/\/$/, '')}/wallet/triggerconstantcontract`

  // 限流：TronGrid 有 QPS 限制
  for (let i = 0; i < contracts.length; i += TRON_CONCURRENCY) {
    await Promise.all(
      contracts.slice(i, i + TRON_CONCURRENCY).map(async (contract) => {
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner_address: contract.address,
              contract_address: contract.address,
              function_selector: 'paused()',
              visible: true,
            }),
          })
          const body = (await res.json()) as { constant_result?: string[] }
          const hex = body.constant_result?.[0]
          if (hex !== undefined) states.set(contract.id, { paused: /1$/.test(hex) })
        } catch {
          /* 忽略单个合约失败 */
        }
      }),
    )
  }
  return states
}
