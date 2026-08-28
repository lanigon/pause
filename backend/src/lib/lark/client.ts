import { spawn } from 'node:child_process'

/**
 * Lark（飞书）多维表格读取 —— 基础能力，不含任何业务字段知识。
 *
 * 接入方式：本机的 `lark` CLI。没装就报 LARK_CLI_MISSING，
 * 调用方决定是降级还是报错（对紧急运维控制台来说，一定是降级）。
 */
export type LarkRow = Readonly<Record<string, string>>

export class LarkError extends Error {
  constructor(
    readonly code: 'LARK_CLI_MISSING' | 'LARK_TIMEOUT' | 'LARK_FAILED' | 'LARK_BAD_RESPONSE',
    message: string,
  ) {
    super(message)
    this.name = 'LarkError'
  }
}

const DEFAULT_TIMEOUT_MS = 15_000

/** 读一张多维表格，返回原始行。字段名保持 Lark 上的原样 */
export async function readTable(
  tableRef: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<readonly LarkRow[]> {
  if (!(await hasCommand('lark'))) {
    throw new LarkError(
      'LARK_CLI_MISSING',
      '未检测到 lark CLI。装好并登录后重试：https://open.feishu.cn/document/tools/lark-cli',
    )
  }

  const output = await run(
    'lark',
    ['bitable', 'record', 'list', '--table', tableRef, '--format', 'json'],
    timeoutMs,
  )

  try {
    const parsed = JSON.parse(output) as { data?: { items?: { fields?: LarkRow }[] } }
    return (parsed.data?.items ?? []).map((item) => item.fields ?? {})
  } catch {
    throw new LarkError('LARK_BAD_RESPONSE', 'lark CLI 的输出不是合法 JSON')
  }
}

/**
 * 大小写与空格不敏感地取字段。
 * 飞书表头经常带空格、中英文混用，按名字精确匹配一定会漏。
 */
export function field(row: LarkRow, ...names: readonly string[]): string {
  for (const name of names) {
    for (const [key, value] of Object.entries(row)) {
      if (key.trim().toLowerCase() === name.toLowerCase()) return String(value ?? '').trim()
    }
  }
  return ''
}

export const hasCommand = (command: string): Promise<boolean> =>
  run('which', [command], 3_000)
    .then(() => true)
    .catch(() => false)

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    // 超时必须杀掉：卡住的 lark CLI 会一直占着请求，前端就在那儿转圈
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new LarkError('LARK_TIMEOUT', `${command} 超过 ${timeoutMs / 1000}s 未返回`))
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', (cause) => {
      clearTimeout(timer)
      reject(new LarkError('LARK_FAILED', `${command} 启动失败: ${cause.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new LarkError('LARK_FAILED', stderr.trim() || `${command} 退出码 ${code}`))
    })
  })
}
