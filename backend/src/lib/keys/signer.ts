import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { env } from '../../config/env.js'
import type { ChainFamily } from '../web3/types.js'
import type { SignPayloadFn, UnsignedPayload } from '../web3/index.js'
import { GpgKey } from './gpg.js'
import type {
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
} from './worker.js'
import { AppError, ErrorCode, type ErrorCodeValue } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

/**
 * GPG 签名会话（父进程侧）。
 *
 * 安全要点：
 * - 口令/PIN 由本机的 gpg-agent / pinentry 负责，既不经过 HTTP 也不经过环境变量
 * - 子进程用 detached 建独立进程组，超时 kill(-pid) 杀整组，
 *   防止 gpg 变孤儿进程继续持有私钥
 * - 一次批量任务只解密一次，同一子进程连续签完 N 笔再退出
 * - 会话结束（正常或异常）必定 close()，不留常驻持钥进程
 */

/** dev 跑 .ts（tsx loader），prod 跑编译后的 .js */
const RUNNING_FROM_SOURCE = import.meta.url.endsWith('.ts')

/** 口令当场就输完；YubiKey 要留时间给人伸手 */
const PASSPHRASE_TIMEOUT_MS = 60_000
const TOUCH_TIMEOUT_MS = 120_000

const workerPath = fileURLToPath(
  new URL(
    RUNNING_FROM_SOURCE ? './worker.ts' : './worker.js',
    import.meta.url,
  ),
)

/* ══ 类型 ══════════════════════════════════════════════════════════════ */

interface SigningSession {
  /** 解密后派生并已校验的地址 */
  readonly address: string
  /** 交给 adapter.executeBatch 的签名回调 */
  readonly sign: SignPayloadFn
  /** 无论成败都要调用；重复调用安全 */
  readonly close: () => void
}

interface OpenSessionParams {
  readonly family: ChainFamily
  /** secrets/<链族>.address 里声明的地址，解密结果必须与它一致 */
  readonly expectedAddress: string
  /** 要人摸设备（YubiKey）。会话得串行开，超时也要给足 */
  readonly exclusive: boolean
  /** 整个批量任务的超时（含解密 + 全部签名） */
  readonly jobTimeoutMs?: number
  /** 需要物理触摸时的回调，用于向前端推"请触摸设备" */
  readonly onAwaitingTouch?: (label: string) => void
}

type Pending = {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
}

/* ══ 会话控制器 ════════════════════════════════════════════════════════ */

class SessionController {
  private readonly pending = new Map<string, Pending>()
  private ready: { resolve: (address: string) => void; reject: (e: Error) => void } | null = null
  private touchListener: ((label: string) => void) | null = null
  private closed = false
  private nextId = 1
  private readonly timer: NodeJS.Timeout

