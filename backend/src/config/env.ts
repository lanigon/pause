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
 * 真正要配的环境变量只有一个，它是"这台机器特有的凭证"，做不成常量：
 *   ALCHEMY_API_KEY  RPC 三级降级里的第二级，不填就降级到 Lark / ChainList
 *
 * 另外读了两个但都有默认值、平时不用管：
 *   NODE_ENV         运行时标准变量
 *   GPG_BINARY       gpg 不在 PATH 里时的逃生口（默认就是 'gpg'）
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
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY?.trim() || undefined

/* ── 其余全是常量 ────────────────────────────────────────────────────── */

const NODE_ENV = process.env.NODE_ENV ?? 'development'
export const isProduction = NODE_ENV === 'production'
export const isTest = NODE_ENV === 'test'

const PORT = 8787
const LOG_LEVEL = isProduction ? 'info' : 'debug'

/** 前端来源。本地工具，前端就跑在这台机器上 */
const CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173']

/** 全部 JSON 数据：chains / contracts / operators / rpc / sync / operations */
const DATA_DIR = './data'
/** GPG 加密的运维私钥，已 gitignore */
const SECRETS_DIR = './secrets'

const GPG_BINARY = process.env.GPG_BINARY ?? 'gpg'

/** JWT 有效期。过期就重新用钱包签一次名，没有 refresh 流程 */
const JWT_TTL_SECONDS = 8 * 3600

/** 整个批量任务的超时上限（含解密 + 全部签名 + 等待上链） */
const GPG_JOB_TIMEOUT_MS = 180_000

/**
 * JWT 签名密钥。
 *
 * 生产：每次启动随机生成，重启后 token 全部失效，重新签名登录即可。
 * 开发：缓存到 secrets/.jwt-dev（0600，已 gitignore）—— tsx watch 改一行代码就重启，
 *      每次都把人踢下线没法测。这个文件只在非生产环境读写。
 */
const JWT_SECRET = NODE_ENV === 'production' ? randomBytes(32).toString('hex') : devSecret()

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

/**
 * 汇总成一个对象，上层统一从这里取。
 *
 * 上面那些常量**故意不单独导出** —— 全导一遍的话就有两条取值路径，
 * 有人写 `import { DATA_DIR }`、有人写 `env.DATA_DIR`，
 * 将来想在这里加一层（比如按环境覆盖、或做一次校验）会漏掉一半调用点。
 * 对外只有三个出口：env、isProduction、isTest。
 */
export const env = {
  NODE_ENV,
  PORT,
  LOG_LEVEL,
  CORS_ORIGINS,
  DATA_DIR,
  SECRETS_DIR,
  GPG_BINARY,
  ALCHEMY_API_KEY,
  JWT_SECRET,
  JWT_TTL_SECONDS,
  GPG_JOB_TIMEOUT_MS,
} as const
