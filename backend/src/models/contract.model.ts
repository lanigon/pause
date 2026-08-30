import { z } from 'zod'
import { identifier } from './primitives.js'

/**
 * contracts.json 里的两张表：业务线与合约。
 *
 * 一个合约要说清：属于哪条业务线、在哪条链上、地址是多少，
 * 以及（可选）谁有权暂停它。
 * ABI、可执行操作、前置条件全部内置（见 web3/abi.ts 与 executor/operations.ts），
 * 因为平台只做 pause / unpause，这些在所有 Pausable 合约上都一样。
 */
export const businessLineSchema = z.object({
  id: identifier,
  name: z.string().min(1),
})

export type BusinessLine = z.infer<typeof businessLineSchema>

export const contractSchema = z.object({
  id: identifier,
  name: z.string().min(1),
  businessLine: identifier,
  chain: identifier,
  /**
   * 地址格式**不在这里校验**。
   *
   * schema 只认识 EVM/Tron 两种形状的话，接一条 Solana 链时每一行合约
   * 都会在这一步被拒，而真正权威的检查（registry.service 里按链分派的
   * meta(chain.type).isValidAddress）根本轮不到执行 —— 那里还知道这个合约
   * 配在哪条链上，能报出"地址不符合 evm 链的格式"这种有用的话。
   */
  address: z.string().min(1),
  /**
   * 有权暂停这个合约的地址。可选。
   *
   * 配了的话前端会去读它的原生币余额 —— 紧急暂停时最怕的是按下去才发现
   * 那个地址没气了。地址格式同样交给 registry.service 按链分派校验。
   */
  operator: z.string().min(1).optional(),
})

export type ContractDef = z.infer<typeof contractSchema>
