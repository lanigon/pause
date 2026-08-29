import { getAddress, isAddress } from 'ethers'
import type { Chain } from '../../../models/chain.model.js'
import type { BatchHooks, BatchItem, BatchItemResult, BatchOptions, ReadCall, SignPayloadFn } from '../types.js'
import type { ChainAdapter } from '../ChainAdapter.js'
import { runBatch, type BatchStrategy } from '../runner.js'
import { checkHealth, getProvider, readBatch, resetProviders } from './client.js'
import {
  broadcast,
  buildUnsigned,
  checkBalance,
  confirmWithEscalation,
  getTransaction,
  simulate,
} from './tx.js'
import { requireSingleSigner, serializePerSigner } from '../runner.js'
import { evmNonceManager } from './nonce.js'
import { trimSlash } from '../../utils/net.js'

/**
 * EVM 链族适配器。
 * 新增任意 EVM 链（Base / Arbitrum / 任意 L2）只需在 chains.json 加一项，不改这里。
 */
export const evmAdapter: ChainAdapter = {
  name: 'EVM',

  meta: {
    isValidAddress: (address) => isAddress(address),
    // EIP-55 checksum 同时用作比较形式与展示形式
    normalizeAddress: (address) => getAddress(address),
    displayAddress: (address) => getAddress(address),
    explorerTxUrl: (chain, hash) => `${trimSlash(chain.explorer)}/tx/${hash}`,
  },

  tx: {
    readBatch: (chain: Chain, calls: readonly ReadCall[]) => readBatch(chain, calls),
    simulate,
    getTransaction,
    checkBalance,
    checkHealth,
    reset: resetProviders,

    /**
     * 批量执行。序号管理走统一契约（lib/web3/nonce.ts），各链族一致。
     */
    executeBatch(
      chain: Chain,
      items: readonly BatchItem[],
      sign: SignPayloadFn,
      hooks?: BatchHooks,
      options?: BatchOptions,
    ): Promise<readonly BatchItemResult[]> {
      if (items.length === 0) return Promise.resolve([])

      const from = requireSingleSigner(items, getAddress)

      return serializePerSigner(chain.key, from, async () => {
        const nonce = await evmNonceManager(getProvider(chain), from, chain.key)
        for (const warning of nonce.warnings) hooks?.onWarning?.(warning)

        /**
         * 每笔用了哪个 nonce。settle 阶段是并发的，而重发替换交易必须用**同一个** nonce，
         * 所以得按 item 记住，不能只留一个"当前 nonce"。
         */
        const usedNonce = new Map<string, number>()

        const strategy: BatchStrategy = {
          simulate: (item) => simulate(chain, item.request),

          // 取号在这里 —— build 只在预演通过后才被调用，所以预演失败天然不消耗序号
          build: async (item) => {
            const next = nonce.next()!
            usedNonce.set(item.id, next)
            return buildUnsigned(chain, item.request, next)
          },

          // 只有节点收下了才推进；广播失败时序号让给下一笔，不留空洞
          broadcast: async (signed) => {
            const hash = await broadcast(chain, signed)
            nonce.commit()
            return hash
          },

          // 等回执 → 查状态 → 没变就翻倍 gas 同 nonce 重发 → 还不行就自转账让出 nonce
          settle: (item, hash) =>
            confirmWithEscalation({ chain, item, hash, nonce: usedNonce.get(item.id)!, sign }),
        }

        return runBatch(items, sign, strategy, hooks, options)
      })
    },
  },
}
