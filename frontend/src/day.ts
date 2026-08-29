/**
 * 本地日历日 ↔ UTC 时间窗。
 *
 * 日志按天看，"今天"指的是**运维本地的今天**（北京时间），
 * 而 ts 存的是 UTC。直接按 UTC 切日的话，晚上八点之后的操作会被算进"明天"，
 * 运维查当天记录时找不到自己刚做的事。所以换算只在这里做一次。
 */

/** 今天，YYYY-MM-DD（本地时区） */
export function today(): string {
  return toDay(new Date())
}

/** Date → YYYY-MM-DD（本地时区）。不能用 toISOString，那是 UTC 的 */
export function toDay(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 某个本地日历日对应的 UTC 时间窗 [from, to)。
 * 左闭右开：一天的最后一毫秒不会同时落进两天。
 */
export function dayRange(day: string): { from: string; to: string } {
  const start = fromDay(day)
  const end = new Date(start)
  // 用 setDate 而不是加 86400000 —— 夏令时那天不是 24 小时
  end.setDate(end.getDate() + 1)
  return { from: start.toISOString(), to: end.toISOString() }
}

/** YYYY-MM-DD → 本地零点 */
export function fromDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
}

/** 前一天 / 后一天 */
export function shiftDay(day: string, days: number): string {
  const date = fromDay(day)
  date.setDate(date.getDate() + days)
  return toDay(date)
}

/** 这天在未来吗（未来的日子没有日志可看，按钮该禁掉） */
export const isFuture = (day: string): boolean => day > today()
