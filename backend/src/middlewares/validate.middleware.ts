import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodTypeAny } from 'zod'

/** body / query 的 zod 校验。解析后的值写回 req，后续 handler 拿到的都是已校验数据。 */
export const validateBody =
  (schema: ZodTypeAny): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      next(result.error)
      return
    }
    req.body = result.data
    next()
  }

export const validateQuery =
  (schema: ZodTypeAny): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      next(result.error)
      return
    }
    // Express 5 的 req.query 是 getter，挂到 req.validatedQuery 上
    ;(req as Request & { validatedQuery?: unknown }).validatedQuery = result.data
    next()
  }

export const validated = <T>(req: Request): T =>
  (req as Request & { validatedQuery?: T }).validatedQuery as T

/** 把 async handler 的异常转交给 errorHandler */
export const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next)
  }
