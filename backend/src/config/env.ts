import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { config as loadDotenv } from 'dotenv'

loadDotenv()

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  配置
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 除了两个**密钥**，其余全是代码里的常量 —— 这是个本地运行的运维工具，
 * 端口、超时、路径这些不需要按环境变化，做成配置项只会多一处出错的地方。
 *
 * 环境变量只有两个，都是"这台机器特有的位置/凭证"，做不成常量：
 *   ALCHEMY_API_KEY  RPC 三级降级里的第二级，不填就降级到 Lark / ChainList
 *   LARK_TABLE       飞书表格位置，不填就跳过同步、只用本地数据
 *
 * 密钥口令不在这里：后端是本地运行的，解密交给本机的 gpg-agent / pinentry ——
 * YubiKey 场景本来就是这样（输 PIN + 触摸设备），对称加密的口令也一样由 pinentry 问。
 *
 * JWT 密钥每次启动随机生成 —— 单实例部署，没必要固化。
 * 代价是重启后所有人要重新签名登录，对本地运维工具来说完全可以接受，
 * 好处是少一个会泄露的长期密钥。
 */

/* ── 环境变量 ────────────────────────────────────────────────────────── */

/** RPC 三级降级的第二级。缺失时自动降级到 Lark / ChainList */
export const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY?.trim() || undefined

/** 飞书表格位置（一张表四列：业务线/链/RPC/合约）。缺失时跳过同步，只用本地数据 */
export const LARK_TABLE = process.env.LARK_TABLE?.trim() ?? ''

/* ── 其余全是常量 ────────────────────────────────────────────────────── */

export const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const isProduction = NODE_ENV === 'production'
export const isTest = NODE_ENV === 'test'

export const PORT = 8787
export const LOG_LEVEL = isProduction ? 'info' : 'debug'

/** 前端来源。本地工具，前端就跑在这台机器上 */
export const CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** 全部 JSON 数据：chains / contracts / operators / signers / rpc / operations */
export const DATA_DIR = './data'
/** GPG 加密的运维私钥，已 gitignore */
export const SECRETS_DIR = './secrets'

export const GPG_BINARY = process.env.GPG_BINARY ?? 'gpg'

/** JWT 有效期。过期就重新用钱包签一次名，没有 refresh 流程 */
export const JWT_TTL_SECONDS = 8 * 3600

/** 整个批量任务的超时上限（含解密 + 全部签名 + 等待上链） */
export const GPG_JOB_TIMEOUT_MS = 180_000

/** SSE 心跳间隔，防中间代理因空闲断连 */
export const SSE_HEARTBEAT_MS = 15_000

/**
 * JWT 签名密钥。
 *
 * 生产：每次启动随机生成，重启后 token 全部失效，重新签名登录即可。
 * 开发：缓存到 secrets/.jwt-dev（0600，已 gitignore）—— tsx watch 改一行代码就重启，
 *      每次都把人踢下线没法测。这个文件只在非生产环境读写。
 */
export const JWT_SECRET = NODE_ENV === 'production' ? randomBytes(32).toString('hex') : devSecret()

function devSecret(): string {
  const file = `${SECRETS_DIR}/.jwt-dev`
  try {
    const cached = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(cached)) return cached
  } catch {
    /* 没有就生成 */
  }
  const fresh = randomBytes(32).toString('hex')
  try {
    mkdirSync(SECRETS_DIR, { recursive: true })
    writeFileSync(file, fresh, { mode: 0o600 })
  } catch {
    /* 写不了就退回纯内存，行为等同生产 */
  }
  return fresh
}

/** 汇总成一个对象，上层统一从这里取 */
export const env = {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  CORS_ORIGINS,
  DATA_DIR,
  SECRETS_DIR,
  GPG_BINARY,
  ALCHEMY_API_KEY,
  LARK_TABLE,
  JWT_SECRET,
  JWT_TTL_SECONDS,
  GPG_JOB_TIMEOUT_MS,
  SSE_HEARTBEAT_MS,
} as const
