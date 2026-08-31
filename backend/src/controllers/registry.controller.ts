import type { Request, Response } from 'express'
import * as registryService from '../services/registry.service.js'
import type { SyncEvent } from '../core/sync.js'
import { ok } from '../lib/utils/response.js'
import { openSse } from '../lib/utils/sse.js'

/**
 * 带同步的加载：先跟 Lark 对一遍，再把数据给前端。
 *
 *   GET /api/registry/sync  → 响应体是 SSE 流
 *     event: source    从 Lark 拉取（成功 / 跳过 + 原因）
 *     event: diff      与本地比对的结果（变更摘要）
 *     event: apply     写入并重载 / 无需更新
 *     event: registry  最终数据，前端拿这个渲染
 *
 * 取数只有这一个入口 —— 它是一条状态流，过程中的每一步都是事件，
 * 结束时给出全量配置，所以不需要另一个接口去问「现在什么情况」。
 * `?force=1` 顺带重载本地配置：手改 data/*.json 后点「重新同步」即可生效。
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


/* ══ 系统状态 ══════════════════════════════════════════════════════════ */

/** 存活探针，无需认证 */
export function getHealth(_req: Request, res: Response): void {
  ok(res, registryService.health())
}
