import type { Request, Response } from 'express'
import { z } from 'zod'
import { OperationKind } from '../core/operations.js'
import { cancelFor, plan, run } from '../services/gpg.service.js'
import { currentOperator } from '../middlewares/auth.middleware.js'
import type { ExecutionEvent } from '../core/execution.js'
import { ok } from '../lib/utils/response.js'
import { openSse } from '../lib/utils/sse.js'

/**
 * GPG 批量执行 —— 只有这一个接口。
 *
 *   POST /api/gpg/batch
 *   { operation, contractIds, expectedConfigVersion, confirm: "CONFIRM" }
 *   → 响应体是 SSE 流，边执行边推进度
 *
 * 前端只发这个轻请求，**不传任何密钥材料**。
 * 后端是本地运行的：解本地的 secrets/<链族>.key.gpg，
 * 口令/PIN 由本机的 gpg-agent + pinentry 负责 ——
 * YubiKey 场景下用户还要去按一下插在这台机器上的那把 key。
 */
export const batchSchema = z.object({
  operation: z.nativeEnum(OperationKind),
  contractIds: z.array(z.string().min(1)).min(1),
  /** 前端看到的 configVersion，用于检测配置漂移 */
  expectedConfigVersion: z.string().min(1),
  /** 危险操作二次确认 */
  confirm: z.literal('CONFIRM'),
})

export async function postBatch(req: Request, res: Response): Promise<void> {
  const body = req.body as z.infer<typeof batchSchema>

  // ① 授权校验。不过就走正常的 JSON 错误响应，还没进 SSE
  const batch = await plan({
    operation: body.operation,
    contractIds: body.contractIds,
    actor: currentOperator(req),
    expectedConfigVersion: body.expectedConfigVersion,
  })

  // ② 切到 SSE。此后所有错误都以事件形式推给前端，不再改 HTTP 状态码
  const stream = openSse(res)

  try {
    await run(batch, (event: ExecutionEvent) => stream.emit(event.phase, event), stream.aborted)
  } finally {
    stream.close()
  }
}

/**
 * 取消自己正在跑的批量任务。
 *
 * 已经广播出去的交易**拦不住** —— 那是链上的事了。
 * 取消只保证：还没签名的不再签，还没广播的不再发。
 */
export function postCancel(req: Request, res: Response): void {
  const cancelled = cancelFor(currentOperator(req).address)
  ok(res, { cancelled })
}
