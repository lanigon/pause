import { BrowserProvider, Interface, type Eip1193Provider } from 'ethers'
import { PAUSABLE_ABI, canEncode } from '../abi'
import type { WalletAdapter } from '../types'

/**
 * EVM 钱包（MetaMask / OKX / Rabby 等 EIP-1193）。
 *
 * **一个链族可以有多个钱包** —— 用户同时装好几个是常态，它们会抢
 * window.ethereum，谁最后注入谁赢。所以走 EIP-6963：每个钱包各自广播
 * 自己和自己的 provider，用户点哪个就用哪个，不看那个全局变量。
 */

/** 和 multicall 共用同一份 ABI，免得两处各写一份、改一处漏一处 */
const iface = new Interface(PAUSABLE_ABI)

const encodeOperation = (operation: string): string => {
  // 后端可能下发了前端 ABI 里没有的新操作。在这里挡下来，
  // 否则 ethers 抛的是 "no matching function" 这种查不出所以然的错
  if (!canEncode(operation)) {
    throw new Error(
      `钱包模式暂不支持「${operation}」：前端的 ABI 里没有这个方法。` +
        '改用 GPG 批量（由后端编码），或更新前端后重试。',
    )
  }
  return iface.encodeFunctionData(operation)
}

type InjectedProvider = Eip1193Provider & {
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  /** EIP-1193 要求提供，但老钱包不一定有 —— 没有就退化成解绑无效，不能直接崩 */
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
}

/** EIP-6963：钱包各自广播自己，不再抢 window.ethereum */
interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string }
  provider: InjectedProvider
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

    async sendTransaction(chain, to, operation) {
      await wallet.switchChain(chain)
      const signer = await new BrowserProvider(provider).getSigner()
      // ABI 编码在这里做 —— 平台的操作都是无参的，编出来就是 4 字节选择器
      const tx = await signer.sendTransaction({ to, data: encodeOperation(operation) })
      return tx.hash
    },


    /** 链不存在时（4902）自动添加 */
    async currentChainId() {
      const hex = (await provider.request({ method: 'eth_chainId' })) as string
      return Number.parseInt(hex, 16)
    },

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
      // 监听器提出来命名，解绑时要拿同一个引用才摘得掉
      const listener = (...args: unknown[]): void => {
        const accounts = args[0] as string[] | undefined
        handler(accounts?.[0] ?? null)
      }
      provider.on?.('accountsChanged', listener)
      return () => provider.removeListener?.('accountsChanged', listener)
    },
  }
  return wallet
}

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
export async function discoverEvm(): Promise<readonly WalletAdapter[]> {
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

