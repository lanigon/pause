import { Contract, Interface, JsonRpcProvider, formatUnits } from 'ethers'
import { OPERATORS_ABI, OPERATOR_PAGE, PAUSABLE_ABI, isBoolWord } from '../abi'
import type { Chain, Contract as ContractDef, ContractState, OperatorInfo } from '../../types'

/**
 * 读 EVM 链上的合约状态、operator 名单与余额。
 *
 * 走 Multicall3：一条链上所有合约一次 RPC 读完。
 * 这条链上没有部署的话（调一个没有代码的地址会失败），回退到并发单点调用。
 *
 * **分两轮**，因为第二轮的入参来自第一轮的结果：
 *   第一轮  paused · getOperators · isOperator(viewer)
 *   第二轮  第一轮读回来的每个 operator 地址的原生币余额
 * 两轮各自还是一次 multicall，所以一条链最多两次 RPC 往返。
 */

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
  // Multicall3 自带的余额查询，target 指向它自己即可 —— 余额能塞进同一批
  'function getEthBalance(address addr) view returns (uint256 balance)',
]

const iface = new Interface(PAUSABLE_ABI)
const opIface = new Interface(OPERATORS_ABI)
const mcIface = new Interface(MULTICALL3_ABI)

/**
 * Multicall3 的规范地址，**每条链都一样** —— 它用确定性部署，
 * 所以在几乎所有 EVM 链上都落在这个地址，不需要按链配置。
 */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

type Call =
  | { kind: 'paused'; id: string; target: string }
  | { kind: 'operators'; id: string; target: string }
  | { kind: 'isOperator'; id: string; target: string; viewer: string }
  | { kind: 'balance'; address: string }

/** 一轮读回来的东西。读不到的项**不进表**，而不是塞个默认值 */
interface Reading {
  readonly paused: Map<string, boolean>
  readonly operators: Map<string, readonly string[]>
  readonly viewerIsOperator: Map<string, boolean>
  readonly balance: Map<string, bigint>
}

const emptyReading = (): Reading => ({
  paused: new Map(),
  operators: new Map(),
  viewerIsOperator: new Map(),
  balance: new Map(),
})

export async function readEvm(
  chain: Chain,
  contracts: readonly ContractDef[],
  viewer?: string,
): Promise<Map<string, ContractState>> {
  const provider = new JsonRpcProvider(chain.rpcs[0], chain.chainId, { staticNetwork: true })

  const round1: Call[] = contracts.flatMap((contract): Call[] => [
    { kind: 'paused', id: contract.id, target: contract.address },
    { kind: 'operators', id: contract.id, target: contract.address },
    ...(viewer ? [{ kind: 'isOperator' as const, id: contract.id, target: contract.address, viewer }] : []),
  ])

  const first = await runCalls(provider, round1)

  /**
   * 第二轮的地址来自两处：合约自己声明的 operator，和配置里手填的那个。
   * 按小写去重 —— 同一个地址常常管好几个合约，读 N 次是白费。
   */
  const addresses = new Set<string>()
  for (const list of first.operators.values()) for (const a of list) addresses.add(a.toLowerCase())
  for (const contract of contracts) {
    if (contract.operator) addresses.add(contract.operator.toLowerCase())
  }

  const second = addresses.size
    ? await runCalls(provider, [...addresses].map((address) => ({ kind: 'balance' as const, address })))
    : emptyReading()

  return assemble(contracts, chain, first, second.balance)
}

/** 把两轮的结果摊成 contractId → ContractState */
function assemble(
  contracts: readonly ContractDef[],
  chain: Chain,
  reading: Reading,
  balances: Map<string, bigint>,
): Map<string, ContractState> {
  const states = new Map<string, ContractState>()

  const format = (address: string): OperatorInfo => {
    const wei = balances.get(address.toLowerCase())
    // 读不到就不写 balance 字段，界面显示"—"。写成 0 会让人以为地址没气了
    return wei === undefined ? { address } : { address, balance: formatUnits(wei, chain.decimals) }
  }

  for (const contract of contracts) {
    const state: ContractState = {}
    const paused = reading.paused.get(contract.id)
    if (paused !== undefined) state.paused = paused

    const list = reading.operators.get(contract.id)
    if (list !== undefined) {
      state.operators = list.map(format)
      // 没有总数可问，只能靠"第一页装满了"推断还有下一页
      if (list.length >= OPERATOR_PAGE) state.operatorsTruncated = true
    }

    const isOp = reading.viewerIsOperator.get(contract.id)
    if (isOp !== undefined) state.viewerIsOperator = isOp

    if (contract.operator) {
      const wei = balances.get(contract.operator.toLowerCase())
      if (wei !== undefined) state.operatorBalance = formatUnits(wei, chain.decimals)
    }

    if (Object.keys(state).length > 0) states.set(contract.id, state)
  }
  return states
}

