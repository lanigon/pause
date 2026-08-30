import { messageOf } from '../lib/utils/errors.js'
import { createHash } from 'node:crypto'
import {
  readContracts,
  readSyncConfig,
  saveContracts,
  type ContractsFile,
} from '../repositories/config.repository.js'
import { field, LarkError, readTable, type LarkRow } from '../lib/lark/client.js'
import { KeyedMutex } from '../lib/utils/mutex.js'
import { logger } from '../lib/utils/logger.js'
import { contractsFileSchema } from '../config/config.schema.js'
import { getRegistry, loadRegistry } from './config.js'
import type { Chain } from '../models/chain.model.js'
import type { ContractDef } from '../models/contract.model.js'

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

/**
 * 同步只管内容：解析、比对、决定写不写。
 * contracts.json 在哪、怎么原子写、不存在时怎么办，全归 config.repository ——
 * 换存储介质时这个文件一行都不用动。
 */
export type ContractsPayload = ContractsFile

/** 解析结果 = 内容 + 被跳过的行（每条一句人话，说清是哪一行、为什么） */
export interface ContractsResult extends ContractsPayload {
  readonly skipped: readonly string[]
}


/** 同步节流：这段时间内的重复请求直接用上次结果 */
const SYNC_TTL_MS = 60_000

const LARK_TIMEOUT_MS = 15_000

// RPC 不再来自这张表（C 列现在是 chainId）。
// 运行时的 RPC 来源见 lib/rpc：手工填的 rpc.json lark 段 → Alchemy → ChainList。

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
  /** B 列：链的名字，给人看的标签 */
  readonly chain: string
  /** C 列：chainId —— 链的真身份，机器可校验，解析时以它为准 */
  readonly chainId: number | null
  /** D 列：合约地址 */
  readonly contract: string
  readonly contractName: string
}

export function parseRows(rows: readonly LarkRow[]): readonly LarkRecord[] {
  return rows
    .map((row) => ({
      businessLine: field(row, 'business_line', 'businessLine', '业务线'),
      chain: field(row, 'chain', '链', 'chainKey', '链名'),
      chainId: toChainId(field(row, 'chainid', 'chain_id', 'chainId', '链id', '链 id')),
      contract: field(row, 'contract', '合约', '合约地址', 'address', '地址'),
      contractName: field(row, 'name', '名称', '合约名'),
    }))
    .filter((record) => record.chain !== '' || record.chainId !== null)
}

/** 表格里的数字列可能带逗号或空格，也可能是空的 */
function toChainId(raw: string): number | null {
  const cleaned = raw.replace(/[,\s]/g, '')
  if (!cleaned) return null
  const parsed = Number(cleaned)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * 业务线 + 合约。
 *
 * **链以 chainId 为准**。表格 B 列的"链"是给人看的标签，会写成「Morph 主网」
 * 「morph」「Morph Mainnet」各种样子；C 列的 chainId 才是机器可校验的真身份。
 * 拿 chainId 去 chains.json 里查到哪条链，用那条链的 key。
 *
 * **id 沿用本地已有的**。Lark 是内容的真相来源，但 id 是本地的稳定标识：
 * 手工维护的可读 id（payment、morph-pausable-live）不该被同步冲成哈希，
 * 而且 operations.json 里的历史日志是按 id 引用合约的，换了 id 就对不上了。
 *
 * 配对依据是**内在身份**，不是 id：
 *   业务线 → 名称        合约 → 链 + 地址（合约的真身份就是这个）
 *
 * 解析不了的行**跳过并报告**，不让它拖垮整次同步 ——
 * 50 行里有 1 行填错，另外 49 个合约照样该更新。
 */
export function toContracts(
  records: readonly LarkRecord[],
  local: ContractsPayload = { businessLines: [], contracts: [] },
  chains: readonly Chain[] = [],
): ContractsResult {
  const byChainId = new Map(chains.map((chain) => [chain.chainId, chain]))
  const byKey = new Map(chains.map((chain) => [chain.key.toLowerCase(), chain]))

  const localLineIdByName = new Map(local.businessLines.map((line) => [line.name, line.id]))
  const localContractIdByAddress = new Map(
    local.contracts.map((contract) => [addressKey(contract.chain, contract.address), contract.id]),
  )

  const lines = new Map<string, string>()
  const contracts: ContractDef[] = []
  const skipped: string[] = []
  const seen = new Set<string>()

  for (const record of records) {
    const where = record.contractName || record.contract || '(无名行)'

    if (!record.businessLine || !record.contract) {
      if (record.contract || record.businessLine) skipped.push(`${where}：业务线或合约地址为空`)
      continue
    }

    const chain = resolveChain(record, byChainId, byKey)
    if (typeof chain === 'string') {
      skipped.push(`${where}：${chain}`)
      continue
    }

    const lineId = localLineIdByName.get(record.businessLine) ?? slug(record.businessLine)
    lines.set(lineId, record.businessLine)

    // 同一个合约可能重复出现，按 链+地址 去重
    const key = addressKey(chain.key, record.contract)
    if (seen.has(key)) continue
    seen.add(key)

    contracts.push({
      // 本地已有就沿用；新合约才生成。生成规则：链 + 地址前 8 位，改名不换 id
      id:
        localContractIdByAddress.get(key) ??
        `${slug(chain.key)}-${record.contract.replace(/^0x/i, '').slice(0, 8).toLowerCase()}`,
      name: record.contractName || record.contract,
      businessLine: lineId,
      chain: chain.key,
      address: record.contract,
    })
  }

  return {
    businessLines: [...lines].map(([id, name]) => ({ id, name })),
    contracts,
    skipped,
  }
}

/**
 * 把一行定位到某条链。解析不了就返回原因字符串。
 *
 * chainId 优先 —— 它是链的真身份。填了 chainId 但 chains.json 里没有，
 * 说明要接一条新链，那得先补 chains.json（还要 explorer、类型、multicall
 * 这些表格里没有的信息），不能凭一个数字就往紧急暂停的清单里加链。
 */
function resolveChain(
  record: LarkRecord,
  byChainId: ReadonlyMap<number, Chain>,
  byKey: ReadonlyMap<string, Chain>,
): Chain | string {
  if (record.chainId !== null) {
    const chain = byChainId.get(record.chainId)
    if (!chain) {
      return `chainId ${record.chainId} 在 chains.json 里没有对应的链，请先补上链定义`
    }
    return chain
  }

  // 没填 chainId 就退回按链名匹配 —— 要正好等于 chains.json 的 key
  const label = record.chain.trim().toLowerCase()
  const chain = byKey.get(label)
  if (!chain) return `没填 chainId，链名「${record.chain}」也匹配不上 chains.json 里的任何一条链`
  return chain
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

    /**
     * 强制刷新时总是重载一次本地配置。
     *
     * runSync 只在**飞书有变更**时才 loadRegistry —— 没配飞书、或拉下来和本地
     * 一致时都不会重载。但「手改了 data/*.json 想让它生效」是真实需求，
     * 以前靠一个单独的 POST /registry/reload，那个接口零调用方。
     * 并到这里之后，「重新同步」这一个动作同时覆盖两件事。
     *
     * 校验不过时 loadRegistry 会抛，而 core/config 只在 build 成功后才换掉
     * current，所以沿用的是上一份能跑的配置，不会把服务搞挂。
     */
    if (force && !result.changed) {
      try {
        await loadRegistry()
        emit(event(SyncPhase.APPLY, true, '已重新加载本地配置'))
      } catch (error) {
        emit(
          event(SyncPhase.APPLY, false, `本地配置校验不过，沿用上一份：${messageOf(error)}`, 'RELOAD_FAILED'),
        )
      }
    }

    lastSyncAt = Date.now()
    lastResult = result
    return result
  })
}

