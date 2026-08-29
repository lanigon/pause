import type { Chain } from '../../models/chain.model.js'
import { endpointsOf, EMPTY_RPC_FILE, type RpcEndpoint, type RpcFile } from './endpoint.js'
import { AppError, ErrorCode } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RpcProvider —— 全后端唯一的 RPC 来源
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 对外就两个问题：**这条链后端能用哪些 RPC**、**哪些能下发前端**。
 *
 * 候选列表按两层排：先按来源优先级合并去重（见 endpoint.ts），
 * 再按探活结果重排 —— 活的在前、没探过的居中、死的垫底。
 * 交给 ethers 的 FallbackProvider 后，运行时某个节点挂了还会自动切下一个。
 *
 * 不读文件：rpc.json 由调用方读好传进来（repositories/config.repository）。
 * 这样这一层是纯的，测试不用建临时目录。
 */
interface RpcHealth {
  readonly alive: boolean
  readonly latencyMs?: number
}

/**
 * 探活函数由调用方注入。
 *
 * 探活要按链族来（EVM 是 JSON-RPC，Tron 是 REST），那是 adapter 的知识；
 * 而 web3 层反过来要 import 本模块拿 URL，直接依赖就成环了。
 * 注入之后这一层对链族一无所知。
 */
export type RpcProbe = (
  chain: Chain,
) => Promise<readonly { url: string; ok: boolean; latencyMs?: number }[]>

export class RpcProvider {
  private file: RpcFile = EMPTY_RPC_FILE
  private alchemyKey: string | undefined
  private readonly cache = new Map<string, readonly RpcEndpoint[]>()
  /** url → 探活结果。没有条目表示还没探过 */
  private readonly health = new Map<string, RpcHealth>()

  /** 启动与热重载时调用 */
  load(file: RpcFile, alchemyKey: string | undefined): void {
    this.file = file
    this.alchemyKey = alchemyKey
    this.cache.clear()
    this.health.clear()

    logger.info(
      {
        syncedAt: file.syncedAt || '(未同步)',
        lark: Object.keys(file.lark).length,
        chainlist: Object.keys(file.chainlist).length,
        alchemy: alchemyKey ? '已配置' : '未配置',
      },
      'RPC 来源已加载',
    )
  }

  /** 后端自己用：全部候选，含私有的 */
  urlsFor(chain: Chain): readonly string[] {
    const urls = this.candidates(chain).map((endpoint) => endpoint.url)
    if (urls.length === 0) {
      throw new AppError(
        ErrorCode.RPC_UNAVAILABLE,
        `链 ${chain.key} 没有可用的 RPC。请运行 npm run sync rpc，或配置 ALCHEMY_API_KEY`,
      )
    }
    return urls
  }

  /**
   * 下发前端：只给公开的。
   * 前端 multicall 用的就是这些 —— 所以前端不需要自己配任何 RPC。
   */
  publicUrlsFor(chain: Chain): readonly string[] {
    return this.candidates(chain)
      .filter((endpoint) => endpoint.public)
      .map((endpoint) => endpoint.url)
  }

  /**
   * 探一遍所有链的 RPC，把结果记下来。
   *
   * **不阻塞启动** —— 调用方在服务起来之后再跑（见 server.ts）。
   * 探测期间请求照常走原顺序，探完了自动生效。
   *
   * 一条链全军覆没时忽略本次结果：那多半是我们自己出不去网，
   * 而不是所有节点同时挂了。这种时候按原顺序试才是对的。
   */
  async probeAll(chains: readonly Chain[], probe: RpcProbe): Promise<void> {
    let alive = 0
    let dead = 0

    for (const chain of chains) {
      const results = await probe(chain).catch(() => [])
      if (results.length === 0) continue

      if (results.every((r) => !r.ok)) {
        logger.warn(
          { chain: chain.key, count: results.length },
          '该链所有 RPC 均探测失败，忽略本次结果',
        )
        continue
      }

      for (const result of results) {
        this.health.set(result.url.toLowerCase(), {
          alive: result.ok,
          ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
        })
        result.ok ? (alive += 1) : (dead += 1)
      }
    }

    this.cache.clear() // 排序依据变了，重算
    logger.info(
      { alive, dead },
      dead > 0 ? 'RPC 探活完成，已把不可用的降到最后' : 'RPC 探活完成，全部可用',
    )
  }

  get syncedAt(): string {
    return this.file.syncedAt
  }

  /* ── 内部 ── */

  private candidates(chain: Chain): readonly RpcEndpoint[] {
    const cached = this.cache.get(chain.key)
    if (cached) return cached

    const ordered = this.orderByHealth(endpointsOf(chain, this.file, this.alchemyKey))
    this.cache.set(chain.key, ordered)
    return ordered
  }

  /**
   * 活的在前、没探过的居中、死的垫底；同为活的按延迟排。
   *
   * 死的**只降权不删除**：一次探活失败可能是我们自己网络抖了，
   * 删掉的话这条链可能一个 RPC 都不剩，紧急暂停时就按不下去了。
   */
  private orderByHealth(endpoints: readonly RpcEndpoint[]): readonly RpcEndpoint[] {
    if (this.health.size === 0) return endpoints

    const rank = (url: string): number => {
      const health = this.health.get(url.toLowerCase())
      if (!health) return 1
      return health.alive ? 0 : 2
    }

    return [...endpoints].sort((a, b) => {
      const byRank = rank(a.url) - rank(b.url)
      if (byRank !== 0) return byRank
      const la = this.health.get(a.url.toLowerCase())?.latencyMs ?? Number.MAX_SAFE_INTEGER
      const lb = this.health.get(b.url.toLowerCase())?.latencyMs ?? Number.MAX_SAFE_INTEGER
      return la - lb
    })
  }
}

/** 单例：全后端共用 */
export const rpcProvider = new RpcProvider()
