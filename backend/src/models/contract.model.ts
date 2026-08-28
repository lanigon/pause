import { z } from 'zod'
import { anyAddress, identifier } from './primitives.js'

/**
 * contracts.json 里的两张表：业务线与合约。
 *
 * 一个合约只要说清三件事：属于哪条业务线、在哪条链上、地址是多少。
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
  address: anyAddress,
})

export type ContractDef = z.infer<typeof contractSchema>
