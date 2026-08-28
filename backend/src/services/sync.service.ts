import { createHash } from 'node:crypto'
import { writeJsonAtomic, readJson } from '../lib/utils/jsonFile.js'
import { field, LarkError, readTable, type LarkRow } from '../lib/lark/client.js'
import { KeyedMutex } from '../lib/utils/mutex.js'
import { logger } from '../lib/utils/logger.js'
import { env } from '../config/env.js'
import { contractsFileSchema } from '../config/config.schema.js'
import { loadRegistry } from './registry.service.js'
import { rpcProvider } from '../lib/rpc/rpcProvider.js'
import type { BusinessLine, ContractDef } from '../models/contract.model.js'
import type { RpcFile } from '../lib/rpc/types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Lark 数据同步
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 前端每次加载数据时先跑一遍：拉 Lark → 和本地上次的比对 → 有差异才更新。
 *
 * 这是**紧急暂停**工具，可用性优先于数据新鲜度。三条硬约束：
 *
 *   ① Lark 挂了不能挡住控制台 —— 拉不到就说明原因，继续用本地数据
 *   ② Lark 解析出 0 个合约 = 异常，绝不覆盖本地
 *      （表格一次误操作就把合约清空，紧急时会找不到东西可暂停）
 *   ③ 不能每次刷页面都打 Lark —— TTL 缓存 + 互斥，并发请求共享同一次同步
 */

export interface ContractsPayload {
  readonly businessLines: readonly BusinessLine[]
  readonly contracts: readonly ContractDef[]
}


/** 同步节流：这段时间内的重复请求直接用上次结果 */
const SYNC_TTL_MS = 60_000

const LARK_TIMEOUT_MS = 15_000

const CONTRACTS_FILE = `${env.DATA_DIR}/contracts.json`
const RPC_FILE = `${env.DATA_DIR}/rpc.json`

/* ══ 事件 ════════════════════════════════════════════════════════════════ */

export enum SyncPhase {
  /** 从 Lark 拉取 */
  SOURCE = 'source',
  /** 与本地比对 */
  DIFF = 'diff',
  /** 写入并重载（或跳过） */
  APPLY = 'apply',
}

export interface SyncEvent {
  readonly phase: SyncPhase
  readonly at: number
  readonly ok: boolean
  readonly message: string
  /** 失败/跳过时的原因码，前端可据此分支 */
  readonly code?: string
  /** 变更摘要，只在 diff / apply 阶段有 */
  readonly changes?: readonly string[]
}

export type SyncEmit = (event: SyncEvent) => void

export interface SyncResult {
  /** 本地数据是否被更新 */
  readonly changed: boolean
  /** 是否真的拉到了 Lark 数据 */
  readonly fromLark: boolean
}

/* ══ 解析 ════════════════════════════════════════════════════════════════ */

/**
 * Lark 上就一张表，四列：**业务线 · 链 · RPC · 合约**。
 * 一行是一条记录，同一条链会在多行里重复出现（每个合约一行），
 * 所以要按列聚合：链去重、RPC 去重、业务线去重、合约逐条收集。
 */
export interface LarkRecord {
  readonly businessLine: string
  readonly chain: string
  readonly rpc: string
  readonly contract: string
  readonly contractName: string
}

export function parseRows(rows: readonly LarkRow[]): readonly LarkRecord[] {
  return rows
    .map((row) => ({
      businessLine: field(row, 'business_line', 'businessLine', '业务线'),
      chain: field(row, 'chain', '链', 'chainKey'),
      rpc: field(row, 'rpc', 'RPC', 'RPC地址', 'url', 'endpoint'),
      contract: field(row, 'contract', '合约', '合约地址', 'address', '地址'),
      contractName: field(row, 'name', '名称', '合约名'),
    }))
    .filter((record) => record.chain !== '')
}

/** 链 → RPC 列表（去重，保持出现顺序） */
export function toRpcMap(records: readonly LarkRecord[]): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const record of records) {
    if (!record.rpc.startsWith('http')) continue
    const list = (map[record.chain] ??= [])
    if (!list.includes(record.rpc)) list.push(record.rpc)
  }
  return map
}


