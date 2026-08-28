import { z } from 'zod'
import { anyAddress, chainType } from './primitives.js'

/**
 * signers.json —— 后端签名密钥的声明。不含私钥、不含文件路径。
 *
 * 不是登录身份 —— 没人拿它去浏览器里登录，所以和 operators 分开两张表。
 * 只三个字段：哪个链族、声明地址、怎么解锁。
 * 密钥文件路径按 secrets/<chainType>.key.gpg 约定推导，配置里不出现路径，
 * 也就不存在路径穿越的问题。
 *
 * 声明地址是安全控制点：解密后派生的地址必须与它一致，
 * 否则说明密钥文件被换过，立即拒绝。
 *
 * 不再单独配授权范围 —— 能操作哪些业务线由**登录的人**的角色决定，
 * 给后端密钥再配一套是重复的。
 */

/**
 * 解锁方式。
 *
 * 这是 signers.json 里的一个**字段值**，是领域事实，所以定义在这里；
 * GPG 只是这两种方式的实现手段，由 lib/keys/gpg.ts 反过来 import 它。
 * 反过来放会让 models 挂在密钥基础设施后面。
 */
export enum UnlockMethod {
  PASSPHRASE = 'passphrase',
  YUBIKEY = 'yubikey',
}

export const signerSchema = z.object({
  chainType,
  address: anyAddress,
  /** 密钥来源，可插拔。默认解本地 GPG 文件，见 lib/keys/provider.ts */
  source: z.string().min(1).default('gpg'),
  /** 解锁方式（gpg 来源专用） */
  unlock: z.nativeEnum(UnlockMethod).default(UnlockMethod.PASSPHRASE),
})

export type SignerDef = z.infer<typeof signerSchema>
