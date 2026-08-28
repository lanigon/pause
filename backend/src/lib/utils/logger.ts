import pino from 'pino'
import { env, isProduction, isTest } from '../../config/env.js'

/**
 * 敏感字段一律 redact。这是最后一道防线——
 * 真正的保证是这些值根本不该被传进 logger（见 repositories/log.repository.ts 的 redact）。
 */
const REDACT_PATHS = [
  'passphrase',
  'privateKey',
  'rawTx',
  'signature',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.passphrase',
  '*.privateKey',
  '*.rawTx',
]

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  transport: isProduction
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
})
