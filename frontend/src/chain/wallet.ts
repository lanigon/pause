import { BrowserProvider, type Eip1193Provider } from 'ethers'
import type { Chain, ChainFamily } from '../types'

/**
 * 钱包适配。与后端一样的思路：一个接口，多套实现，按链族分派。
 *
 * **一个链族可以有多个钱包** —— 用户同时装了 MetaMask、OKX、Rabby 是常态，
 * 它们会抢 window.ethereum，谁最后注入谁赢。所以 EVM 侧用 EIP-6963 发现，
 * 每个钱包各自announce 自己和自己的 provider，用户点哪个就用哪个的 provider。
 *
 * 加新链族：实现一份 discover，在 DISCOVERY 里加一行。
 */
export interface WalletAdapter {
  /** 同链族下的唯一标识（EIP-6963 的 rdns，或链族名） */
  readonly id: string
  readonly family: ChainFamily
  readonly label: string
  /** 钱包图标，EIP-6963 给的 data URI */
  readonly icon?: string
  isInstalled(): boolean
  connect(): Promise<string>
  signMessage(message: string): Promise<string>
  /** 发交易。calldata 由调用方编码好 */
  sendTransaction(chain: Chain, to: string, data: string): Promise<string>
  /** 当前所在链（EVM 为 chainId，Tron 返回 null 表示不适用） */
  currentChainId(): Promise<number | null>
  switchChain(chain: Chain): Promise<void>
  onAccountChange(handler: (address: string | null) => void): void
}

type InjectedProvider = Eip1193Provider & {
  on?: (event: string, handler: (...args: unknown[]) => void) => void
}

/** EIP-6963：钱包各自广播自己，不再抢 window.ethereum */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: InjectedProvider
}

declare global {
  interface Window {
    ethereum?: InjectedProvider
    tronLink?: { request: (args: { method: string }) => Promise<unknown> }
    tronWeb?: {
      defaultAddress?: { base58?: string }
      ready?: boolean
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
        sendRawTransaction: (tx: unknown) => Promise<{ txid?: string; transaction?: { txID?: string } }>
        signMessageV2: (message: string) => Promise<string>
      }
    }
  }
}

/* ── EVM（MetaMask / OKX / Rabby 等 EIP-1193 钱包）── */

/**
 * 每个 EVM 钱包绑定**自己的** provider，不共用 window.ethereum ——
 * 装了多个钱包时那个全局变量归谁全看注入顺序，点了 OKX 却用上 MetaMask
 * 是最常见的困惑来源。
 */
function createEvmWallet(
  provider: InjectedProvider,
  label: string,
  id: string,
  icon?: string,
): WalletAdapter {
  const wallet: WalletAdapter = {
    id,
    family: 'evm',
    label,
    icon,

    isInstalled: () => true, // 能被发现就说明装了

    async connect() {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
      const address = accounts[0]
      if (!address) throw new Error('未获得授权账户')
      return address
    },

    async signMessage(message) {
      return (await new BrowserProvider(provider).getSigner()).signMessage(message)
    },

    async sendTransaction(chain, to, data) {
      await wallet.switchChain(chain)
      const signer = await new BrowserProvider(provider).getSigner()
      const tx = await signer.sendTransaction({ to, data })
      return tx.hash
    },

    async currentChainId() {
      const hex = (await provider.request({ method: 'eth_chainId' })) as string
      return Number.parseInt(hex, 16)
    },

    /** 链不存在时（4902）自动添加 */
    async switchChain(chain) {
      const chainIdHex = `0x${chain.chainId.toString(16)}`
      try {
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        })
      } catch (error) {
        if ((error as { code?: number }).code !== 4902) throw error
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: chainIdHex,
              chainName: chain.key,
              rpcUrls: chain.rpcs,
              blockExplorerUrls: [chain.explorer],
              nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: chain.decimals },
            },
          ],
        })
      }
    },

    onAccountChange(handler) {
      provider.on?.('accountsChanged', (...args) => {
        const accounts = args[0] as string[] | undefined
        handler(accounts?.[0] ?? null)
      })
    },
  }
  return wallet
}

