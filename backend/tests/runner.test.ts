import { describe, expect, it, vi } from 'vitest'
import { runBatch, SigningAbortedError, type BatchStrategy } from '../src/lib/web3/runner.js'
import { BatchItemStatus, TxStatus, type BatchItem } from '../src/lib/web3/types.js'

/**
 * 批量执行的公共循环。
 *
 * 这里的每条规则都对应一个真实事故：
 *  - 预演失败还消耗序号 → nonce 空洞 → 后续交易全部卡死
 *  - 单笔失败就中断 → 紧急暂停做了一半
 *  - 签名失败还继续 → 拿着有问题的密钥硬发
 *  - 广播失败还推进序号 → 同样是 nonce 空洞
 */

const item = (id: string): BatchItem => ({
  id,
  request: { contractAddress: `0xC${id}`, fromAddress: '0xFROM', method: 'pause', args: [] },
})

/** 造一个可观测的 strategy：记录每一步谁被调用了、用了什么序号 */
function makeStrategy(overrides: Partial<BatchStrategy> = {}) {
  let nonce = 100
  const built: { id: string; sequence: number | undefined }[] = []
  const broadcasted: string[] = []

  /**
   * 模拟 EVM adapter 的做法：取号在 build 里，推进在 broadcast 成功后。
   * runner 本身不认识序号 —— 这里是为了验证那两条不变量仍然成立。
   */
  const strategy: BatchStrategy = {
    simulate: async () => ({ ok: true }),
    build: async (i) => {
      built.push({ id: i.id, sequence: nonce })
      return { family: 'evm', payload: { id: i.id } }
    },
    broadcast: async (signed) => {
      broadcasted.push(String((signed as { id?: string }).id ?? ''))
      nonce += 1
      return `0xhash-${broadcasted.length}`
    },
    settle: async (_i, hash) => ({ status: TxStatus.CONFIRMED, hash, blockNumber: 1 }),
    ...overrides,
  }

  return { strategy, built, broadcasted, currentNonce: () => nonce }
}

const sign = async (payload: { payload: Record<string, unknown> }) => payload.payload

