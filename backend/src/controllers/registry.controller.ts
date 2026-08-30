import type { Request, Response } from 'express'
import { z } from 'zod'
import * as registryService from '../services/registry.service.js'
import type { SyncEvent } from '../core/sync.js'
import { currentOperator } from '../middlewares/auth.middleware.js'
import { validated } from '../middlewares/validate.middleware.js'
import { ok } from '../lib/utils/response.js'
import { openSse } from '../lib/utils/sse.js'

/**
 * 前端渲染的唯一数据源：一个接口拿全 链+RPC+合约+业务线。
 *
 * 这一层只管 HTTP：ETag、SSE 帧、状态码、参数解析。
 * 编排在 services/registry.service.ts，能力在 core/。
 *
 * **不按人裁剪** —— 只有一份预计算好的 dto，所有能登录的人看到的内容都一样。
 * 角色的区别只在能不能动（viewer 只读，由 requireWriteRole 在写接口上拦），
 * 别把这里当成权限边界。
 */
export function getRegistry(req: Request, res: Response): void {
  const payload = registryService.snapshot()

  // 配置没变就回 304，前端频繁轮询时连响应体都不用传
  const etag = `W/"${payload.configVersion}"`
  res.setHeader('ETag', etag)
  res.setHeader('Cache-Control', 'private, no-cache')

  if (req.header('if-none-match') === etag) {
    res.status(304).end()
    return
  }
  ok(res, payload)
}

/**
 * 带同步的加载：先跟 Lark 对一遍，再把数据给前端。
 *
 *   GET /api/registry/sync  → 响应体是 SSE 流
 *     event: source    从 Lark 拉取（成功 / 跳过 + 原因）
 *     event: diff      与本地比对的结果（变更摘要）
 *     event: apply     写入并重载 / 无需更新
 *     event: registry  最终数据，前端拿这个渲染
 *
 * 不想等同步的场景（轮询、降级）走 GET /registry，纯本地、立刻返回。
 */
export async function getRegistryStream(req: Request, res: Response): Promise<void> {
  const stream = openSse(res)
  try {
    const payload = await registryService.syncAndSnapshot(
      (event: SyncEvent) => stream.emit(event.phase, event),
      req.query.force === '1',
    )
    stream.emit('registry', payload)
  } finally {
    stream.close()
  }
}

export const statesQuerySchema = z.object({
  businessLine: z.string().optional(),
  ids: z.string().optional(),
})

/**
 * 读链上状态。
 * 前端平时自己用 multicall 读（省后端 RPC 配额），这个接口是兜底：
 * 前端没有可用 RPC、或需要一个权威快照时用。
 */
export async function getStates(req: Request, res: Response): Promise<void> {
  const query = validated<z.infer<typeof statesQuerySchema>>(req)
  ok(res, Object.fromEntries(await registryService.states(query)))
}

/** 热重载配置（admin） */
export async function postReload(req: Request, res: Response): Promise<void> {
  ok(res, await registryService.reload(currentOperator(req)))
}

/* ══ 系统状态 ══════════════════════════════════════════════════════════ */

/** 存活探针，无需认证 */
export function getHealth(_req: Request, res: Response): void {
  ok(res, registryService.health())
}
