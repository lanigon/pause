import { z } from 'zod'

/**
 * data/operations.json —— 交易日志表。
 *
 * 只记交易，不记登录之类的行为：日志面板要看的是"链上发生了什么"。
 *
 * 这张表和另外四张不一样 —— 它不是人手写的配置，是程序追加的记录，
 * 所以在 config.schema.ts 里没有对应的文件信封，读写由 jsonStore 直接管。
 */

/**
 * 交易状态。
 * broadcast 已发出去 · confirmed/failed 最终结果 · cancelled 用户中途取消，没发出去
 */
export const txLogStatusSchema = z.enum(['broadcast', 'confirmed', 'failed', 'cancelled'])

export type TxLogStatus = z.infer<typeof txLogStatusSchema>

/** 一行日志：谁、对哪个合约做了什么、交易哈希、什么状态、什么时候 */
export const operationLogSchema = z.object({
  /** 谁 —— 操作者钱包地址。一律由后端从 JWT 填充，忽略请求体里的身份字段 */
  address: z.string().min(1),
  /** 做了什么：pause / unpause */
  operation: z.string().min(1).max(32),
  /** 哪个合约 */
  contract: z.string().min(1).max(128),
  chain: z.string().min(1).max(64),
  hash: z.string().min(1).max(128),
  status: txLogStatusSchema,
  /** 什么时候 */
  ts: z.string().min(1),
})

export type OperationLog = Readonly<z.infer<typeof operationLogSchema>>
