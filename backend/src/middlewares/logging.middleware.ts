import { randomUUID } from 'node:crypto'
import type { SerializedRequest, SerializedResponse } from 'pino'
import { pinoHttp, type HttpLogger } from 'pino-http'
import { logger } from '../lib/utils/logger.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HTTP 访问日志
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 每个请求分配一个 reqId 并回写到响应头，pino-http 把它挂到 req.log 上 ——
 * 这条请求链路上后续所有日志都自带 reqId，排查时能把散落的行重新串成一次请求。
 * 用户报障时报响应头里的 x-request-id，就能直接定位到是哪一次。
 *
 * 三个刻意的取舍：
 *
 * 1. **请求头一个都不落盘。** serializer 只放行 reqId / method / url / 来源 IP，
 *    Authorization 根本没机会进入日志对象 —— logger.ts 的 redact 是第二道防线，
 *    不该当第一道。运维工具的日志会被翻很久，少写一个字段就少一处泄露面。
 *
 * 2. **健康检查不记。** 它是被轮询的，逐条记只会淹没真正有用的行。
 *
 * 3. **SSE 那条路由照常记。** /gpg/batch 的响应要等整批执行完才结束，
 *    所以它的 responseTime 就是整批耗时；客户端中途断开也会记一行 ——
 *    这两件事对批量上链来说都是想知道的，不要 ignore 掉。
 */

/** 不记访问日志的路径 */
const SILENT_PATHS: ReadonlySet<string> = new Set(['/api/health'])

/**
 * reqId 允许客户端用 x-request-id 透传（方便前端把一次操作的多个请求关联起来），
 * 但必须长得像个 id —— 否则客户端能往我们每一行日志里塞任意长的垃圾。
 */
const REQ_ID_PATTERN = /^[\w.:-]{1,128}$/

const pathOf = (url: string | undefined): string => (url ?? '').split('?')[0] ?? ''

export const httpLogger: HttpLogger = pinoHttp({
  logger,

  genReqId: (req, res) => {
    const header = req.headers['x-request-id']
    const incoming = (Array.isArray(header) ? header[0] : header)?.trim()
    const id = incoming && REQ_ID_PATTERN.test(incoming) ? incoming : randomUUID()
    res.setHeader('x-request-id', id)
    return id
  },

  autoLogging: {
    ignore: (req) => SILENT_PATHS.has(pathOf(req.url)),
  },

  /** 4xx 是调用方的问题（没登录、参数不对、配置漂移），5xx 才是我们的 */
  customLogLevel: (_req, res, error) => {
    if (error || res.statusCode >= 500) return 'error'
    if (res.statusCode >= 400) return 'warn'
    return 'info'
  },

  customSuccessMessage: (req, res) => `${req.method} ${pathOf(req.url)} → ${res.statusCode}`,
  customErrorMessage: (req, _res, error) => `${req.method} ${pathOf(req.url)} → ${error.message}`,

  serializers: {
    req: (req: SerializedRequest) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.remoteAddress,
    }),
    res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
  },
})
