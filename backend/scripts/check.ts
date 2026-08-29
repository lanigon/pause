/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  启动前排查  ——  npm run check  |  pnpm check
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 一条命令看清楚：环境齐不齐、密钥在不在、数据对不对、Lark 能不能拉、服务起没起。
 *
 * 三个原则：
 *   · **不解密**。全程不需要输入口令，也不碰 YubiKey ——
 *     排查是随手跑的，不该消耗 PIN 次数。要验密钥能不能解开，用 keys verify。
 *   · **不在第一个错误停下**。全部跑完再汇总，一次看清所有问题。
 *   · **每条失败都说下一步做什么**，而不只是说"失败了"。
 */
// 排查脚本的输出要干净：把库里的 INFO 日志压掉，只留我们自己打的
process.env.LOG_LEVEL ??= 'silent'

import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { env } from '../src/config/env.js'
import { loadRawConfig } from '../src/repositories/config.repository.js'
import { hasCommand } from '../src/lib/lark/client.js'
import { GpgKey, LOW_PIN_RETRIES, gpgBinary, gpgEnv, readCardStatus } from '../src/lib/keys/gpg.js'
import { rpcProvider } from '../src/lib/rpc/rpcProvider.js'

type Level = 'ok' | 'warn' | 'fail'

interface Result {
  readonly level: Level
  readonly label: string
  readonly detail: string
  /** 失败/警告时告诉用户下一步做什么 */
  readonly next?: string
}

const results: Result[] = []
const MARK: Record<Level, string> = { ok: '✓', warn: '⚠', fail: '✗' }

function report(level: Level, label: string, detail: string, next?: string): void {
  results.push({ level, label, detail, next })
  console.log(`  ${MARK[level]} ${label.padEnd(22)} ${detail}`)
  if (next) console.log(`${' '.repeat(27)}→ ${next}`)
}

