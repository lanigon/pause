import { Contract, Interface, JsonRpcProvider, formatUnits } from 'ethers'
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
  // Multicall3 自带的余额查询，target 指向它自己即可 ——
  // 所以 operator 余额能塞进同一批，不多一次 RPC 往返
  'function getEthBalance(address addr) view returns (uint256 balance)',
]

const iface = new Interface(PAUSABLE_ABI)
const mcIface = new Interface(MULTICALL3_ABI)

/**
 * Multicall3 的规范地址，**每条链都一样** —— 它用确定性部署，
 * 所以在几乎所有 EVM 链上都落在这个地址，不需要按链配置。
 * 没部署的链由运行时发现：调一个没有代码的地址会失败，自动回退到单点调用。
 */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
/**
 * 一次读。两种：读合约的 paused()，或读某个地址的原生币余额。
 *
 * 余额按**地址**去重（同一个 operator 常常管好几个合约），
 * 拿回来再摊回各合约上 —— 读 N 次同一个地址是白费一次调用。
 */
type Call =
  | { kind: 'paused'; id: string; target: string }
  | { kind: 'balance'; address: string }

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

/** 读一条链上这批合约的 paused 与各自 operator 的余额。返回 contractId → 状态 */
export async function readEvm(
  chain: Chain,
  contracts: readonly ContractDef[],
): Promise<Map<string, ContractState>> {
  const provider = new JsonRpcProvider(chain.rpcs[0], chain.chainId, { staticNetwork: true })

  const paused: Call[] = contracts.map((contract) => ({
    kind: 'paused',
    id: contract.id,
    target: contract.address,
  }))

  // operator 去重：同一个地址管三个合约时只读一次
  const addresses = [...new Set(contracts.map((c) => c.operator).filter((a): a is string => !!a))]
  const balances: Call[] = addresses.map((address) => ({ kind: 'balance', address }))

  const calls = [...paused, ...balances]
  let results: Map<string, ContractState>
  let balanceByAddress: Map<string, bigint>

  try {
    ;[results, balanceByAddress] = await readViaMulticall(provider, calls)
  } catch {
    // 这条链没部署 Multicall3，或者节点不支持 —— 退回并发单点调用，别整条链读不到
    ;[results, balanceByAddress] = await readOneByOne(provider, calls)
  }

  return attachBalances(results, contracts, balanceByAddress, chain)
}

/**
 * 把按地址读回来的余额摊回各合约。
 *
 * 读不到就**不写这个字段**，界面显示"—"。写成 0 的话运维会以为那个地址
 * 没气了，跑去充值一个其实好好的地址；更糟的是反过来 —— 真没气时
 * 和"读不到"长得一样，就没人当回事了。
 */
function attachBalances(
  states: Map<string, ContractState>,
  contracts: readonly ContractDef[],
  balances: Map<string, bigint>,
  chain: Chain,
): Map<string, ContractState> {
  for (const contract of contracts) {
    if (!contract.operator) continue
    const wei = balances.get(contract.operator.toLowerCase())
    if (wei === undefined) continue
    states.set(contract.id, {
      ...states.get(contract.id),
      operatorBalance: formatUnits(wei, chain.decimals),
    })
  }
  return states
}

/** 收集结果。解码失败或形状不对就当没读到 —— 状态未知比状态错了安全 */
function collect(states: Map<string, ContractState>, id: string, data: string): void {
  if (!isBoolWord(data)) return
  try {
    states.set(id, { ...(states.get(id) ?? {}), paused: decode('paused', data) === true })
  } catch {
    /* 解码失败就当读不到 */
  }
}

/** 把一次 Call 编码成 multicall 的一项 */
const encodeCall = (call: Call): { target: string; allowFailure: boolean; callData: string } =>
  call.kind === 'paused'
    ? { target: call.target, allowFailure: true, callData: iface.encodeFunctionData('paused') }
    : {
        // 余额查询打给 Multicall3 自己
        target: MULTICALL3,
        allowFailure: true,
        callData: mcIface.encodeFunctionData('getEthBalance', [call.address]),
      }

/** 把一条返回值归位：paused 进状态表，余额进地址表 */
function absorb(
  call: Call,
  data: string,
  states: Map<string, ContractState>,
  balances: Map<string, bigint>,
): void {
  if (call.kind === 'paused') {
    collect(states, call.id, data)
    return
  }
  try {
    const [wei] = mcIface.decodeFunctionResult('getEthBalance', data)
    balances.set(call.address.toLowerCase(), wei as bigint)
  } catch {
    /* 读不到就不写，界面显示 — */
  }
}

async function readViaMulticall(
  provider: JsonRpcProvider,
  calls: readonly Call[],
): Promise<[Map<string, ContractState>, Map<string, bigint>]> {
  const states = new Map<string, ContractState>()
  const balances = new Map<string, bigint>()
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider)

  const raw = (await multicall.aggregate3!.staticCall(calls.map(encodeCall))) as [boolean, string][]

  calls.forEach((call, index) => {
    const entry = raw[index]
    // 单个调用 revert 不能拖垮整批（allowFailure），失败的跳过
    if (entry?.[0]) absorb(call, entry[1], states, balances)
  })
  return [states, balances]
}

async function readOneByOne(
  provider: JsonRpcProvider,
  calls: readonly Call[],
): Promise<[Map<string, ContractState>, Map<string, bigint>]> {
  const states = new Map<string, ContractState>()
  const balances = new Map<string, bigint>()

  await Promise.all(
    calls.map(async (call) => {
      try {
        // 没有 Multicall3 的链上余额只能直接问节点，不能走 getEthBalance
        if (call.kind === 'balance') {
          balances.set(call.address.toLowerCase(), await provider.getBalance(call.address))
          return
        }
        const encoded = encodeCall(call)
        collect(states, call.id, await provider.call({ to: encoded.target, data: encoded.callData }))
      } catch {
        /* 忽略单点失败 */
      }
    }),
  )
  return [states, balances]
}
