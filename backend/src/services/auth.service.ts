import { createHmac, timingSafeEqual } from 'node:crypto'
import { verifyMessage } from 'ethers'
import { env } from '../config/env.js'
import { EVM } from '../lib/web3/index.js'
import type { Operator, OperatorRole } from '../models/operator.model.js'

import { findOperator, getConfigVersion } from './registry.service.js'
import { meta } from '../lib/web3/index.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'
import { logger } from '../lib/utils/logger.js'

/**
 * 钱包签名登录 + JWT。**只有一个接口**：POST /auth/login。
 *
 * 只认 **EVM 签名**：operator 的身份就是一个 EVM 地址，
 * 在白名单里就发 token。拿到 token 之后所有需要鉴权的接口都能用 ——
 * 包括操作 Tron 合约（Tron 钱包只用于"钱包模式"发交易，不参与登录）。
 *
 * 不需要服务端 nonce：挑战消息由前端自己拼（含时间戳 + 随机数），
 * 后端用同样的模板重建消息再验签。防重放靠两条：
 *   1. 时间戳必须在 ±2 分钟内
 *   2. 用过的签名记在内存里 5 分钟，重复提交直接拒
 *
 * 好处是省掉一次往返和一份服务端状态，登录数据完全不落盘。
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


/* ══ 类型 ══════════════════════════════════════════════════════════════ */

/**
 * 当前操作者身份 —— 运行时的东西，不落盘，所以不在 models 里。
 * 由 JWT 还原而来，挂在 req.operator 上，也是执行器记录"谁做的"的依据。
 */
export interface AuthContext {
  readonly address: string
  readonly label: string
  readonly role: OperatorRole
}

/**
 * JWT 载荷 —— 传输格式，不落盘，所以不在 models 里。
 * 字段名短是因为它会跟着每个请求走。
 */
export interface JwtPayload {
  /** EVM 地址（checksum 形式） */
  readonly sub: string
  readonly label: string
  readonly role: OperatorRole
  /** 签发时的 configVersion，用于检测配置漂移 */
  readonly cv: string
  readonly iat?: number
  readonly exp?: number
}

/* ══ 实现 ══════════════════════════════════════════════════════════════ */

const CLOCK_SKEW_MS = 120_000
const REPLAY_WINDOW_MS = 300_000

/** 已用签名，防重放。只存 HMAC 摘要，不存签名原文 */
const usedSignatures = new Map<string, number>()

function markUsed(signature: string): void {
  const now = Date.now()
  for (const [key, at] of usedSignatures) {
    if (now - at > REPLAY_WINDOW_MS) usedSignatures.delete(key)
  }
  usedSignatures.set(digest(signature), now)
}

const isUsed = (signature: string): boolean => usedSignatures.has(digest(signature))

const digest = (value: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(value).digest('base64url')

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

/** EVM personal_sign 恢复签名者 */
function recoverSigner(message: string, signature: string): string | null {
  try {
    return verifyMessage(message, signature)
  } catch {
    return null
  }
}

/* ══ JWT（HS256，自己实现，不引第三方库以减少攻击面）══════════════════ */

const base64url = (input: string): string => Buffer.from(input).toString('base64url')

const hmac = (data: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(data).digest('base64url')

function signToken(payload: JwtPayload): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ ...payload, iat: now, exp: now + env.JWT_TTL_SECONDS }))
  return `${header}.${claims}.${hmac(`${header}.${claims}`)}`
}

export function verifyToken(token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AppError(ErrorCode.UNAUTHORIZED, 'token 格式非法')

  const [header, claims, signature] = parts as [string, string, string]
  const expected = hmac(`${header}.${claims}`)

  // 定长比较，避免时序侧信道
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'token 签名无效')
  }

  let payload: JwtPayload
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as JwtPayload
  } catch {
    throw new AppError(ErrorCode.UNAUTHORIZED, 'token 内容无法解析')
  }

  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new AppError(ErrorCode.TOKEN_EXPIRED, '登录已过期，请重新用钱包签名登录')
  }
  return payload
}

/** JWT payload → 挂在 req 上的身份上下文 */
export const toAuthContext = (payload: JwtPayload): AuthContext => ({
  address: payload.sub,
  label: payload.label,
  role: payload.role,
})

/** 仅测试用 */
export const __clearUsedSignatures = (): void => usedSignatures.clear()
