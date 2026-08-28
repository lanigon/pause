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
import { KeyedMutex } from '../../utils/mutex.js'
import { AppError, ErrorCode } from '../../utils/errors.js'

/** 同一 (chain, address) 的批量任务串行，防 nonce 冲突 */
const nonceMutex = new KeyedMutex()

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
     * 批量执行：整批在一个 nonce 锁内跑完。
     * 基准 nonce 每批现读链上 pending 值（不用本地缓存），只有节点接受才推进。
     */
    executeBatch(
      chain: Chain,
      items: readonly BatchItem[],
      sign: SignPayloadFn,
      hooks?: BatchHooks,
      options?: BatchOptions,
    ): Promise<readonly BatchItemResult[]> {
      if (items.length === 0) return Promise.resolve([])

      const addresses = new Set(items.map((item) => getAddress(item.request.fromAddress)))
      if (addresses.size !== 1) {
        throw new AppError(ErrorCode.INTERNAL, '一批交易必须来自同一个签名地址')
      }
      const from = [...addresses][0]!

      return nonceMutex.runExclusive(`${chain.key}:${from.toLowerCase()}`, async () => {
        const baseNonce = await getProvider(chain).getTransactionCount(from, 'pending')
        let offset = 0

        const strategy: BatchStrategy = {
          nextSequence: () => baseNonce + offset,
          commitSequence: () => {
            offset += 1
          },
          simulate: (item) => simulate(chain, item.request),
          build: (item, sequence) => buildUnsigned(chain, item.request, sequence!),
          broadcast: (signed) => broadcast(chain, signed),
          // 等回执 → 查状态 → 没变就翻倍 gas 同 nonce 重发
          settle: (item, hash, sequence) =>
            confirmWithEscalation({ chain, item, hash, nonce: sequence ?? 0, sign }),
        }

        return runBatch(items, sign, strategy, hooks, options)
      })
    },
  },
}
