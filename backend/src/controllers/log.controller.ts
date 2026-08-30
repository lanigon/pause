import type { Request, Response } from 'express'
import { z } from 'zod'
import * as logService from '../services/log.service.js'
import type { OperationLogInput } from '../repositories/log.repository.js'
import { currentOperator } from '../middlewares/auth.middleware.js'
import { validated } from '../middlewares/validate.middleware.js'
import { ok } from '../lib/utils/response.js'

/** 分页参数是 HTTP 的事，不属于日志表，所以留在 controller */
export const logQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  address: z.string().optional(),
  /** 时间窗 [from, to)。前端按本地日历日算好再传，后端不做时区推断 */
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

/** 前端启动时拉历史交易记录 */
export async function getLogs(req: Request, res: Response): Promise<void> {
  ok(res, await logService.list(validated<z.infer<typeof logQuerySchema>>(req)))
}

/** 日期选择器用：这段时间里每天各有几笔交易 */
export const logDailySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** 浏览器的 getTimezoneOffset()，东八区是 -480 */
  offsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
})

export async function getDailyCounts(req: Request, res: Response): Promise<void> {
  ok(res, await logService.dailyCounts(validated<z.infer<typeof logDailySchema>>(req)))
}

/**
 * 钱包模式下前端上报一条。
 * 请求体的形状直接用日志表推导出来的那份，不在这里另写一遍。
 */
export { operationLogInputSchema as logInputSchema } from '../repositories/log.repository.js'

export async function postLog(req: Request, res: Response): Promise<void> {
  const input = req.body as OperationLogInput
  // 身份从 JWT 来，不看请求体
  ok(res, await logService.record(currentOperator(req).address, input), 201)
}
