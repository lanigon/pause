import { Contract, FallbackProvider, Interface, JsonRpcProvider, Network, type Provider } from 'ethers'
import type { Chain } from '../../../models/chain.model.js'
import type { HealthResult, ReadCall, ReadResult } from '../types.js'
import { PAUSABLE_ABI } from '../abi.js'
import { rpcProvider } from '../../rpc/rpcProvider.js'
import { logger } from '../../utils/logger.js'

/**
 * EVM 节点访问：provider 池 + 批量只读 + 健康探测。
 *
 * 多个 RPC 组成 FallbackProvider：单点超时/报错自动切下一个。
 * provider 按 chainKey 缓存，配置热重载时由 reset() 清空。
 */
const providers = new Map<string, Provider>()

const iface = new Interface(PAUSABLE_ABI as unknown as string[])

export function getProvider(chain: Chain): Provider {
  const cached = providers.get(chain.key)
  if (cached) return cached

  // staticNetwork：链 id 固定，省掉每次请求前的 eth_chainId 探测
  const network = Network.from(chain.chainId)
  // 三级降级后的候选列表：Lark → Alchemy → ChainList
  const urls = rpcProvider.urlsFor(chain)

  const created: Provider =
    urls.length === 1
      ? new JsonRpcProvider(urls[0]!, network, { staticNetwork: network })
      : new FallbackProvider(
          urls.map((url, index) => ({
            provider: new JsonRpcProvider(url, network, { staticNetwork: network }),
            priority: index + 1,
            weight: Math.max(1, urls.length - index),
            stallTimeout: 2_000,
          })),
          network,
          { quorum: 1 }, // 运维读操作不需要多节点共识，取最快的
        )

  providers.set(chain.key, created)
  logger.debug({ chain: chain.key, rpcCount: urls.length }, 'EVM provider 已创建')
  return created
}

export function resetProviders(): void {
  for (const provider of providers.values()) provider.destroy?.()
  providers.clear()
}

export const encodeCall = (method: string, args: readonly unknown[]): string =>
  iface.encodeFunctionData(method, args as never[])

/**
 * 解码返回值。
 *
 * bool 额外做严格校验：ethers 会把任何非零值当成 true，
 * 但一个真正的 Pausable 合约只会返回 0 或 1。返回别的值说明这个地址
 * 根本不是我们以为的合约（比如误配成了预编译地址 0x…0002，
 * 它对任意 calldata 都返回哈希，会被解成 true），这时候宁可当作读不到。
 */
export function decodeCall(method: string, data: string): unknown {
  const decoded = iface.decodeFunctionResult(method, data)
  const value = decoded.length === 1 ? decoded[0] : decoded.toArray()

  if (typeof value === 'boolean') {
    const raw = data.replace(/^0x/, '')
    if (raw.length !== 64 || !/^0{63}[01]$/.test(raw)) {
      throw new Error('bool 返回值不是 0 或 1，该地址可能不是预期的合约')
    }
  }
  return value
}

const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]

/**
 * 一次 RPC 读回一批合约状态。
 * chain.multicall3 为 null 时回退到并发单点调用。
 */
export async function readBatch(chain: Chain, calls: readonly ReadCall[]): Promise<readonly ReadResult[]> {
  if (calls.length === 0) return []
  const provider = getProvider(chain)
  if (!chain.multicall3) return fallbackRead(provider, calls)

  try {
    const multicall = new Contract(chain.multicall3, MULTICALL3_ABI, provider)
    const payload = calls.map((call) => ({
      target: call.target,
      allowFailure: true, // 单个合约 revert 不能拖垮整批
      callData: encodeCall(call.method, call.args),
    }))

    const raw = (await multicall.aggregate3!.staticCall(payload)) as readonly [boolean, string][]

    return calls.map((call, index): ReadResult => {
      const entry = raw[index]
      if (!entry?.[0]) return { id: call.id, success: false }
      try {
        return { id: call.id, success: true, value: decodeCall(call.method, entry[1]) }
      } catch {
        return { id: call.id, success: false }
      }
    })
  } catch (error) {
    logger.warn(
      { chain: chain.key, error: error instanceof Error ? error.message : error },
      'multicall 失败，回退到并发单点调用',
    )
    return fallbackRead(provider, calls)
  }
}

const fallbackRead = (provider: Provider, calls: readonly ReadCall[]): Promise<ReadResult[]> =>
  Promise.all(
    calls.map(async (call): Promise<ReadResult> => {
      try {
        const data = await provider.call({ to: call.target, data: encodeCall(call.method, call.args) })
        return { id: call.id, success: true, value: decodeCall(call.method, data) }
      } catch {
        return { id: call.id, success: false }
      }
    }),
  )

/**
 * 逐个 RPC 单独探测（不走 FallbackProvider，否则测不出单点故障）。
 *
 * 必须是 async —— urlsFor 在没有可用 RPC 时会**同步抛错**，
 * 非 async 函数里这个异常会在 Promise 创建之前就抛出去，
 * 调用方的 .catch() 根本接不住，一条链没 RPC 就能让整个健康接口 500。
 */
export async function checkHealth(chain: Chain, timeoutMs = 4_000): Promise<HealthResult[]> {
  const network = Network.from(chain.chainId)

  return Promise.all(
    rpcProvider.urlsFor(chain).map(async (url): Promise<HealthResult> => {
      const startedAt = Date.now()
      const probe = new JsonRpcProvider(url, network, { staticNetwork: network })
      try {
        const blockNumber = await withTimeout(probe.getBlockNumber(), timeoutMs)
        return { url: redactRpcUrl(url), ok: true, latencyMs: Date.now() - startedAt, blockNumber }
      } catch {
        return { url: redactRpcUrl(url), ok: false, latencyMs: Date.now() - startedAt, blockNumber: null }
      } finally {
        probe.destroy()
      }
    }),
  )
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ])
}

/** 带 apiKey 的 RPC 只暴露 host，不泄露完整 URL */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '[invalid-url]'
  }
}
