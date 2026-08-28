import type { ChainFamily } from './types.js'
import type { ChainAdapter } from './ChainAdapter.js'
import { evmAdapter } from './evm/adapter.js'
import { tronAdapter } from './tron/adapter.js'
import { AppError, ErrorCode } from '../utils/errors.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  链族注册表 —— 接入新链的唯一入口
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 加一条新的 EVM 链（Base / Arbitrum / 任意 L2）：
 *   → **零代码**，只改 data/chains.json。这张表不用动。
 *
 * 加一个新链族（Solana / Aptos / Sui）：
 *   1. 新建 web3/<family>/，实现 ChainAdapter（meta + tx 两半）
 *   2. 在下面加一行
 *   services / controllers / routes / 前端 —— 一行都不用改。
 *
 * 链族标识是字符串不是枚举，所以连枚举定义都不用改；
 * 写错了也不会漏：启动时 assertRegistered 校验 chains.json 里的每个 type 都已注册。
 */
const ADAPTERS: ReadonlyMap<ChainFamily, ChainAdapter> = new Map([
  ['evm', evmAdapter],
  ['tron', tronAdapter],
])

export function adapterOf(family: ChainFamily): ChainAdapter {
  const adapter = ADAPTERS.get(family)
  if (!adapter) {
    throw new AppError(
      ErrorCode.INTERNAL,
      `未注册的链族: ${family}。实现 ChainAdapter 后请在 web3/chains.ts 注册。`,
    )
  }
  return adapter
}

/** 元数据 adapter：纯函数，无网络。地址、explorer、能力都用它 */
export const meta = (family: ChainFamily) => adapterOf(family).meta

/** 交易 adapter：所有链上 IO */
export const tx = (family: ChainFamily) => adapterOf(family).tx

export const supportedFamilies = (): readonly ChainFamily[] => [...ADAPTERS.keys()]

/** 启动时校验：chains.json 里出现的每个 type 都必须已注册，漏了直接起不来 */
export function assertRegistered(families: readonly ChainFamily[]): void {
  const missing = [...new Set(families)].filter((f) => !ADAPTERS.has(f))
  if (missing.length > 0) {
    throw new AppError(
      ErrorCode.INTERNAL,
      `chains.json 使用了未注册的链族: ${missing.join(', ')}。请在 web3/chains.ts 注册。`,
    )
  }
}

export function resetAll(): void {
  for (const adapter of ADAPTERS.values()) adapter.tx.reset()
}