/** 把一次 Call 编码成 multicall 的一项 */
function encodeCall(call: Call): { target: string; allowFailure: boolean; callData: string } {
  switch (call.kind) {
    case 'paused':
      return { target: call.target, allowFailure: true, callData: iface.encodeFunctionData('paused') }
    case 'operators':
      return {
        target: call.target,
        allowFailure: true,
        callData: opIface.encodeFunctionData('getOperators', [0, OPERATOR_PAGE]),
      }
    case 'isOperator':
      return {
        target: call.target,
        allowFailure: true,
        callData: opIface.encodeFunctionData('isOperator', [call.viewer]),
      }
    case 'balance':
      // 余额查询打给 Multicall3 自己
      return {
        target: MULTICALL3,
        allowFailure: true,
        callData: mcIface.encodeFunctionData('getEthBalance', [call.address]),
      }
  }
}

/** 把一条返回值归位。解不出来就当没读到 —— 状态未知比状态错了安全 */
function absorb(call: Call, data: string, into: Reading): void {
  try {
    switch (call.kind) {
      case 'paused':
        // bool 必须是干净的 32 字节 0 或 1：合约地址误配成预编译地址时，
        // 它对任意调用都返回哈希，长度对但值不是 0/1，解出来就成了"已暂停"，
        // 紧急暂停会被静默跳过
        if (!isBoolWord(data)) return
        into.paused.set(call.id, iface.decodeFunctionResult('paused', data)[0] === true)
        return
      case 'operators': {
        const list = opIface.decodeFunctionResult('getOperators', data)[0] as readonly string[]
        into.operators.set(call.id, [...list])
        return
      }
      case 'isOperator':
        if (!isBoolWord(data)) return
        into.viewerIsOperator.set(call.id, opIface.decodeFunctionResult('isOperator', data)[0] === true)
        return
      case 'balance': {
        const wei = mcIface.decodeFunctionResult('getEthBalance', data)[0] as bigint
        into.balance.set(call.address.toLowerCase(), wei)
        return
      }
    }
  } catch {
    /* 解码失败就当读不到 */
  }
}

/** 一轮：优先 multicall，这条链没部署就退回并发单点 */
async function runCalls(provider: JsonRpcProvider, calls: readonly Call[]): Promise<Reading> {
  if (calls.length === 0) return emptyReading()
  try {
    return await viaMulticall(provider, calls)
  } catch {
    // 这条链没部署 Multicall3，或者节点不支持 —— 别整条链读不到
    return oneByOne(provider, calls)
  }
}

async function viaMulticall(provider: JsonRpcProvider, calls: readonly Call[]): Promise<Reading> {
  const into = emptyReading()
  const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider)
  const raw = (await multicall.aggregate3!.staticCall(calls.map(encodeCall))) as [boolean, string][]

  calls.forEach((call, index) => {
    const entry = raw[index]
    // 单个调用 revert 不能拖垮整批（allowFailure），失败的跳过
    if (entry?.[0]) absorb(call, entry[1], into)
  })
  return into
}

async function oneByOne(provider: JsonRpcProvider, calls: readonly Call[]): Promise<Reading> {
  const into = emptyReading()
  await Promise.all(
    calls.map(async (call) => {
      try {
        // 没有 Multicall3 的链上余额只能直接问节点，不能走 getEthBalance
        if (call.kind === 'balance') {
          into.balance.set(call.address.toLowerCase(), await provider.getBalance(call.address))
          return
        }
        const encoded = encodeCall(call)
        absorb(call, await provider.call({ to: encoded.target, data: encoded.callData }), into)
      } catch {
        /* 忽略单点失败 */
      }
    }),
  )
  return into
}
