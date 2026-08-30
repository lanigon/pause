import type { Eip1193Provider } from 'ethers'

/**
 * 钱包注入到 window 上的东西。
 * 单独成文件是因为 declare global 只需要一份，各链族的实现文件里再写会重复声明。
 */
declare global {
  interface Window {
    ethereum?: InjectedProvider
    /** 新版 TronLink */
    tron?: TronProvider
    /** 老版 TronLink */
    tronLink?: { request: (args: { method: string }) => Promise<unknown> }
    tronWeb?: TronWebApi
  }
}

