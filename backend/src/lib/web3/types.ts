import type { Chain } from '../../models/chain.model.js'
import type { AbiFragment } from './abi.js'

/* ════════════════════════ 链族 ════════════════════════ */

/**
 * 链族标识，例如 'evm' / 'tron' / 'solana'。
 *
 * 用字符串而不是枚举：接一个新链族只需要实现 adapter 并注册一行，
 * 不用回头改任何枚举定义。写错了也不会漏 —— 启动时 assertRegistered
 * 会校验 chains.json 里出现的每个 type 都已注册，未注册直接起不来。
 */
export type ChainFamily = string

/** 内置链族的常量，避免各处硬编码字符串 */
export const EVM = 'evm'
export const TRON = 'tron'

/* ════════════════════════ 枚举 ════════════════════════ */

/** 交易终态 —— 各链回执语义不同，在 adapter 里归一到这几个 */
export enum TxStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  REVERTED = 'reverted',
  /** 等待超时，但交易可能仍在内存池，不等于失败 */
  TIMEOUT = 'timeout',
  UNKNOWN = 'unknown',
}

/** 批量执行中单笔的状态 */
export enum BatchItemStatus {
  PENDING = 'pending',
  /** 预演未通过，跳过 */
  SKIPPED = 'skipped',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

/* ════════════════════════ 读 ════════════════════════ */

export interface ReadCall {
  /** 调用方自定义标识，用于把结果映射回去 */
  readonly id: string
  readonly target: string
  readonly method: string
  readonly args: readonly unknown[]
  /**
   * 返回值类型。
   * EVM 用不着 —— ethers 从 ABI 就知道；
   * Tron 必须知道，因为 triggerConstantContract 只回一串裸 hex，
   * 不告诉它是 bool 还是 address 就没法正确解码。
   */
  readonly returns?: 'bool' | 'address'
}

export interface ReadResult {
  readonly id: string
  readonly success: boolean
  readonly value?: unknown
}

/* ════════════════════════ 写 ════════════════════════ */

export interface CallRequest {
  readonly contractAddress: string
  readonly fromAddress: string
  readonly method: string
  readonly args: readonly unknown[]
}

export interface SimulateResult {
  /** eth_call 是否通过（交易会不会 revert） */
  readonly ok: boolean
  /** estimateGas 的结果，已含安全余量。Tron 为 energy */
  readonly gasEstimate?: string
  readonly reason?: string
}

/** 签名地址的余额够发多少笔这样的交易 */
export interface BalanceCheck {
  /** 余额（原生币，已格式化） */
  readonly balance: string
  readonly symbol: string
  /** 按当前 gas 价格还能发几笔 */
  readonly runs: number
}

/**
 * 不透明的待签名负载。
 * EVM 的 nonce/gasPrice 与 Tron 的 ref_block/expiration 各装各的，
 * 上层从不拆包 —— 这样加新链族不会被迫套用 EVM 的模型。
 */
export interface UnsignedPayload {
  /** 由哪个链族产生 —— GPG worker 按它分派到对应的签名实现 */
  readonly family: ChainFamily
  /** family-specific 原始负载，原样透传给 signer */
  readonly payload: Readonly<Record<string, unknown>>
}

export interface ConfirmResult {
  readonly status: TxStatus
  readonly blockNumber?: number
  readonly reason?: string
}

/** 交易快照。不含签名材料，只有可公开字段。 */
export interface TransactionSnapshot {
  readonly hash: string
  readonly status: TxStatus
  readonly blockNumber?: number
  readonly reason?: string
}

export interface HealthResult {
  /** **脱敏后**的地址，只到 host —— 带 apiKey 的 RPC 不能整条露出去 */
  readonly url: string
  readonly ok: boolean
  readonly latencyMs: number
  readonly blockNumber: number | null
  /**
   * 原始地址，仅供进程内把结果对回具体节点（rpcProvider 的探活排序要用）。
   * **绝不能出现在任何响应体或日志里** —— 下发前一律只取 url。
   */
  readonly rawUrl: string
}

/* ════════════════════════ 批量执行 ════════════════════════ */

export interface BatchItem {
  /** 调用方标识（一般是 contractId），进度回调按它对应回去 */
  readonly id: string
  readonly request: CallRequest
  /**
   * 期望达成的链上状态。
   * 等回执超时后用它去查：状态若已达成，说明交易生效了（只是回执慢）或别人已经做了，
   * 都不该再发一笔；状态没变才提高 gas 重发。
   */
  readonly stateCheck?: { readonly method: string; readonly expected: unknown }
}

/**
 * 签名回调。由调用方注入 —— 在本项目里它是"把负载交给 GPG 子进程签名"。
 * adapter 不知道私钥从哪来，也不该知道。
 */
export type SignPayloadFn = (payload: UnsignedPayload) => Promise<Readonly<Record<string, unknown>>>

/** 批量执行的进度回调，用于实时推 SSE。每个回调都必须是非阻塞的。 */
export interface BatchHooks {
  /** 预演完成（无论通过与否）。通过时带 gas 估算 */
  readonly onSimulate?: (id: string, result: SimulateResult) => void
  readonly onSkip?: (id: string, reason: string) => void
  readonly onSign?: (id: string) => void
  readonly onBroadcast?: (id: string, hash: string) => void
  /** 终态。result.hash 是**最终** hash —— gas 阶梯重发可能换过 */
  readonly onSettle?: (id: string, result: ConfirmResult & { hash: string }) => void
  readonly onFail?: (id: string, reason: string) => void
  /** 不针对某一笔的整体性提醒（如开工前发现有悬空交易） */
  readonly onWarning?: (message: string) => void
}

export interface BatchItemResult {
  readonly id: string
  readonly status: BatchItemStatus
  readonly hash?: string
  readonly blockNumber?: number
  readonly reason?: string
}

export interface BatchOptions {
  /** 中止信号：用户取消任务时置位，adapter 应在下一笔开始前退出 */
  readonly signal?: AbortSignal
}

export type { Chain, AbiFragment }
