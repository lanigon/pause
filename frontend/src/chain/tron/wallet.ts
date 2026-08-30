import type { WalletAdapter } from '../types'

/** TIP-6963 广播是异步的，给钱包一点时间应答 */
const ANNOUNCE_WINDOW_MS = 300

/**
 * Tron 钱包（TronLink 及兼容钱包）。
 *
 * 两代并存：新版 window.tron 走 TIP-6963 广播发现 + eth_requestAccounts；
 * 老版只有 window.tronLink / window.tronWeb，靠全局 message 事件通知换号。
 */

/** TIP-6963：Tron 侧的同一套机制，只是 provider 换成了 TronProvider */
interface Tip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: TronProvider
}

/** tronWeb 上我们真正用到的部分。交易构建与签名两代 TronLink 都走它 */
interface TronWebApi {
  defaultAddress?: { base58?: string }
  ready?: boolean
  /** 当前连的节点。老版没有读 chainId 的能力，只能靠它判断网络 */
  fullNode?: { host?: string }
  transactionBuilder: {
    triggerSmartContract: (
      address: string,
      selector: string,
      options: Record<string, unknown>,
      params: unknown[],
      from: string,
    ) => Promise<{ transaction: unknown; result?: { result?: boolean } }>
  }
  trx: {
    sign: (tx: unknown) => Promise<unknown>
    sendRawTransaction: (tx: unknown) => Promise<TronBroadcastResult>
    signMessageV2: (message: string) => Promise<string>
  }
}

/**
 * 广播结果。
 *
 * **`result` 才是「节点收下了没有」** —— `txid` 是签名时本地算出来的，
 * 广播被拒绝它照样有值。只看 txid 会把失败当成功。
 */
interface TronBroadcastResult {
  result?: boolean
  code?: string
  message?: string
  txid?: string
  transaction?: { txID?: string }
}

/**
 * 新版 TronLink 的 provider（TIP-1193），挂在 window.tron。
 * 形状和 EIP-1193 基本一致：request / on，chainId 用 EIP 风格的 hex。
 */
