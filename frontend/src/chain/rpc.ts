import type { Chain } from '../types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  一条链的 RPC —— 前端这边唯一的节点来源
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 前端**不自己配 RPC**。`chain.rpcs` 是后端下发的（`publicUrlsFor`）：
 * 只含可公开的那些（带 apiKey 的一律不下发），并且已经按后端探活的结果排过序。
 * 这一层做的是拿着那份候选列表，在浏览器这边真正把降级跑起来。
 *
 * 和后端 `lib/rpc/rpcProvider` 是同一个角色，各管一半：
 *   后端   决定有哪些候选、哪些能公开、按探活排序
 *   前端   在这些候选里挑一个能用的，挂了就换下一个
 *
 * 为什么必须有这一层：以前两个 reader 各自写死 `chain.rpcs[0]`，
 * 第一个节点挂了或者被 CORS 拦掉，这条链的状态、operator 名单、余额
 * **全部读不到** —— 而后端代读那条兜底路（GET /states）已经删了，
 * 等于一个候选都没降级。后端每条链其实给了 2–4 个。
 *
 * 它是**有记忆的**：某个节点被证明能用之后就记住，下次从它开始试。
 * 不记的话，第一个节点长期挂着时，每次切业务线都要先撞它一次再往后走。
 *
 * 链族无关 —— 只管交出一个能用的 url：
 *   EVM   拿 url 建 JsonRpcProvider
 *   Tron  拿 url 当 TronGrid 的 host 拼 REST 路径
 */
export interface ChainRpc {
  readonly chainKey: string
  /** 有几个候选 */
  readonly size: number
  /**
   * 依次试候选，第一个跑通的就是它，并记住下次从这里开始。
   *
   * `run` 抛错 = **这个节点不能用**，换下一个。所以调用方要想清楚
   * 什么才算"节点不能用" —— 合约没这个方法、调用 revert 都不算，
   * 那是合约的事，换多少个节点都一样。
   */
  use<T>(run: (url: string) => Promise<T>): Promise<T>
}

/** chainKey → 上次跑通的候选下标。候选列表变了就作废 */
const memory = new Map<string, { urls: string; index: number }>()

export function rpcFor(chain: Chain): ChainRpc {
  const urls = chain.rpcs
  const fingerprint = urls.join('|')
  const remembered = memory.get(chain.key)
  const start = remembered?.urls === fingerprint ? remembered.index : 0

  return {
    chainKey: chain.key,
    size: urls.length,

    async use<T>(run: (url: string) => Promise<T>): Promise<T> {
      if (urls.length === 0) throw new Error(`${chain.key} 没有可用的 RPC`)

      let lastError: unknown = new Error(`${chain.key} 的 RPC 全部不可用`)

      // 从记住的那个开始，绕一圈把每个都试到
      for (let step = 0; step < urls.length; step += 1) {
        const index = (start + step) % urls.length
        try {
          const result = await run(urls[index]!)
          memory.set(chain.key, { urls: fingerprint, index })
          return result
        } catch (error) {
          lastError = error
        }
      }

      throw lastError
    },
  }
}

/** 仅测试用：清掉"上次哪个能用"的记忆 */
export const __resetRpcMemory = (): void => memory.clear()
