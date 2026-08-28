/** 对外错误码：前端按 code 分支处理，message 只用于展示 */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  SIGNER_SCOPE_DENIED: 'SIGNER_SCOPE_DENIED',
  GPG_DECRYPT_FAILED: 'GPG_DECRYPT_FAILED',
  GPG_TIMEOUT: 'GPG_TIMEOUT',
  /** 密钥文件不存在 */
  GPG_KEY_MISSING: 'GPG_KEY_MISSING',
  /** gpg-agent 弹不出输入框（后端无终端运行） */
  GPG_PINENTRY_UNAVAILABLE: 'GPG_PINENTRY_UNAVAILABLE',
  /** 口令 / PIN 错误 */
  GPG_WRONG_SECRET: 'GPG_WRONG_SECRET',
  /** YubiKey 被锁（PIN 连错 3 次） */
  GPG_CARD_BLOCKED: 'GPG_CARD_BLOCKED',
  /** 没检测到 YubiKey */
  GPG_CARD_ABSENT: 'GPG_CARD_ABSENT',
  /** 卡上没有解密密钥 */
  GPG_CARD_NO_KEY: 'GPG_CARD_NO_KEY',
  /** PIN 只剩一两次，先别试了 */
  GPG_CARD_LOW_RETRIES: 'GPG_CARD_LOW_RETRIES',
  /** 解密出的地址与配置声明不一致 —— 密钥可能被换过 */
  GPG_ADDRESS_MISMATCH: 'GPG_ADDRESS_MISMATCH',
  SIMULATE_FAILED: 'SIMULATE_FAILED',
  BROADCAST_FAILED: 'BROADCAST_FAILED',
  RPC_UNAVAILABLE: 'RPC_UNAVAILABLE',
  JOB_CONFLICT: 'JOB_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

const DEFAULT_STATUS: Record<ErrorCodeValue, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFIG_CHANGED: 409,
  SIGNER_SCOPE_DENIED: 403,
  GPG_DECRYPT_FAILED: 400,
  GPG_TIMEOUT: 504,
  GPG_KEY_MISSING: 500,
  GPG_PINENTRY_UNAVAILABLE: 500,
  GPG_WRONG_SECRET: 400,
  GPG_CARD_BLOCKED: 423,
  GPG_CARD_ABSENT: 503,
  GPG_CARD_NO_KEY: 500,
  GPG_CARD_LOW_RETRIES: 423,
  GPG_ADDRESS_MISMATCH: 500,
  SIMULATE_FAILED: 422,
  BROADCAST_FAILED: 502,
  RPC_UNAVAILABLE: 503,
  JOB_CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

export class AppError extends Error {
  readonly code: ErrorCodeValue
  readonly status: number
  /** 附加信息，会随响应下发；调用方必须保证其中没有敏感数据 */
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: ErrorCodeValue,
    message: string,
    options?: { status?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = options?.status ?? DEFAULT_STATUS[code]
    if (options?.details) this.details = Object.freeze({ ...options.details })
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(ErrorCode.BAD_REQUEST, message, details ? { details } : undefined)

export const notFound = (message: string) => new AppError(ErrorCode.NOT_FOUND, message)

