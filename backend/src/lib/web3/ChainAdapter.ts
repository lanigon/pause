import type { Chain } from '../../models/chain.model.js'
import type { ChainFamily } from './types.js'
import type {
  BalanceCheck,
  BatchHooks,
  BatchItem,
  BatchItemResult,
  BatchOptions,
  CallRequest,
  HealthResult,
  ReadCall,
  ReadResult,
  SignPayloadFn,
  SimulateResult,
  TransactionSnapshot,
} from './types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ChainAdapter —— 接入一条新链族时要实现的全部内容
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一个链族 = 两个 adapter：
 *
 *   meta   元数据。**纯函数，不碰网络** —— 只回答"这条链的地址长什么样、
 *          浏览器链接怎么拼"。校验配置、拼审计信息、格式化日志都要用地址逻辑，
 *          但不该为此起节点；单测也不用 mock 网络。
 *
 *   tx     交易。**所有网络 IO 都在这** —— 读链上数据、预演、拼装、广播、等确认。
 *          重连、限流、序号锁、批量策略这些脏活全关在这个盒子里。
 *
 * 用什么签名算法、手续费怎么算、要不要 nonce —— 全是 adapter 内部的事，
 * 不往接口上暴露。上层只知道"交一批调用进去，出来一批结果"。
 *
 * 实现完在 web3/chains.ts 注册一行，services / controllers / routes / 前端零改动。
 * 链族标识是字符串不是枚举，所以连枚举定义都不用改。
 *
 * 参考实现（两边文件结构一一对应，照着任一份改都能接出新链族）：
 *   web3/evm/{client,tx,adapter}.ts     有 nonce、有 Multicall3、有 gas 阶梯重发
 *   web3/tron/{client,tx,adapter}.ts    无 nonce、无批量读、交易会过期
 */
export interface ChainMetaAdapter {
  /** 地址是否符合本链族格式（不抛错，用于校验分支） */
  isValidAddress(address: string): boolean

  /**
   * 归一化为**比较用**形式。
   * EVM → EIP-55 checksum；Tron → hex41 小写。
   * 两者绝不混用 —— 拿 EVM checksum 去比 Tron 地址会误判 owner。
   */
  normalizeAddress(address: string): string

  /** 转为**展示用**形式。EVM → checksum；Tron → base58 */
  displayAddress(address: string): string

  explorerTxUrl(chain: Chain, hash: string): string
}

/**
 * 三条实现约定，违反会出安全问题：
 *
 *  A. 签名材料**绝不能**写进日志、返回值或任何持久状态 ——
 *     一笔已签名的 pause 泄露出去，任何人都能事后重放它。
 *  B. 待签名负载是不透明的，不要为了"统一"把它拍平成 EVM 的形状。
 *     EVM 的 nonce/gasPrice 与 Tron 的 ref_block/expiration 各装各的。
 *  C. `executeBatch` 即使链上没有 nonce 概念，也必须对同一地址加锁串行 ——
 *     并发广播在 Tron 会因 ref_block 相同被判重复交易。
 */
export interface ChainTxAdapter {
  /* ── 读 ── */

  /** 批量只读。有原生批量接口就用（EVM Multicall3），没有就受限并发（Tron） */
  readBatch(chain: Chain, calls: readonly ReadCall[]): Promise<readonly ReadResult[]>

  /**
   * 预演。EVM 是 eth_call + estimateGas 两步。
   * **不是**安全边界 —— 从这里到打包之间状态仍可能变化，真正的不变量由合约保证。
   */
  simulate(chain: Chain, request: CallRequest): Promise<SimulateResult>

  /** 按 hash 读一笔交易的当前状态 */
  getTransaction(chain: Chain, hash: string): Promise<TransactionSnapshot>

  /* ── 写 ── */

  /**
   * ★ 批量执行 —— 上层唯一需要调的写入口。
   *
   * 序号分配、加锁、并发广播策略全部由 adapter 内部决定，
   * 上层不需要知道 EVM 有 nonce 而 Tron 没有。
   *
   * 约定：预演失败标 SKIPPED 且不消耗序号；单笔失败不中断整批；
   * 签名回调抛错说明密钥有问题，整批中止（抛 SigningAbortedError）。
   *
   * 公共循环在 web3/executor/runner.ts —— 实现时提供一个 BatchStrategy 即可，
   * 这些规则不用重写。
   */
  executeBatch(
    chain: Chain,
    items: readonly BatchItem[],
    sign: SignPayloadFn,
    hooks?: BatchHooks,
    options?: BatchOptions,
  ): Promise<readonly BatchItemResult[]>

  /* ── 运维 ── */

  /**
   * 签名地址的余额还够发几笔。
   * 不适用的链族（如 Tron 用能量模型）不实现，上层自动跳过这项检查。
   */
  checkBalance?(chain: Chain, address: string, gasLimit: bigint): Promise<BalanceCheck | null>

  /** 逐个 RPC 探测健康（不走 fallback，否则测不出单点故障） */
  checkHealth(chain: Chain, timeoutMs?: number): Promise<readonly HealthResult[]>

  /** 配置热重载后清空连接缓存 */
  reset(): void
}

/** 一个链族 = 显示名 + 两个 adapter。注册进 web3/chains.ts 的就是它 */
export interface ChainAdapter {
  readonly name: string
  readonly meta: ChainMetaAdapter
  readonly tx: ChainTxAdapter
}

export type { ChainFamily }