async function runSync(emit: SyncEmit): Promise<SyncResult> {
  const { larkUrl } = await readSyncConfig()
  if (!larkUrl) {
    emit(
      event(SyncPhase.SOURCE, false, '未配置 data/sync.json 的 larkUrl，使用本地数据', 'LARK_NOT_CONFIGURED'),
    )
    return { changed: false, fromLark: false }
  }

  // ① 拉取。失败就降级到本地，绝不让前端拿不到数据
  emit(event(SyncPhase.SOURCE, true, '正在从 Lark 拉取合约清单…'))
  let records: readonly LarkRecord[]
  try {
    records = parseRows(await readTable(larkUrl, LARK_TIMEOUT_MS))
  } catch (error) {
    const code = error instanceof LarkError ? error.code : 'LARK_FAILED'
    const message = messageOf(error)
    logger.warn({ code, message }, 'Lark 同步失败，使用本地数据')
    emit(event(SyncPhase.SOURCE, false, `Lark 拉取失败，使用本地数据：${message}`, code))
    return { changed: false, fromLark: false }
  }

  const localContracts = await readContracts()
  const next = toContracts(records, localContracts, [...getRegistry().chains.values()])
  emit(
    event(
      SyncPhase.SOURCE,
      true,
      `拉到 ${records.length} 行，解析出 ${next.businessLines.length} 条业务线、${next.contracts.length} 个合约`,
    ),
  )

  // 解析不了的行单独报出来 —— 跳过它们，但绝不能悄悄跳过
  if (next.skipped.length > 0) {
    emit(
      event(
        SyncPhase.SOURCE,
        false,
        `${next.skipped.length} 行解析不了，已跳过（其余照常同步）`,
        'ROWS_SKIPPED',
        next.skipped,
      ),
    )
  }

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

  // ③ 比对。RPC 不在这张表里（C 列现在是 chainId），所以只比合约
  const changes = diffContracts(localContracts, next)

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

  try {
    await saveContracts(next)
    await loadRegistry()

    logger.info({ changes: changes.length }, 'Lark 同步已应用')
    emit(event(SyncPhase.APPLY, true, `已更新本地数据并重载配置（${changes.length} 处变更）`, undefined, changes))
    return { changed: true, fromLark: true }
  } catch (error) {
    /**
     * 写进去了但配置校验没过。
     *
     * chainId 解析那一层已经挡掉了"链不存在"这类问题，走到这儿说明是
     * 更意外的情况（地址格式、id 冲突…）。仍然必须回滚 ——
     * 磁盘上留着一份跑不起来的配置，**下次重启后端就起不来了**。
     */
    const message = messageOf(error)
    logger.error({ message }, 'Lark 同步应用失败，正在回滚')

    const rolledBack = await rollback(localContracts)
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

/** 把 contracts.json 恢复到同步前的内容并重载。返回是否恢复成功 */
async function rollback(contracts: ContractsPayload): Promise<boolean> {
  try {
    await saveContracts(contracts)
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