/**
 * 业务线 + 合约。
 *
 * **id 沿用本地已有的**。Lark 是内容的真相来源，但 id 是本地的稳定标识：
 * 手工维护的可读 id（payment、morph-pausable-live）不该被同步冲成哈希，
 * 而且 operations.json 里的历史日志是按 id 引用合约的，换了 id 就对不上了。
 *
 * 配对依据是**内在身份**，不是 id：
 *   业务线 → 名称        合约 → 链 + 地址（合约的真身份就是这个）
 */
export function toContracts(
  records: readonly LarkRecord[],
  local: ContractsPayload = { businessLines: [], contracts: [] },
): ContractsPayload {
  const localLineIdByName = new Map(local.businessLines.map((line) => [line.name, line.id]))
  const localContractIdByAddress = new Map(
    local.contracts.map((contract) => [addressKey(contract.chain, contract.address), contract.id]),
  )

  const lines = new Map<string, string>()
  const contracts: ContractDef[] = []
  const seen = new Set<string>()

  for (const record of records) {
    if (!record.businessLine || !record.contract) continue

    const lineId = localLineIdByName.get(record.businessLine) ?? slug(record.businessLine)
    lines.set(lineId, record.businessLine)

    // 同一个合约可能因为多个 RPC 而出现多行，按 链+地址 去重
    const key = addressKey(record.chain, record.contract)
    if (seen.has(key)) continue
    seen.add(key)

    contracts.push({
      // 本地已有就沿用；新合约才生成。生成规则：链 + 地址前 8 位，改名不换 id
      id:
        localContractIdByAddress.get(key) ??
        `${slug(record.chain)}-${record.contract.replace(/^0x/i, '').slice(0, 8).toLowerCase()}`,
      name: record.contractName || record.contract,
      businessLine: lineId,
      chain: record.chain,
      address: record.contract,
    })
  }

  return {
    businessLines: [...lines].map(([id, name]) => ({ id, name })),
    contracts,
  }
}

const addressKey = (chain: string, address: string): string => `${chain}:${address.toLowerCase()}`

/**
 * 生成 id。
 *
 * 中文原样 slug 出来是空字符串 —— 飞书表上业务线基本都是中文，
 * 全塌成空 id 的话所有业务线会挤成一条。所以非 ASCII 退回稳定短哈希：
 * 不好看，但唯一、稳定、跨次同步不变。
 */
export function slug(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (ascii) return ascii
  return `bl-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`
}

/* ══ 比对 ════════════════════════════════════════════════════════════════ */

/**
 * 差异摘要要说人话 —— "变了" 没用，得说清变了什么，
 * 运维才能判断这次变更是不是自己预期的。
 */
export function diffContracts(local: ContractsPayload, next: ContractsPayload): readonly string[] {
  const changes: string[] = []
  const localById = new Map(local.contracts.map((c) => [c.id, c]))
  const nextById = new Map(next.contracts.map((c) => [c.id, c]))

  /**
   * id 里带地址，所以改地址会表现为「删一个 + 加一个」。
   * 但这两件事对运维的含义完全不同 —— 地址变更可能是升级，也可能是表格填错，
   * 必须单独点出来。用 业务线+链+名称 作为"同一个东西"的判据把这对配起来。
   */
  const identityOf = (contract: ContractDef): string =>
    `${contract.businessLine}|${contract.chain}|${contract.name}`

  const orphanedLocal = new Map(
    local.contracts.filter((c) => !nextById.has(c.id)).map((c) => [identityOf(c), c]),
  )

  for (const contract of next.contracts) {
    if (localById.has(contract.id)) continue

    const moved = orphanedLocal.get(identityOf(contract))
    if (moved) {
      changes.push(`合约 ${contract.name} 地址变更 ${short(moved.address)} → ${short(contract.address)}`)
      orphanedLocal.delete(identityOf(contract)) // 配上了就不再报"移除"
    } else {
      changes.push(`新增合约 ${contract.name}（${contract.chain}）`)
    }
  }

  for (const contract of orphanedLocal.values()) {
    changes.push(`移除合约 ${contract.name}（${contract.chain}）`)
  }

  // 名称/归属变了但地址没变的（id 相同）
  for (const [id, contract] of nextById) {
    const previous = localById.get(id)
    if (!previous) continue
    if (previous.name !== contract.name || previous.businessLine !== contract.businessLine) {
      changes.push(`合约 ${contract.name} 归属或名称变更`)
    }
  }

  const localLines = new Set(local.businessLines.map((line) => line.id))
  const nextLines = new Set(next.businessLines.map((line) => line.id))
  for (const line of next.businessLines) {
    if (!localLines.has(line.id)) changes.push(`新增业务线 ${line.name}`)
  }
  for (const line of local.businessLines) {
    if (!nextLines.has(line.id)) changes.push(`移除业务线 ${line.name}`)
  }

  return changes
}