/** 包一层，任何一项自己炸了都不能中断整场排查 */
async function section(title: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`)
  try {
    await run()
  } catch (error) {
    report('fail', '排查中断', error instanceof Error ? error.message : String(error))
  }
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(() => true).catch(() => false)

/* ══ ① 运行环境 ══════════════════════════════════════════════════════ */

async function checkRuntime(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 20) report('ok', 'Node 版本', process.versions.node)
  else report('fail', 'Node 版本', `${process.versions.node} 过低`, '需要 Node 20 以上')

  for (const [label, path] of [
    ['后端依赖', './node_modules'],
    ['前端依赖', '../frontend/node_modules'],
  ] as const) {
    if (await exists(path)) report('ok', label, '已安装')
    else report('fail', label, '没装', `在对应目录跑 npm install`)
  }
}

/* ══ ② GPG 与密钥 ════════════════════════════════════════════════════ */

async function checkKeys(): Promise<void> {
  const version = await run(gpgBinary(), ['--version'], 5_000).catch(() => null)
  if (version) report('ok', 'gpg', version.split('\n')[0] ?? '')
  else return report('fail', 'gpg', '不可用', '安装 GnuPG：brew install gnupg')

  const home = process.env.GNUPGHOME
  if (!home) {
    report('ok', 'GNUPGHOME', '默认 ~/.gnupg')
  } else if (home.length > 80) {
    // gpg-agent 的 unix socket 路径有长度上限（约 104 字符），超了会 File name too long
    report('warn', 'GNUPGHOME', `${home}（${home.length} 字符，偏长）`, '换到短路径，否则 gpg-agent 起不来')
  } else {
    report('ok', 'GNUPGHOME', home)
  }

  // 卡不在不算错 —— 口令模式本来就不需要卡
  const card = await readCardStatus().catch(() => null)
  if (!card?.present) {
    report('ok', 'YubiKey', '未插入（口令模式不需要）')
  } else if (card.pinRetriesLeft !== undefined && card.pinRetriesLeft <= LOW_PIN_RETRIES) {
    report('warn', 'YubiKey', `已插入，PIN 只剩 ${card.pinRetriesLeft} 次`, '再错几次会锁卡，确认 PIN 后再操作')
  } else {
    report('ok', 'YubiKey', `已插入${card.serial ? ` (${card.serial})` : ''}，PIN 剩 ${card.pinRetriesLeft ?? '?'} 次`)
  }

  const keys = await GpgKey.available().catch((error: unknown) => {
    report('fail', '密钥目录', error instanceof Error ? error.message : String(error))
    return [] as readonly GpgKey[]
  })

  if (keys.length === 0) {
    return report('fail', '运维密钥', `${env.SECRETS_DIR} 下一把都没有`, 'npm run keys encrypt')
  }

  for (const key of keys) {
    const info = await stat(key.path)
    const mode = (info.mode & 0o777).toString(8)
    if (mode !== '600') {
      report('warn', `${key.family} 密钥`, `权限 ${mode}`, `chmod 600 ${key.path}`)
      continue
    }

    const address = await key.address().catch((e: unknown) => (e as Error).message)
    const unlock = await key.unlock().catch(() => '探测失败')
    report('ok', `${key.family} 密钥`, `${address}  解锁方式 ${unlock}`)
  }
}

/* ══ ③ 数据 ══════════════════════════════════════════════════════════ */

async function checkData(): Promise<void> {
  const config = await loadRawConfig().catch((error: unknown) => {
    report('fail', '配置校验', error instanceof Error ? error.message : String(error), '按报错修 data/ 下的 json')
    return null
  })
  if (!config) return

  report(
    'ok',
    '配置',
    `${config.chains.length} 条链 · ${config.businessLines.length} 条业务线 · ` +
      `${config.contracts.length} 个合约 · ${config.operators.length} 个操作员`,
  )

  // 每条链的密钥有没有配齐 —— 合约在的链族必须有密钥，否则紧急时按不下去
  const keys = new Set((await GpgKey.available().catch(() => [])).map((k) => k.family))
  const used = new Set(
    config.contracts
      .map((c) => config.chains.find((chain) => chain.key === c.chain)?.type)
      .filter((type): type is string => type !== undefined),
  )
  const missing = [...used].filter((family) => !keys.has(family))
  if (missing.length > 0) {
    report('fail', '密钥覆盖', `${missing.join('、')} 链族有合约但没密钥`, `npm run keys encrypt`)
  } else {
    report('ok', '密钥覆盖', `${[...used].join('、')} 都有密钥`)
  }

  await rpcProvider.load()
  const syncedAt = rpcProvider.syncedAt
  if (!syncedAt) {
    report('warn', 'RPC 数据', '从未同步过', 'npm run sync')
  } else {
    const days = Math.floor((Date.now() - new Date(syncedAt).getTime()) / 86_400_000)
    const stale = days > 7
    report(
      stale ? 'warn' : 'ok',
      'RPC 数据',
      `${syncedAt.slice(0, 10)} 同步（${days} 天前）`,
      stale ? 'npm run sync 刷新一下' : undefined,
    )
  }

  // 每条有合约的链至少要有一个能用的 RPC
  for (const chain of config.chains.filter((c) => used.size > 0 && config.contracts.some((ct) => ct.chain === c.key))) {
    const urls = rpcProvider.urlsFor(chain).length
    if (urls === 0) report('fail', `${chain.key} RPC`, '一个都没有', 'npm run sync')
    else report('ok', `${chain.key} RPC`, `${urls} 个可用`)
  }
}

/* ══ ④ Lark ══════════════════════════════════════════════════════════ */

async function checkLark(): Promise<void> {
  const cli = await hasCommand('lark')
  report(
    cli ? 'ok' : 'warn',
    'lark CLI',
    cli ? '已安装' : '未安装',
    cli ? undefined : '装了才能从飞书拉数据：https://open.feishu.cn/document/tools/lark-cli',
  )

  // MCP 是给对话式操作用的，不装也不影响 npm run sync
  const mcp = await hasCommand('lark-mcp')
  report(mcp ? 'ok' : 'warn', 'lark MCP', mcp ? '已安装' : '未安装（不影响 sync）')

  if (!env.LARK_URL) {
    return report('warn', 'LARK_URL', '未配置', '不配就只用本地 data/，配了才能同步。填多维表格的地址栏链接')
  }
  report('ok', 'LARK_URL', env.LARK_URL.slice(0, 60) + (env.LARK_URL.length > 60 ? '…' : ''))

  if (cli) {
    report('ok', '能否拉取数据', '可以 —— 跑 npm run sync 把飞书的合约清单同步到本地 data/')
  } else {
    report('warn', '能否拉取数据', '不能 —— 缺 lark CLI', '先装 lark CLI 并登录，再 npm run sync')
  }
}

/* ══ ⑤ 服务 ══════════════════════════════════════════════════════════ */

async function checkServices(): Promise<void> {
  const backend = await fetch(`http://localhost:${env.PORT}/api/health`, {
    signal: AbortSignal.timeout(2_000),
  })
    .then((r) => r.ok)
    .catch(() => false)

  report(
    backend ? 'ok' : 'warn',
    '后端',
    backend ? `在跑 (:${env.PORT})` : `没在跑 (:${env.PORT})`,
    backend ? undefined : 'npm run dev',
  )

  const frontend = await fetch('http://localhost:5173', { signal: AbortSignal.timeout(2_000) })
    .then(() => true)
    .catch(() => false)

  report(
    frontend ? 'ok' : 'warn',
    '前端',
    frontend ? '在跑 (:5173)' : '没在跑 (:5173)',
    frontend ? undefined : 'cd ../frontend && npm run dev',
  )
}

/* ══ 跑 ══════════════════════════════════════════════════════════════ */

function run(command: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: gpgEnv() })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('超时'))
    }, timeoutMs)
    timer.unref()
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(`退出码 ${code}`))
    })
    child.on('error', reject)
  })
}

async function main(): Promise<void> {
  console.log('\n合约管理平台 · 启动前排查')

  await section('运行环境', checkRuntime)
  await section('GPG 与运维密钥', checkKeys)
  await section('数据', checkData)
  await section('飞书', checkLark)
  await section('服务', checkServices)

  const failed = results.filter((r) => r.level === 'fail')
  const warned = results.filter((r) => r.level === 'warn')

  console.log('\n' + '─'.repeat(60))
  if (failed.length === 0 && warned.length === 0) {
    console.log('全部通过，可以开工。\n')
    return
  }

  if (failed.length > 0) {
    console.log(`\n${failed.length} 项必须处理：`)
    for (const r of failed) console.log(`  ✗ ${r.label}：${r.detail}${r.next ? `\n      → ${r.next}` : ''}`)
  }
  if (warned.length > 0) {
    console.log(`\n${warned.length} 项建议处理（不影响启动）：`)
    for (const r of warned) console.log(`  ⚠ ${r.label}：${r.detail}${r.next ? `\n      → ${r.next}` : ''}`)
  }
  console.log()
  if (failed.length > 0) process.exitCode = 1
}

void main()
