import { dto, getRegistry, loadRegistry } from '../core/config.js'
import { readBusinessLineStates, readStates, type ContractState } from '../core/contractState.js'
import { SyncPhase, syncFromLark, type SyncEvent, type SyncResult } from '../core/sync.js'
import { activeCount } from './gpg.service.js'
import * as logService from './log.service.js'
import type { AuthContext } from '../core/identity.js'
import { tx } from '../lib/web3/index.js'
import { AppError, ErrorCode, messageOf } from '../lib/utils/errors.js'

/**
 * 服务于 registry.controller 的六个接口。
 *
 * 这一层只做**编排**：把 core/ 里的能力按接口的需要串起来。
 * 配置本身的真相在 core/config.ts，同步在 core/sync.ts，读链上状态在
 * core/contractState.ts —— 它们都不知道 HTTP 的存在，所以能各自单测。
 *
 * HTTP 的部分（ETag、SSE 帧、状态码）留在 controller，不下沉到这里。
 */

/** GET /registry —— 纯本地，立刻返回。ETag 由 controller 加 */
export const snapshot = (): ReturnType<typeof dto> => dto()

/**
 * GET /registry/sync —— 先跟 Lark 对一遍再给数据。
 *
 * emit 由 controller 注入（它才知道怎么写 SSE 帧）。
 * **同步出任何问题都不影响拿到数据**：这是紧急暂停工具，可用性优先于新鲜度，
 * 所以异常在这里就地转成一条事件，最后照样返回本地版本。
 */
export async function syncAndSnapshot(
  emit: (event: SyncEvent) => void,
  force: boolean,
): Promise<ReturnType<typeof dto> & { synced: SyncResult }> {
  try {
    const synced = await syncFromLark(emit, force)
    return { ...dto(), synced }
  } catch (error) {
    // 同步服务自己已经吞掉了所有可预期的失败，走到这儿说明是意料外的
    emit({
      phase: SyncPhase.APPLY,
      at: Date.now(),
      ok: false,
      message: messageOf(error),
      code: 'SYNC_CRASHED',
    })
    return { ...dto(), synced: { changed: false, fromLark: false } }
  }
}

/**
 * GET /states —— 读链上状态。二选一：整条业务线，或指定一批合约 id。
 * 前端平时自己 multicall，这个接口是它没有可用 RPC 时的兜底。
 */
export function states(query: {
  businessLine?: string
  ids?: string
}): Promise<ReadonlyMap<string, ContractState>> {
  if (query.businessLine) return readBusinessLineStates(query.businessLine)

  const ids = query.ids?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  if (ids.length === 0) throw new AppError(ErrorCode.BAD_REQUEST, '需要 businessLine 或 ids 参数')
  return readStates(ids)
}

/** POST /registry/reload —— 热重载。只有 admin 能做 */
export async function reload(actor: AuthContext): Promise<{ configVersion: string }> {
  if (actor.role !== 'admin') {
    throw new AppError(ErrorCode.FORBIDDEN, '只有 admin 可以重载配置')
  }
  const registry = await loadRegistry()
  return { configVersion: registry.configVersion }
}

/* ══ 系统状态 ══════════════════════════════════════════════════════════ */

const startedAt = Date.now()

/** GET /health —— 存活探针，无需认证 */
export const health = (): { ok: true; uptimeMs: number } => ({
  ok: true,
  uptimeMs: Date.now() - startedAt,
})

/** GET /state —— 后端状态快照，全部读内存，前端顶栏的健康指示用 */
export async function state(): Promise<{
  configVersion: string
  loadedAt: number
  chains: number
  contracts: number
  activeJobs: number
  logCount: number
}> {
  const registry = getRegistry()
  return {
    configVersion: registry.configVersion,
    loadedAt: registry.loadedAt,
    chains: registry.chains.size,
    contracts: registry.contracts.size,
    activeJobs: activeCount(),
    logCount: await logService.count(),
  }
}

/**
 * GET /state/rpc —— 各链 RPC 健康：延迟与区块高度。
 * 这个会真的去探测每个节点，比 /state 慢一个量级，所以是独立接口。
 */
export async function rpcHealth(): Promise<
  readonly { chain: string; rpcs: readonly unknown[]; error?: string }[]
> {
  const chains = [...getRegistry().chains.values()]
  return Promise.all(
    chains.map(async (chain) => {
      try {
        const results = await tx(chain.type).checkHealth(chain)
        // rawUrl 只在进程内用来对回节点，含 apiKey，**绝不下发**
        return { chain: chain.key, rpcs: results.map(({ rawUrl: _rawUrl, ...safe }) => safe) }
      } catch (error) {
        // 一条链没有可用 RPC 不该让整个接口挂掉，但要明确说出来
        return { chain: chain.key, rpcs: [], error: messageOf(error) }
      }
    }),
  )
}