interface TronProvider {
  /** TronLink 会置 true，别的 Tron 钱包也可能注入 window.tron */
  isTronLink?: boolean
  request: (args: { method: string; params?: unknown }) => Promise<unknown>
  /** 授权前是 false */
  tronWeb?: TronWebApi | false
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

/** 老版 tron_requestAccounts 的返回：200 成功 / 4000 已在队列 / 4001 用户拒绝 */
interface TronAuthResult {
  code?: number
  message?: string
}

/* ── Tron（TronLink）── */

/**
 * TronLink 有新老两代接口，都要支持：
 *
 *   新版  window.tron —— TIP-6963 广播发现、eth_requestAccounts 授权、
 *         eth_chainId 读链、wallet_switchEthereumChain（TIP-3326）切链、
 *         accountsChanged / chainChanged 事件。形状和 EIP-1193 基本一致，
 *         所以下面这份实现和上面 EVM 那份是对称的。
 *   老版  window.tronLink + window.tronWeb —— 只有 tron_requestAccounts，
 *         没有读链/切链能力，只能靠 tronWeb.fullNode.host 反推在哪个网络。
 *
 * 两代的差别只在「连接 / 读链 / 切链」，交易构建与广播都得经 tronWeb
 * （Tron 没有 calldata 那一套），那部分是同一份代码。
 */

/** 默认手续费上限：150 TRX（单位 sun），与后端 tron/tx.ts 保持一致 */
const TRON_FEE_LIMIT = 150_000_000

const toHexChainId = (chainId: number): string => `0x${chainId.toString(16)}`

/**
 * 取这个钱包**自己的** tronWeb。
 *
 * 选定了 provider 就只认 provider.tronWeb，**绝不回落到 window.tronWeb** ——
 * 装了多个 Tron 钱包时那个全局变量归谁全看注入顺序，回落等于
 * 「点了 A 却用 B 签名」，正是 TIP-6963 要消灭的问题（见上面 EVM 的同款注释）。
 *
 * 新版 provider 的 tronWeb 在授权前是 false，所以 connect 里先 authorize 再取。
 * 只有老版（provider 为 null）才用全局的那个。
 */
const tronWebOf = (provider: TronProvider | null): TronWebApi | undefined =>
  (provider ? provider.tronWeb || undefined : window.tronWeb) ?? undefined

const requireTronWeb = (provider: TronProvider | null): TronWebApi => {
  const tronWeb = tronWebOf(provider)
  if (!tronWeb?.ready) throw new Error('TronLink 未就绪，请解锁后重试')
  return tronWeb
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Tron 的错误信息常常是 hex 编码的，直接抛给运维看是一串乱码 */
function decodeTronMessage(raw?: string): string | undefined {
  if (!raw) return undefined
  if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return raw
  const text = (raw.match(/../g) ?? [])
    .map((byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .join('')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
  return text || raw
}

const broadcastError = (result?: TronBroadcastResult): string =>
  decodeTronMessage(result?.message) ?? result?.code ?? 'Tron 广播被节点拒绝'

/**
 * 老版只能用 window.postMessage 收账户变更，而 message 是**任何** iframe /
 * 第三方脚本都能发的。所以：只认来自本窗口的消息，且全局只装一个监听器
 * （每次 connect 都 addEventListener 会不断累积）。
 */
let legacyAccountHandler: ((address: string | null) => void) | null = null
let legacyListenerInstalled = false

function installLegacyAccountListener(): void {
  if (legacyListenerInstalled) return
  legacyListenerInstalled = true
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return
    const action = (event.data as { message?: { action?: string } } | undefined)?.message?.action
    if (action === 'accountsChanged' || action === 'setAccount') {
      legacyAccountHandler?.(window.tronWeb?.defaultAddress?.base58 ?? null)
    }
  })
}

/**
 * provider 为 null 表示走老版接口。
 * 新版每个钱包绑定自己的 provider，理由和 EVM 那边一样。
 */
function createTronWallet(
  provider: TronProvider | null,
  label: string,
  id: string,
  icon?: string,
): WalletAdapter {
  /** 授权。两代的方法名和返回约定都不同 */
  async function authorize(): Promise<void> {
    if (provider) {
      // 标准 EIP-1193 语义：用户拒绝会抛 4001，钱包锁定时 20 秒内重复请求抛 -32000
      await provider.request({ method: 'eth_requestAccounts' })
      return
    }
    const legacy = window.tronLink
    if (!legacy) throw new Error('没有检测到 TronLink，请先安装插件')

    const result = (await legacy.request({ method: 'tron_requestAccounts' })) as
      | TronAuthResult
      | undefined
    // 旧接口不抛错，只在返回码里体现 —— 不看的话「用户点了拒绝」会被当成连接成功
    if (result?.code === 4001) throw new Error('已在 TronLink 中拒绝授权')
    if (result?.code !== undefined && result.code !== 200 && result.code !== 4000) {
      throw new Error(decodeTronMessage(result.message) ?? `TronLink 授权失败（code ${result.code}）`)
    }
  }

  const wallet: WalletAdapter = {
    id,
    family: 'tron',
    label,
    icon,

    isInstalled: () => provider !== null || window.tronLink !== undefined,

    async connect() {
      await authorize()
      // 地址一律取 tronWeb 的 base58 —— 后端比较地址用的就是这个形式
      const address = requireTronWeb(provider).defaultAddress?.base58
      if (!address) throw new Error('TronLink 未解锁，或尚未授权本站')
      return address
    },

    signMessage: (message) => requireTronWeb(provider).trx.signMessageV2(message),

    /** 老版没有 eth_chainId，读不到就返回 null，由 switchChain 走 host 兜底 */

    /**
     * 确保钱包停在目标网络上。
     *
     * TronLink 可以切到 Nile / Shasta 测试网，而界面显示的是主网合约地址 ——
     * 发过去要么失败，要么打到测试网上一个**完全无关的合约**。
     * 紧急暂停时这等于没暂停，却会显示成功，所以这一步不能省。
     */
    async currentChainId() {
      if (!provider) return null
      try {
        const hex = (await provider.request({ method: 'eth_chainId' })) as string
        const id = Number.parseInt(hex, 16)
        return Number.isNaN(id) ? null : id
      } catch {
        return null
      }
    },

    async switchChain(chain) {
      const current = await wallet.currentChainId()
      if (current === chain.chainId) return

      if (provider) {
        // TIP-3326，和 EVM 的 wallet_switchEthereumChain 是同一个方法
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: toHexChainId(chain.chainId) }],
        })
        // 再读一次确认：有的钱包在用户取消时并不报错
        const after = await wallet.currentChainId()
        if (after !== null && after !== chain.chainId) {
          throw new Error(`TronLink 仍未切到 ${chain.key}，请手动切换后重试`)
        }
        return
      }

