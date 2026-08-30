import { createHmac } from 'node:crypto'
import { verifyMessage } from 'ethers'
import { env } from '../config/env.js'
import { EVM, meta } from '../lib/web3/index.js'
import type { Operator } from '../models/operator.model.js'
import { findOperator, getConfigVersion } from '../core/config.js'
import { signToken } from '../core/identity.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'
import { logger } from '../lib/utils/logger.js'

/**
 * 服务于 POST /auth/login —— 这个 service 只做这一件事。
 *
 * 只认 **EVM 签名**：operator 的身份就是一个 EVM 地址，在白名单里就发 token。
 * 拿到 token 之后所有需要鉴权的接口都能用，包括操作 Tron 合约
 * （Tron 钱包只用于"钱包模式"发交易，不参与登录）。
 *
 * 不需要服务端 nonce：挑战消息由前端自己拼（含时间戳 + 随机数），
 * 后端用同样的模板重建消息再验签。防重放靠两条：
 *   1. 时间戳必须在 ±2 分钟内
 *   2. 用过的签名记在内存里 5 分钟，重复提交直接拒
 *
 * 好处是省掉一次往返和一份服务端状态，登录数据完全不落盘。
 * token 本身的签发与校验在 core/identity.ts —— 校验是每个请求都要做的事，
 * 不该挂在这个只服务一个接口的模块上。
 */

interface LoginParams {
  /** EVM 地址 */
  readonly address: string
  readonly timestamp: number
  readonly nonce: string
  readonly signature: string
}

interface LoginResult {
  readonly accessToken: string
  readonly expiresIn: number
  readonly operator: {
    readonly address: string
    readonly label: string
    readonly role: Operator['role']
  }
}

const CLOCK_SKEW_MS = 120_000
const REPLAY_WINDOW_MS = 300_000

/** 已用签名，防重放。只存 HMAC 摘要，不存签名原文 */
const usedSignatures = new Map<string, number>()

const digest = (value: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(value).digest('base64url')

function markUsed(signature: string): void {
  const now = Date.now()
  for (const [key, at] of usedSignatures) {
    if (now - at > REPLAY_WINDOW_MS) usedSignatures.delete(key)
  }
  usedSignatures.set(digest(signature), now)
}

const isUsed = (signature: string): boolean => usedSignatures.has(digest(signature))

/**
 * 挑战消息模板。前后端必须完全一致，差一个字符验签就过不了。
 * 内容里带上用途与地址，防止把别处的签名挪用过来。
 */
function buildLoginMessage(params: {
  address: string
  timestamp: number
  nonce: string
}): string {
  return [
    '合约管理平台 登录',
    '',
    `地址: ${params.address}`,
    `时间: ${new Date(params.timestamp).toISOString()}`,
    `随机数: ${params.nonce}`,
    '',
    '签名此消息即可登录',
  ].join('\n')
}

/** EVM personal_sign 恢复签名者 */
function recoverSigner(message: string, signature: string): string | null {
  try {
    return verifyMessage(message, signature)
  } catch {
    return null
  }
}

export async function login(params: LoginParams): Promise<LoginResult> {
  const adapter = meta(EVM)
  const address = adapter.normalizeAddress(params.address)

  // 1. 时间窗
  const skew = Math.abs(Date.now() - params.timestamp)
  if (!Number.isFinite(params.timestamp) || skew > CLOCK_SKEW_MS) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '签名已过期，请重新登录（检查本机时间是否准确）')
  }

  // 2. 防重放
  if (isUsed(params.signature)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, '该签名已被使用，请重新登录')
  }

  // 3. 验签：用前端同样的模板重建消息
  const message = buildLoginMessage({
    address: params.address,
    timestamp: params.timestamp,
    nonce: params.nonce,
  })
  const recovered = recoverSigner(message, params.signature)

  if (recovered === null || adapter.normalizeAddress(recovered) !== address) {
    logger.warn({ address: adapter.displayAddress(address) }, '登录验签失败')
    throw new AppError(ErrorCode.UNAUTHORIZED, '签名验证失败')
  }

  // 4. 白名单
  const operator = findOperator(address)
  if (!operator) {
    logger.warn({ address: adapter.displayAddress(address) }, '非白名单地址尝试登录')
    throw new AppError(ErrorCode.FORBIDDEN, '该地址不在操作员白名单中')
  }

  markUsed(params.signature)

  return {
    accessToken: signToken({
      sub: address,
      label: operator.label,
      role: operator.role,
      cv: getConfigVersion(),
    }),
    expiresIn: env.JWT_TTL_SECONDS,
    operator: {
      address: adapter.displayAddress(address),
      label: operator.label,
      role: operator.role,
    },
  }
}

/** 仅测试用 */
export const __clearUsedSignatures = (): void => usedSignatures.clear()
