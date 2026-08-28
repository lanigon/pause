/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  数据同步 CLI —— 从 Lark（飞书）与 ChainList 拉取 RPC 和合约数据
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npm run sync rpc        |  pnpm sync rpc        同步 RPC → data/rpc.json
 *   npm run sync contracts  |  pnpm sync contracts  同步合约 → data/contracts.json
 *   npm run sync all        |  pnpm sync all        两个都同步
 *
 * 为什么要离线同步而不是运行时拉：
 * 后端每次解析 RPC 都去请求 Lark / ChainList，一次页面加载就会被外部服务的
 * 延迟和限流拖住。所以把「拉取 + 转换」放在这个脚本里，请求路径上只读本地 json。
 *
 * Lark 接入方式（二选一，脚本自动探测）：
 *   1. lark MCP —— 在 Claude Code 里配好 lark MCP server 后由本脚本调用
 *   2. lark CLI —— 本机装了 `lark` 命令行工具
 * 两个都没有时，脚本会跳过 Lark 并告诉你怎么配，其余来源照常同步。
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { config as loadDotenv } from 'dotenv'
import { readTable } from '../src/lib/lark/client.js'
import { parseRows, toContracts, toRpcMap } from '../src/services/sync.service.js'

// 脚本独立运行，也要读 .env（ALCHEMY_API_KEY / LARK_TABLE）
loadDotenv()

const DATA_DIR = './data'
const RPC_FILE = `${DATA_DIR}/rpc.json`
const CHAINS_FILE = `${DATA_DIR}/chains.json`
const CONTRACTS_FILE = `${DATA_DIR}/contracts.json`

/**
 * Lark 表格位置。一张表四列：业务线 · 链 · RPC · 合约。
 * 不填就跳过 Lark，只用 ChainList 的公开 RPC。
 */
const LARK_TABLE = process.env.LARK_TABLE?.trim() ?? ''

interface ChainDef {
  key: string
  name: string
  type: string
  chainId: number
}


/* ══ 连通性检查 ════════════════════════════════════════════════════════ */

/**
 * 拿到 RPC 之后必须真连一下。
 *
 * 光有地址不够：ChainList 上一半的公开节点是死的或已经要 API key 了
 * （polygon-rpc.com 现在就返回 401），把它们写进 rpc.json 只会让运行时
 * 每次请求都先撞一次墙再降级。
 *
 * 除了"通不通"还要验 **chainId 对不对** —— 一个能响应但链不对的节点
 * 比死节点更危险：交易会发到错误的链上。
 */
interface Probe {
  url: string
  ok: boolean
  latencyMs: number
  reason?: string
}

const PROBE_TIMEOUT_MS = 6_000

