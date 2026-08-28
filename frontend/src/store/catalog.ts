import { computed, ref, shallowRef } from 'vue'
import * as api from './api'
import { readStates } from '../chain/multicall'
import type { Session } from './session'
import type {
  Chain,
  Contract,
  ContractState,
  OperationLog,
  Registry,
  SyncEvent,
  SyncResult,
} from '../types'

/**
 * 配置目录与链上状态：看得见什么、选中了什么、现在是什么状态。
 *
 * 配置一个接口拿全（/registry），链上状态优先自己 multicall 读。
 */
export function useCatalog(session: Session) {
  const registry = shallowRef<Registry | null>(null)
  /** 侧边栏勾选的业务线，可多选。右侧按业务线一块一块展示 */
  const selectedLines = ref<Set<string>>(new Set())
  const selected = ref<Set<string>>(new Set())
  const states = ref<Map<string, ContractState>>(new Map())
  /** 交易日志，来自后端。只含真实发出去的交易 */
  const logs = ref<OperationLog[]>([])
  const loading = ref(false)
  /** 本次加载时后端与 Lark 的同步进度 */
  const syncEvents = ref<SyncEvent[]>([])
  const syncResult = ref<SyncResult | null>(null)

  /* ── 派生 ── */

  const businessLines = computed(() => registry.value?.businessLines ?? [])
  const chains = computed(() => registry.value?.chains ?? [])
  const allContracts = computed(() => registry.value?.contracts ?? [])

  const chainOf = (key: string): Chain | undefined => chains.value.find((c) => c.key === key)

  /** 勾选的业务线下的全部合约 */
  const visibleContracts = computed<Contract[]>(() =>
    selectedLines.value.size === 0
      ? []
      : allContracts.value.filter((c) => selectedLines.value.has(c.businessLine)),
  )

  /** 按业务线分块，右侧一个业务线一张表 */
  const groups = computed(() =>
    businessLines.value
      .filter((line) => selectedLines.value.has(line.id))
      .map((line) => ({
        line,
        contracts: allContracts.value.filter((c) => c.businessLine === line.id),
      })),
  )

  /** 侧边栏红点：该业务线下有合约处于暂停中 */
  const pausedCountOf = (lineId: string): number =>
    allContracts.value.filter(
      (c) => c.businessLine === lineId && states.value.get(c.id)?.paused === true,
    ).length

  const contractCountOf = (lineId: string): number =>
    allContracts.value.filter((c) => c.businessLine === lineId).length

  const selectedContracts = computed(() =>
    visibleContracts.value.filter((c) => selected.value.has(c.id)),
  )

  /** 钱包模式下，只能操作当前钱包所在链族的合约 */
  const canOperate = (contract: Contract): boolean => {
    if (session.mode.value === 'gpg') return true
    const family = chainOf(contract.chain)?.type
    return family !== undefined && session.connected.value[family] !== null
  }

  const countByState = (paused: boolean): number =>
    visibleContracts.value.filter((c) => states.value.get(c.id)?.paused === paused).length

  /* ── 加载 ── */

  /**
   * 启动加载：配置 + 历史日志 + 链上状态。
   *
   * 配置走同步接口 —— 后端会先跟 Lark 对一遍再把数据给我们，
   * 过程通过 SSE 推过来（拉取 / 比对 / 应用），进度存进 syncEvents 给 UI 展示。
   * 同步接口本身挂了才退回纯本地的 /registry —— 数据比进度重要。
   */
  async function bootstrap(force = false): Promise<void> {
    loading.value = true
    syncEvents.value = []
    syncResult.value = null
    try {
      const [reg, log] = await Promise.all([
        api
          .syncRegistry((event) => syncEvents.value.push(event), { force })
          .then((synced) => {
            syncResult.value = synced.synced
            return synced
          })
          .catch(async (error: unknown) => {
            syncEvents.value.push({
              phase: 'source',
              at: Date.now(),
              ok: false,
              message: `同步接口不可用，直接读本地配置：${(error as Error).message}`,
              code: 'SYNC_UNAVAILABLE',
            })
            return api.getRegistry()
          }),
        api.getLogs(),
      ])
      registry.value = reg
      logs.value = log.items
      if (selectedLines.value.size === 0 && reg.businessLines[0]) {
        selectedLines.value = new Set([reg.businessLines[0].id])
      }
      await refreshStates()
    } finally {
      loading.value = false
    }
  }

  /**
   * 刷新链上状态。
   * 先自己 multicall（省后端 RPC 配额、也更快）；
   * 一个都没读到就退回后端的 /states —— 公开 RPC 常常不带 CORS 头，
   * 浏览器会直接拦掉，这时候只能让后端代读。
   */
  async function refreshStates(): Promise<void> {
    const reg = registry.value
    if (!reg) return

    let next = new Map<string, ContractState>()
    try {
      next = await readStates(reg.chains, reg.contracts)
    } catch {
      /* 整体失败也走兜底 */
    }

    // 判断依据是"有没有真读到值"，不是 Map 有没有条目 ——
    // RPC 被 CORS 拦掉时也可能返回一堆空对象
    const gotAnything = [...next.values()].some((s) => s.paused !== undefined)
    if (!gotAnything && reg.contracts.length > 0) {
      const fallback = await api.getStates(reg.contracts.map((c) => c.id))
      next = new Map(Object.entries(fallback))
    }

    // 保留执行中的临时状态（pending/hash），只覆盖链上读到的字段
    const merged = new Map(states.value)
    for (const [id, state] of next) merged.set(id, { ...merged.get(id), ...state })
    states.value = merged
  }

  async function reloadLogs(): Promise<void> {
    logs.value = (await api.getLogs()).items
  }

  /* ── 勾选 ── */

  function toggleLine(lineId: string): void {
    const next = new Set(selectedLines.value)
    if (next.has(lineId)) next.delete(lineId)
    else next.add(lineId)
    selectedLines.value = next

    // 取消勾选业务线时，把它下面已选中的合约一并清掉，避免操作到看不见的东西
    const visible = new Set(visibleContracts.value.map((c) => c.id))
    selected.value = new Set([...selected.value].filter((id) => visible.has(id)))
  }

  function toggle(contractId: string): void {
    const next = new Set(selected.value)
    if (next.has(contractId)) next.delete(contractId)
    else next.add(contractId)
    selected.value = next
  }

  function toggleAll(checked: boolean): void {
    selected.value = checked
      ? new Set(visibleContracts.value.filter(canOperate).map((c) => c.id))
      : new Set()
  }

  /**
   * 按当前链上状态快捷勾选。
   * 需暂停 = 现在还在运行的；需恢复 = 现在已经暂停的。
   * 状态读不到的（RPC 挂了）不勾 —— 不确定的事情不替用户做决定。
   */
  function selectByState(target: 'needPause' | 'needResume'): void {
    const want = target === 'needResume'
    selected.value = new Set(
      visibleContracts.value
        .filter((c) => canOperate(c) && states.value.get(c.id)?.paused === want)
        .map((c) => c.id),
    )
  }

  /** 执行过程中把某个合约标成进行中 / 记下哈希 */
  function markContract(contractId: string, patch: Partial<ContractState>): void {
    const merged = new Map(states.value)
    merged.set(contractId, { ...merged.get(contractId), ...patch })
    states.value = merged
  }

  function resetCatalog(): void {
    registry.value = null
    syncEvents.value = []
    syncResult.value = null
    states.value = new Map()
    logs.value = []
    selected.value = new Set()
    selectedLines.value = new Set()
  }

  return {
    registry, selectedLines, selected, states, logs, loading, syncEvents, syncResult,
    businessLines, chains, visibleContracts, selectedContracts, groups,
    chainOf, pausedCountOf, contractCountOf, canOperate, countByState,
    bootstrap, refreshStates, reloadLogs,
    toggleLine, toggle, toggleAll, selectByState, markContract, resetCatalog,
  }
}

export type Catalog = ReturnType<typeof useCatalog>
