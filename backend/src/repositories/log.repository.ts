import type { z } from 'zod'
import { env } from '../config/env.js'
import { JsonCollectionStore } from './jsonStore.js'
import { operationLogSchema, type OperationLog } from '../models/log.model.js'
import { logger } from '../lib/utils/logger.js'

/* ── 查询契约。不是表的一部分，所以不在 models 里 ────────────────────── */

export interface LogQuery {
  /**
   * 时间窗 [from, to)，ISO 字符串。
   *
   * **由前端算好传过来，后端不认识时区**。运维眼里的"今天"是本地日历日，
   * 而 ts 存的是 UTC —— 后端按 UTC 切日的话，北京时间晚上八点之后的操作
   * 会被算进"明天"，查当天记录时找不到自己刚做的事。
   */
  readonly from?: string
  readonly to?: string
  readonly limit: number
  /** 偏移分页：从倒序结果的第几条开始 */
  readonly offset?: number
  readonly address?: string
}

export interface LogPage {
  readonly items: readonly OperationLog[]
  readonly total: number
  readonly nextOffset: number | null
}

/**
 * 前端上报时能提供的字段 —— address 与 ts 由后端从 JWT / 当前时间填。
 *
 * 用 omit 从整行推导，而不是另写一份：以后给日志加字段，这一边不会漏。
 */
export const operationLogInputSchema = operationLogSchema.omit({ address: true, ts: true })

export type OperationLogInput = Readonly<z.infer<typeof operationLogInputSchema>>

/**
 * 交易日志。磁盘读写全部经 jsonStore 这个公共组件。
 *
 * 只记交易：钱包模式下前端广播后上报一条，GPG 模式下后端自己在广播与确认时各记一条。
 * 登录之类的行为不记 —— 日志面板要看的是"链上发生了什么"。
 */
const MAX_LOG_ITEMS = 20_000

const store = new JsonCollectionStore<OperationLog>({
  baseDir: env.DATA_DIR,
  fileName: 'operations.json',
  maxItems: MAX_LOG_ITEMS,
})

export const init = (): Promise<void> => store.load()

export const count = (): Promise<number> => store.count()

/** 地址由调用方从 JWT 取，**绝不采信请求体里的身份字段** */
export async function record(address: string, input: OperationLogInput): Promise<OperationLog> {
  const entry: OperationLog = { ...input, address, ts: new Date().toISOString() }
  await store.append(entry)
  return entry
}

/** 批量写：一次 GPG 任务会产生一串日志，合并写盘比逐条快得多 */
export async function recordMany(
  address: string,
  inputs: readonly OperationLogInput[],
): Promise<void> {
  if (inputs.length === 0) return
  const ts = new Date().toISOString()
  await store.appendMany(inputs.map((input) => ({ ...input, address, ts })))
}

/** 写日志失败不能拖垮主流程 */
export function recordSafe(address: string, input: OperationLogInput): void {
  void record(address, input).catch((error: unknown) => {
    logger.warn({ address, operation: input.operation, error }, '写交易日志失败')
  })
}

/**
 * 每天有几笔交易，给日期选择器用。
 *
 * **按交易哈希去重**：GPG 模式下一笔交易会写两条（广播时、确认后），
 * 直接数行数的话日历上显示 58、点进去只有 5 条，对不上就没人信这个数了。
 * 前端列表也是按哈希去重显示的，两边必须用同一套口径。
 *
 * 时区由调用方给：offsetMinutes 就是浏览器的 getTimezoneOffset()
 * （东八区是 -480）。后端不做时区推断，只按这个数把 UTC 挪成本地日历日。
 */
export async function dailyCounts(q: {
  readonly from?: string
  readonly to?: string
  readonly offsetMinutes: number
}): Promise<Record<string, number>> {
  const all = await store.all()
  const seen = new Set<string>()
  const counts: Record<string, number> = {}

  for (const item of all) {
    const at = Date.parse(item.ts)
    if (Number.isNaN(at)) continue
    if (q.from && at < Date.parse(q.from)) continue
    if (q.to && at >= Date.parse(q.to)) continue

    const day = localDay(at, q.offsetMinutes)
    // 同一笔交易在同一天只算一次
    const key = `${day}|${item.hash || item.contract + item.ts}`
    if (seen.has(key)) continue
    seen.add(key)

    counts[day] = (counts[day] ?? 0) + 1
  }
  return counts
}

/** UTC 毫秒 → 本地日历日 YYYY-MM-DD */
function localDay(at: number, offsetMinutes: number): string {
  return new Date(at - offsetMinutes * 60_000).toISOString().slice(0, 10)
}

/**
 * 时间戳解析不出来的**不过滤掉**。
 * 藏起来的话，运维会以为交易没发出去 —— 宁可多显示一条脏数据。
 */
function matches(item: OperationLog, q: LogQuery): boolean {
  if (q.address && item.address.toLowerCase() !== q.address.toLowerCase()) return false
  if (!q.from && !q.to) return true

  const at = Date.parse(item.ts)
  if (Number.isNaN(at)) return true
  if (q.from && at < Date.parse(q.from)) return false
  if (q.to && at >= Date.parse(q.to)) return false
  return true
}

/** 倒序分页：最新的在前 */
export async function query(q: LogQuery): Promise<LogPage> {
  const all = await store.all()
  const filtered = all.filter((item) => matches(item, q))

  // 存储是追加序，倒过来就是时间倒序
  const descending = [...filtered].reverse()
  const offset = q.offset ?? 0
  const items = descending.slice(offset, offset + q.limit)
  const consumed = offset + items.length

  return {
    items,
    total: filtered.length,
    nextOffset: consumed < filtered.length ? consumed : null,
  }
}
