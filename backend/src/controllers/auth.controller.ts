import type { Request, Response } from 'express'
import { z } from 'zod'
import { login } from '../services/auth.service.js'
import { ok } from '../lib/utils/response.js'

/**
 * 登录只有这一个接口，只认 EVM 签名。
 * 挑战消息由前端自己拼（含时间戳与随机数），后端重建同样的消息验签。
 * 拿到 token 后所有需要鉴权的接口都能用，包括操作 Tron 合约。
 */
export const loginSchema = z.object({
  /** EVM 地址。登录只认 EVM 签名 */
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, '需要 EVM 地址'),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(8).max(64),
  signature: z.string().min(1),
})

export async function postLogin(req: Request, res: Response): Promise<void> {
  ok(res, await login(req.body as z.infer<typeof loginSchema>))
}