      // 老版：切不了，只能核对当前节点。对不上就拒绝发送，别赌
      const host = tronWebOf(provider)?.fullNode?.host
      const expected = chain.rpcs.map(hostOf).filter(Boolean)
      if (host && expected.length > 0 && !expected.includes(hostOf(host) || host)) {
        throw new Error(
          `TronLink 当前连的是 ${host}，不是 ${chain.key}（${expected[0]}）。` +
            '请在 TronLink 里切换网络后重试',
        )
      }
    },

    async sendTransaction(chain, to, method) {
      // 和 EVM 同样的顺序：先保证在对的网络上，再发
      await wallet.switchChain(chain)

      const tronWeb = requireTronWeb(provider)
      const from = tronWeb.defaultAddress?.base58
      if (!from) throw new Error('TronLink 未解锁')

      // Tron 不用 calldata，直接传方法签名。本平台只有无参的 pause()/unpause()
      const built = await tronWeb.transactionBuilder.triggerSmartContract(
        to,
        `${method}()`,
        { feeLimit: TRON_FEE_LIMIT, callValue: 0 },
        [],
        from,
      )
      if (!built.result?.result) throw new Error('Tron 交易构建失败')

      const signed = await tronWeb.trx.sign(built.transaction)
      const result = await tronWeb.trx.sendRawTransaction(signed)

      /**
       * 必须看 result —— txID 是签名时本地算出来的，广播被拒绝它照样有值。
       * 不检查的话会返回一个从未上链的哈希，上层当成「已广播」记进操作日志，
       * 界面还会显示成功。后端 lib/web3/tron/tx.ts 就是这么判的，两边保持一致。
       */
      if (!result?.result) throw new Error(broadcastError(result))

      const hash = result.transaction?.txID ?? result.txid
      if (!hash) throw new Error('Tron 广播已被接受，但没拿到交易哈希')
      return hash
    },

    onAccountChange(handler) {
      if (provider?.on) {
        const listener = (): void =>
          handler(tronWebOf(provider)?.defaultAddress?.base58 ?? null)
        provider.on('accountsChanged', listener)
        return () => provider.removeListener?.('accountsChanged', listener)
      }
      legacyAccountHandler = handler
      installLegacyAccountListener()
      // 全局只有一个 message 监听器（见上），所以解绑就是摘掉回调；
      // 比对一下是不是自己那个，免得把后来者装的回调也摘了
      return () => {
        if (legacyAccountHandler === handler) legacyAccountHandler = null
      }
    },
  }

  return wallet
}

/**
 * Tron 侧的钱包发现。
 *
 * 走 TIP-6963 —— 和 EVM 的 EIP-6963 是同一套机制，连事件名都对应。
 *
 * ⚠ 大小写不一样，别"顺手统一"：EVM 侧是小写 `eip6963:`，
 *   Tron 侧规范写的是大写 `TIP6963:`，改成小写就收不到应答了。
 *
 * 这同时解决了一个老问题：TronLink 是**异步注入**的，进页面时同步检查
 * window.tronLink 基本必然落空，用户明明装了却显示「没有检测到」。
 * 广播 + 应答窗口天然给了它注入的时间。
 *
 * 没有应答就依次退到 window.tron（新版但不支持广播）与 window.tronLink（老版）。
 */
export async function discoverTron(): Promise<readonly WalletAdapter[]> {
  const found = new Map<string, Tip6963Detail>()
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<Tip6963Detail>).detail
    if (detail?.info?.rdns) found.set(detail.info.rdns, detail)
  }

  window.addEventListener('TIP6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('TIP6963:requestProvider'))
  await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_WINDOW_MS))
  window.removeEventListener('TIP6963:announceProvider', onAnnounce)

  if (found.size > 0) {
    return [...found.values()].map((detail) =>
      createTronWallet(detail.provider, detail.info.name, detail.info.rdns, detail.info.icon),
    )
  }

  // 注入 window.tron 的不一定是 TronLink（OKX / Bitget 等也会），按 isTronLink 标名
  if (window.tron) {
    const isTronLink = window.tron.isTronLink === true
    return [
      createTronWallet(window.tron, isTronLink ? 'TronLink' : 'Tron 钱包', isTronLink ? 'tronlink' : 'tron'),
    ]
  }
  if (window.tronLink) return [createTronWallet(null, 'TronLink', 'tronlink')]
  return []
}

