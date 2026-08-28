import { describe, expect, it } from 'vitest'
import { OperationKind, expectedPausedState, labelOf, requiredPausedState } from '../src/executor/operations.js'
import { KeyedMutex } from '../src/lib/utils/mutex.js'

/**
 * 操作语义与并发原语。
 * pause/unpause 的前置条件与预期结果搞反了，会导致该暂停的被跳过。
 */
describe('操作语义', () => {
  it('★ pause 要求当前未暂停，执行后应变为已暂停', () => {
    expect(requiredPausedState(OperationKind.PAUSE)).toBe(false)
    expect(expectedPausedState(OperationKind.PAUSE)).toBe(true)
  })

  it('★ unpause 正好相反', () => {
    expect(requiredPausedState(OperationKind.UNPAUSE)).toBe(true)
    expect(expectedPausedState(OperationKind.UNPAUSE)).toBe(false)
  })

  it('前置条件与预期结果永远相反（不然逻辑就是错的）', () => {
    for (const kind of Object.values(OperationKind)) {
      expect(requiredPausedState(kind)).not.toBe(expectedPausedState(kind))
    }
  })

  it('枚举值就是合约方法名，直接拿来编码 calldata', () => {
    expect(OperationKind.PAUSE).toBe('pause')
    expect(OperationKind.UNPAUSE).toBe('unpause')
  })

  it('有中文标签给前端用', () => {
    expect(labelOf(OperationKind.PAUSE)).toBe('暂停')
    expect(labelOf(OperationKind.UNPAUSE)).toBe('恢复')
  })
})

/**
 * 按 key 串行的互斥锁。
 * 同一签名地址的批量任务靠它串行，锁错了就会 nonce 冲突。
 */
describe('KeyedMutex', () => {
  it('★ 同一个 key 严格串行', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []

    const task = (name: string, ms: number) =>
      mutex.runExclusive('same', async () => {
        order.push(`${name}-start`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`${name}-end`)
      })

    await Promise.all([task('a', 30), task('b', 5)])
    // b 必须等 a 完全结束才开始
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('不同 key 互不阻塞（不同链可以并行）', async () => {
    const mutex = new KeyedMutex()
    const started: string[] = []

    await Promise.all([
      mutex.runExclusive('chainA', async () => {
        started.push('A')
        await new Promise((r) => setTimeout(r, 20))
      }),
      mutex.runExclusive('chainB', async () => {
        started.push('B')
        await new Promise((r) => setTimeout(r, 1))
      }),
    ])
    // 两个都在很短时间内开始了，说明没互相等
    expect(started.sort()).toEqual(['A', 'B'])
  })

  it('★ 一个任务失败不会卡死整条队列', async () => {
    const mutex = new KeyedMutex()

    await expect(
      mutex.runExclusive('k', async () => {
        throw new Error('炸了')
      }),
    ).rejects.toThrow('炸了')

    // 后续任务照常执行
    await expect(mutex.runExclusive('k', async () => 'ok')).resolves.toBe('ok')
  })

  it('返回值原样透传', async () => {
    const mutex = new KeyedMutex()
    expect(await mutex.runExclusive('k', async () => ({ v: 42 }))).toEqual({ v: 42 })
  })
})
