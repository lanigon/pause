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
export class RpcProvider {
  private sources: readonly RpcSourceAdapter[] = []
  private file: RpcFile = EMPTY_RPC_FILE
  private readonly cache = new Map<string, readonly RpcEndpoint[]>()

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
   * 解析一条链的 RPC 候选列表，按降级顺序排列。
   * 同一个 URL 在多个来源里出现只保留优先级最高的那次。
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

    this.cache.set(chain.key, merged)
    return merged
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

  get syncedAt(): string {
    return this.file.syncedAt
  }
}

/** 单例：全后端共用 */
export const rpcProvider = new RpcProvider()
