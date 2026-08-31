import type { NextFunction, Request, Response } from 'express'
import type { OperatorRole } from '../models/operator.model.js'
import { toAuthContext, verifyToken, type AuthContext } from '../core/identity.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'

/** 能执行写操作的角色。viewer 只能看 */
const canWrite = (role: OperatorRole): boolean => role === 'admin' || role === 'operator'

/**
 * 把当前身份挂到 req 上。
 *
 * 用 `declare global` 增强 Express 的全局命名空间，而不是
 * `declare module 'express-serve-static-core'` —— 后者依赖模块解析路径：
 * npm 的扁平布局下只有一份 @types/express-serve-static-core 所以碰巧能用，
 * pnpm 的严格布局下可能装着多份，增强会打在错的那份上，
 * 表现是 `Property 'operator' does not exist on type 'Request'`。
 */
declare global {
  namespace Express {
    interface Request {
      operator?: AuthContext
    }
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
