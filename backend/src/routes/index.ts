import { Router } from 'express'
import * as auth from '../controllers/auth.controller.js'
import * as registry from '../controllers/registry.controller.js'
import * as gpg from '../controllers/gpg.controller.js'
import * as log from '../controllers/log.controller.js'
import { requireAuth, requireWriteRole } from '../middlewares/auth.middleware.js'
import { asyncHandler, validateBody, validateQuery } from '../middlewares/validate.middleware.js'

/**
 * 路由表。只做 path → controller 的映射，不含任何业务逻辑。
 *
 * 四组接口，对应四类数据：
 *   /auth      登录白名单
 *   /registry  合约 + RPC
 *   /gpg       批量执行（一个接口，响应即 SSE 进度流）
 *   /logs      操作记录
 */
export const router: Router = Router()

// ── 无需认证 ──────────────────────────────────────────────────────────────
router.get('/health', registry.getHealth)

router.post('/auth/login', validateBody(auth.loginSchema), asyncHandler(auth.postLogin))

// ── 以下全部需要 JWT ──────────────────────────────────────────────────────
router.use(requireAuth)

// 带 Lark 同步的加载：响应是 SSE，先同步再给数据。?force=1 跳过节流
router.get('/registry/sync', asyncHandler(registry.getRegistryStream))
router.get('/states', validateQuery(registry.statesQuerySchema), asyncHandler(registry.getStates))

// GPG 批量执行：一个接口，响应是 SSE 流。密钥由后端本地处理，前端不传
router.post('/gpg/batch', requireWriteRole, validateBody(gpg.batchSchema), asyncHandler(gpg.postBatch))
// 取消自己正在跑的任务。已广播的拦不住，只保证还没签的不签、没发的不发
router.post('/gpg/cancel', requireWriteRole, gpg.postCancel)

// 操作日志：启动时 GET，每次操作 POST
router.get('/logs', validateQuery(log.logQuerySchema), asyncHandler(log.getLogs))
router.get('/logs/daily', validateQuery(log.logDailySchema), asyncHandler(log.getDailyCounts))
router.post('/logs', validateBody(log.logInputSchema), asyncHandler(log.postLog))

