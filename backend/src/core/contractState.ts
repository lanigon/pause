import type { ContractDef } from '../models/contract.model.js'
import type { ReadCall, ReadResult } from '../lib/web3/types.js'
import { tx } from '../lib/web3/chains.js'
import { CONTRACT_READS } from './operations.js'
import { contractsOf, getChain, getContract } from './config.js'
import { groupBy } from '../lib/utils/collection.js'
import { logger } from '../lib/utils/logger.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  合约链上状态 —— 只读查询
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 从 execution.service 里分出来：那边是写编排（解密、签名、广播、重发），
 * 这边只有 eth_call。两者的失败代价差一个量级 —— 这里读失败最多让前端显示
 * "状态未知"，那边一步出错就是一笔真金白银的交易。放在一个文件里，
 * 改动时得先分辨手上这行属于哪一半。
 *
 * 两个消费者互不相干：
 *   registry.controller  前端的兜底状态查询（纯只读，不该穿过写编排模块）
 *   execution.service    执行前的前置检查
 */

/** 单个合约的链上状态快照 */
export interface ContractState {
  readonly contractId: string
  readonly chainKey: string
  /** 主状态：列表里的 Active / Paused 标签看它。读不到为 undefined */
  readonly paused?: boolean
  readonly fetchedAt: number
}

/**
 * 批量读合约链上状态。按链分组交给各自 adapter —— EVM 走 Multicall3 一次 RPC 读完，
 * Tron 走受限并发。读什么是固定的（只有 paused），配置里不用声明。
 */
export async function readStates(
  contractIds: readonly string[],
): Promise<ReadonlyMap<string, ContractState>> {
  const groups = groupBy(contractIds.map(getContract), (c) => c.chain)

  const perChain = await Promise.all(
    [...groups.entries()].map(([chainKey, contracts]) => readChainGroup(chainKey, contracts)),
  )

  const merged = new Map<string, ContractState>()
  for (const states of perChain) for (const state of states) merged.set(state.contractId, state)
  return merged
}

/** 读一整条业务线（前端切业务线时用） */
export const readBusinessLineStates = (businessLine: string): Promise<ReadonlyMap<string, ContractState>> =>
  readStates(contractsOf(businessLine).map((c) => c.id))

async function readChainGroup(
  chainKey: string,
  contracts: readonly ContractDef[],
): Promise<readonly ContractState[]> {
  const chain = getChain(chainKey)
  const fetchedAt = Date.now()

  // N 个合约 × 固定几个只读字段摊平成一批，callId 编码成 "contractId::key"
  const calls: ReadCall[] = contracts.flatMap((contract) =>
    CONTRACT_READS.map((read) => ({
      id: `${contract.id}::${read.key}`,
      target: contract.address,
      method: read.method,
      args: read.args,
      returns: read.returns,
    })),
  )

  let results: readonly ReadResult[]
  try {
    results = await tx(chain.type).readBatch(chain, calls)
  } catch (error) {
    logger.warn(
      { chain: chainKey, error: error instanceof Error ? error.message : error },
      '批量读链上状态失败，该链所有合约状态置为 unknown',
    )
    return contracts.map((c) => ({ contractId: c.id, chainKey, fetchedAt }))
  }

  const byId = new Map(results.map((r) => [r.id, r]))

  return contracts.map((contract): ContractState => {
    const paused = byId.get(`${contract.id}::paused`)
    return {
      contractId: contract.id,
      chainKey,
      paused: paused?.success && typeof paused.value === 'boolean' ? paused.value : undefined,
      fetchedAt,
    }
  })
}
