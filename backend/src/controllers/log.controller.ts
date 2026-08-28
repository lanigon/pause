import type { Request, Response } from 'express'
import { z } from 'zod'
import * as logRepo from '../repositories/log.repository.js'
import type { OperationLogInput } from '../repositories/log.repository.js'
import { currentOperator } from '../middlewares/auth.middleware.js'
import { validated } from '../middlewares/validate.middleware.js'
import { ok } from '../lib/utils/response.js'

/** 分页参数是 HTTP 的事，不属于日志表，所以留在 controller */
export const logQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  address: z.string().optional(),
})

/** 前端启动时拉历史交易记录 */
export async function getLogs(req: Request, res: Response): Promise<void> {
  ok(res, await logRepo.query(validated<z.infer<typeof logQuerySchema>>(req)))
}

/**
 * 钱包模式下前端上报一条 —— **广播成功之后才报**，没发出去的不记。
 * 地址由后端从 JWT 填，请求体里的任何身份字段都会被忽略。
 *
 * 请求体的形状直接用日志表推导出来的那份，不在这里另写一遍。
 */
export { operationLogInputSchema as logInputSchema } from '../repositories/log.repository.js'

export async function postLog(req: Request, res: Response): Promise<void> {
  const input = req.body as OperationLogInput
  ok(res, await logRepo.record(currentOperator(req).address, input), 201)
}
