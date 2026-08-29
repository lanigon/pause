import { ref } from 'vue'
import * as api from './api'
import { byFamily, signsIn, type WalletAdapter } from '../chain/wallet'
import type { ChainFamily, Operator, SignMode } from '../types'

/**
 * 身份与签名方式。
 *
 * **只有 EVM 钱包用于登录**：身份就是一个 EVM 地址，在白名单里就发 JWT。
 * Tron 钱包只用于「钱包模式」下给 Tron 合约发交易，不参与登录。
 */
export function useSession() {
  const operator = ref<Operator | null>(null)
  const connected = ref<Record<ChainFamily, string | null>>(byFamily<string | null>(() => null))
  /**
   * 每个链族当前用的是哪个钱包。
   * 必须记住 —— 用户装了多个钱包时，发交易要用他连的那个，
   * 不能回头再去猜 window.ethereum 现在是谁。
   */
  const wallets = ref<Record<ChainFamily, WalletAdapter | null>>(byFamily<WalletAdapter | null>(() => null))
  /** 签名模式：tab 切的就是这个 */
  /**
 * 默认钱包签名 —— 它是"用自己的钱包，签之前看得见"的那条路。
 * GPG 走的是后端那把运维密钥，权限更大，要显式切过去才用。
 */
const mode = ref<SignMode>('wallet')

  /** 返回 true 表示这次连接完成了登录，调用方该去加载数据了 */
  async function connect(wallet: WalletAdapter, onDisconnect: () => void): Promise<boolean> {
    const family = wallet.family
    const address = await wallet.connect()
    connected.value = { ...connected.value, [family]: address }
    wallets.value = { ...wallets.value, [family]: wallet }

    wallet.onAccountChange((next) => {
      connected.value = { ...connected.value, [family]: next }
      if (next === null && signsIn(family)) onDisconnect()
    })

    // 不参与登录的链族（Tron）只是连上；已登录的也不用再签一次
    if (!signsIn(family) || operator.value) return false

    const timestamp = Date.now()
    const nonce = api.randomNonce()
    const signature = await wallet.signMessage(api.buildLoginMessage(address, timestamp, nonce))
    const result = await api.login(address, timestamp, nonce, signature)

    api.setToken(result.accessToken)
    operator.value = result.operator
    return true
  }

  function resetSession(): void {
    api.setToken(null)
    operator.value = null
    connected.value = byFamily<string | null>(() => null)
    wallets.value = byFamily<WalletAdapter | null>(() => null)
  }

  return { operator, connected, wallets, mode, connect, resetSession }
}

export type Session = ReturnType<typeof useSession>
