import type { z } from 'zod'
import { env } from '../config/env.js'
import { JsonCollectionStore } from './jsonStore.js'
import { operationLogSchema, type OperationLog } from '../models/log.model.js'
import { logger } from '../lib/utils/logger.js'

/* ── 查询契约。不是表的一部分，所以不在 models 里 ────────────────────── */

export interface LogQuery {
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

/** 倒序分页：最新的在前 */
export async function query(q: LogQuery): Promise<LogPage> {
  const all = await store.all()
  const filtered = q.address
    ? all.filter((item) => item.address.toLowerCase() === q.address!.toLowerCase())
    : all

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
