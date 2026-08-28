import { z } from 'zod'

/**
 * 各张表共用的字段校验原语。
 *
 * 单独成文件是因为它们**跨表**：地址同时出现在 chains / contracts /
 * operators / signers 四张表里。放进其中任何一个 model，另外三个就得反向
 * 依赖它，模型之间会织出一张网。抽到这里，依赖就都是单向的。
 */

/** EVM 地址：只校验形状，checksum 由 adapter 归一化 */
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, '不是合法的 EVM 地址')

/** Tron base58 地址：T 开头 + 33 位 base58 */
export const tronAddress = z
  .string()
  .regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/, '不是合法的 Tron base58 地址')

export const anyAddress = z.union([evmAddress, tronAddress])

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
