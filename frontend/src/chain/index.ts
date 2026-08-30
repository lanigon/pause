import { discoverEvm } from './evm/wallet'
import { readEvm } from './evm/read'
import { discoverTron } from './tron/wallet'
import { readTron } from './tron/read'
import { trimSlash, type FamilyMeta, type WalletAdapter } from './types'
import type { Chain, ChainFamily, Contract, ContractState } from '../types'

export type { WalletAdapter, StateReader, FamilyMeta } from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  链族注册表 —— 接入新链的唯一入口
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 加一条新链族（Solana / Aptos）：
 *   1. 新建 chain/<链族>/，实现 discover + readState（见 chain/types.ts 的契约）
 *   2. 在下面的 FAMILIES 里加一项
 *   组件、store、api —— 一行都不用改。
 *
 * 加一条新的 **EVM 链**（Base / Arbitrum）：什么都不用改，后端 chains.json 加就行。
 */
const FAMILY_LIST: readonly FamilyMeta[] = [
  {
    family: 'evm',
    label: 'EVM',
    // 身份就是一个 EVM 地址，所以只有它参与签名登录
    signsIn: true,
    discover: discoverEvm,
    readState: readEvm,
    explorerTxUrl: (chain, hash) => `${trimSlash(chain.explorer)}/tx/${hash}`,
    explorerAddressUrl: (chain, address) => `${trimSlash(chain.explorer)}/address/${address}`,
  },
  {
    family: 'tron',
    label: 'Tron',
    signsIn: false,
    discover: discoverTron,
    readState: readTron,
    // Tron 的路径和 EVM 不一样，拼成 /tx/ 点开是 404
    explorerTxUrl: (chain, hash) => `${trimSlash(chain.explorer)}/transaction/${hash}`,
    explorerAddressUrl: (chain, address) => `${trimSlash(chain.explorer)}/address/${address}`,
  },
]

const BY_FAMILY = new Map(FAMILY_LIST.map((meta) => [meta.family, meta]))

/** 顶栏按链族出按钮，顺序即这里的顺序 */
export const FAMILIES = FAMILY_LIST

/** 没注册的链族返回 undefined —— 调用方要自己决定怎么降级，不要在这里瞎猜 */
export const familyOf = (family: ChainFamily): FamilyMeta | undefined => BY_FAMILY.get(family)

/* ══ 对外的四个能力 ═══════════════════════════════════════════════════ */

/** 这个链族下装了哪些钱包。没注册的返回空列表，界面显示"没有检测到钱包" */
export async function discoverWallets(family: ChainFamily): Promise<readonly WalletAdapter[]> {
  if (typeof window === 'undefined') return []
  return (await familyOf(family)?.discover()) ?? []
}

/**
 * 读一批合约的链上状态，按链分组后各走各的读法。
 *
 * 单条链失败不影响其它链 —— 那条链的合约留空（显示"未知"），
 * 而不是让整次刷新失败。没注册的链族同样留空，**绝不拿 EVM 的逻辑去套异构链**。
 */
export async function readStates(
  chains: readonly Chain[],
  contracts: readonly Contract[],
): Promise<Map<string, ContractState>> {
  const byChain = new Map<string, Contract[]>()
  for (const contract of contracts) {
    const bucket = byChain.get(contract.chain)
    if (bucket) bucket.push(contract)
    else byChain.set(contract.chain, [contract])
  }

  const results = await Promise.all(
    [...byChain.entries()].map(async ([chainKey, group]) => {
      const chain = chains.find((c) => c.key === chainKey)
      const reader = chain && familyOf(chain.type)?.readState
      if (!chain || !reader) return new Map<string, ContractState>()
      try {
        return await reader(chain, group)
      } catch {
        return new Map<string, ContractState>()
      }
    }),
  )

  const merged = new Map<string, ContractState>()
  for (const map of results) for (const [id, state] of map) merged.set(id, state)
  return merged
}

/** 交易 / 合约在区块浏览器上的地址。链族认不出来时返回 '#'，不猜路径 */
export const explorerTxUrl = (chain: Chain | undefined, hash: string): string =>
  chain ? (familyOf(chain.type)?.explorerTxUrl(chain, hash) ?? '#') : '#'

export const explorerAddressUrl = (chain: Chain | undefined, address: string): string =>
  chain ? (familyOf(chain.type)?.explorerAddressUrl(chain, address) ?? '#') : '#'

/* ══ 小工具 ═══════════════════════════════════════════════════════════ */

/** 按链族建一张表，每族一个初值。避免各处手写 { evm: …, tron: … } */
export const byFamily = <T,>(initial: () => T): Record<ChainFamily, T> =>
  Object.fromEntries(FAMILIES.map((f) => [f.family, initial()])) as Record<ChainFamily, T>

/** 这个链族参不参与签名登录 */
export const signsIn = (family: ChainFamily): boolean => familyOf(family)?.signsIn === true

export const shorten = (address: string, head = 6, tail = 4): string =>
  address.length <= head + tail ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