export function diffRpc(
  local: Readonly<Record<string, readonly string[]>>,
  next: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const changes: string[] = []
  for (const [chain, urls] of Object.entries(next)) {
    const previous = local[chain] ?? []
    if (previous.join('|') !== urls.join('|')) {
      changes.push(`${chain} RPC ${previous.length} → ${urls.length} 个`)
    }
  }
  for (const chain of Object.keys(local)) {
    if (!(chain in next)) changes.push(`${chain} 移除了 Lark RPC`)
  }
  return changes
}

/* ══ 同步 ════════════════════════════════════════════════════════════════ */

const lock = new KeyedMutex()
let lastSyncAt = 0
let lastResult: SyncResult = { changed: false, fromLark: false }

/** 测试用：清掉节流状态 */
export function resetSyncThrottle(): void {
  lastSyncAt = 0
  lastResult = { changed: false, fromLark: false }
}

/**
 * 拉 Lark → 比对 → 有差异才写。
 *
 * 任何一步失败都只是"这次没同步成"，不影响本地数据可用 ——
 * 调用方拿到结果后照常返回本地 registry。
 */
export async function syncFromLark(emit: SyncEmit, force = false): Promise<SyncResult> {
  // 并发请求共享同一次同步：第二个请求在锁上等，拿到的是同一份结果
  return lock.runExclusive('lark-sync', async () => {
    if (!force && Date.now() - lastSyncAt < SYNC_TTL_MS) {
      emit(event(SyncPhase.SOURCE, true, `${Math.round((Date.now() - lastSyncAt) / 1000)}s 前刚同步过，跳过`, 'THROTTLED'))
      // 这次调用本身没有做任何变更
      return { ...lastResult, changed: false }
    }

    const result = await runSync(emit)
    lastSyncAt = Date.now()
    lastResult = result
    return result
  })
}

