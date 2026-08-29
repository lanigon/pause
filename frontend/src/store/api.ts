import type {
  ExecutionEvent,
  OperationKind,
  OperationLog,
  Operator,
  Registry,
  SyncEvent,
  SyncResult,
} from '../types'

/**
 * 后端调用。全部集中在这一个文件里 —— 组件不直接发请求。
 * JWT 只存在内存里（不进 localStorage），刷新页面重新用钱包签名登录。
 */

/** 后端统一响应信封 */
interface Envelope<T> {
  success: boolean
  data: T | null
  error: { code: string; message: string } | null
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787/api'

let token: string | null = null

export const setToken = (value: string | null): void => {
  token = value
}
export const hasToken = (): boolean => token !== null

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${BASE}${path}`, { ...init, headers })
  const body = (await res.json().catch(() => null)) as Envelope<T> | null

  if (!res.ok || !body?.success) {
    throw new ApiError(body?.error?.code ?? 'NETWORK', body?.error?.message ?? `请求失败 (${res.status})`)
  }
  return body.data as T
}

/* ── 登录：只有一个接口 ── */

/**
 * 挑战消息模板。**必须与后端 buildLoginMessage 逐字一致**，差一个字符验签就过不了。
 * 由前端自己拼，所以不需要先向服务端要 nonce —— 少一次往返，服务端也不用存状态。
 */
export function buildLoginMessage(address: string, timestamp: number, nonce: string): string {
  return [
    '合约管理平台 登录',
    '',
    `地址: ${address}`,
    `时间: ${new Date(timestamp).toISOString()}`,
    `随机数: ${nonce}`,
    '',
    '签名此消息即可登录',
  ].join('\n')
}

export const randomNonce = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

/** 只认 EVM 签名。拿到 token 后所有接口都能用，包括操作 Tron 合约 */
export const login = (address: string, timestamp: number, nonce: string, signature: string) =>
  request<{ accessToken: string; expiresIn: number; operator: Operator }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ address, timestamp, nonce, signature }),
  })

/* ── 配置：一个接口拿全 合约 + 链 + RPC ── */

export const getRegistry = () => request<Registry>('/registry')

/**
 * 后端兜底的链上状态。
 * 前端平时自己 multicall（省后端 RPC 配额），但公开 RPC 很多不带 CORS 头，
 * 浏览器会直接拦掉 —— 那种情况下退回来用这个。
 */
export const getStates = (contractIds: string[]) =>
  request<Record<string, { paused?: boolean }>>(
    `/states?ids=${encodeURIComponent(contractIds.join(','))}`,
  )

/* ── 交易日志 ── */

/**
 * 拉交易日志。
 *
 * 时间窗由调用方按**本地日历日**算好 —— 后端不认识时区。
 * 不传就是不限时间（首次加载兜底用）。
 */
export const getLogs = (range?: { from: string; to: string }, limit = 500) => {
  const params = new URLSearchParams({ limit: String(limit) })
  if (range) {
    params.set('from', range.from)
    params.set('to', range.to)
  }
  return request<{ items: OperationLog[]; total: number }>(`/logs?${params}`)
}

/** 钱包模式下广播成功后上报。地址与时间由后端从 JWT 填 */
export const postLog = (input: {
  operation: string
  contract: string
  chain: string
  hash: string
  status: 'broadcast' | 'confirmed' | 'failed'
}) => request<OperationLog>('/logs', { method: 'POST', body: JSON.stringify(input) })

/* ── GPG 批量执行 ── */

/** 取消自己正在跑的批量任务。已广播的拦不住，只保证还没签的不签、没发的不发 */
export const cancelBatch = () =>
  request<{ cancelled: number }>('/gpg/cancel', { method: 'POST' })

/**
 * 一个请求做完全部事情：POST 过去，**响应体就是 SSE 流**。
 *
 * 前端不传任何密钥材料 —— 后端是本地运行的，解本地的 GPG 文件，
 * 需要时调本机上插着的 YubiKey。
 *
 * 因为响应是 POST 的流，用不了浏览器的 EventSource（它只支持 GET），
 * 所以自己读 ReadableStream 解 SSE 帧。
 */
export async function runBatch(
  operation: OperationKind,
  contractIds: string[],
  expectedConfigVersion: string,
  onEvent: (event: ExecutionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/gpg/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ operation, contractIds, expectedConfigVersion, confirm: 'CONFIRM' }),
    signal,
  })

  await readSse(res, (_event, data) => onEvent(data as ExecutionEvent), '执行失败')
}

/* ── 带 Lark 同步的加载 ── */

/**
 * 加载配置，但后端会**先跟 Lark 对一遍**：拉取 → 与本地比对 → 有差异才更新。
 * 整个过程通过 SSE 推过来，最后一个 `registry` 事件才是数据。
 *
 * Lark 出问题不影响拿到数据 —— 进度事件里会说明原因，registry 照发本地版本。
 */
export async function syncRegistry(
  onProgress: (event: SyncEvent) => void,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<Registry & { synced: SyncResult }> {
  const res = await fetch(`${BASE}/registry/sync${options.force ? '?force=1' : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: options.signal,
  })

  let registry: (Registry & { synced: SyncResult }) | null = null
  await readSse(
    res,
    (event, data) => {
      if (event === 'registry') registry = data as Registry & { synced: SyncResult }
      else onProgress(data as SyncEvent)
    },
    '加载配置失败',
  )

  // 后端保证最后一定发 registry；没收到说明连接中断了
  if (!registry) throw new ApiError('SYNC_INCOMPLETE', '同步中断，未收到配置数据')
  return registry
}

/* ── SSE ── */

/**
 * 读一个「响应体即 SSE 流」的响应。
 *
 * 两个接口都用不了浏览器的 EventSource：一个是 POST（EventSource 只支持 GET），
 * 另一个要带 Authorization 头（EventSource 也不支持）。所以自己解帧。
 */
async function readSse(
  res: Response,
  onFrame: (event: string, data: unknown) => void,
  failureMessage: string,
): Promise<void> {
  // 后端还没切到 SSE 时（授权没过等）回的是普通 JSON 错误
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as Envelope<never> | null
    throw new ApiError(body?.error?.code ?? 'NETWORK', body?.error?.message ?? failureMessage)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    // SSE 帧以空行分隔；最后一段可能不完整，留到下一轮
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const lines = frame.split('\n')
      const data = lines.find((line) => line.startsWith('data: '))
      if (!data) continue // 心跳等注释行
      const name = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message'
      try {
        onFrame(name.trim(), JSON.parse(data.slice(6)))
      } catch {
        /* 忽略解析不了的帧 */
      }
    }
  }
}
