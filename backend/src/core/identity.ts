import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'
import type { OperatorRole } from '../models/operator.model.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  身份令牌 —— JWT 的签发与校验
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 从登录流程里分出来，因为**两边的消费者完全不同**：
 *
 *   签发   只有 services/auth.service 的 login() 用（一个接口）
 *   校验   每个请求都要过一遍，用的是中间件 —— 它不该去 import 一个
 *          「服务于 /auth/login 这个接口」的模块
 *
 * HS256 自己实现，不引第三方库：这是个能改合约状态的工具，
 * 少一个依赖就少一处供应链攻击面，而 HS256 本身只有几十行。
 */

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

const base64url = (input: string): string => Buffer.from(input).toString('base64url')

const hmac = (data: string): string =>
  createHmac('sha256', env.JWT_SECRET).update(data).digest('base64url')

export function signToken(payload: JwtPayload): string {
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
