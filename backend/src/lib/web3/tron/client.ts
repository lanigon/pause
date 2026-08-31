import { TronWeb } from 'tronweb'
import type { Chain } from '../../../models/chain.model.js'
import { rpcProvider } from '../../rpc/rpcProvider.js'
import { AppError, ErrorCode } from '../../utils/errors.js'

/**
 * Tron 节点访问：客户端池、地址转换、只读调用、健康探测。
 * 与 EVM 的 evm/client.ts 一一对应。
 */
const clients = new Map<string, TronWeb>()

/** Tron 无 Multicall3，且 TronGrid 有 QPS 限制 */
export const READ_CONCURRENCY = 5

export function getClient(chain: Chain): TronWeb {
  const cached = clients.get(chain.key)
  if (cached) return cached

  // 三级降级后的首选 RPC
  const primary = rpcProvider.urlsFor(chain)[0]
  if (!primary) throw new AppError(ErrorCode.INTERNAL, `${chain.key} 没有可用的 RPC`)

  // 不传 privateKey：父进程只做只读与交易拼装，签名在 GPG 子进程里。
  // 早先塞了个全 0 占位私钥，TronWeb 会直接抛 "Invalid private key provided" ——
  // 全 0 不是合法的 secp256k1 私钥。
  const client = new TronWeb({ fullHost: primary })
  clients.set(chain.key, client)
  return client
}

export const resetClients = (): void => clients.clear()

/* ── 地址：比较用 hex41，展示用 base58，两者绝不混用 ──────────────────── */

/** hex41 → base58；已是 base58 就原样返回 */
export const toBase58 = (address: string): string =>
  address.startsWith('T') ? address : TronWeb.address.fromHex(address)

/** 比较用形式：统一 hex41 小写。绝不能对 Tron 地址走 EVM checksum */
export function toHex41(address: string): string {
  if (!TronWeb.isAddress(address)) {
    throw new AppError(ErrorCode.BAD_REQUEST, `不是合法的 Tron 地址: ${address}`)
  }
  return (address.startsWith('T') ? TronWeb.address.toHex(address) : address).toLowerCase()
}

/* ── 只读 ────────────────────────────────────────────────────────────── */

/**
 * 方法名 → TronWeb 要的函数签名。
 *
 * 这是 Tron 与 EVM 的一个隐蔽差异：ethers 的 Interface 认方法名（`paused`）并自己
 * 查 ABI 补全签名；TronWeb 不认，必须给完整签名（`paused()`），
 * 给方法名会直接 REVERT。本平台只用无参方法，所以补个空括号就够。
 */
const toSelector = (method: string): string => (method.includes('(') ? method : `${method}()`)

/** 只读调用（对应 EVM 的 eth_call）。本平台只读无参的 paused()/owner() */
export async function constantCall(
  chain: Chain,
  contractAddress: string,
  method: string,
  returns?: 'bool' | 'address',
): Promise<{ ok: boolean; value?: unknown; reason?: string }> {
  try {
    const address = toBase58(contractAddress)
    const result = await getClient(chain).transactionBuilder.triggerConstantContract(
      address,
      toSelector(method),
      {},
      [],
      address,
    )
    return result.result?.result
      ? { ok: true, value: decodeConstant(result.constant_result ?? [], returns) }
      : { ok: false, reason: decodeError(result) }
  } catch (error) {
    /**
     * 刻意不用 messageOf。
     *
     * 两者对 Error 的处理是一样的（实测 tronweb 无论网络层还是 API 层
     * 抛的都是 Error 子类），区别只在**兜底**：messageOf 用 String(error)，
     * 而这个 reason 会原样显示给运维看 —— 万一拿到的是个普通对象，
     * 屏幕上就是 [object Object]，不如退回一句人能读懂的话。
     */
    return { ok: false, reason: error instanceof Error ? error.message : 'Tron 调用失败' }
  }
}

/**
 * constant_result 是一串裸 hex，得靠调用方告诉我们它是什么类型。
 *
 * bool 严格校验只能是 0 或 1 —— 返回别的值说明这个地址不是我们以为的合约
 * （和 EVM 侧同样的防呆，见 evm/client.ts 的 decodeCall）。
 */
function decodeConstant(constantResult: readonly string[], returns?: 'bool' | 'address'): unknown {
  const first = constantResult[0]
  if (first === undefined) return null
  const raw = first.replace(/^0x/, '')

  if (returns === 'bool') {
    if (raw.length !== 64 || !/^0{63}[01]$/.test(raw)) {
      throw new Error('bool 返回值不是 0 或 1，该地址可能不是预期的合约')
    }
    return raw.endsWith('1')
  }

  if (returns === 'address') {
    // 32 字节补零的地址 → 取后 20 字节 → Tron 的 41 前缀 → base58
    if (raw.length !== 64) return `0x${raw}`
    return toBase58(`41${raw.slice(24)}`)
  }

  // 没声明类型就按老规矩：形状像 bool 就当 bool，否则原样给 hex
  if (/^0{63}[01]$/.test(raw)) return raw.endsWith('1')
  return `0x${raw}`
}

/** Tron 把 revert 信息放在 hex 编码的 message 里 */
export function decodeError(result: { result?: { message?: string }; message?: string }): string | undefined {
  const hex = result.result?.message ?? result.message
  if (!hex) return undefined
  try {
    return Buffer.from(hex, 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '').trim() || hex
  } catch {
    return hex
  }
}

export { toSelector }

/** 探活用：指定某个 URL 单独问一次，不走缓存的首选客户端 */
export async function getBlockNumberAt(url: string): Promise<number | null> {
  return blockNumberOf(new TronWeb({ fullHost: url }))
}

async function blockNumberOf(client: TronWeb): Promise<number | null> {
  const block = (await client.trx.getCurrentBlock()) as {
    block_header?: { raw_data?: { number?: number } }
  }
  return block.block_header?.raw_data?.number ?? null
}
