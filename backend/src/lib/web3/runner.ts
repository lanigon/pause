import { BatchItemStatus, TxStatus } from './types.js'
import type {
  BatchHooks,
  BatchItem,
  BatchItemResult,
  BatchOptions,
  ConfirmResult,
  SignPayloadFn,
  SimulateResult,
  UnsignedPayload,
} from './types.js'
import { logger } from '../utils/logger.js'
import { KeyedMutex } from '../utils/mutex.js'
import { AppError, ErrorCode, messageOf } from '../utils/errors.js'

/**
 * 批量执行的公共循环。
 *
 * 各链族的差异通过 BatchStrategy 注入，循环本身共用 —— 这样"单笔失败不中断整批、
 * 签名失败整批中止并结算已广播的"这些**规则**只写一遍，两边实现不会走样。
 *
 * 循环里**没有"序号"这个概念**。nonce 是 EVM 特有的（Tron 靠 ref_block 时间窗，
 * Solana 常规交易靠 recent blockhash），不该让每条异构链都来适配它。
 * EVM 在自己的 build 里取号、在自己的 broadcast 成功后推进 —— 见 evm/nonce.ts。
 * "预演失败不消耗序号"这条也就由构造保证了：build 只在预演通过后才被调用。
 */
export interface BatchStrategy {
  readonly simulate: (item: BatchItem) => Promise<SimulateResult>
  readonly build: (item: BatchItem) => Promise<UnsignedPayload>
  readonly broadcast: (signed: Readonly<Record<string, unknown>>) => Promise<string>
  /** 等待终态。策略内部可重发（提高 gas 的替换交易），故返回最终 hash */
  readonly settle: (item: BatchItem, hash: string) => Promise<ConfirmResult & { hash: string }>
}

/* ══ 批次前置 ══════════════════════════════════════════════════════════ */

/**
 * 一批交易必须来自同一个签名地址。
 * 这是所有链族共同的前提 —— 混着来的话，"这是第几笔"之类的账就没法算了。
 */
export function requireSingleSigner(
  items: readonly BatchItem[],
  normalize: (address: string) => string,
): string {
  const addresses = new Set(items.map((item) => normalize(item.request.fromAddress)))
  if (addresses.size !== 1) {
    throw new AppError(ErrorCode.INTERNAL, '一批交易必须来自同一个签名地址')
  }
  return [...addresses][0]!
}

/** 同一个 (链, 签名地址) 上的批次串行执行 */
const signerMutex = new KeyedMutex()

export const serializePerSigner = <T>(
  chainKey: string,
  signer: string,
  task: () => Promise<T>,
): Promise<T> => signerMutex.runExclusive(`${chainKey}:${signer.toLowerCase()}`, task)

/** 签名回调抛错 = 密钥有问题，必须整批中止 */
export class SigningAbortedError extends Error {
  constructor(
    message: string,
    readonly completed: readonly BatchItemResult[],
  ) {
    super(message)
    this.name = 'SigningAbortedError'
  }
}

export async function runBatch(
  items: readonly BatchItem[],
  sign: SignPayloadFn,
  strategy: BatchStrategy,
  hooks: BatchHooks = {},
  options: BatchOptions = {},
): Promise<readonly BatchItemResult[]> {
  const results: BatchItemResult[] = []
  const broadcasted: { item: BatchItem; hash: string }[] = []

  for (const item of items) {
    if (options.signal?.aborted) {
      results.push({ id: item.id, status: BatchItemStatus.SKIPPED, reason: '任务已取消' })
      hooks.onSkip?.(item.id, '任务已取消')
      continue
    }

    // ── 预演：失败就跳过，且不消耗序号 ──
    const simulation = await strategy.simulate(item).catch((error: unknown) => ({
      ok: false,
      reason: messageOf(error),
    }))

    hooks.onSimulate?.(item.id, simulation)

    if (!simulation.ok) {
      const reason = simulation.reason ?? '预演未通过'
      results.push({ id: item.id, status: BatchItemStatus.SKIPPED, reason })
      hooks.onSkip?.(item.id, reason)
      continue
    }

    // ── 拼装 ──
    let payload: UnsignedPayload
    try {
      payload = await strategy.build(item)
    } catch (error) {
      const reason = messageOf(error)
      results.push({ id: item.id, status: BatchItemStatus.FAILED, reason })
      hooks.onFail?.(item.id, reason)
      continue
    }

    // ── 签名：抛错说明密钥/子进程有问题，整批中止 ──
    let signed: Readonly<Record<string, unknown>>
    try {
      signed = await sign(payload)
    } catch (error) {
      const reason = messageOf(error)
      results.push({ id: item.id, status: BatchItemStatus.FAILED, reason })
      hooks.onFail?.(item.id, reason)
      logger.error({ itemId: item.id, broadcasted: broadcasted.length }, '签名失败，中止整批')

      /**
       * 关键：此前已经广播出去的交易**已经在链上了**，中止不了。
       * 必须把它们等到终态再一起报出去 —— 否则上层会以为什么都没发生，
       * 既不记日志也不刷新界面，而实际上已经有合约被暂停了。
       */
      const settled = await settleAll(broadcasted, strategy, hooks)
      throw new SigningAbortedError(reason, [...results, ...settled])
    }
    hooks.onSign?.(item.id)

    // ── 广播 ──
    let hash: string
    try {
      hash = await strategy.broadcast(signed)
    } catch (error) {
      const reason = messageOf(error)
      results.push({ id: item.id, status: BatchItemStatus.FAILED, reason })
      hooks.onFail?.(item.id, reason)
      continue
    }

    hooks.onBroadcast?.(item.id, hash)
    broadcasted.push({ item, hash })
  }

  // ── 确认阶段并发跑：都已经广播出去了，等待互不影响 ──
  return [...results, ...(await settleAll(broadcasted, strategy, hooks))]
}

/** 确认阶段并发跑：都已经广播出去了，等待互不影响 */
async function settleAll(
  broadcasted: readonly { item: BatchItem; hash: string }[],
  strategy: BatchStrategy,
  hooks: BatchHooks,
): Promise<BatchItemResult[]> {
  return Promise.all(
    broadcasted.map(async ({ item, hash }): Promise<BatchItemResult> => {
      try {
        const result = await strategy.settle(item, hash)
        hooks.onSettle?.(item.id, result)
        return {
          id: item.id,
          // 可能因重发换了 hash，用策略返回的最终值
          hash: result.hash,
          status: result.status === TxStatus.CONFIRMED ? BatchItemStatus.CONFIRMED : BatchItemStatus.FAILED,
          blockNumber: result.blockNumber,
          reason: result.reason,
        }
      } catch (error) {
        const reason = messageOf(error)
        hooks.onFail?.(item.id, reason)
        return { id: item.id, hash, status: BatchItemStatus.FAILED, reason }
      }
    }),
  )
}
