import type { Chain } from '../../models/chain.model.js'

/**
 * RPC 来源。按这个顺序降级 —— 前面的拿不到才用后面的。
 *
 *   LARK       团队在飞书表格上维护的 RPC（可能是付费/私有节点，最可靠）
 *   ALCHEMY    用 ALCHEMY_API_KEY 拼出来的（稳定，但含密钥，不能下发前端）
 *   CHAINLIST  chainlist.org 的公开 RPC（兜底，质量参差）
 */
export enum RpcSource {
  LARK = 'lark',
  ALCHEMY = 'alchemy',
  CHAINLIST = 'chainlist',
}

/** 降级顺序，改这里就改了优先级 */
export const SOURCE_PRIORITY: readonly RpcSource[] = [
  RpcSource.LARK,
  RpcSource.ALCHEMY,
  RpcSource.CHAINLIST,
]

export interface RpcEndpoint {
  readonly url: string
  readonly source: RpcSource
  /**
   * 能否下发前端。
   * 含 API key 的一律 false —— 前端 multicall 用的 RPC 是后端下发的，
   * 泄露出去等于把付费额度送人。
   */
  readonly public: boolean
}

/**
 * 一个 RPC 来源。加新来源实现这个接口再注册即可。
 * 全部是**同步的本地查询** —— 网络同步由 scripts/syncRpc.ts 离线做，
 * 请求路径上不做外部调用。
 */
export interface RpcSourceAdapter {
  readonly source: RpcSource
  /** 该来源为这条链提供的 RPC，没有就返回空数组 */
  endpointsFor(chain: Chain): readonly RpcEndpoint[]
}

/** 同步脚本产出的文件结构：data/rpc.json */
export interface RpcFile {
  readonly syncedAt: string
  /** chainKey → URL 列表 */
  readonly lark: Readonly<Record<string, readonly string[]>>
  readonly chainlist: Readonly<Record<string, readonly string[]>>
}

export const EMPTY_RPC_FILE: RpcFile = { syncedAt: '', lark: {}, chainlist: {} }
