import type { Chain } from '../../../models/chain.model.js'
import { TxStatus, type ConfirmResult, type TransactionSnapshot } from '../types.js'
import { decodeError, getClient, toBase58, toSelector } from './client.js'
import { AppError, ErrorCode } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

/**
 * Tron 交易：拼装、广播、回执解析。
 * 与 EVM 的 evm/tx.ts 一一对应，但内部机制完全不同 ——
 * 没有 nonce、没有 gas 阶梯重发，交易会过期。
 */

/** 默认手续费上限：150 TRX（单位 sun） */
const DEFAULT_FEE_LIMIT = 150_000_000

/** Tron 出块约 3 秒，19 个确认约 60 秒，留一倍余量 */
export const CONFIRM_TIMEOUT_MS = 120_000

const POLL_INTERVAL_MS = 3_000

/**
 * 构建待签名交易。
 *
 * 含 ref_block 与 expiration（约 60s 失效），所以**必须在每次签名前现场构建**。
 * 这是 Tron 与 EVM 最大的差别：EVM 的交易只要 nonce 没被占就一直有效，
 * Tron 的放一会儿就废了。
 */
export async function buildTransaction(
  chain: Chain,
  contractAddress: string,
  ownerAddress: string,
  method: string,
): Promise<Record<string, unknown>> {
  const built = await getClient(chain).transactionBuilder.triggerSmartContract(
    toBase58(contractAddress),
    // 必须是完整签名 pause()，给方法名 TronWeb 会 REVERT
    toSelector(method),
    { feeLimit: DEFAULT_FEE_LIMIT, callValue: 0 },
    [],
    toBase58(ownerAddress),
  )

  if (!built.result?.result || !built.transaction) {
    throw new AppError(ErrorCode.SIMULATE_FAILED, decodeError(built) ?? 'Tron 交易构建失败')
  }
  return built.transaction as unknown as Record<string, unknown>
}

/**
 * 广播。签名材料只以形参形式在本函数内存在，
 * 绝不写入任何状态、日志或返回值（与 EVM 侧同样的约定）。
 */
export async function broadcast(
  chain: Chain,
  signed: Readonly<Record<string, unknown>>,
): Promise<string> {
  const signedTx = signed.signedTx
  if (typeof signedTx !== 'object' || signedTx === null) {
    throw new AppError(ErrorCode.INTERNAL, 'Tron 广播需要 { signedTx }')
  }

  const result = await getClient(chain).trx.sendRawTransaction(signedTx as never)
  if (!result.result) {
    throw new AppError(ErrorCode.BROADCAST_FAILED, String(result.code ?? 'Tron 广播被拒绝'))
  }

  const hash = (signedTx as { txID?: string }).txID ?? ''
  logger.info({ chain: chain.key, hash }, 'Tron 交易已广播')
  return hash
}

/**
 * 按 hash 读状态。
 *
 * Tron 回执语义与 EVM 完全不同：未打包时 getTransactionInfo 返回空对象，
 * receipt.result 为 SUCCESS / REVERT / OUT_OF_ENERGY / OUT_OF_TIME，
 * 没有 EVM 的 status 0/1。
 */
export async function getTransaction(chain: Chain, hash: string): Promise<TransactionSnapshot> {
  try {
    const info = (await getClient(chain).trx.getTransactionInfo(hash)) as {
      receipt?: { result?: string }
      blockNumber?: number
    }
    const result = info.receipt?.result

    if (!result) return { hash, status: TxStatus.PENDING }
    if (result === 'SUCCESS') return { hash, status: TxStatus.CONFIRMED, blockNumber: info.blockNumber }
    return { hash, status: TxStatus.REVERTED, blockNumber: info.blockNumber, reason: failureReason(result) }
  } catch {
    return { hash, status: TxStatus.PENDING }
  }
}

/**
 * 等待终态。
 *
 * 没有 EVM 那套 gas 阶梯重发 —— Tron 的交易要么在 expiration 前打包，
 * 要么就彻底作废（不会像 EVM 那样卡在内存池里），所以只轮询等结果。
 */
export async function waitForConfirmation(
  chain: Chain,
  hash: string,
  timeoutMs = CONFIRM_TIMEOUT_MS,
): Promise<ConfirmResult> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const snapshot = await getTransaction(chain, hash)
    if (snapshot.status !== TxStatus.PENDING && snapshot.status !== TxStatus.UNKNOWN) {
      return { status: snapshot.status, blockNumber: snapshot.blockNumber, reason: snapshot.reason }
    }
    await sleep(POLL_INTERVAL_MS)
  }

  return { status: TxStatus.TIMEOUT, reason: '等待 Tron 确认超时（交易可能已过期作废）' }
}

function failureReason(result: string): string {
  switch (result) {
    case 'REVERT':
      return '合约执行回滚（可能在签名后状态已变更）'
    case 'OUT_OF_ENERGY':
      return '能量不足，请为账户质押更多能量'
    case 'OUT_OF_TIME':
      return '合约执行超时'
    default:
      return `Tron 执行失败: ${result}`
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref())
