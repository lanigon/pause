import { z } from 'zod'

/**
 * 各张表共用的字段校验原语。
 *
 * 单独成文件是因为它们**跨表**：id 与地址同时出现在 chains / contracts /
 * operators 三张表里。放进其中任何一个 model，另外两个就得反向
 * 依赖它，模型之间会织出一张网。抽到这里，依赖就都是单向的。
 */

/**
 * EVM 地址：只校验形状，checksum 由 adapter 归一化。
 *
 * 只有 operators.json 用它 —— 登录只认 EVM 签名，这是设计决定，不随链族变。
 * **合约地址不用它**：那是按链分派的，见 core/config 的引用完整性校验。
 */
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, '不是合法的 EVM 地址')

/** 配置里的 id */
export const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'id 只能是小写字母、数字和连字符')

/**
 * 链族标识：字符串而非枚举，接新链族不用回头改枚举定义。
 * 写错了也不会漏 —— 启动时会校验它已注册，未注册直接起不来。
 */
export const chainType = identifier
