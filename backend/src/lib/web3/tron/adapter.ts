import { TronWeb } from 'tronweb'
import type { Chain } from '../../../models/chain.model.js'
import type { BatchHooks, BatchItem, BatchItemResult, BatchOptions, HealthResult, ReadCall, ReadResult, SignPayloadFn } from '../types.js'
import type { ChainAdapter } from '../ChainAdapter.js'
import { runBatch, type BatchStrategy } from '../runner.js'
import { constantCall, getBlockNumber, resetClients, toBase58, toHex41, READ_CONCURRENCY } from './client.js'
import { broadcast, buildTransaction, getTransaction, waitForConfirmation } from './tx.js'
import { redactRpcUrl, withTimeout } from '../evm/client.js'
import { rpcProvider } from '../../rpc/rpcProvider.js'
import { KeyedMutex } from '../../utils/mutex.js'
import { AppError, ErrorCode } from '../../utils/errors.js'

const addressMutex = new KeyedMutex()
const trimSlash = (url: string): string => url.replace(/\/$/, '')

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await fn(items[index]!)
      }
    }),
  )
  return results
}

/**
 * Tron 链族适配器。
 * 没有 nonce（靠 ref_block 防重放）、交易会过期、必须串行广播。
 */
export const tronAdapter: ChainAdapter = {
  name: 'Tron',

  meta: {
    isValidAddress: (address) => TronWeb.isAddress(address),
    // 比较用 hex41，展示用 base58，两者绝不混用
    normalizeAddress: toHex41,
    displayAddress: toBase58,
    explorerTxUrl: (chain, hash) => `${trimSlash(chain.explorer)}/transaction/${hash}`,
  },

  tx: {
    /** Tron 没有 Multicall3，用受限并发替代 */
    readBatch: (chain: Chain, calls: readonly ReadCall[]): Promise<readonly ReadResult[]> =>
      mapWithConcurrency(calls, READ_CONCURRENCY, async (call): Promise<ReadResult> => {
        const result = await constantCall(chain, call.target, call.method, call.returns)
        return { id: call.id, success: result.ok, value: result.value }
      }),

    async simulate(chain: Chain, request) {
      const result = await constantCall(chain, request.contractAddress, request.method)
      return result.ok ? { ok: true } : { ok: false, reason: result.reason }
    },

    getTransaction,

    async checkHealth(chain: Chain, timeoutMs = 4_000): Promise<readonly HealthResult[]> {
      const startedAt = Date.now()
      // 没有可用 RPC 时 urlsFor 会抛，交给调用方处理
      const url = redactRpcUrl(rpcProvider.urlsFor(chain)[0] ?? '')
      try {
        const blockNumber = await withTimeout(getBlockNumber(chain), timeoutMs)
        return [{ url, ok: true, latencyMs: Date.now() - startedAt, blockNumber }]
      } catch {
        return [{ url, ok: false, latencyMs: Date.now() - startedAt, blockNumber: null }]
      }
    },

    reset: resetClients,

    /**
     * 批量执行：整批在地址锁内**严格串行**。
     * 并发广播会因引用同一 ref_block 被判重复交易。
     */
    executeBatch(
      chain: Chain,
      items: readonly BatchItem[],
      sign: SignPayloadFn,
      hooks?: BatchHooks,
      options?: BatchOptions,
    ): Promise<readonly BatchItemResult[]> {
      if (items.length === 0) return Promise.resolve([])

      const addresses = new Set(items.map((item) => toHex41(item.request.fromAddress)))
      if (addresses.size !== 1) {
        throw new AppError(ErrorCode.INTERNAL, '一批交易必须来自同一个签名地址')
      }

      return addressMutex.runExclusive(`${chain.key}:${[...addresses][0]!}`, () => {
        const strategy: BatchStrategy = {
          // 无序号模型：next 恒为 undefined，commit 是空操作
          nextSequence: () => undefined,
          commitSequence: () => undefined,
          simulate: (item) => tronAdapter.tx.simulate(chain, item.request),
          // 每次现场构建：交易含 expiration，约 60s 失效
          build: (item) =>
            buildTransaction(
              chain,
              item.request.contractAddress,
              item.request.fromAddress,
              item.request.method,
            ).then((payload) => ({ family: chain.type, payload })),
          broadcast: (signed) => broadcast(chain, signed),
          settle: async (_item, hash) => ({ ...(await waitForConfirmation(chain, hash)), hash }),
        }

        return runBatch(items, sign, strategy, hooks, options)
      })
    },
  },
}
