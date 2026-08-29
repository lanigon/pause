import type { Chain } from '../../models/chain.model.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RPC 节点
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一个节点知道三件事：**属于哪条链**、从哪来、能不能给前端。
 * 整个 RPC 层就是围着这个结构转的 —— 拼出一条链的候选列表，排个序，交出去。
 *
 * 三个来源按顺序降级，前面的拿不到才用后面的：
 *   lark       团队在飞书上维护的（付费/自建节点，最可靠）
 *   alchemy    用 ALCHEMY_API_KEY 拼的（稳定，但含密钥，不能下发前端）
 *   chainlist  chainlist.org 的公开节点（兜底，质量参差）
 *
 * 全部是**同步的本地查询**。网络同步由 `npm run sync rpc` 离线做，
 * 请求路径上不做外网调用 —— 否则一次页面加载就会被 chainlist.org 的延迟拖住。
 */
export type RpcSource = 'lark' | 'alchemy' | 'chainlist'

export interface RpcEndpoint {
  /** 属于哪条链 */
  readonly chainKey: string
  readonly url: string
  readonly source: RpcSource
  /**
   * 能否下发前端。
   * 含 API key 的一律 false —— 前端 multicall 用的 RPC 是后端下发的，
   * 泄露出去等于把付费额度送人。
   */
  readonly public: boolean
}

/** `npm run sync rpc` 产出的 data/rpc.json */
export interface RpcFile {
  readonly syncedAt: string
  /** chainKey → URL 列表 */
  readonly lark: Readonly<Record<string, readonly string[]>>
  readonly chainlist: Readonly<Record<string, readonly string[]>>
}

export const EMPTY_RPC_FILE: RpcFile = { syncedAt: '', lark: {}, chainlist: {} }

/**
 * 拼出一条链的全部候选，按来源优先级排列并去重。
 * 同一个 URL 在多个来源里出现，只保留优先级最高的那次。
 */
export function endpointsOf(
  chain: Chain,
  file: RpcFile,
  alchemyKey: string | undefined,
): readonly RpcEndpoint[] {
  const seen = new Set<string>()
  const merged: RpcEndpoint[] = []

  const take = (endpoints: readonly RpcEndpoint[]): void => {
    for (const endpoint of endpoints) {
      const key = endpoint.url.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(endpoint)
    }
  }

  // 顺序即优先级
  take(fromLark(chain, file))
  take(fromAlchemy(chain, alchemyKey))
  take(fromChainlist(chain, file))

  return merged
}

/** 飞书上维护的。URL 可能含鉴权信息，按形态判断能不能公开 */
const fromLark = (chain: Chain, file: RpcFile): readonly RpcEndpoint[] =>
  (file.lark[chain.key] ?? []).map((url) => ({
    chainKey: chain.key,
    url,
    source: 'lark' as const,
    public: looksPublic(url),
  }))

/** chainlist 上有些是 https://xxx/${API_KEY} 这种模板，过滤掉。其余都可公开 */
const fromChainlist = (chain: Chain, file: RpcFile): readonly RpcEndpoint[] =>
  (file.chainlist[chain.key] ?? [])
    .filter((url) => !url.includes('${') && url.startsWith('https://'))
    .map((url) => ({ chainKey: chain.key, url, source: 'chainlist' as const, public: true }))

/** 按 chainId 拼。含密钥，**永远不下发前端** */
function fromAlchemy(chain: Chain, apiKey: string | undefined): readonly RpcEndpoint[] {
  if (!apiKey) return []
  const url = alchemyUrlFor(chain.chainId, apiKey)
  return url ? [{ chainKey: chain.key, url, source: 'alchemy', public: false }] : []
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
    // 路径里有长串 → 多半是路径式密钥
    if (/\/[A-Za-z0-9_-]{20,}/.test(parsed.pathname)) return false
    // 有 basic auth
    if (parsed.username !== '' || parsed.password !== '') return false
    return true
  } catch {
    return false
  }
}

/**
 * chainId → Alchemy 的网络名。
 *
 * 这张表是实测出来的：Alchemy 的子域名不是通配 DNS，不支持的网络域名
 * 根本不解析，所以表里每一项都对应一个真实存在的端点。加新链加一行即可。
 *
 * ⚠️ **网络是按 app 逐个启用的**。key 有效不代表每条链都能用 ——
 * 没启用的返回 403「XXX is not enabled for this app」，去 dashboard 打开。
 * 拿到 403 时会自动退到 ChainList，不影响可用性，只是多一次无效往返。
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
  // 把 Alchemy 排进 Tron 的候选会让 TronWeb 拿到一个路径不兼容的地址，
  // 每次调用都失败再降级。Tron 只用 TronGrid。
])

/** 同步脚本也用这个，保证两边用同一张表 */
export function alchemyUrlFor(chainId: number, apiKey: string): string | null {
  const network = NETWORK_BY_CHAIN_ID.get(chainId)
  return network ? `https://${network}.g.alchemy.com/v2/${apiKey}` : null
}