describe('批量执行的规则', () => {
  it('全部成功时，序号连续递增', async () => {
    const { strategy, built } = makeStrategy()
    const results = await runBatch([item('a'), item('b'), item('c')], sign, strategy)

    expect(built.map((b) => b.sequence)).toEqual([100, 101, 102])
    expect(results.every((r) => r.status === BatchItemStatus.CONFIRMED)).toBe(true)
  })

  it('★ 预演失败的那笔标 SKIPPED，且不消耗序号（否则留 nonce 空洞）', async () => {
    const { strategy, built } = makeStrategy({
      simulate: async (i) => (i.id === 'b' ? { ok: false, reason: '已经暂停了' } : { ok: true }),
    })

    const results = await runBatch([item('a'), item('b'), item('c')], sign, strategy)

    // b 根本没进入 build
    expect(built.map((b) => b.id)).toEqual(['a', 'c'])
    // 关键：c 拿到的是 101 而不是 102 —— 序号没被跳过的那笔吃掉
    expect(built.map((b) => b.sequence)).toEqual([100, 101])

    const b = results.find((r) => r.id === 'b')
    expect(b?.status).toBe(BatchItemStatus.SKIPPED)
    expect(b?.reason).toBe('已经暂停了')
  })

  it('★ 广播失败时序号让给下一笔，不留空洞', async () => {
    const { strategy, built } = makeStrategy({
      broadcast: async (signed) => {
        if ((signed as { id?: string }).id === 'a') throw new Error('节点拒绝')
        return '0xok'
      },
    })

    const results = await runBatch([item('a'), item('b')], sign, strategy)

    // a 用了 100 但没提交；b 应该复用 100，而不是跳到 101
    expect(built.map((b) => b.sequence)).toEqual([100, 100])
    expect(results.find((r) => r.id === 'a')?.status).toBe(BatchItemStatus.FAILED)
    expect(results.find((r) => r.id === 'b')?.status).toBe(BatchItemStatus.CONFIRMED)
  })

  it('★ 单笔失败不中断整批', async () => {
    const { strategy } = makeStrategy({
      build: async (i) => {
        if (i.id === 'b') throw new Error('拼装炸了')
        return { family: 'evm', payload: { id: i.id } }
      },
    })

    const results = await runBatch([item('a'), item('b'), item('c')], sign, strategy)

    expect(results).toHaveLength(3)
    expect(results.find((r) => r.id === 'b')?.status).toBe(BatchItemStatus.FAILED)
    expect(results.find((r) => r.id === 'c')?.status).toBe(BatchItemStatus.CONFIRMED)
  })

  it('★ 签名失败 = 密钥有问题，整批中止（不是跳过这一笔继续）', async () => {
    const { strategy, broadcasted } = makeStrategy()
    const failingSign = vi.fn(async () => {
      throw new Error('解密出的地址不匹配')
    })

    await expect(runBatch([item('a'), item('b')], failingSign, strategy)).rejects.toThrow(
      SigningAbortedError,
    )

    // 第一笔就炸了，一笔都不该广播出去
    expect(broadcasted).toHaveLength(0)
    expect(failingSign).toHaveBeenCalledTimes(1)
  })

  it('签名失败时，已完成的部分仍要能拿到', async () => {
    const { strategy } = makeStrategy()
    let calls = 0
    const sometimesFailing = async (p: { payload: Record<string, unknown> }) => {
      calls += 1
      if (calls > 1) throw new Error('密钥失效')
      return p.payload
    }

    try {
      await runBatch([item('a'), item('b')], sometimesFailing, strategy)
      expect.unreachable('应该抛 SigningAbortedError')
    } catch (error) {
      expect(error).toBeInstanceOf(SigningAbortedError)
      // a 已经广播了，得让上层知道
      expect((error as SigningAbortedError).completed.some((r) => r.id === 'a')).toBe(true)
    }
  })

  it('取消信号置位后，剩下的直接标记为已取消', async () => {
    const controller = new AbortController()
    controller.abort()
    const { strategy, broadcasted } = makeStrategy()

    const results = await runBatch([item('a'), item('b')], sign, strategy, {}, {
      signal: controller.signal,
    })

    expect(broadcasted).toHaveLength(0)
    expect(results.every((r) => r.status === BatchItemStatus.SKIPPED)).toBe(true)
    expect(results[0]?.reason).toBe('任务已取消')
  })

  it('确认阶段返回的新 hash 会覆盖原 hash（gas 重发换了 hash）', async () => {
    const { strategy } = makeStrategy({
      settle: async () => ({ status: TxStatus.CONFIRMED, hash: '0xREPLACED', blockNumber: 9 }),
    })

    const results = await runBatch([item('a')], sign, strategy)
    expect(results[0]?.hash).toBe('0xREPLACED')
    expect(results[0]?.blockNumber).toBe(9)
  })

  it('确认返回非 CONFIRMED 一律算失败（超时也不当成功）', async () => {
    const { strategy } = makeStrategy({
      settle: async (_i, hash) => ({ status: TxStatus.TIMEOUT, hash, reason: '等超时了' }),
    })

    const results = await runBatch([item('a')], sign, strategy)
    expect(results[0]?.status).toBe(BatchItemStatus.FAILED)
    expect(results[0]?.reason).toBe('等超时了')
  })

  it('每一步都通知 hooks，好让 SSE 实时推给前端', async () => {
    const { strategy } = makeStrategy({
      simulate: async (i) => (i.id === 'skip' ? { ok: false, reason: 'no-op' } : { ok: true }),
    })
    const hooks = {
      onSimulate: vi.fn(),
      onSkip: vi.fn(),
      onSign: vi.fn(),
      onBroadcast: vi.fn(),
      onSettle: vi.fn(),
      onFail: vi.fn(),
    }

    await runBatch([item('a'), item('skip')], sign, strategy, hooks)

    expect(hooks.onSimulate).toHaveBeenCalledTimes(2)
    expect(hooks.onSkip).toHaveBeenCalledWith('skip', 'no-op')
    expect(hooks.onSign).toHaveBeenCalledWith('a')
    expect(hooks.onBroadcast).toHaveBeenCalledWith('a', expect.stringContaining('0xhash'))
    expect(hooks.onSettle).toHaveBeenCalledOnce()
    expect(hooks.onFail).not.toHaveBeenCalled()
  })

  it('预演本身抛异常也当作跳过，不让整批崩掉', async () => {
    const { strategy } = makeStrategy({
      simulate: async () => {
        throw new Error('RPC 超时')
      },
    })

    const results = await runBatch([item('a')], sign, strategy)
    expect(results[0]?.status).toBe(BatchItemStatus.SKIPPED)
    expect(results[0]?.reason).toBe('RPC 超时')
  })

  it('空列表直接返回空结果', async () => {
    const { strategy } = makeStrategy()
    expect(await runBatch([], sign, strategy)).toEqual([])
  })
})
