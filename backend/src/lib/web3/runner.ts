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

/**
 * 批量执行的公共循环。
 *
 * 各链族的差异通过 BatchStrategy 注入，循环本身共用 —— 这样"预演失败不消耗序号、
 * 单笔失败不中断整批、签名失败整批中止"这些**规则**只写一遍，两边实现不会走样。
 */
export interface BatchStrategy {
  /** 取下一个待用序号；无序号模型返回 undefined */
  readonly nextSequence: () => number | undefined
  /** 节点已接受该笔 → 推进序号。广播失败时不调用，序号让给下一笔（不留空洞） */
  readonly commitSequence: () => void

  readonly simulate: (item: BatchItem) => Promise<SimulateResult>
  readonly build: (item: BatchItem, sequence: number | undefined) => Promise<UnsignedPayload>
  readonly broadcast: (signed: Readonly<Record<string, unknown>>) => Promise<string>
  /** 等待终态。策略内部可重发（提高 gas 的替换交易），故返回最终 hash */
  readonly settle: (
    item: BatchItem,
    hash: string,
    sequence: number | undefined,
  ) => Promise<ConfirmResult & { hash: string }>
}

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
  const broadcasted: { item: BatchItem; hash: string; sequence: number | undefined }[] = []

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

    const sequence = strategy.nextSequence()

    // ── 拼装 ──
    let payload: UnsignedPayload
    try {
      payload = await strategy.build(item, sequence)
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
    hooks.onSign?.(item.id, sequence)

    // ── 广播：只有节点接受了才推进序号 ──
    let hash: string
    try {
      hash = await strategy.broadcast(signed)
      strategy.commitSequence()
    } catch (error) {
      const reason = messageOf(error)
      results.push({ id: item.id, status: BatchItemStatus.FAILED, reason })
      hooks.onFail?.(item.id, reason)
      continue
    }

    hooks.onBroadcast?.(item.id, hash)
    broadcasted.push({ item, hash, sequence })
  }

  // ── 确认阶段并发跑：都已经广播出去了，等待互不影响 ──
  return [...results, ...(await settleAll(broadcasted, strategy, hooks))]
}

/** 确认阶段并发跑：都已经广播出去了，等待互不影响 */
async function settleAll(
  broadcasted: readonly { item: BatchItem; hash: string; sequence: number | undefined }[],
  strategy: BatchStrategy,
  hooks: BatchHooks,
): Promise<BatchItemResult[]> {
  return Promise.all(
    broadcasted.map(async ({ item, hash, sequence }): Promise<BatchItemResult> => {
      try {
        const result = await strategy.settle(item, hash, sequence)
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
