import { createApp } from './app.js'
import { env, isProduction } from './config/env.js'
import { getRegistry, loadRegistry } from './services/registry.service.js'
import { rpcProvider } from './lib/rpc/rpcProvider.js'
import * as logRepo from './repositories/log.repository.js'
import { abortAll } from './services/batch.service.js'
import { resetAll, tx } from './lib/web3/index.js'
import { logger } from './lib/utils/logger.js'

/**
 * 启动顺序很重要：
 *   1. 校验环境变量（env.ts 在 import 时就做了，失败直接退出）
 *   2. 加载并校验配置 —— 配置有问题就**不要起服务**，别让半个错误配置对外提供接口
 *   3. 加载操作日志
 *   4. 起 HTTP
 */
/** 探一遍所有链的 RPC。失败不影响服务 —— 大不了还按原顺序试 */
async function probeRpcs(): Promise<void> {
  const chains = [...getRegistry().chains.values()]
  await rpcProvider
    .probeAll(chains, async (chain) => {
      const results = await tx(chain.type).checkHealth(chain)
      // 用 rawUrl 对回具体节点；脱敏后的 url 只用于展示，匹配不上
      return results.map((r) => ({
        url: r.rawUrl,
        ok: r.ok,
        ...(r.latencyMs === undefined ? {} : { latencyMs: r.latencyMs }),
      }))
    })
    .catch((error: unknown) => {
      logger.warn({ error: error instanceof Error ? error.message : error }, 'RPC 探活失败，忽略')
    })
}

async function main(): Promise<void> {
  // 顺序不能反：registry 校验链定义时会用到 RPC 来源
  await rpcProvider.load()
  const registry = await loadRegistry()
  await logRepo.init()

  const app = createApp()
  const server = app.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        configVersion: registry.configVersion,
        chains: registry.chains.size,
        contracts: registry.contracts.size,
        rpcSyncedAt: rpcProvider.syncedAt || '(未同步，运行 npm run sync rpc)',
      },
      `合约管理平台 后端已启动 → http://localhost:${env.PORT}`,
    )
    if (!isProduction) {
      logger.info('单实例部署：JWT 密钥每次启动随机生成，重启后需重新登录')
    }

    /**
     * RPC 探活放在服务起来**之后**，后台跑。
     *
     * 不放前面是因为它要挨个连外部节点，几十秒起步 —— 紧急暂停时
     * 让人多等半分钟才能打开页面是不可接受的。探测期间请求照常走原顺序，
     * 探完了不可用的自动降到最后。
     */
    void probeRpcs()
  })

  const shutdown = (signal: string): void => {
    logger.info({ signal }, '收到退出信号，正在优雅关闭…')
    // 先取消在跑的批量任务，让 GPG 子进程被清理掉，绝不留常驻持钥进程
    abortAll()
    resetAll()
    server.close(() => {
      logger.info('已关闭')
      process.exit(0)
    })
    // 兜底：10 秒还没关干净就强退
    setTimeout(() => process.exit(1), 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, '启动失败')
  process.exit(1)
})
