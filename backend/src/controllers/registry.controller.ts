import type { Request, Response } from 'express'
import { z } from 'zod'
import { dto, getRegistry as getRegistrySnapshot, loadRegistry } from '../services/registry.service.js'
import { activeCount } from '../services/batch.service.js'
import * as logRepo from '../repositories/log.repository.js'
import { tx } from '../lib/web3/index.js'
import { readBusinessLineStates, readStates } from '../services/execution.service.js'
import { currentOperator } from '../middlewares/auth.middleware.js'
import { ok } from '../lib/utils/response.js'
import { openSse } from '../lib/utils/sse.js'
import { syncFromLark, type SyncEvent } from '../services/sync.service.js'
import { validated } from '../middlewares/validate.middleware.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'

/**
 * 前端渲染的唯一数据源：一个接口拿全 链+RPC+合约+业务线。
 * 只返回当前操作员有权限的业务线与合约。
 */
export function getRegistry(req: Request, res: Response): void {
  // 内存里预计算好的，直接给
  const payload = dto()

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
 * **Lark 出任何问题都不影响拿到数据** —— 事件里说明原因，registry 照发本地版本。
 * 这是紧急暂停工具，可用性优先于数据新鲜度。
 * 不想等同步的场景（轮询、降级）走 GET /registry，纯本地、立刻返回。
 */
export async function getRegistryStream(req: Request, res: Response): Promise<void> {
  const force = req.query.force === '1'
  const stream = openSse(res)

  try {
    const result = await syncFromLark((event: SyncEvent) => stream.emit(event.phase, event), force)
    // 无论同步成没成，最后一定把数据发出去
    stream.emit('registry', { ...dto(), synced: result })
  } catch (error) {
    // 同步服务自己已经吞掉了所有可预期的失败，走到这儿说明是意料外的
    const message = error instanceof Error ? error.message : String(error)
    stream.emit('apply', { phase: 'apply', at: Date.now(), ok: false, message, code: 'SYNC_CRASHED' })
    stream.emit('registry', { ...dto(), synced: { changed: false, fromLark: false } })
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

  if (query.businessLine) {
    ok(res, Object.fromEntries(await readBusinessLineStates(query.businessLine)))
    return
  }

  const ids = query.ids?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  if (ids.length === 0) throw new AppError(ErrorCode.BAD_REQUEST, '需要 businessLine 或 ids 参数')
  ok(res, Object.fromEntries(await readStates(ids)))
}

/** 热重载配置（admin） */
export async function postReload(req: Request, res: Response): Promise<void> {
  if (currentOperator(req).role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN, '只有 admin 可以重载配置')
  }
  const registry = await loadRegistry()
  ok(res, { configVersion: registry.configVersion })
}

/* ══ 系统状态 ══════════════════════════════════════════════════════════ */

const startedAt = Date.now()

/** 存活探针，无需认证 */
export function getHealth(_req: Request, res: Response): void {
  ok(res, { ok: true, uptimeMs: Date.now() - startedAt })
}

/** 后端状态快照：前端顶栏用它显示健康指示 */
export async function getState(_req: Request, res: Response): Promise<void> {
  const registry = getRegistrySnapshot()
  ok(res, {
    configVersion: registry.configVersion,
    loadedAt: registry.loadedAt,
    chains: registry.chains.size,
    contracts: registry.contracts.size,
    activeJobs: activeCount(),
    logCount: await logRepo.count(),
  })
}

/** 各链 RPC 健康：延迟与区块高度 */
export async function getRpcHealth(_req: Request, res: Response): Promise<void> {
  const chains = [...getRegistrySnapshot().chains.values()]
  const results = await Promise.all(
    chains.map(async (chain) => {
      try {
        return { chain: chain.key, rpcs: await tx(chain.type).checkHealth(chain) }
      } catch (error) {
        // 一条链没有可用 RPC 不该让整个接口挂掉，但要明确说出来
        return {
          chain: chain.key,
          rpcs: [],
          error: error instanceof Error ? error.message : '探测失败',
        }
      }
    }),
  )
  ok(res, results)
}
