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
import { requireSingleSigner, serializePerSigner } from '../nonce.js'
import { evmNonceManager } from './nonce.js'

const trimSlash = (url: string): string => url.replace(/\/$/, '')

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

        const strategy: BatchStrategy = {
          nextSequence: () => nonce.next(),
          commitSequence: () => nonce.commit(),
          simulate: (item) => simulate(chain, item.request),
          build: (item, sequence) => buildUnsigned(chain, item.request, sequence!),
          broadcast: (signed) => broadcast(chain, signed),
          // 等回执 → 查状态 → 没变就翻倍 gas 同 nonce 重发 → 还不行就自转账让出 nonce
          settle: (item, hash, sequence) =>
            confirmWithEscalation({ chain, item, hash, nonce: sequence ?? 0, sign }),
        }

        return runBatch(items, sign, strategy, hooks, options)
      })
    },
  },
}