/* ── Tron（TronLink）── */

const tronWallet: WalletAdapter = {
  id: 'tronlink',
  family: 'tron',
  label: 'TronLink',

  isInstalled: () => typeof window !== 'undefined' && window.tronLink !== undefined,

  async connect() {
    await window.tronLink?.request({ method: 'tron_requestAccounts' })
    const address = window.tronWeb?.defaultAddress?.base58
    if (!address) throw new Error('TronLink 未解锁或未授权')
    return address
  },

  signMessage: (message) => requireTronWeb().trx.signMessageV2(message),

  async sendTransaction(_chain, to, method) {
    const tronWeb = requireTronWeb()
    const from = tronWeb.defaultAddress?.base58
    if (!from) throw new Error('TronLink 未解锁')

    // Tron 不用 calldata，直接传方法签名。本平台只有无参的 pause()/unpause()
    const built = await tronWeb.transactionBuilder.triggerSmartContract(
      to,
      `${method}()`,
      { feeLimit: 150_000_000, callValue: 0 },
      [],
      from,
    )
    if (!built.result?.result) throw new Error('Tron 交易构建失败')

    const signed = await tronWeb.trx.sign(built.transaction)
    const result = await tronWeb.trx.sendRawTransaction(signed)
    return result.transaction?.txID ?? result.txid ?? ''
  },

  currentChainId: async () => null, // Tron 没有 chainId 切换的概念
  switchChain: async () => undefined,

  onAccountChange(handler) {
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { message?: { action?: string } } | undefined
      if (data?.message?.action === 'accountsChanged') {
        handler(window.tronWeb?.defaultAddress?.base58 ?? null)
      }
    })
  },
}

const requireTronWeb = () => {
  if (!window.tronWeb?.ready) throw new Error('TronLink 未就绪，请解锁后重试')
  return window.tronWeb
}

/* ── 钱包发现 ── */

/** EIP-6963 广播是异步的，给钱包一点时间应答 */
const ANNOUNCE_WINDOW_MS = 300

/**
 * 列出某个链族下装了哪些钱包。
 *
 * EVM 走 EIP-6963：我们喊一声 requestProvider，装了的钱包各自应答，
 * 带上自己的名字、图标和**独立的 provider**。这样多个钱包能并存，
 * 用户点哪个就用哪个 —— 不像 window.ethereum 那样只有一个赢家。
 *
 * 没有任何钱包应答时退回 window.ethereum（老钱包不支持 6963）。
 */
export async function discoverWallets(family: ChainFamily): Promise<readonly WalletAdapter[]> {
  if (typeof window === 'undefined') return []
  if (family === 'tron') return tronWallet.isInstalled() ? [tronWallet] : []
  if (family !== 'evm') return []

  const found = new Map<string, Eip6963Detail>()
  const onAnnounce = (event: Event): void => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail
    if (detail?.info?.rdns) found.set(detail.info.rdns, detail)
  }

  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_WINDOW_MS))
  window.removeEventListener('eip6963:announceProvider', onAnnounce)

  if (found.size > 0) {
    return [...found.values()].map((detail) =>
      createEvmWallet(detail.provider, detail.info.name, detail.info.rdns, detail.info.icon),
    )
  }

  // 老钱包不广播 6963，只注入 window.ethereum
  return window.ethereum ? [createEvmWallet(window.ethereum, '浏览器钱包', 'injected')] : []
}

export const FAMILIES: readonly { family: ChainFamily; label: string; signsIn: boolean }[] = [
  // 只有 EVM 参与登录 —— 身份就是一个 EVM 地址
  { family: 'evm', label: 'EVM', signsIn: true },
  { family: 'tron', label: 'Tron', signsIn: false },
]

export const shorten = (address: string, head = 6, tail = 4): string =>
  address.length <= head + tail ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
