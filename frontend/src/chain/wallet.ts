import { BrowserProvider, type Eip1193Provider } from 'ethers'
import type { Chain, ChainFamily } from '../types'

/**
 * 钱包适配。与后端一样的思路：一个接口，两套实现，按链族分派。
 * 加新链族就在 ADAPTERS 里加一行。
 */
export interface WalletAdapter {
  readonly family: ChainFamily
  readonly label: string
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

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      on?: (event: string, handler: (...args: unknown[]) => void) => void
    }
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

const evmWallet: WalletAdapter = {
  family: 'evm',
  label: 'EVM 钱包',

  isInstalled: () => typeof window !== 'undefined' && window.ethereum !== undefined,

  async connect() {
    const provider = requireEthereum()
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
    const address = accounts[0]
    if (!address) throw new Error('未获得授权账户')
    return address
  },

  async signMessage(message) {
    const provider = new BrowserProvider(requireEthereum())
    return (await provider.getSigner()).signMessage(message)
  },

  async sendTransaction(chain, to, data) {
    await evmWallet.switchChain(chain)
    const provider = new BrowserProvider(requireEthereum())
    const tx = await (await provider.getSigner()).sendTransaction({ to, data })
    return tx.hash
  },

  async currentChainId() {
    const hex = (await requireEthereum().request({ method: 'eth_chainId' })) as string
    return Number.parseInt(hex, 16)
  },

  /** 链不存在时（4902）自动添加 */
  async switchChain(chain) {
    const provider = requireEthereum()
    const chainIdHex = `0x${chain.chainId.toString(16)}`
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] })
    } catch (error) {
      if ((error as { code?: number }).code !== 4902) throw error
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: chainIdHex,
            chainName: chain.name,
            rpcUrls: chain.rpcs,
            blockExplorerUrls: [chain.explorer],
            nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: chain.decimals },
          },
        ],
      })
    }
  },

  onAccountChange(handler) {
    window.ethereum?.on?.('accountsChanged', (...args) => {
      const accounts = args[0] as string[] | undefined
      handler(accounts?.[0] ?? null)
    })
  },
}

const requireEthereum = () => {
  if (!window.ethereum) throw new Error('未检测到 EVM 钱包，请安装 MetaMask')
  return window.ethereum
}

/* ── Tron（TronLink）── */

const tronWallet: WalletAdapter = {
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

/* ── 注册表 ── */

const ADAPTERS: Record<string, WalletAdapter> = { evm: evmWallet, tron: tronWallet }

export const walletFor = (family: ChainFamily): WalletAdapter => {
  const adapter = ADAPTERS[family]
  if (!adapter) throw new Error(`不支持的链族: ${family}`)
  return adapter
}

export const allWallets = (): WalletAdapter[] => Object.values(ADAPTERS)

export const shorten = (address: string, head = 6, tail = 4): string =>
  address.length <= head + tail ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
