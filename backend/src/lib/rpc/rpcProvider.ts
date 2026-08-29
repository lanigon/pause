import { join, resolve } from 'node:path'
import { env } from '../../config/env.js'
import type { Chain } from '../../models/chain.model.js'
import { readJson } from '../utils/jsonFile.js'
import { createAlchemySource, createChainlistSource, createLarkSource } from './sources.js'
import {
  EMPTY_RPC_FILE,
  RpcSource,
  SOURCE_PRIORITY,
  type RpcEndpoint,
  type RpcFile,
  type RpcSourceAdapter,
} from './types.js'
import { AppError, ErrorCode } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RpcProvider —— 全后端唯一的 RPC 来源
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 三级降级：Lark → Alchemy → ChainList。
 * 前面的来源有货就用前面的，没有才往后退，最终拼成一个有序候选列表交给
 * ethers 的 FallbackProvider —— 所以"降级"既发生在配置层（哪个来源提供）
 * 也发生在运行时（某个节点挂了自动切下一个）。
 *
 * 请求路径上**不做任何外网调用**：Lark 与 ChainList 的数据由
 * `npm run sync:rpc` 离线同步到 data/rpc.json，这里只读本地文件。
 * 这样一次页面加载不会因为 chainlist.org 慢而卡住。
 *
 * 前端用的 RPC 也由这里下发：只给 `public: true` 的，
 * Alchemy 那种含密钥的永远留在后端。
 */
/** 一个 URL 的探活结果 */
interface RpcHealth {
  readonly alive: boolean
  readonly latencyMs?: number
  readonly checkedAt: number
}

/**
 * 探活函数由调用方注入。
 *
 * 为什么不在这里直接发请求：探活要按链族来（EVM 是 JSON-RPC eth_chainId，
 * Tron 是 REST），那是 adapter 的知识。而 web3 层反过来要 import 本模块拿 URL，
 * 直接依赖就成环了。注入之后 lib/rpc 对链族一无所知。
 */
export type RpcProbe = (
  chain: Chain,
) => Promise<readonly { url: string; ok: boolean; latencyMs?: number }[]>

export class RpcProvider {
  private sources: readonly RpcSourceAdapter[] = []
  private file: RpcFile = EMPTY_RPC_FILE
  private readonly cache = new Map<string, readonly RpcEndpoint[]>()
  /** url → 探活结果。空的表示还没探过 */
  private readonly health = new Map<string, RpcHealth>()

  /**
   * 从 data/rpc.json 加载来源数据。启动与热重载时调用。
   * 两个依赖都做成显式参数 —— 不然测试里没法隔离 Alchemy 那一级。
   */
  async load(dataDir: string = env.DATA_DIR, alchemyKey = env.ALCHEMY_API_KEY): Promise<void> {
    const path = join(resolve(dataDir), 'rpc.json')
    this.file = await readJson<RpcFile>(path, EMPTY_RPC_FILE)

    this.sources = [
      createLarkSource(this.file),
      createAlchemySource(alchemyKey),
      createChainlistSource(this.file),
    ]
    this.cache.clear()
    this.health.clear()

    logger.info(
      {
        syncedAt: this.file.syncedAt || '(未同步)',
        lark: Object.keys(this.file.lark).length,
        chainlist: Object.keys(this.file.chainlist).length,
        alchemy: alchemyKey ? '已配置' : '未配置',
      },
      'RPC 来源已加载',
    )
  }

  /**
   * 解析一条链的 RPC 候选列表。
   *
   * 排序两层：先按来源优先级（Lark → Alchemy → ChainList）合并去重，
   * 再按探活结果重排 —— **探到活的排前面，探到死的排最后**。
   *
   * 死的不删只降权：一次探活失败可能是我们自己网络抖了，
   * 删掉的话这条链可能一个 RPC 都不剩，紧急暂停时就按不下去了。
   */
  endpointsFor(chain: Chain): readonly RpcEndpoint[] {
    const cached = this.cache.get(chain.key)
    if (cached) return cached

    const seen = new Set<string>()
    const merged: RpcEndpoint[] = []

    for (const source of SOURCE_PRIORITY) {
      const adapter = this.sources.find((s) => s.source === source)
      if (!adapter) continue

      for (const endpoint of adapter.endpointsFor(chain)) {
        const key = endpoint.url.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(endpoint)
      }
    }

    const ordered = this.orderByHealth(merged)
    this.cache.set(chain.key, ordered)
    return ordered
  }