  constructor(
    private readonly child: ChildProcess,
    jobTimeoutMs: number,
  ) {
    this.timer = setTimeout(() => {
      this.failAll(new AppError(ErrorCode.GPG_TIMEOUT, 'GPG 签名会话超时，已终止'))
      this.close()
    }, jobTimeoutMs)
    this.timer.unref()

    child.on('message', (message: WorkerResponse) => this.onMessage(message))
    child.on('exit', (code, signal) => {
      // exit code 2 是 worker 约定的"地址不匹配"退出码
      const failure =
        code === 2
          ? {
              code: ErrorCode.GPG_ADDRESS_MISMATCH,
              reason: '解密出的地址与配置声明的地址不一致，密钥可能已被替换',
            }
          : {
              code: ErrorCode.GPG_DECRYPT_FAILED,
              reason: `签名子进程已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
            }
      this.failAll(new AppError(failure.code, failure.reason))
    })
    child.on('error', (error) => {
      this.failAll(new AppError(ErrorCode.GPG_DECRYPT_FAILED, `签名子进程异常: ${error.message}`))
    })
  }

  onAwaitingTouch(listener: (label: string) => void): void {
    this.touchListener = listener
  }

  waitForReady(timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.ready = { resolve, reject }
      const t = setTimeout(
        () => reject(new AppError(ErrorCode.GPG_TIMEOUT, 'GPG 解密超时')),
        timeoutMs,
      )
      t.unref()
    })
  }

  sign(payload: UnsignedPayload): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new AppError(ErrorCode.GPG_DECRYPT_FAILED, '签名会话已关闭'))
    }

    const id = String(this.nextId++)
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const request: WorkerRequest = {
        type: 'sign',
        id,
        family: payload.family,
        payload: payload.payload as Record<string, unknown>,
      }
      this.child.send(request)
    })
  }

  private onMessage(message: WorkerResponse): void {
    switch (message.type) {
      case 'awaiting-touch':
        this.touchListener?.(message.label)
        return

      case 'ready':
        this.ready?.resolve(message.address)
        this.ready = null
        return

      case 'signed': {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        pending?.resolve(message.signed)
        return
      }

      case 'error': {
        const code = (message.code ?? ErrorCode.GPG_DECRYPT_FAILED) as ErrorCodeValue
        const error = new AppError(code, message.reason)
        if (message.id) {
          const pending = this.pending.get(message.id)
          this.pending.delete(message.id)
          pending?.reject(error)
          if (!message.fatal) return
        }
        this.ready?.reject(error)
        this.ready = null
        this.failAll(error)
      }
    }
  }

  private failAll(error: Error): void {
    this.ready?.reject(error)
    this.ready = null
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.timer)

    try {
      if (this.child.connected) this.child.send({ type: 'done' } satisfies WorkerRequest)
    } catch {
      /* 已断开 */
    }

    // 给 100ms 优雅退出，之后杀整个进程组（连同它派生的 gpg）
    const pid = this.child.pid
    setTimeout(() => {
      if (!pid || this.child.exitCode !== null) return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        try {
          this.child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
    }, 100).unref()
  }
}

/* ══ 会话管理 ══════════════════════════════════════════════════════════ */

/**
 * 为多个链族打开签名会话（跨链族批量时用）。
 *
 * ⚠️ 需要独占设备的来源（YubiKey）必须**串行**打开 ——
 * scdaemon 对智能卡是独占锁，两个进程同时访问同一张卡会失败。
 * 不需要设备的（本地口令文件）可以并发，省时间。
 */
export async function openSessions(
  targets: readonly { family: ChainFamily; expectedAddress: string }[],
  onAwaitingTouch?: (family: ChainFamily, label: string) => void,
): Promise<ReadonlyMap<ChainFamily, SigningSession>> {
  const sessions = new Map<ChainFamily, SigningSession>()

  /**
   * 要不要独占设备，是探出来的（看密钥文件 + 卡在不在），不是配的。
   * 独占的必须串行打开 —— 同一张卡同时只能被一个进程访问（scdaemon 锁）。
   */
  const resolved = await Promise.all(
    targets.map(async (target) => {
      const key = await GpgKey.of(target.family)
      return { ...target, exclusive: await key.needsTouch() }
    }),
  )

  const open = async (target: (typeof resolved)[number]): Promise<void> => {
    const session = await openSigningSession({
      ...target,
      onAwaitingTouch: onAwaitingTouch ? (label) => onAwaitingTouch(target.family, label) : undefined,
    })
    sessions.set(target.family, session)
  }

  try {
    const exclusive = resolved.filter((t) => t.exclusive)
    const concurrent = resolved.filter((t) => !t.exclusive)

    // 独占设备的一个一个来 —— 同一张卡同时只能被一个进程访问
    for (const target of exclusive) await open(target)
    // 其余的可以并发
    await Promise.all(concurrent.map(open))

    return sessions
  } catch (error) {
    for (const session of sessions.values()) session.close()
    throw error
  }
}

/**
 * 打开签名会话：fork 子进程 → 流式送 passphrase → 解密 → 校验地址 → 就绪。
 * 解密失败、地址不匹配、超时都会在这里抛错，且子进程已被清理。
 */
async function openSigningSession(params: OpenSessionParams): Promise<SigningSession> {
  // 取密钥可能要等人按设备，整体超时至少要覆盖取密钥的窗口
  const keyTimeoutMs = params.exclusive ? TOUCH_TIMEOUT_MS : PASSPHRASE_TIMEOUT_MS
  const jobTimeoutMs = Math.max(params.jobTimeoutMs ?? env.GPG_JOB_TIMEOUT_MS, keyTimeoutMs + 30_000)
  const child = fork(workerPath, [], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: true,
    execArgv: RUNNING_FROM_SOURCE ? ['--import', 'tsx'] : [],
    /**
     * 只传子进程真正需要的环境变量，其余一律不带进去。
     * GNUPGHOME 必须转发 —— 不转发的话 gpg 会去找默认密钥环，
     * 配了独立密钥环（YubiKey 常见做法）就永远解不开，
     * 而报错看起来像"口令错"，极具误导性。
     */
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_ENV: env.NODE_ENV,
      ...(process.env.GNUPGHOME ? { GNUPGHOME: process.env.GNUPGHOME } : {}),
    },
  })

  const controller = new SessionController(child, jobTimeoutMs)

  try {
    const init: WorkerInit = {
      type: 'init',
      family: params.family,
      expectedAddress: params.expectedAddress,
      jobTimeoutMs,
    }
    child.send(init)

    if (params.onAwaitingTouch) controller.onAwaitingTouch(params.onAwaitingTouch)
    const address = await controller.waitForReady(keyTimeoutMs + 5_000)
    logger.info({ family: params.family, address }, 'GPG 签名会话已就绪')

    return {
      address,
      sign: (payload) => controller.sign(payload),
      close: () => controller.close(),
    }
  } catch (error) {
    controller.close()
    throw error
  }
}

