import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setToken, syncRegistry } from '../src/store/api'
import type { SyncEvent } from '../src/types'

/**
 * SSE 帧解析。
 *
 * 这是最容易出微妙 bug 的地方：网络分片是任意的，一个事件可能被切成两半，
 * 也可能几个事件挤在一个 chunk 里。解错了表现为"进度少了几条"或"整个卡住"，
 * 而且只在慢网络下偶发 —— 本地永远测不出来。
 */
function streamOf(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const frame = (event: string, data: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const REGISTRY = {
  configVersion: 'sha256:test',
  businessLines: [],
  chains: [],
  contracts: [],
  signers: [],
  operations: [],
  synced: { changed: false, fromLark: true },
}

beforeEach(() => {
  setToken('token')
  vi.restoreAllMocks()
})

describe('SSE 帧解析', () => {
  it('把进度事件和最终数据分开：registry 是返回值，其余走 onProgress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamOf([
          frame('source', { phase: 'source', ok: true, message: '拉取中' }),
          frame('diff', { phase: 'diff', ok: true, message: '有 1 处变更' }),
          frame('registry', REGISTRY),
        ]),
      ),
    )

    const progress: SyncEvent[] = []
    const result = await syncRegistry((event) => progress.push(event))

    expect(progress.map((e) => e.phase)).toEqual(['source', 'diff'])
    expect(result.configVersion).toBe('sha256:test')
  })

  it('★ 一个事件被网络切成两半也要正确还原', async () => {
    const whole = frame('source', { phase: 'source', ok: true, message: '拉取中' })
    vi.stubGlobal(
      'fetch',
      // 从中间任意位置切开 —— 真实网络就是这样
      vi.fn(async () => streamOf([whole.slice(0, 20), whole.slice(20), frame('registry', REGISTRY)])),
    )

    const progress: SyncEvent[] = []
    await syncRegistry((event) => progress.push(event))

    expect(progress).toHaveLength(1)
    expect(progress[0]?.message).toBe('拉取中')
  })

  it('几个事件挤在一个 chunk 里也要全部拿到', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamOf([
          frame('source', { phase: 'source', ok: true, message: 'a' }) +
            frame('diff', { phase: 'diff', ok: true, message: 'b' }) +
            frame('apply', { phase: 'apply', ok: true, message: 'c' }) +
            frame('registry', REGISTRY),
        ]),
      ),
    )

    const progress: SyncEvent[] = []
    await syncRegistry((event) => progress.push(event))

    expect(progress.map((e) => e.message)).toEqual(['a', 'b', 'c'])
  })

  it('心跳注释行要忽略，不能当成事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamOf([': heartbeat\n\n', frame('source', { phase: 'source', ok: true, message: 'x' }), ': heartbeat\n\n', frame('registry', REGISTRY)]),
      ),
    )

    const progress: SyncEvent[] = []
    await syncRegistry((event) => progress.push(event))

    expect(progress).toHaveLength(1)
  })

  it('★ 流断了但没收到 registry 要报错，不能把空数据当成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamOf([frame('source', { phase: 'source', ok: true, message: 'x' })])),
    )

    await expect(syncRegistry(() => undefined)).rejects.toThrow(/同步中断/)
  })

  it('后端还没切到 SSE 就失败时（如 401），抛出后端给的错误码', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: 'token 无效' } }), {
            status: 401,
          }),
      ),
    )

    await expect(syncRegistry(() => undefined)).rejects.toThrow(/token 无效/)
  })
})
