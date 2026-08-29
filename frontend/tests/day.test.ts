import { describe, expect, it } from 'vitest'
import { dayRange, fromDay, isFuture, shiftDay, toDay, today } from '../src/day'

/**
 * 本地日历日 ↔ UTC 时间窗。
 *
 * 这里最容易错的是时区：运维眼里的"今天"是北京时间的今天，
 * 而 ts 存的是 UTC。按 UTC 切日的话，晚上八点之后的操作会被算进"明天"，
 * 运维查当天记录时找不到自己刚做的事 —— 紧急场景下会以为交易没发出去。
 */
describe('本地日历日', () => {
  it('★ 用本地日期，不是 UTC —— toISOString 在东八区会差一天', () => {
    // 北京时间 8 月 29 日早上 7 点 = UTC 8 月 28 日 23 点
    const morning = new Date(2026, 7, 29, 7, 0, 0)
    expect(toDay(morning)).toBe('2026-08-29')
  })

  it('★ 深夜的操作仍算当天 —— 这正是按 UTC 切会出错的时刻', () => {
    const lateNight = new Date(2026, 7, 29, 23, 30, 0)
    expect(toDay(lateNight)).toBe('2026-08-29')
  })

  it('月末、年末不跳错', () => {
    expect(toDay(new Date(2026, 0, 31, 12, 0))).toBe('2026-01-31')
    expect(toDay(new Date(2026, 11, 31, 12, 0))).toBe('2026-12-31')
  })
})

describe('一天的时间窗', () => {
  it('左闭右开，正好一天', () => {
    const { from, to } = dayRange('2026-08-29')
    const span = Date.parse(to) - Date.parse(from)
    expect(span).toBe(86_400_000)
  })

  it('起点是本地零点', () => {
    const { from } = dayRange('2026-08-29')
    const start = new Date(from)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(toDay(start)).toBe('2026-08-29')
  })

  it('★ 相邻两天的窗不重叠也不留缝 —— 一笔交易只能落进一天', () => {
    const a = dayRange('2026-08-29')
    const b = dayRange('2026-08-30')
    expect(a.to).toBe(b.from)
  })

  it('窗覆盖当天的第一毫秒和最后一毫秒', () => {
    const { from, to } = dayRange('2026-08-29')
    const first = new Date(2026, 7, 29, 0, 0, 0, 0).getTime()
    const last = new Date(2026, 7, 29, 23, 59, 59, 999).getTime()

    expect(first).toBeGreaterThanOrEqual(Date.parse(from))
    expect(last).toBeLessThan(Date.parse(to))
  })
})

describe('翻天', () => {
  it('前后各一天', () => {
    expect(shiftDay('2026-08-29', -1)).toBe('2026-08-28')
    expect(shiftDay('2026-08-29', 1)).toBe('2026-08-30')
  })

  it('★ 跨月、跨年都对 —— 不能拿字符串或 86400000 硬算', () => {
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01') // 2026 不是闰年
  })
})

describe('未来的日子', () => {
  it('今天不算未来 —— 算的话按钮会一直禁着', () => {
    expect(isFuture(today())).toBe(false)
  })

  it('明天算未来，昨天不算', () => {
    expect(isFuture(shiftDay(today(), 1))).toBe(true)
    expect(isFuture(shiftDay(today(), -1))).toBe(false)
  })
})

describe('往返一致', () => {
  it('fromDay → toDay 转回来还是同一天', () => {
    for (const day of ['2026-01-01', '2026-02-28', '2026-08-29', '2026-12-31']) {
      expect(toDay(fromDay(day))).toBe(day)
    }
  })
})