async function probe(url: string, chain: ChainDef): Promise<Probe> {
  const startedAt = Date.now()
  const fail = (reason: string): Probe => ({ url, ok: false, latencyMs: Date.now() - startedAt, reason })

  try {
    if (chain.type === 'tron') {
      // TronGrid 是 REST，不是 JSON-RPC
      const res = await fetch(`${url.replace(/\/$/, '')}/wallet/getnowblock`, {
        method: 'POST',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return fail(`HTTP ${res.status}`)
      const body = (await res.json()) as { block_header?: unknown }
      return body.block_header
        ? { url, ok: true, latencyMs: Date.now() - startedAt }
        : fail('响应里没有区块头')
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!res.ok) return fail(`HTTP ${res.status}`)

    const body = (await res.json()) as { result?: string; error?: { message?: string } }
    if (!body.result) return fail(body.error?.message ?? '无返回值')

    const actual = Number.parseInt(body.result, 16)
    // 链不对比死节点更危险 —— 交易会发到错误的链上
    return actual === chain.chainId
      ? { url, ok: true, latencyMs: Date.now() - startedAt }
      : fail(`chainId 不符：期望 ${chain.chainId}，实际 ${actual}`)
  } catch (error) {
    return fail(error instanceof Error ? error.message.slice(0, 60) : '连接失败')
  }
}

/** 逐条探活，只留通的，并按延迟从快到慢排 */
async function keepAlive(
  urls: readonly string[],
  chain: ChainDef,
  label: string,
): Promise<string[]> {
  if (urls.length === 0) return []

  const results = await Promise.all(urls.map((url) => probe(url, chain)))
  const alive = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs)

  for (const dead of results.filter((r) => !r.ok)) {
    console.log(`     ✗ ${label} ${host(dead.url)} — ${dead.reason}`)
  }
  for (const good of alive) {
    console.log(`     ✓ ${label} ${host(good.url)} — ${good.latencyMs}ms`)
  }

  return alive.map((r) => r.url)
}

const host = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/* ══ RPC 同步 ══════════════════════════════════════════════════════════ */

/**
 * Tron 不能用 ChainList 的数据。
 *
 * ChainList 给 Tron 列的是 `rpc.ankr.com/tron_jsonrpc` 这类 **EVM 风格 JSON-RPC** 端点，
 * 但我们读 Tron 合约用的是 TronGrid 的 REST 接口（/wallet/triggerconstantcontract），
 * 两者路径完全不同，拿 ChainList 的地址去调会 404。所以 Tron 单独写死已知的 REST 端点。
 */
const TRON_ENDPOINTS: readonly string[] = ['https://api.trongrid.io']

/** ChainList 的公开 RPC。按 chainId 匹配，过滤掉带模板占位符与 ws 的 */
async function fetchChainlist(chains: ChainDef[]): Promise<Record<string, string[]>> {
  const res = await fetch('https://chainid.network/chains.json')
  if (!res.ok) throw new Error(`ChainList 请求失败: HTTP ${res.status}`)

  const all = (await res.json()) as { chainId: number; rpc?: string[] }[]
  const byChainId = new Map(all.map((entry) => [entry.chainId, entry.rpc ?? []]))

  const map: Record<string, string[]> = {}
  for (const chain of chains) {
    if (chain.type === 'tron') {
      map[chain.key] = [...TRON_ENDPOINTS]
      continue
    }
    const urls = (byChainId.get(chain.chainId) ?? []).filter(
      (url) => url.startsWith('https://') && !url.includes('${'),
    )
    // 只留前 5 个，避免把一大堆低质量节点塞进候选列表
    if (urls.length > 0) map[chain.key] = urls.slice(0, 5)
  }
  return map
}

async function syncRpc(): Promise<void> {
  const chains = await readChains()
  console.log(`链定义: ${chains.map((c) => c.key).join(', ')}\n`)

  // ① Lark（优先级最高）
  let lark: Record<string, string[]> = {}
  if (LARK_TABLE) {
    try {
      console.log('① 从 Lark 拉取…')
      lark = toRpcMap(parseRows(await readTable(LARK_TABLE)))
      console.log(`   拿到 ${count(lark)} 个，开始探活…`)
      lark = await verifyAll(lark, chains, 'lark')
    } catch (error) {
      console.log(`   ⚠️  跳过 Lark：${(error as Error).message}\n`)
    }
  } else {
    console.log('① Lark：未设置 LARK_TABLE，跳过')
  }

  // ② Alchemy 运行时按 chainId 现拼，不写进 rpc.json；但这里验一下 key 与网络是否可用
  console.log('\n② Alchemy：检查 key 与各链是否已启用…')
  await checkAlchemy(chains)

  // ③ ChainList（兜底）
  console.log('\n③ 从 ChainList 拉取公开 RPC…')
  let chainlist = await fetchChainlist(chains)
  console.log(`   拿到 ${count(chainlist)} 个，开始探活…`)
  chainlist = await verifyAll(chainlist, chains, 'chainlist')

  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(
    RPC_FILE,
    `${JSON.stringify({ syncedAt: new Date().toISOString(), lark, chainlist }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\n✅ 已写入 ${RPC_FILE}`)

  const missing = chains.filter((c) => !lark[c.key]?.length && !chainlist[c.key]?.length)
  if (missing.length > 0) {
    console.log(`\n⚠️  以下链没有可用的公开 RPC，将只能依赖 Alchemy：${missing.map((c) => c.key).join(', ')}`)
  }
}

/** 对每条链的候选逐一探活 */
async function verifyAll(
  map: Record<string, string[]>,
  chains: ChainDef[],
  label: string,
): Promise<Record<string, string[]>> {
  const verified: Record<string, string[]> = {}

  for (const chain of chains) {
    const urls = map[chain.key]
    if (!urls?.length) continue
    console.log(`   ${chain.key}:`)
    const alive = await keepAlive(urls, chain, label)
    if (alive.length > 0) verified[chain.key] = alive
  }
  return verified
}

/**
 * 验证 Alchemy。
 *
 * 它不写进 rpc.json（运行时按 chainId 现拼），但值得在这里查一次 ——
 * Alchemy 的网络是**按 app 逐个启用**的，没启用的会返回 403，
 * 运行时才发现就晚了：每次请求都要先撞一次 403 再降级。
 */
async function checkAlchemy(chains: ChainDef[]): Promise<void> {
  const key = process.env.ALCHEMY_API_KEY?.trim()
  if (!key) {
    console.log('   未设置 ALCHEMY_API_KEY，跳过这一级')
    return
  }

  const { alchemyUrlFor } = await import('../src/lib/rpc/sources.js')

  for (const chain of chains) {
    const url = alchemyUrlFor(chain.chainId, key)
    if (!url) {
      console.log(`   ${chain.key.padEnd(14)} — Alchemy 不支持这条链`)
      continue
    }
    const result = await probe(url, chain)
    console.log(
      result.ok
        ? `   ${chain.key.padEnd(14)} ✓ ${result.latencyMs}ms`
        : `   ${chain.key.padEnd(14)} ✗ ${result.reason}` +
          (result.reason?.includes('403') || result.reason?.includes('not enabled')
            ? '（去 Alchemy dashboard 启用这条网络）'
            : ''),
    )
  }
}

/* ══ 合约同步 ══════════════════════════════════════════════════════════ */

async function syncContracts(): Promise<void> {
  if (!LARK_TABLE) {
    console.log('未设置 LARK_TABLE，跳过合约同步。')
    return
  }

  console.log('从 Lark 拉取合约…')
  const payload = toContracts(parseRows(await readTable(LARK_TABLE)))

  if (payload.contracts.length === 0) {
    throw new Error('Lark 表里没有解析出任何合约，请检查表头是否为 业务线/链/RPC/合约')
  }

  await writeFile(CONTRACTS_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(
    `✅ 已写入 ${CONTRACTS_FILE}：${payload.businessLines.length} 条业务线，${payload.contracts.length} 个合约`,
  )
}

/* ══ 辅助 ══════════════════════════════════════════════════════════════ */

async function readChains(): Promise<ChainDef[]> {
  const parsed = JSON.parse(await readFile(CHAINS_FILE, 'utf8')) as { chains: ChainDef[] }
  return parsed.chains
}

const count = (map: Record<string, string[]>): number =>
  Object.values(map).reduce((sum, list) => sum + list.length, 0)

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} 退出码 ${code}`)),
    )
  })
}

export const hasCommand = (command: string): Promise<boolean> =>
  run('which', [command]).then(() => true).catch(() => false)

/* ══ 入口 ══════════════════════════════════════════════════════════════ */

const COMMANDS: Record<string, () => Promise<void>> = {
  rpc: syncRpc,
  contracts: syncContracts,
  all: async () => {
    await syncRpc()
    console.log('')
    await syncContracts()
  },
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const handler = command ? COMMANDS[command] : undefined

  if (!handler) {
    console.log(`
用法（npm / pnpm 都支持）：

  npm run sync rpc        |  pnpm sync rpc        同步 RPC → data/rpc.json
  npm run sync contracts  |  pnpm sync contracts  同步合约 → data/contracts.json
  npm run sync all        |  pnpm sync all        两个都同步

RPC 三级降级：Lark → Alchemy → ChainList
  Lark       需要 lark CLI + 环境变量 LARK_TABLE（一张表：业务线/链/RPC/合约）
  Alchemy    只要 ALCHEMY_API_KEY，运行时现拼，不用同步
  ChainList  公开数据，直接可用
`)
    process.exitCode = command ? 1 : 0
    return
  }
  await handler()
}

// 被 import（测试）时不执行，只有直接运行才跑
if (process.argv[1]?.endsWith('sync.ts') || process.argv[1]?.endsWith('sync.js')) {
  main().catch((error: unknown) => {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
