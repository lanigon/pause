import { z } from 'zod'
import { chainType, identifier } from './primitives.js'

/**
 * chains.json —— 链的静态配置。
 *
 * 链族（evm / tron / …）不在这里 —— 表里存的只是 type 这个字符串，
 * 「链族」是 web3 层的概念，定义在 lib/web3/types.ts。
 */

/** chains.json 里的一行：chainId / name / explorer 这些静态配置 */
export const chainSchema = z.object({
  /** 唯一标识，同时也是展示用的名字 —— 再配一个 name 只是同一件事写两遍 */
  key: identifier,
  type: chainType,
  chainId: z.number().int().positive(),
  explorer: z.string().url(),
  /** 原生币符号。key 给不了这个信息（morph 上是 ETH，bsc 上是 BNB） */
  symbol: z.string().min(1).max(12),
  decimals: z.number().int().min(0).max(18),
})

export type Chain = z.infer<typeof chainSchema>
