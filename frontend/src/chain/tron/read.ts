import { isBoolWord } from '../abi'
import type { Chain, Contract as ContractDef, ContractState } from '../../types'

/**
 * 读 Tron 链上的合约状态。
 *
 * Tron 没有 Multicall3，用受限并发替代 —— TronGrid 有 QPS 限制，
 * 放开并发会被限流，反而更慢。
 */
const TRON_CONCURRENCY = 5

export async function readTron(chain: Chain, contracts: readonly ContractDef[]): Promise<Map<string, ContractState>> {
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

