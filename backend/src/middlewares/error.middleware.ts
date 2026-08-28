import type { NextFunction, Request, Response } from 'express'
import type { Logger } from 'pino'
import { ZodError } from 'zod'
import { isProduction } from '../config/env.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'
import { fail } from '../lib/utils/response.js'
import { logger } from '../lib/utils/logger.js'

/**
 * 请求级 logger。pino-http 挂在 req 上的那个自带 reqId + method + url，
 * 用它记的错误能和访问日志里的同一行对上。
 * 兜底到全局 logger，只是为了让这个中间件能脱离 createApp 单独被测。
 */
const logOf = (req: Request): Logger => req.log ?? logger

export function notFound(_req: Request, res: Response): void {
  // 不记日志：pino-http 已经把这次 404 记成一行 warn 了
  fail(res, 404, ErrorCode.NOT_FOUND, '接口不存在')
}

/**
 * 统一错误出口。
 * 生产环境不回显内部细节 —— 尤其是 GPG / 节点的原始错误，
 * 它们可能包含路径、密钥文件名等不该外泄的信息。
 *
 * 注意这里不再记 path：req.log 的绑定里已经有 url 了，重复写只会让每行更长。
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const log = logOf(req)

  if (error instanceof ZodError) {
    const detail = error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    log.warn({ code: ErrorCode.BAD_REQUEST, detail }, '参数校验失败')
    fail(res, 400, ErrorCode.BAD_REQUEST, `参数校验失败 → ${detail}`)
    return
  }

  if (error instanceof AppError) {
    if (error.status >= 500) {
      log.error({ code: error.code, err: error }, '服务端错误')
    } else {
      log.warn({ code: error.code, message: error.message }, '请求被拒绝')
    }
    fail(res, error.status, error.code, error.message, error.details)
    return
  }

  log.error({ err: error }, '未捕获异常')
  fail(
    res,
    500,
    ErrorCode.INTERNAL,
    isProduction ? '服务器内部错误' : error instanceof Error ? error.message : String(error),
  )
}
