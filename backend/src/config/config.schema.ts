import { z } from 'zod'
import { chainSchema } from '../models/chain.model.js'
import { businessLineSchema, contractSchema } from '../models/contract.model.js'
import { operatorSchema } from '../models/operator.model.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  配置文件的信封
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 这里**只**描述"四个 JSON 文件的顶层长什么样"，不描述任何领域概念 ——
 * 行的形状在 models/ 里（chains.json 的一行就是 models/chain.model.ts）。
 *
 * 为什么要分开，看这两行就够了：
 *
 *   chains.json      是 { chains: [...] } 这样的对象包装
 *   operators.json   是个裸数组
 *
 * 这种不对称纯粹是"文件当初碰巧这么写"的事实，和"链是什么"毫无关系。
 * 让它留在这一层，models/ 才能干净到只依赖 zod。
 */

export const chainsFileSchema = z.object({ chains: z.array(chainSchema).min(1) })

export const contractsFileSchema = z.object({
  businessLines: z.array(businessLineSchema).min(1),
  contracts: z.array(contractSchema).min(1),
})

export const operatorsFileSchema = z.array(operatorSchema).min(1)

