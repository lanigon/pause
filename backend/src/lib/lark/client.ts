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
    readonly code:
      | 'LARK_CLI_MISSING'
      | 'LARK_TIMEOUT'
      | 'LARK_FAILED'
      | 'LARK_BAD_RESPONSE'
      | 'LARK_BAD_URL',
    message: string,
  ) {
    super(message)
    this.name = 'LarkError'
  }
}

/** 从表格 URL 里解出来的定位信息 */
export interface LarkTableRef {
  /** 多维表格本体的 token（URL 里 /base/ 或 /wiki/ 后面那一段） */
  readonly appToken: string
  /** 具体哪张表（URL 的 ?table= 参数） */
  readonly tableId: string
  /** 视图。带上它才能拿到用户当前筛选/排序后的结果 */
  readonly viewId?: string
  /** wiki 托管的表格，token 语义和 /base/ 不同，出错时要给不同的提示 */
  readonly isWiki: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * 从浏览器地址栏里的表格链接解出定位信息。
 *
 * 配置里只让填这一个 URL —— 让人从链接里手抠 app token 和 table id
 * 是最容易配错的一步，而且配错的表现是"同步不到数据"，很难查。
 *
 * 认得的形态（feishu.cn 与 larksuite.com 都行）：
 *   https://x.feishu.cn/base/<appToken>?table=<tableId>&view=<viewId>
 *   https://x.feishu.cn/wiki/<nodeToken>?table=<tableId>
 *   带 /wiki/ 的是知识库托管，token 语义不同，单独标出来
 */
export function parseLarkUrl(url: string): LarkTableRef {
  const trimmed = url.trim()
  if (!trimmed) throw new LarkError('LARK_BAD_URL', '飞书表格链接为空')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new LarkError(
      'LARK_BAD_URL',
      `不是合法的链接：${trimmed.slice(0, 60)}。请直接复制浏览器地址栏里的表格链接。`,
    )
  }

  const match = /\/(base|wiki)\/([A-Za-z0-9]+)/.exec(parsed.pathname)
  if (!match) {
    throw new LarkError(
      'LARK_BAD_URL',
      '链接里找不到 /base/ 或 /wiki/ 段。请在飞书里打开那张多维表格，直接复制地址栏的完整链接。',
    )
  }

  const tableId = parsed.searchParams.get('table')?.trim()
  if (!tableId) {
    throw new LarkError(
      'LARK_BAD_URL',
      '链接里没有 ?table= 参数。请点开具体的那张表再复制链接（只到多维表格首页是不够的）。',
    )
  }

  return {
    appToken: match[2]!,
    tableId,
    viewId: parsed.searchParams.get('view')?.trim() || undefined,
    isWiki: match[1] === 'wiki',
  }
}

/** 读一张多维表格，返回原始行。字段名保持 Lark 上的原样 */
export async function readTable(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<readonly LarkRow[]> {
  const ref = parseLarkUrl(url)

  if (!(await hasCommand('lark'))) {
    throw new LarkError(
      'LARK_CLI_MISSING',
      '未检测到 lark CLI。装好并登录后重试：https://open.feishu.cn/document/tools/lark-cli',
    )
  }

  const args = [
    'bitable',
    'record',
    'list',
    '--app-token',
    ref.appToken,
    '--table-id',
    ref.tableId,
    ...(ref.viewId ? ['--view-id', ref.viewId] : []),
    '--format',
    'json',
  ]

  let output: string
  try {
    output = await run('lark', args, timeoutMs)
  } catch (error) {
    // wiki 托管的表格 token 语义不同，报错时要说清楚，否则用户会以为是权限问题
    if (ref.isWiki && error instanceof LarkError && error.code === 'LARK_FAILED') {
      throw new LarkError(
        'LARK_FAILED',
        `${error.message}\n提示：这是知识库（/wiki/）里的表格，可能需要用「更多 → 在浏览器打开」拿到 /base/ 开头的链接。`,
      )
    }
    throw error
  }

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
