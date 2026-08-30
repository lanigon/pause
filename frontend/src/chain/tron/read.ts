import { isBoolWord } from '../abi'
import type { Chain, Contract as ContractDef, ContractState } from '../../types'

/**
 * 读 Tron 链上的合约状态与 operator 余额。
 *
 * Tron 没有 Multicall3，用受限并发替代 —— TronGrid 有 QPS 限制，
 * 放开并发会被限流，反而更慢。
 */
const TRON_CONCURRENCY = 5

/** TRX 的精度固定 6（1 TRX = 1e6 sun），不随链配置变 */
const SUN_PER_TRX = 1_000_000

export async function readTron(
  chain: Chain,
  contracts: readonly ContractDef[],
): Promise<Map<string, ContractState>> {
  const states = new Map<string, ContractState>()

  // 没有 RPC 就直接返回：不加这道，下面会 fetch 到 "undefined/wallet/…"，
  // 变成对本站的一次 404，每个合约都白跑一趟
  const base = chain.rpcs[0]
  if (!base) return states
  const host = base.replace(/\/$/, '')

  await inBatches(contracts, async (contract) => {
    const paused = await readPaused(host, contract.address)
    if (paused !== undefined) states.set(contract.id, { paused })
  })

  // operator 按地址去重：同一个地址管好几个合约时只问一次
  const addresses = [...new Set(contracts.map((c) => c.operator).filter((a): a is string => !!a))]
  const balances = new Map<string, string>()
  await inBatches(addresses, async (address) => {
    const trx = await readBalance(host, address)
    if (trx !== undefined) balances.set(address, trx)
  })

  // 摊回各合约。读不到就不写这个字段，界面显示"—"
  for (const contract of contracts) {
    const trx = contract.operator ? balances.get(contract.operator) : undefined
    if (trx === undefined) continue
    states.set(contract.id, { ...states.get(contract.id), operatorBalance: trx })
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

async function readPaused(host: string, address: string): Promise<boolean | undefined> {
  const res = await fetch(`${host}/wallet/triggerconstantcontract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_address: address,
      contract_address: address,
      function_selector: 'paused()',
      visible: true,
    }),
  })
  const body = (await res.json()) as { constant_result?: string[] }
  const hex = body.constant_result?.[0]
  // 判定必须严到"整个字是 0 或 1"。松成 /1$/ 的话，任何以 1 结尾的返回
  // 都会被当成「已暂停」，运维就会跳过一个其实还在跑的合约
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
