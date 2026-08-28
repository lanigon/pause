import type { Response } from 'express'

/**
 * SSE 响应流。
 *
 * 一旦切进 SSE，HTTP 状态码就定死 200 了 —— 之后所有的错误都只能以事件形式
 * 推给前端。所以调用方要在 open() 之前把能校验的都校验完。
 */
export interface SseStream {
  /** 推一个事件。事件名即 `event:` 字段，前端按它分支 */
  emit(event: string, data: unknown): void
  /** 关闭流。重复调用无害 */
  close(): void
  /** 客户端断开的信号（关页面、点取消） */
  readonly aborted: AbortSignal
}

const HEARTBEAT_MS = 15_000

export function openSse(res: Response, heartbeatMs = HEARTBEAT_MS): SseStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 nginx 缓冲，否则事件会被攒着一起发
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  // 心跳防中间代理因空闲断连；YubiKey 等触摸时可能静默很久
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), heartbeatMs)
  heartbeat.unref()

  /**
   * 客户端断开就中止，别让子进程和外部请求白跑。
   *
   * 监听的是 `res` 不是 `req` —— 请求体被 express.json 读完后 req 的 'close'
   * 会立刻触发，拿它当断开信号会把正常执行误判成取消。
   * finished 标志挡住"响应正常结束"那一次 close。
   */
  const controller = new AbortController()
  let finished = false
  res.on('close', () => {
    if (!finished) controller.abort()
  })

  return {
    emit(event: string, data: unknown): void {
      if (finished) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    close(): void {
      if (finished) return
      finished = true
      clearInterval(heartbeat)
      res.end()
    },
    aborted: controller.signal,
  }
}
