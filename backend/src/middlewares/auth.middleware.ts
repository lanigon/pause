import type { NextFunction, Request, Response } from 'express'
import type { OperatorRole } from '../models/operator.model.js'
import { toAuthContext, verifyToken, type AuthContext } from '../services/auth.service.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'

/** 能执行写操作的角色。viewer 只能看 */
const canWrite = (role: OperatorRole): boolean => role === 'admin' || role === 'operator'

declare module 'express-serve-static-core' {
  interface Request {
    operator?: AuthContext
  }
}

/**
 * 验 JWT，把身份挂到 req.operator。所有业务接口都要过这一关。
 *
 * token 优先取 Authorization 头；SSE 例外 —— 浏览器的 EventSource 不支持自定义头，
 * 只能走 query。所以 query 里的 token 仅对 GET 生效（GET 不产生副作用，
 * 就算 URL 落进代理日志，影响也限于只读）。
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization')
  const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : null
  const fromQuery = req.method === 'GET' && typeof req.query.token === 'string' ? req.query.token : null
  const token = fromHeader ?? fromQuery

  if (!token) {
    next(new AppError(ErrorCode.UNAUTHORIZED, '缺少认证令牌，请先用钱包登录'))
    return
  }

  try {
    req.operator = toAuthContext(verifyToken(token))
    next()
  } catch (error) {
    next(error)
  }
}

export function currentOperator(req: Request): AuthContext {
  if (!req.operator) throw new AppError(ErrorCode.UNAUTHORIZED, '未认证')
  return req.operator
}

/** 业务线权限：viewer 只能看，operator/admin 才能执行 */
export function requireWriteRole(req: Request, _res: Response, next: NextFunction): void {
  const operator = req.operator
  if (!operator) {
    next(new AppError(ErrorCode.UNAUTHORIZED, '未认证'))
    return
  }
  if (!canWrite(operator.role)) {
    next(new AppError(ErrorCode.FORBIDDEN, '只读账号不能执行操作'))
    return
  }
  next()
}
