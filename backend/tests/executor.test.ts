import { describe, expect, it } from 'vitest'
import {
  CONTRACT_READS,
  OperationKind,
  expectedPausedState,
  labelOf,
  requiredPausedState,
} from '../src/core/operations.js'
import { PAUSABLE_ABI } from '../src/lib/web3/evm/abi.js'
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


/**
 * 「平台能做哪些操作」这件事同时活在两个层：
 *
 *   core/operations.ts        操作的语义（有哪些、前置条件、预期结果）
 *   lib/web3/evm/abi.ts       它在 EVM 上的编码（Solidity ABI）
 *
 * 分开是对的 —— core 是链无关的，Solidity ABI 只对 EVM 成立，
 * 塞进 core 会让链无关层认识 Solidity；而 Tron 压根不用 ABI（要的是方法签名字符串）。
 *
 * 但两边必须同步：往 OperationKind 里加一种操作却忘了加 ABI，
 * **编译期查不出来**，要等到真的去 encodeFunctionData 才炸 ——
 * 而那时人已经点了「批量暂停」并输过 CONFIRM 了。所以用测试守着。
 */
describe('操作清单 ↔ EVM ABI 必须同步', () => {
  const abiMethods = new Set(PAUSABLE_ABI.map((fragment) => fragment.name))

  it('★ 每一种操作都能在 EVM 上编码', () => {
    for (const kind of Object.values(OperationKind)) {
      expect(abiMethods, `操作 ${kind} 在 PAUSABLE_ABI 里没有对应方法`).toContain(kind)
    }
  })

  it('★ 每个要读的字段都在 ABI 里', () => {
    for (const read of CONTRACT_READS) {
      expect(abiMethods, `要读 ${read.method}，但 ABI 里没有`).toContain(read.method)
    }
  })

  it('ABI 里不留用不到的方法（每多一个都是白读一次链）', () => {
    const used = new Set<string>([
      ...Object.values(OperationKind),
      ...CONTRACT_READS.map((r) => r.method),
    ])
    for (const method of abiMethods) {
      expect(used, `ABI 里的 ${method}() 没有任何操作或读取用到它`).toContain(method)
    }
  })
})