  /**
   * 活的在前、没探过的居中、死的垫底。
   * 同为活的按延迟排 —— 快的先用，FallbackProvider 也就更少触发重试。
   */
  private orderByHealth(endpoints: readonly RpcEndpoint[]): readonly RpcEndpoint[] {
    if (this.health.size === 0) return endpoints

    const rank = (url: string): number => {
      const health = this.health.get(url.toLowerCase())
      if (!health) return 1 // 没探过
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

  /**
   * 探一遍所有链的 RPC，把结果记下来。
   *
   * **不阻塞启动** —— 调用方在服务起来之后再跑（见 server.ts）。
   * 探测期间请求照常走原顺序，探完了自动生效。
   *
   * 全军覆没时不改动排序：那多半是我们自己出不去网，
   * 而不是所有节点同时挂了。这种时候按原顺序试才是对的。
   */
  async probeAll(chains: readonly Chain[], probe: RpcProbe): Promise<void> {
    const checkedAt = Date.now()
    let alive = 0
    let dead = 0

    for (const chain of chains) {
      const results = await probe(chain).catch(() => [])
      if (results.length === 0) continue

      // 一条链全挂 = 大概率是本机网络问题，这条链的结果整个丢掉
      if (results.every((r) => !r.ok)) {
        logger.warn({ chain: chain.key, count: results.length }, '该链所有 RPC 均探测失败，忽略本次结果')
        continue
      }

      for (const result of results) {
        this.health.set(result.url.toLowerCase(), {
          alive: result.ok,
          ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
          checkedAt,
        })
        result.ok ? (alive += 1) : (dead += 1)
      }
    }

    this.cache.clear() // 排序依据变了，重算
    logger.info({ alive, dead }, dead > 0 ? 'RPC 探活完成，已把不可用的降到最后' : 'RPC 探活完成，全部可用')
  }

  /** 某个 URL 探活的结果。没探过返回 undefined */
  healthOf(url: string): RpcHealth | undefined {
    return this.health.get(url.toLowerCase())
  }

  /** 后端自己用：全部候选 URL，含私有的 */
  urlsFor(chain: Chain): readonly string[] {
    const urls = this.endpointsFor(chain).map((endpoint) => endpoint.url)
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
    return this.endpointsFor(chain)
      .filter((endpoint) => endpoint.public)
      .map((endpoint) => endpoint.url)
  }

  /** 有没有 RPC 可用（用于启动校验，不抛错） */
  hasAny(chain: Chain): boolean {
    return this.endpointsFor(chain).length > 0
  }

  /** 诊断信息：每条链每个来源各提供了几个，运维排查用 */
  describe(chain: Chain): Record<RpcSource, number> {
    const counts = { [RpcSource.LARK]: 0, [RpcSource.ALCHEMY]: 0, [RpcSource.CHAINLIST]: 0 }
    for (const endpoint of this.endpointsFor(chain)) counts[endpoint.source] += 1
    return counts
  }

  /** 这条链有几个探到活的、几个探到死的、几个还没探 */
  healthSummary(chain: Chain): { alive: number; dead: number; unknown: number } {
    const summary = { alive: 0, dead: 0, unknown: 0 }
    for (const endpoint of this.endpointsFor(chain)) {
      const health = this.health.get(endpoint.url.toLowerCase())
      if (!health) summary.unknown += 1
      else if (health.alive) summary.alive += 1
      else summary.dead += 1
    }
    return summary
  }

  get syncedAt(): string {
    return this.file.syncedAt
  }
}

/** 单例：全后端共用 */
export const rpcProvider = new RpcProvider()
