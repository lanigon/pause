import { Contract, Interface, JsonRpcProvider } from 'ethers'
import { PAUSABLE_ABI, isBoolWord } from '../abi'
import type { Chain, Contract as ContractDef, ContractState } from '../../types'

/**
 * 读 EVM 链上的合约状态。
 *
 * 走 Multicall3：一条链上所有合约一次 RPC 读完。
 * 这条链上没有部署的话（调一个没有代码的地址会失败），回退到并发单点调用。
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

/** 按链分组并行读。返回 contractId → 状态 */
export async function readEvm(chain: Chain, contracts: readonly ContractDef[]): Promise<Map<string, ContractState>> {
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

