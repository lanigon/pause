/**
 * 按 key 串行化的互斥队列。
 * 用途：同一 signer 的 GPG 任务串行、同一 (chain,address) 的 nonce 分配串行（Codex #4）。
 *
 * 只暴露 runExclusive，刻意不提供 isBusy 之类的探测接口 ——
 * 读到"空闲"的下一刻就可能被别人占上，据此做的任何决策天生是竞态。
 * 要独占就直接 runExclusive，让队列去保证。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    // 无论前一个成败都继续，避免一次失败卡死整条队列
    const current = previous.then(task, task)
    this.tails.set(
      key,
      current.catch(() => undefined),
    )

    try {
      return await current
    } finally {
      // 队尾没有新任务时清理，防止 Map 无限增长
      if (this.tails.get(key) !== undefined) {
        const tail = this.tails.get(key)
        void Promise.resolve(tail).then(() => {
          if (this.tails.get(key) === tail) this.tails.delete(key)
        })
      }
    }
  }
}
