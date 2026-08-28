import type { Chain } from '../../models/chain.model.js'
import { RpcSource, type RpcEndpoint, type RpcFile, type RpcSourceAdapter } from './types.js'

/**
 * 三个 RPC 来源，按 SOURCE_PRIORITY 降级：Lark → Alchemy → ChainList。
 *
 * 共同点：全部是**同步的本地查询**。网络同步由 `npm run sync rpc` 离线做，
 * 请求路径上不做任何外部调用 —— 否则一次页面加载就会被 chainlist.org 的延迟拖住。
 */

/* ══ ① Lark（飞书）—— 优先级最高 ══════════════════════════════════════ */

/**
 * Lark（飞书）来源 —— 优先级最高。
 *
 * 团队在飞书表格上维护各链的 RPC（通常是付费节点或自建节点）。
 * 数据由 `npm run sync:rpc` 离线拉取并写入 data/rpc.json，
 * 请求路径上只读本地文件，不做外网调用。
 *
 * 是否下发前端：Lark 上的 URL 可能含鉴权信息，所以按 URL 形态判断 ——
 * 带 query 参数或路径里像密钥的一律视为私有。
 */
export function createLarkSource(file: RpcFile): RpcSourceAdapter {
  return {
    source: RpcSource.LARK,
    endpointsFor(chain: Chain): readonly RpcEndpoint[] {
      return (file.lark[chain.key] ?? []).map((url) => ({
        url,
        source: RpcSource.LARK,
        public: looksPublic(url),
      }))
    },
  }
}

/**
 * 粗判 URL 是否可公开。
 * 宁可误判为私有（少下发一个 RPC），也不能把带密钥的 URL 发给前端。
 */
function looksPublic(url: string): boolean {
  try {
    const parsed = new URL(url)
    // 有 query 参数 → 多半是 ?apikey=xxx
    if (parsed.search !== '') return false
    // 路径里有长串十六进制/base58 → 多半是路径式密钥
    if (/\/[A-Za-z0-9_-]{20,}/.test(parsed.pathname)) return false
    // 有 basic auth
    if (parsed.username !== '' || parsed.password !== '') return false
    return true
  } catch {
    return false
  }
}

/* ══ ② Alchemy —— 第二优先级 ═════════════════════════════════════════ */

/**
 * Alchemy 来源 —— 第二优先级。
 *
 * 用唯一的环境变量 ALCHEMY_API_KEY 按 chainId 拼 URL。
 * 拼出来的 URL **含密钥，永远 public:false**，只在后端使用，绝不下发前端。
 *
 * 下面这张表是实测出来的：Alchemy 的子域名不是通配 DNS，
 * 不支持的网络（如 arbnova / fantom）域名根本不解析，
 * 所以表里每一项都对应一个真实存在的 Alchemy 端点。
 * 加新链就在这里加一行 chainId → network slug。
 *
 * ⚠️ 注意：**网络是按 app 逐个启用的**。key 有效不代表每条链都能用 ——
 * 没启用的会返回 403「XXX is not enabled for this app」，去 Alchemy dashboard 打开即可。
 * 拿到 403 时 FallbackProvider 会自动退到下一个来源（ChainList），不影响可用性，
 * 只是每次请求多一次无效往返。
 */
const NETWORK_BY_CHAIN_ID: ReadonlyMap<number, string> = new Map([
  // 以太坊
  [1, 'eth-mainnet'],
  [11155111, 'eth-sepolia'],
  [17000, 'eth-holesky'],
  // L2 / Rollup
  [8453, 'base-mainnet'],
  [84532, 'base-sepolia'],
  [42161, 'arb-mainnet'],
  [421614, 'arb-sepolia'],
  [10, 'opt-mainnet'],
  [11155420, 'opt-sepolia'],
  [59144, 'linea-mainnet'],
  [534352, 'scroll-mainnet'],
  [324, 'zksync-mainnet'],
  [1101, 'polygonzkevm-mainnet'],
  [81457, 'blast-mainnet'],
  [5000, 'mantle-mainnet'],
  [130, 'unichain-mainnet'],
  [57073, 'ink-mainnet'],
  [1868, 'soneium-mainnet'],
  [2741, 'abstract-mainnet'],
  [7777777, 'zora-mainnet'],
  [252, 'frax-mainnet'],
  [360, 'shape-mainnet'],
  [480, 'worldchain-mainnet'],
  [2818, 'morph-mainnet'],
  // 侧链 / 独立链
  [137, 'polygon-mainnet'],
  [80002, 'polygon-amoy'],
  [56, 'bnb-mainnet'],
  [97, 'bnb-testnet'],
  [204, 'opbnb-mainnet'],
  [43114, 'avax-mainnet'],
  [100, 'gnosis-mainnet'],
  [42220, 'celo-mainnet'],
  [1088, 'metis-mainnet'],
  [146, 'sonic-mainnet'],
  [80094, 'berachain-mainnet'],
  [33139, 'apechain-mainnet'],
  [666666666, 'degen-mainnet'],
  [2020, 'ronin-mainnet'],
  [1514, 'story-mainnet'],
  [10143, 'monad-testnet'],
  [4663, 'robinhood-mainnet'],
  //
  // ⚠️ 故意不列 Tron（chainId 728126428）。
  // Alchemy 确实有 tron-mainnet 端点，但它讲的是 **EVM 风格 JSON-RPC**；
  // 我们读写 Tron 走的是 TronWeb，它要求 fullHost 提供 **TronGrid REST**
  // （/wallet/triggerconstantcontract 这类路径）。
  // 把 Alchemy 排进 Tron 的候选列表会让 TronWeb 拿到一个路径不兼容的地址，
  // 每次调用都失败再降级。Tron 只用 TronGrid。
])

/** 按 chainId 拼 Alchemy URL；不支持的链返回 null。同步脚本也用这个，保证两边用同一张表 */
export function alchemyUrlFor(chainId: number, apiKey: string): string | null {
  const network = NETWORK_BY_CHAIN_ID.get(chainId)
  return network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : null
}

export function createAlchemySource(apiKey: string | undefined): RpcSourceAdapter {
  return {
    source: RpcSource.ALCHEMY,
    endpointsFor(chain: Chain): readonly RpcEndpoint[] {
      if (!apiKey) return []
      const url = alchemyUrlFor(chain.chainId, apiKey)
      if (!url) return []

      // 含密钥，绝不下发前端
      return [{ url, source: RpcSource.ALCHEMY, public: false }]
    },
  }
}

/* ══ ③ ChainList —— 兜底 ═════════════════════════════════════════════ */

/**
 * ChainList 来源 —— 兜底。
 *
 * chainlist.org 的公开 RPC，质量参差但胜在总有得用。
 * 数据由 `npm run sync:rpc` 离线拉取写入 data/rpc.json。
 *
 * 全部视为公开，可以下发前端。
 */
export function createChainlistSource(file: RpcFile): RpcSourceAdapter {
  return {
    source: RpcSource.CHAINLIST,
    endpointsFor(chain: Chain): readonly RpcEndpoint[] {
      return (file.chainlist[chain.key] ?? [])
        // 过滤掉带占位符的（chainlist 上有些是 https://xxx/${API_KEY} 这种模板）
        .filter((url) => !url.includes('${') && url.startsWith('https://'))
        .map((url) => ({ url, source: RpcSource.CHAINLIST, public: true }))
    },
  }
}
