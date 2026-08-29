import { Contract, Interface, JsonRpcProvider } from 'ethers'
import { PAUSABLE_ABI } from './abi'
import type { Chain, Contract as ContractDef, ContractState } from '../types'

/**
 * 前端读链上状态。
 *
 * EVM 走 Multicall3：一条链上所有合约的 paused() 一次 RPC 读完，
 * 不占后端配额，切业务线时刷新很快。
 * Tron 没有 Multicall3，用受限并发替代（TronGrid 有 QPS 限制）。
 */
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
type Call = { id: string; key: 'paused'; target: string }

const decode = (key: 'paused', data: string): unknown =>
  iface.decodeFunctionResult(key, data)[0]

/**
 * bool 返回值必须是 32 字节的 0 或 1。
 *
 * 解码器会把**任何非零值**当成 true，但一个真正的 Pausable 合约只会返回 0 或 1。
 * 返回别的东西说明这个地址根本不是我们以为的合约 —— 比如误配成了预编译地址
 * 0x…0002，它对任意 calldata 都返回一个哈希，尾字节是 1 就会被读成「已暂停」。
 *
 * 紧急暂停时把「地址配错了」显示成「已暂停」是最坏的一种错：
 * 运维会直接跳过这个合约。读不到（显示未知）远好过读错。
 *
 * 后端 lib/web3/evm/client.ts 的 decodeCall 与 tron/client.ts 的 decodeConstant
 * 用的是同一条判定，三处必须一致。
 */
const isBoolWord = (data: string): boolean => /^0{63}[01]$/.test(data.replace(/^0x/, ''))

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
        // 没注册的链族返回空 —— 状态显示 Unknown，绝不拿 EVM 的逻辑去套一条异构链
        return (await READERS[chain.type]?.(chain, group)) ?? new Map<string, ContractState>()
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

/**
 * 链族 → 怎么读它的合约状态。**加一条异构链就在这里加一行**。
 */
const READERS: Record<string, (chain: Chain, contracts: ContractDef[]) => Promise<Map<string, ContractState>>> = {
  evm: (chain, contracts) => readEvm(chain, contracts),
  tron: (chain, contracts) => readTron(chain, contracts),
}

async function readEvm(chain: Chain, contracts: ContractDef[]): Promise<Map<string, ContractState>> {
  const provider = new JsonRpcProvider(chain.rpcs[0], chain.chainId, { staticNetwork: true })

  const calls = contracts.map((contract) => ({
    id: contract.id,
    key: 'paused' as const,
    target: contract.address,
  }))

  try {
    return await readViaMulticall(provider, calls)
  } catch {
    // 这条链没部署 Multicall3，或者节点不支持 —— 退回并发单点调用，别整条链读不到
    return readOneByOne(provider, calls)
  }
}

/** 收集结果。解码失败或形状不对就当没读到 —— 状态未知比状态错了安全 */
function collect(states: Map<string, ContractState>, call: Call, data: string): void {
  if (!isBoolWord(data)) return
  try {
    states.set(call.id, { ...(states.get(call.id) ?? {}), paused: decode(call.key, data) === true })
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

  // 没有 RPC 就直接返回：不加这道，下面会 fetch 到 "undefined/wallet/…"，
  // 变成对本站的一次 404，每个合约都白跑一趟
  const base = chain.rpcs[0]
  if (!base) return states
  const endpoint = `${base.replace(/\/$/, '')}/wallet/triggerconstantcontract`

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
          // 原来是 /1$/ —— 任何以 1 结尾的返回都会被当成「已暂停」，太松
          if (hex !== undefined && isBoolWord(hex)) {
            states.set(contract.id, { paused: hex.replace(/^0x/, '').endsWith('1') })
          }
        } catch {
          /* 忽略单个合约失败 */
        }
      }),
    )
  }
  return states
}