async function runSync(emit: SyncEmit): Promise<SyncResult> {
  if (!env.LARK_URL) {
    emit(event(SyncPhase.SOURCE, false, '未配置 LARK_URL，使用本地数据', 'LARK_NOT_CONFIGURED'))
    return { changed: false, fromLark: false }
  }

  // ① 拉取。失败就降级到本地，绝不让前端拿不到数据
  emit(event(SyncPhase.SOURCE, true, '正在从 Lark 拉取合约与 RPC…'))
  let records: readonly LarkRecord[]
  try {
    records = parseRows(await readTable(env.LARK_URL, LARK_TIMEOUT_MS))
  } catch (error) {
    const code = error instanceof LarkError ? error.code : 'LARK_FAILED'
    const message = error instanceof Error ? error.message : String(error)
    logger.warn({ code, message }, 'Lark 同步失败，使用本地数据')
    emit(event(SyncPhase.SOURCE, false, `Lark 拉取失败，使用本地数据：${message}`, code))
    return { changed: false, fromLark: false }
  }

  const localContracts = await readJson<ContractsPayload>(CONTRACTS_FILE, {
    businessLines: [],
    contracts: [],
  })
  const next = toContracts(records, localContracts)
  emit(
    event(
      SyncPhase.SOURCE,
      true,
      `拉到 ${records.length} 行，解析出 ${next.businessLines.length} 条业务线、${next.contracts.length} 个合约`,
    ),
  )

  // ② 空数据 = 异常，绝不覆盖本地。这是最危险的失败模式：
  //    表格权限掉了 / 视图筛选错了，都会返回 0 行；覆盖下去紧急时就没合约可暂停了
  if (next.contracts.length === 0) {
    emit(
      event(
        SyncPhase.DIFF,
        false,
        'Lark 没有解析出任何合约，判定为异常，保留本地数据不覆盖',
        'LARK_EMPTY',
      ),
    )
    return { changed: false, fromLark: true }
  }

  // ③ 比对
  const localRpc = await readJson<RpcFile>(RPC_FILE, { syncedAt: '', lark: {}, chainlist: {} })
  const nextRpc = toRpcMap(records)

  const changes = [...diffContracts(localContracts, next), ...diffRpc(localRpc.lark, nextRpc)]

  if (changes.length === 0) {
    emit(event(SyncPhase.DIFF, true, '与本地一致，无需更新'))
    emit(event(SyncPhase.APPLY, true, '数据已是最新'))
    return { changed: false, fromLark: true }
  }

  emit(event(SyncPhase.DIFF, true, `发现 ${changes.length} 处变更`, undefined, changes))

  // ④ 先校验再落盘。校验不过说明 Lark 上的数据有问题，宁可不更新
  const parsed = contractsFileSchema.safeParse(next)
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? '格式不合法'
    emit(event(SyncPhase.APPLY, false, `Lark 数据校验失败，保留本地：${reason}`, 'INVALID_PAYLOAD'))
    return { changed: false, fromLark: true }
  }

  const nextRpcFile: RpcFile = { ...localRpc, syncedAt: new Date().toISOString(), lark: nextRpc }

  try {
    await writeJsonAtomic(CONTRACTS_FILE, next)
    await writeJsonAtomic(RPC_FILE, nextRpcFile)

    // 重载顺序：先 RPC 再 registry —— registry 的 DTO 里要带 RPC
    await rpcProvider.load(env.DATA_DIR)
    await loadRegistry()

    logger.info({ changes: changes.length }, 'Lark 同步已应用')
    emit(event(SyncPhase.APPLY, true, `已更新本地数据并重载配置（${changes.length} 处变更）`, undefined, changes))
    return { changed: true, fromLark: true }
  } catch (error) {
    /**
     * 写进去了但配置校验没过（最常见：Lark 上有 chains.json 里没有的链）。
     *
     * 必须回滚 —— 磁盘上留着一份跑不起来的配置，**下次重启后端就起不来了**。
     * 紧急暂停工具起不来是最坏的结果，比数据旧得多。
     */
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ message }, 'Lark 同步应用失败，正在回滚')

    const rolledBack = await rollback(localContracts, localRpc)
    emit(
      event(
        SyncPhase.APPLY,
        false,
        rolledBack
          ? `Lark 数据无法应用，已回滚到本地版本：${message}`
          : `Lark 数据无法应用，且回滚失败，请立即人工检查 data/：${message}`,
        rolledBack ? 'APPLY_ROLLED_BACK' : 'ROLLBACK_FAILED',
      ),
    )
    return { changed: false, fromLark: true }
  }
}

/** 把两个文件恢复到同步前的内容并重载。返回是否恢复成功 */
async function rollback(contracts: ContractsPayload, rpc: RpcFile): Promise<boolean> {
  try {
    await writeJsonAtomic(CONTRACTS_FILE, contracts)
    await writeJsonAtomic(RPC_FILE, rpc)
    await rpcProvider.load(env.DATA_DIR)
    await loadRegistry()
    return true
  } catch (cause) {
    logger.error({ cause }, '回滚失败，data/ 目录可能处于不一致状态')
    return false
  }
}

/* ══ 小工具 ══════════════════════════════════════════════════════════════ */

const event = (
  phase: SyncPhase,
  ok: boolean,
  message: string,
  code?: string,
  changes?: readonly string[],
): SyncEvent => ({ phase, at: Date.now(), ok, message, code, changes })

const short = (address: string): string => `${address.slice(0, 8)}…${address.slice(-6)}`
