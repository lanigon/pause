import { formatUnits } from 'ethers'
import type { Chain } from '../../../models/chain.model.js'
import {
  TxStatus,
  type BatchItem,
  type CallRequest,
  type ConfirmResult,
  type SignPayloadFn,
  type BalanceCheck,
  type SimulateResult,
  type TransactionSnapshot,
  type UnsignedPayload,
} from '../types.js'
import { encodeCall, getProvider, readBatch } from './client.js'
import { AppError, ErrorCode } from '../../utils/errors.js'
import { logger } from '../../utils/logger.js'

/**
 * EVM 交易：拼装、预演、广播、以及**上链保障**（等回执 → 查状态 → 提高 gas 重发）。
 */

/* ─────────── gas 与重发策略 ─────────── */

export interface GasPolicy {
  /** 初始 gas price = 节点推荐值 × 这个倍数 */
  readonly initialMultiplier: number
  /** 每次等回执的时长，超时就进入"查状态 → 决定要不要重发" */
  readonly receiptTimeoutMs: number
  /** 最多发几次（含首次），防止 gas 无限翻倍烧光余额 */
  readonly maxAttempts: number
}

/**
 * 运维操作卡在内存池是不可接受的（紧急暂停晚十分钟等于没暂停），
 * 所以首发就给节点推荐值的若干倍，超时后翻倍重发。
 * 以太坊主网单独给更激进的参数：出块慢、竞争激烈、失败代价高。
 */
const DEFAULT_POLICY: GasPolicy = { initialMultiplier: 2, receiptTimeoutMs: 10_000, maxAttempts: 4 }
const POLICY_BY_CHAIN_ID = new Map<number, GasPolicy>([
  [1, { initialMultiplier: 8, receiptTimeoutMs: 30_000, maxAttempts: 4 }],
])

export const policyFor = (chain: Chain): GasPolicy => POLICY_BY_CHAIN_ID.get(chain.chainId) ?? DEFAULT_POLICY

/** 第 attempt 次的倍数（每次翻倍）。主网：8→16→32→64；其它：2→4→8→16 */
export const multiplierAt = (policy: GasPolicy, attempt: number): number =>
  policy.initialMultiplier * 2 ** attempt

/** 按倍数放大 fee，整数运算避免浮点误差 */
export const scaleFee = (value: bigint, multiplier: number): bigint =>
  (value * BigInt(Math.round(multiplier * 100))) / 100n

/* ─────────── 预演 ─────────── */

/** 提取 revert reason，拿不到就退回原始 message */
function revertReason(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error)
  const e = error as { shortMessage?: string; reason?: string; message?: string }
  return e.reason ?? e.shortMessage ?? e.message ?? 'unknown revert'
}

/**
 * 预演，两步：
 *   ① eth_call     —— 这笔交易会不会 revert（权限不对、状态不对都会在这里暴露）
 *   ② estimateGas  —— 要烧多少 gas
 * 第一步不过就没必要做第二步，也没必要去签名浪费一个 nonce。
 */
export async function simulate(chain: Chain, request: CallRequest): Promise<SimulateResult> {
  const provider = getProvider(chain)
  const call = {
    to: request.contractAddress,
    from: request.fromAddress,
    data: encodeCall(request.method, request.args),
  }

  try {
    await provider.call(call)
  } catch (error) {
    return { ok: false, reason: revertReason(error) }
  }

  try {
    const gas = await provider.estimateGas(call)
    return { ok: true, gasEstimate: ((gas * GAS_BUFFER) / 100n).toString() }
  } catch (error) {
    // eth_call 过了但估 gas 失败，多半是节点问题。放行，用保守默认值
    return { ok: true, gasEstimate: DEFAULT_GAS_LIMIT.toString(), reason: revertReason(error) }
  }
}

/**
 * 签名地址的余额还够发几笔。
 * 运维密钥没油了是最容易被忽视的故障 —— 平时不发交易，真要紧急暂停时才发现发不出去。
 */
export async function checkBalance(
  chain: Chain,
  address: string,
  gasLimit: bigint,
): Promise<BalanceCheck | null> {
  try {
    const provider = getProvider(chain)
    const [balance, feeData] = await Promise.all([provider.getBalance(address), provider.getFeeData()])

    const price = feeData.maxFeePerGas ?? feeData.gasPrice
    if (price === null || price === 0n) return null

    // 按首发倍数算，这才是实际会花的价格
    const perTx = gasLimit * scaleFee(price, multiplierAt(policyFor(chain), 0))
    if (perTx === 0n) return null

    return {
      balance: formatUnits(balance, chain.decimals),
      symbol: chain.symbol,
      runs: Number(balance / perTx),
    }
  } catch {
    return null
  }
}

/* ─────────── 拼装 ─────────── */

/** gas 估算上浮 25%：状态在打包前可能变化，留余量 */
const GAS_BUFFER = 125n
/** 估 gas 失败时的保守默认值 */
const DEFAULT_GAS_LIMIT = 500_000n

