import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { env } from './config/env.js'
import { router } from './routes/index.js'
import { httpLogger } from './middlewares/logging.middleware.js'
import { errorHandler, notFound } from './middlewares/error.middleware.js'

/**
 * Express 应用组装。中间件顺序即安全边界，不要随意调整：
 *
 *   访问日志 → helmet → cors → 限流 → body 解析 → 路由 → 404 → 错误处理
 *
 * 日志排在最前面：被 helmet / cors 挡掉的请求也要留痕。
 * 这是个能改合约状态的运维工具，"谁在什么时候敲了哪个接口"本身就是审计材料，
 * 排在后面就等于把被拒绝的请求从审计里抹掉了。
 *
 * 注意 passphrase 那条路由用 text/plain 的 raw body：
 * 它不能经过 JSON 解析，否则 passphrase 会变成 V8 字符串留在内存里。
 */
export function createApp(): Express {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(httpLogger)

  app.use(helmet())
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: false,
      allowedHeaders: ['Content-Type', 'Authorization', 'Last-Event-ID'],
    }),
  )

  app.use(express.json({ limit: '100kb' }))

  app.use('/api', router)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
