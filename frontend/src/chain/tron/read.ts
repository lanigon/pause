import { AbiCoder } from 'ethers'
import { OPERATOR_PAGE, isBoolWord } from '../abi'
import { fromBase58, toBase58 } from './address'
import type { Chain, Contract as ContractDef, ContractState, OperatorInfo } from '../../types'

/**
 * 读 Tron 链上的合约状态、operator 名单与 TRX 余额。
 *
 * 和 EVM 那边做同样的事，但机制完全不同：
 *   Tron 没有 Multicall3，只能一个个问，用受限并发替代（TronGrid 有 QPS 限制）
 *   带参数的 view 调用要自己 ABI 编码塞进 parameter 字段，selector 单独给
 *   余额走 wallet/getaccount，不是合约调用
 *   合约返回的地址是 hex20，显示和查余额都要转成 base58
 */
const TRON_CONCURRENCY = 5

/** TRX 的精度固定 6（1 TRX = 1e6 sun），不随链配置变 */
const SUN_PER_TRX = 1_000_000

const coder = AbiCoder.defaultAbiCoder()

export async function readTron(
  chain: Chain,
  contracts: readonly ContractDef[],
  viewer?: string,
): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>()

  // 没有 RPC 就直接返回：不加这道，下面会 fetch 到 "undefined/wallet/…"，
  // 变成对本站的一次 404，每个合约都白跑一趟
  const base = chain.rpcs[0]
  if (!base) return states
  const host = base.replace(/\/$/, '')

  // viewer 是钱包给的 base58，编进 ABI 要 hex20。转不了就不问 isOperator
  const viewerHex = viewer ? fromBase58(viewer) : undefined

  const operatorsOf = new Map<string, readonly string[]>()

  await inBatches(contracts, async (contract) => {
    const [paused, operators, isOp] = await Promise.all([
      readPaused(host, contract.address),
      readOperators(host, contract.address),
      viewerHex ? readIsOperator(host, contract.address, viewerHex) : Promise.resolve(undefined),
    ])
    const state: ContractState = {}
    if (paused !== undefined) state.paused = paused
    if (isOp !== undefined) state.viewerIsOperator = isOp
    if (operators !== undefined) {
      operatorsOf.set(contract.id, operators)
      if (operators.length >= OPERATOR_PAGE) state.operatorsTruncated = true
    }
    if (Object.keys(state).length > 0) states.set(contract.id, state)
  })

  /**
   * 余额按地址去重：同一个 operator 常常管好几个合约。
   * 合约返回的是 hex20，配置里手填的是 base58，统一成 base58 再问节点。
   */
  const addresses = new Set<string>()
  for (const list of operatorsOf.values()) for (const hex of list) addresses.add(toBase58(hex))
  for (const contract of contracts) if (contract.operator) addresses.add(contract.operator)

  const balances = new Map<string, string>()
  await inBatches([...addresses], async (address) => {
    const trx = await readBalance(host, address)
    if (trx !== undefined) balances.set(address, trx)
  })

  // 摊回各合约。读不到就不写这个字段，界面显示"—"
  for (const contract of contracts) {
    const patch: Partial<ContractState> = {}

    const list = operatorsOf.get(contract.id)
    if (list !== undefined) {
      patch.operators = list.map((hex): OperatorInfo => {
        const address = toBase58(hex)
        const balance = balances.get(address)
        return balance === undefined ? { address } : { address, balance }
      })
    }

    const own = contract.operator ? balances.get(contract.operator) : undefined
    if (own !== undefined) patch.operatorBalance = own

    if (Object.keys(patch).length > 0) {
      states.set(contract.id, { ...states.get(contract.id), ...patch })
    }
  }

  return states
}

/** 分批并发，每批 TRON_CONCURRENCY 个。单项失败不影响其它 */
async function inBatches<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += TRON_CONCURRENCY) {
    await Promise.all(
      items.slice(i, i + TRON_CONCURRENCY).map((item) => run(item).catch(() => undefined)),
    )
  }
}

/**
 * 一次只读调用。
 *
 * parameter 是**不含 selector** 的 ABI 编码参数，selector 单独走 function_selector ——
 * 这是 Tron 和 EVM 最容易踩错的差别，EVM 那边是拼在一起的一段 calldata。
 */
async function constantCall(
  host: string,
  address: string,
  selector: string,
  parameter = '',
): Promise<string | undefined> {
  const res = await fetch(`${host}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_address: address,
      contract_address: address,
      function_selector: selector,
      parameter,
      visible: true,
    }),
  })
  if (!res.ok) return undefined
  const body = (await res.json()) as { constant_result?: string[] }
  return body.constant_result?.[0]
}

async function readPaused(host: string, address: string): Promise<boolean | undefined> {
  const hex = await constantCall(host, address, 'paused()')
  // 判定必须严到"整个字是 0 或 1"。松成 /1$/ 的话，任何以 1 结尾的返回
  // 都会被当成「已暂停」，运维就会跳过一个其实还在跑的合约
  if (hex === undefined || !isBoolWord(hex)) return undefined
  return hex.replace(/^0x/, '').endsWith('1')
}

/** 合约没有这个方法时返回的是空/报错，一律当读不到 —— 不显示这一块 */
async function readOperators(host: string, address: string): Promise<readonly string[] | undefined> {
  const parameter = coder.encode(['uint256', 'uint256'], [0, OPERATOR_PAGE]).replace(/^0x/, '')
  const hex = await constantCall(host, address, 'getOperators(uint256,uint256)', parameter)
  if (!hex) return undefined
  try {
    const [list] = coder.decode(['address[]'], `0x${hex.replace(/^0x/, '')}`)
    return [...(list as readonly string[])]
  } catch {
    return undefined
  }
}

async function readIsOperator(
  host: string,
  address: string,
  viewerHex: string,
): Promise<boolean | undefined> {
  const parameter = coder.encode(['address'], [viewerHex]).replace(/^0x/, '')
  const hex = await constantCall(host, address, 'isOperator(address)', parameter)
  if (hex === undefined || !isBoolWord(hex)) return undefined
  return hex.replace(/^0x/, '').endsWith('1')
}

/**
 * 读某个地址的 TRX 余额。
 *
 * 注意：**从没上过链的地址，getaccount 返回的是空对象**（不是 balance: 0）。
 * 那种情况余额确实是 0，但和"请求失败"要分开 —— 前者写 0，后者不写。
 */
async function readBalance(host: string, address: string): Promise<string | undefined> {
  const res = await fetch(`${host}/wallet/getaccount`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, visible: true }),
  })
  if (!res.ok) return undefined

  const body = (await res.json()) as { balance?: number }
  const sun = body.balance ?? 0
  if (!Number.isFinite(sun)) return undefined
  return (sun / SUN_PER_TRX).toString()
}
