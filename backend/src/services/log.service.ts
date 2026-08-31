import * as logRepo from '../repositories/log.repository.js'
import type { LogPage, LogQuery, OperationLogInput } from '../repositories/log.repository.js'
import type { OperationLog } from '../models/log.model.js'

/**
 * 服务于三个日志接口：GET /logs、GET /logs/daily、POST /logs。
 *
 * 之前 controller 直接调 repository —— 四个 controller 里只有它是这样，
 * 而且**上报时"地址从哪来"这条规则**就散在 controller 里。那是业务规则，
 * 不是 HTTP 的事，controller 换个写法就可能把它漏掉。
 */

/** 前端启动时拉历史记录。时间窗由前端按本地日历日算好，后端不做时区推断 */
export const list = (query: LogQuery): Promise<LogPage> => logRepo.query(query)

/** 日期选择器的角标：这段时间里每天各有几笔 */
export const dailyCounts = (range: {
  from?: string
  to?: string
  offsetMinutes: number
}): Promise<Record<string, number>> => logRepo.dailyCounts(range)

/**
 * 钱包模式下前端上报一条 —— 广播成功之后才报，没发出去的不记。
 *
 * **地址一律由调用方从 JWT 取，绝不采信请求体里的身份字段** ——
 * 否则任何登录用户都能伪造成别人的操作记录，而这份日志是事后追责的依据。
 */
export const record = (actorAddress: string, input: OperationLogInput): Promise<OperationLog> =>
  logRepo.record(actorAddress, input)
