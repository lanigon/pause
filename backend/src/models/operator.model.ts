import { z } from 'zod'
import { evmAddress } from './primitives.js'

/**
 * operators.json —— 能登录的人。
 *
 * 角色即权限，三种：
 *   admin     全部业务线 + 可热重载配置
 *   operator  全部业务线 + 可执行暂停/恢复
 *   viewer    全部业务线，只读
 *
 * 所以没有"授权业务线"这个维度 —— 能登录就能看全部，能不能动只看角色。
 * 登录只认 EVM 签名，所以表里不写链族。
 */
export const operatorSchema = z.object({
  /** EVM 地址 */
  address: evmAddress,
  label: z.string().min(1),
  role: z.enum(['admin', 'operator', 'viewer']),
  enabled: z.boolean().default(true),
})

export type Operator = z.infer<typeof operatorSchema>

export type OperatorRole = Operator['role']