export async function buildUnsigned(
  chain: Chain,
  request: CallRequest,
  nonce: number,
  feeMultiplier?: number,
): Promise<UnsignedPayload> {
  const provider = getProvider(chain)
  const data = encodeCall(request.method, request.args)
  const call = { to: request.contractAddress, from: request.fromAddress, data }
  const multiplier = feeMultiplier ?? multiplierAt(policyFor(chain), 0)

  const [gasEstimate, feeData] = await Promise.all([
    provider.estimateGas(call).catch(() => DEFAULT_GAS_LIMIT),
    provider.getFeeData(),
  ])

  const base = {
    chainId: chain.chainId,
    to: request.contractAddress,
    data,
    value: '0',
    nonce,
    gasLimit: ((gasEstimate * GAS_BUFFER) / 100n).toString(),
  }

  // 优先 EIP-1559；节点不支持时退回 legacy gasPrice
  const payload =
    feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null
      ? {
          ...base,
          type: 2,
          maxFeePerGas: scaleFee(feeData.maxFeePerGas, multiplier).toString(),
          maxPriorityFeePerGas: scaleFee(feeData.maxPriorityFeePerGas, multiplier).toString(),
        }
      : feeData.gasPrice !== null
        ? { ...base, type: 0, gasPrice: scaleFee(feeData.gasPrice, multiplier).toString() }
        : null

  if (!payload) throw new AppError(ErrorCode.BROADCAST_FAILED, `无法从 ${chain.name} 获取 gas 价格`)

  return { family: chain.type, sequence: nonce, payload }
}

/* ─────────── 广播与确认 ─────────── */

/**
 * 广播。rawTx 只以形参形式在本函数内存在，绝不写入任何状态、日志或返回值 ——
 * 已签名的 pause 交易泄露出去，任何人都能事后重放它。
 */
export async function broadcast(chain: Chain, signed: Readonly<Record<string, unknown>>): Promise<string> {
  const rawTx = signed.rawTx
  if (typeof rawTx !== 'string') throw new AppError(ErrorCode.INTERNAL, 'EVM 广播需要 { rawTx }')
  try {
    const response = await getProvider(chain).broadcastTransaction(rawTx)
    return response.hash
  } catch (error) {
    throw new AppError(ErrorCode.BROADCAST_FAILED, revertReason(error))
  }
}

async function waitReceipt(chain: Chain, hash: string, timeoutMs: number): Promise<ConfirmResult> {
  try {
    const receipt = await getProvider(chain).waitForTransaction(hash, chain.confirmations, timeoutMs)
    if (receipt === null) return { status: TxStatus.TIMEOUT }
    return receipt.status === 1
      ? { status: TxStatus.CONFIRMED, blockNumber: receipt.blockNumber }
      : {
          status: TxStatus.REVERTED,
          blockNumber: receipt.blockNumber,
          reason: '交易被链上回滚（可能在签名后状态已变更）',
        }
  } catch {
    return { status: TxStatus.TIMEOUT }
  }
}

export async function getTransaction(chain: Chain, hash: string): Promise<TransactionSnapshot> {
  const provider = getProvider(chain)
  try {
    const receipt = await provider.getTransactionReceipt(hash)
    if (receipt) {
      return {
        hash,
        status: receipt.status === 1 ? TxStatus.CONFIRMED : TxStatus.REVERTED,
        blockNumber: receipt.blockNumber,
      }
    }
    const tx = await provider.getTransaction(hash)
    return tx
      ? { hash, status: TxStatus.PENDING }
      : { hash, status: TxStatus.UNKNOWN, reason: '节点上查不到，可能已掉出内存池' }
  } catch (error) {
    return { hash, status: TxStatus.UNKNOWN, reason: revertReason(error) }
  }
}

/**
 * ★ 上链保障：等回执 → 查状态 → 没变就提高 gas 用**同一 nonce** 重发。
 *
 * 同 nonce 是关键：这是"替换"而不是"再发一笔"，最终只会有一笔上链。
 * 状态已达成就直接认定成功 —— 可能是我们的交易生效了只是回执慢，
 * 也可能别人先一步做了，两种情况都不该再发。
 */
export async function confirmWithEscalation(params: {
  readonly chain: Chain
  readonly item: BatchItem
  readonly hash: string
  readonly nonce: number
  readonly sign: SignPayloadFn
}): Promise<ConfirmResult & { hash: string }> {
  const { chain, item, nonce, sign } = params
  const policy = policyFor(chain)
  let hash = params.hash

  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    const receipt = await waitReceipt(chain, hash, policy.receiptTimeoutMs)
    if (receipt.status === TxStatus.CONFIRMED || receipt.status === TxStatus.REVERTED) {
      return { ...receipt, hash }
    }

    if (await stateSatisfied(chain, item)) {
      logger.info({ chain: chain.key, contractId: item.id, hash }, '回执未到但链上状态已达成，视为成功')
      return { status: TxStatus.CONFIRMED, hash, reason: '回执未返回，但链上状态已达成' }
    }

    if (attempt === policy.maxAttempts - 1) {
      return { status: TxStatus.TIMEOUT, hash, reason: `已重发 ${policy.maxAttempts} 次仍未上链，请人工介入` }
    }

    const multiplier = multiplierAt(policy, attempt + 1)
    logger.warn({ chain: chain.key, contractId: item.id, nonce, multiplier }, '未上链且状态未变，提高 gas 重发')

    try {
      const payload = await buildUnsigned(chain, item.request, nonce, multiplier)
      hash = await broadcast(chain, await sign(payload))
    } catch (error) {
      // 重发失败（比如节点嫌涨幅不够）不代表原交易失败，继续等原来那笔
      logger.warn({ contractId: item.id, reason: revertReason(error) }, '替换交易发送失败，继续等待原交易')
    }
  }

  return { status: TxStatus.TIMEOUT, hash, reason: '等待上链超时' }
}

/** 用 multicall 读一次目标状态，判断是否已经达成 */
async function stateSatisfied(chain: Chain, item: BatchItem): Promise<boolean> {
  const check = item.stateCheck
  if (!check) return false
  try {
    const [result] = await readBatch(chain, [
      { id: item.id, target: item.request.contractAddress, method: check.method, args: [] },
    ])
    return result?.success === true && String(result.value) === String(check.expected)
  } catch {
    return false
  }
}
