import type { Chain, ChainFamily, Contract, ContractState } from '../types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  链族契约
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 和后端 lib/web3/ChainAdapter.ts 一样的思路：一个接口，各链族一套实现。
 * 这个文件**不依赖任何具体链族** —— evm/ 和 tron/ 都 import 它，反过来不行。
 *
 * 加一条链族：新建 chain/<链族>/，实现下面三样，然后在 chain/index.ts
 * 的注册表里加一行。组件、store 一行都不用改。
 */

/* ══ ① 钱包 ══════════════════════════════════════════════════════════ */

export interface WalletAdapter {
  /** 同链族下的唯一标识（EIP-6963 的 rdns，或链族名） */
  readonly id: string
  readonly family: ChainFamily
  readonly label: string
  /** 钱包图标，钱包自己广播的 data URI */
  readonly icon?: string
  isInstalled(): boolean
  connect(): Promise<string>
  signMessage(message: string): Promise<string>
  /**
   * 发一笔无参的操作交易（pause / unpause）。
   *
   * 传的是**操作名**，不是编码好的 calldata —— 各链族的编码方式根本不同：
   * EVM 要 ABI 编码成 4 字节选择器，Tron 要的是 `pause()` 这样的方法签名字符串。
   * 让调用方去编码的话，它就得知道每条链族的编码规则，
   * 那正是 adapter 该藏起来的东西。
   */
  sendTransaction(chain: Chain, to: string, operation: string): Promise<string>
  /**
   * 当前钱包在哪条链上。无此概念的链族返回 null。
   *
   * switchChain 内部要用它做二次确认 —— 有的钱包在用户取消切链时并不报错，
   * 不复查就会把交易发到测试网上一个**完全无关的合约**，界面还显示成功。
   */
  currentChainId(): Promise<number | null>
  switchChain(chain: Chain): Promise<void>
  /**
   * 订阅账户变更，返回解绑函数。
   *
   * **必须能解绑**：断开登录后监听器还活着的话，用户在钱包里换个账号，
   * 回调仍会把 connected 写成新地址 —— 顶栏显示绿色「已连接」，
   * 实际上没有 operator，什么也做不了。重连时也会一层层叠加监听。
   */
  onAccountChange(handler: (address: string | null) => void): () => void
}

/* ══ ② 读链上状态 ═════════════════════════════════════════════════════ */

/**
 * 读一条链上一批合约的状态。
 *
 * 读不到的合约**不要放进结果**（而不是塞个 false）——
 * "状态未知"和"确定没暂停"是两回事，快捷勾选靠这个区分，
 * 猜错了会让运维对着一个其实已经暂停的合约再点一次暂停。
 */
export type StateReader = (
  chain: Chain,
  contracts: readonly Contract[],
) => Promise<Map<string, ContractState>>

/* ══ ③ 链族元信息 ═════════════════════════════════════════════════════ */

export interface FamilyMeta {
  readonly family: ChainFamily
  /** 顶栏按钮上的名字 */
  readonly label: string
  /** 这个链族的钱包能不能用来签名登录。目前只有 EVM 能 */
  readonly signsIn: boolean
  /** 发现这个链族下装了哪些钱包 */
  discover(): Promise<readonly WalletAdapter[]>
  readState: StateReader
  /**
   * 交易在区块浏览器上的地址。
   * 各链的路径不一样（EVM 是 /tx/，Tron 是 /transaction/），拼错了点开是 404。
   */
  explorerTxUrl(chain: Chain, hash: string): string
  /** 合约地址在区块浏览器上的地址 */
  explorerAddressUrl(chain: Chain, address: string): string
}

/** 去掉末尾斜杠，免得拼出 //tx/ */
export const trimSlash = (url: string): string => url.replace(/\/$/, '')
