import { z } from 'zod'
import { chainType, evmAddress, identifier } from './primitives.js'

/**
 * chains.json —— 链的静态配置。
 *
 * 链族（evm / tron / …）不在这里 —— 表里存的只是 type 这个字符串，
 * 「链族」是 web3 层的概念，定义在 lib/web3/types.ts。
 */

/** chains.json 里的一行：chainId / name / explorer 这些静态配置 */
export const chainSchema = z.object({
  key: identifier,
  name: z.string().min(1),
  type: chainType,
  chainId: z.number().int().positive(),
  explorer: z.string().url(),
  confirmations: z.number().int().min(0).max(64),
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().min(0).max(18),
  /** 前端 multicall 用；无部署填 null，回退并发单调 */
  multicall3: evmAddress.nullable().default(null),
})

export type Chain = z.infer<typeof chainSchema>
