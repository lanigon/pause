import { KeyedMutex } from '../utils/mutex.js'
import { AppError, ErrorCode } from '../utils/errors.js'
import type { BatchItem } from './types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  批次序号管理
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 「序号」是一批交易里"这是第几笔"的抽象。EVM 叫 nonce，必须严格递增且不能留洞；
 * Tron 没有这个概念（靠 ref_block + expiration 防重放）；未来接入的链可能又不一样。
 *
 * 每条链族的 executeBatch 都走同一套：
 *
 *   ① requireSingleSigner  一批交易必须来自同一个签名地址
 *   ② serializePerSigner   同一个 (链, 地址) 上的批次串行 —— 并发会各自读到
 *                          同一个基准序号，然后互相覆盖
 *   ③ NonceManager         分配 / 提交，**只有广播成功才提交**
 *
 * 有序号的链在自己的目录里实现（见 evm/nonce.ts），没有的直接用 NO_SEQUENCE。
 * 这个文件只放各链族共用的契约与前置，不含任何链族专有代码。
 *
 * 不在这里的：让出卡死的序号（自转账）。那要构造并签名一笔真实交易，
 * 是 tx 层的事，见 evm/tx.ts 的 releaseNonce。这里只管分配。
 */

/* ══ 契约 ══════════════════════════════════════════════════════════════ */

export interface NonceManager {
  /** 分配当前这一笔的序号。没有序号概念的链返回 undefined */
  next(): number | undefined
  /**
   * 推进序号。**只在广播成功后调用** ——
   * 拼装失败、签名失败都不该消耗序号，下一笔要能原样复用。
   */
  commit(): void
  /** 开工前发现的问题，交给上层推给用户。不阻断执行 */
  readonly warnings: readonly string[]
}

/** 无序号模型：Tron 这类靠时间窗防重放的链 */
export const NO_SEQUENCE: NonceManager = Object.freeze({
  next: () => undefined,
  commit: () => undefined,
  warnings: [],
})

/* ══ 通用前置 ══════════════════════════════════════════════════════════ */

/**
 * 一批交易必须来自同一个签名地址。
 * 混着来的话序号分配就没有意义了 —— 每个地址有自己独立的序号空间。
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
