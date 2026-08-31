import { computed, ref, shallowRef } from 'vue'
import * as api from './api'
import { readStates } from '../chain'
import { dayRange, monthOf, monthRange, today } from '../day'
import type { Session } from './session'
import type {
  Chain,
  Contract,
  ContractState,
  Operation,
  OperationLog,
  Registry,
  SyncEvent,
  SyncResult,
} from '../types'

/**
 * 后端没下发操作清单时用的兜底。
 *
 * 老版本后端的 /registry 里没有 operations 字段，配置还在加载时它也是空的 ——
 * 这两种情况下不能让按钮消失：一个没有暂停按钮的紧急暂停界面等于没有界面。
 */
/** 风险等级，决定按钮从左到右的顺序 */
const RISK: Readonly<Record<string, number>> = { unpause: 0, pause: 2 }

const FALLBACK_OPERATIONS: readonly Operation[] = [
  { kind: 'pause', label: '暂停' },
  { kind: 'unpause', label: '恢复' },
]

/**
 * 配置目录与链上状态：看得见什么、选中了什么、现在是什么状态。
 *
 * 配置一个接口拿全（/registry），链上状态优先自己 multicall 读。
 */
export function useCatalog(session: Session) {
  const registry = shallowRef<Registry | null>(null)
  /** 侧边栏勾选的业务线，可多选。右侧按业务线一块一块展示 */
  const selectedLines = ref<Set<string>>(new Set())
  /** 右侧被折叠起来的业务线。不在集合里就是展开 —— 新出现的业务线默认展开 */
  const collapsedLines = ref<Set<string>>(new Set())
  const selected = ref<Set<string>>(new Set())
  const states = ref<Map<string, ContractState>>(new Map())
  /** 交易日志，来自后端。只含真实发出去的交易 */
  const logs = ref<OperationLog[]>([])
  /** 日志看的是哪一天，YYYY-MM-DD（本地时区）。默认今天 */
  const logDay = ref<string>(today())
  /** 每天有几笔交易，给日期选择器打角标。按月缓存，翻到哪个月拉哪个月 */
  const dailyCounts = ref<Record<string, number>>({})
  const loadedMonths = new Set<string>()
  const loading = ref(false)
  /** 本次加载时后端与 Lark 的同步进度 */
  const syncEvents = ref<SyncEvent[]>([])
  const syncResult = ref<SyncResult | null>(null)

  /* ── 派生 ── */

  const businessLines = computed(() => registry.value?.businessLines ?? [])
  const chains = computed(() => registry.value?.chains ?? [])
  const allContracts = computed(() => registry.value?.contracts ?? [])

  const chainOf = (key: string): Chain | undefined => chains.value.find((c) => c.key === key)

  /**
   * 能做哪些操作，由后端说了算 —— 界面上的按钮、确认框文案、日志里的中文名
   * 全从这份清单来，后端加一种操作前端零改动。
   */
  /**
   * 可执行的操作，**按风险从低到高排**。
   *
   * 位置本身是防误触的一环 —— 运维形成的肌肉记忆是"最右边那个是暂停"。
   * 让后端数组顺序决定它，等于某天后端加个操作就把暂停挪了位，
   * 那是紧急时最不该发生的事。风险等级和配色一样属于前端知识。
   * 认不出的新操作排在中间：不确定的东西不该占据最危险的那个位置。
   */
  const operations = computed<readonly Operation[]>(() => {
    const listed = registry.value?.operations
    const source = listed && listed.length > 0 ? listed : FALLBACK_OPERATIONS
    return [...source].sort((a, b) => (RISK[a.kind] ?? 1) - (RISK[b.kind] ?? 1))
  })

  const operationLabels = computed(() => new Map(operations.value.map((op) => [op.kind, op.label])))

  /**
   * kind → 中文名。
   * 查不到就显示原始 kind：历史日志里可能有已经下线的操作，
   * 按二选一的老写法会把它们统统显示成"恢复"，等于篡改记录。
   */
  const operationLabel = (kind: string): string => operationLabels.value.get(kind) ?? kind

  /** 勾选的业务线下的全部合约 */
  const visibleContracts = computed<Contract[]>(() =>
    selectedLines.value.size === 0
      ? []
      : allContracts.value.filter((c) => selectedLines.value.has(c.businessLine)),
  )

  /**
   * 按业务线分块，右侧一个业务线一张表。
   *
   * 每块自带折叠态与勾选汇总：
   * - 表头的全选框要能显示半选态，所以要知道选了几个 / 一共几个
   * - 折叠起来时也得看得到里面还选着几个，否则会误操作看不见的合约
   *
   * 分母只算 canOperate 的 —— 钱包模式下另一链族的合约根本勾不动，
   * 把它们算进去会让全选框永远到不了全选态。
   */
  const groups = computed(() => {
    // 从 visibleContracts 分桶，不再自己过滤一遍 allContracts ——
    // 「哪些合约算可见」只能有一处定义，两份迟早会分叉
    const byLine = new Map<string, Contract[]>()
    for (const contract of visibleContracts.value) {
      const bucket = byLine.get(contract.businessLine)
      if (bucket) bucket.push(contract)
      else byLine.set(contract.businessLine, [contract])
    }

    return businessLines.value
      .filter((line) => selectedLines.value.has(line.id))
      .map((line) => {
        const contracts = byLine.get(line.id) ?? []
        const operable = contracts.filter(canOperate)
        const picked = operable.filter((c) => selected.value.has(c.id)).length
        return {
          line,
          contracts,
          collapsed: collapsedLines.value.has(line.id),
          /** 可勾选的数量，钱包模式下会小于 contracts.length */
          selectable: operable.length,
          selectedCount: picked,
          allSelected: operable.length > 0 && picked === operable.length,
          someSelected: picked > 0 && picked < operable.length,
          /** 这条业务线自己的待办数。状态未知的不算 —— 不确定的事不替用户做决定 */
          needPause: countIn(operable, false),
          needResume: countIn(operable, true),
        }
      })
  })

  /**
   * 顶部全选框的状态。
   *
   * 和分组表头用**同一套判定**，别再各写一份 —— 之前组件里那份漏了
   * 「可操作数 > 0」这个守卫：钱包模式下连错链族时一个合约都勾不动，
   * 于是 0 === 0 成立，全选框显示勾上、实际一个都没选。
   */
  const visibleSelection = computed(() => {
    const operable = visibleContracts.value.filter(canOperate)
    const picked = operable.filter((c) => selected.value.has(c.id)).length
    return {
      selectable: operable.length,
      selectedCount: picked,
      allSelected: operable.length > 0 && picked === operable.length,
      someSelected: picked > 0 && picked < operable.length,
    }
  })

  /** 这批合约里处于某个 paused 状态的有几个。状态未知的不计 */
  const countIn = (contracts: readonly Contract[], paused: boolean): number =>
    contracts.filter((c) => states.value.get(c.id)?.paused === paused).length

  /** 顶部「全部展开 / 全部收起」按钮的当前态 */
  const allCollapsed = computed(
    () => groups.value.length > 0 && groups.value.every((g) => g.collapsed),
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
          .catch((error: unknown) => {
            syncEvents.value.push({
              phase: 'source',
              at: Date.now(),
              ok: false,
              message: `加载失败，点「重新同步」重试：${(error as Error).message}`,
              code: 'SYNC_UNAVAILABLE',
            })
            throw error
          }),
        // 历史日志是次要数据，它挂了不能连合约列表都出不来 ——
        // 这是紧急暂停工具，能操作比能回顾重要
        api.getLogs(dayRange(logDay.value)).catch(() => ({ items: [], total: 0 })),
      ])
      registry.value = reg
      logs.value = log.items
      if (selectedLines.value.size === 0 && reg.businessLines[0]) {
        selectedLines.value = new Set([reg.businessLines[0].id])
      }
      void loadDailyCounts(monthOf(logDay.value))
      await refreshStates()
    } finally {
      loading.value = false
    }
  }

  /**
   * 刷新链上状态。
   * 前端自己 multicall 读，读不到的合约状态就是"未知"。
   *
   * 曾经有一条"一个都没读到就退回后端 /states"的兜底，删掉了：
   * 判定是整体性的（只要有一个合约读到就算读到），所以但凡有一条链能读，
   * 其余链读不到也永远不会触发 —— 实测一次都没跑起来过。
   * 而真触发时后端在那几条链上同样读不到，救不了任何东西。
   *
   * 读不到就显示"未知"，快捷勾选也不会勾它 —— 不确定的事不替用户做决定。
   */
  async function refreshStates(): Promise<void> {
    const reg = registry.value
    if (!reg) return

    // 整体失败也不抛：某条链挂了不该让其余链的状态一起消失
    const next = await readStates(reg.chains, reg.contracts).catch(
      () => new Map<string, ContractState>(),
    )

    // 保留执行中的临时状态（pending/hash），只覆盖链上读到的字段
    const merged = new Map(states.value)
    for (const [id, state] of next) merged.set(id, { ...merged.get(id), ...state })
    states.value = merged
  }

  async function reloadLogs(): Promise<void> {
    logs.value = (await api.getLogs(dayRange(logDay.value))).items
  }

  /** 换一天看日志。会重新去后端拉那一天 —— 本地筛的话选到没拉下来的日子就是空的 */
  async function setLogDay(day: string): Promise<void> {
    logDay.value = day
    await Promise.all([reloadLogs(), loadDailyCounts(monthOf(day))])
  }

  /**
   * 拉某个月的每日笔数。已经拉过就不重复拉。
   *
   * 失败不抛 —— 这只是日历上的角标，没有它照样能选日期。
   */
  async function loadDailyCounts(month: string, force = false): Promise<void> {
    if (!force && loadedMonths.has(month)) return
    loadedMonths.add(month)
    try {
      const counts = await api.getDailyCounts(monthRange(month))
      dailyCounts.value = { ...dailyCounts.value, ...counts }
    } catch {
      loadedMonths.delete(month) // 失败了下次还能重试
    }
  }

  /**
   * 刚做完操作要能立刻看见。
   * 用户可能正翻着前几天的记录，这时候执行了一批 —— 自动跳回今天，
   * 不然会以为没记上。
   */
  async function jumpToToday(): Promise<void> {
    const day = today()
    logDay.value = day
    // 刚写过日志，本月的计数要强制重拉，否则角标还是旧数
    await Promise.all([reloadLogs(), loadDailyCounts(monthOf(day), true)])
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

  /** 折叠 / 展开一条业务线。纯视图状态，**不动**已勾选的合约 */
  function toggleCollapse(lineId: string): void {
    const next = new Set(collapsedLines.value)
    if (next.has(lineId)) next.delete(lineId)
    else next.add(lineId)
    collapsedLines.value = next
  }

  /** 一键全部收起 / 全部展开。只影响当前展示中的业务线 */
  function setAllCollapsed(collapsed: boolean): void {
    collapsedLines.value = collapsed ? new Set(groups.value.map((g) => g.line.id)) : new Set()
  }

  /**
   * 全选 / 取消全选**某一条**业务线。
   *
   * 与顶部的 toggleAll 不同：那个是整体替换，这个只动这条线下的合约，
   * 其余业务线已经勾好的保持原样 —— 不然分组全选就没法叠加使用了。
   */
  function toggleLineSelection(lineId: string, checked: boolean): void {
    const ids = allContracts.value
      .filter((c) => c.businessLine === lineId && canOperate(c))
      .map((c) => c.id)
    const next = new Set(selected.value)
    for (const id of ids) {
      if (checked) next.add(id)
      else next.delete(id)
    }
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
  /**
   * 按链上状态快捷勾选，**只作用于一条业务线**。
   *
   * 没有全局版本：紧急时是「先把支付停了」这种粒度，
   * 一个按钮横扫所有业务线太容易误伤 —— 而且顶栏已经有全选了。
   *
   * 只动这条业务线：其余业务线已勾的保持不变，不然运维给某条业务线
   * 单独下手时，会把别处选好的一并冲掉。
   *
   * 状态未知的一律不勾：不确定的事不替用户做决定。
   */
  function selectByState(target: 'needPause' | 'needResume', lineId: string): void {
    const want = target === 'needResume'
    const matches = (c: Contract): boolean =>
      canOperate(c) && states.value.get(c.id)?.paused === want

    const inLine = new Set(
      allContracts.value.filter((c) => c.businessLine === lineId).map((c) => c.id),
    )
    const next = new Set([...selected.value].filter((id) => !inLine.has(id)))
    for (const contract of allContracts.value) {
      if (contract.businessLine === lineId && matches(contract)) next.add(contract.id)
    }
    selected.value = next
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
    logDay.value = today()
    dailyCounts.value = {}
    loadedMonths.clear()
    selected.value = new Set()
    selectedLines.value = new Set()
    collapsedLines.value = new Set()
  }

  return {
    registry, selectedLines, collapsedLines, selected, states, logs, loading, syncEvents, syncResult,
    businessLines, chains, visibleContracts, selectedContracts, groups, allCollapsed, visibleSelection,
    operations, operationLabel,
    chainOf, pausedCountOf, contractCountOf, canOperate,
    bootstrap, refreshStates, reloadLogs, logDay, setLogDay, jumpToToday,
    dailyCounts, loadDailyCounts,
    toggleLine, toggle, toggleAll, selectByState, markContract, resetCatalog,
    toggleCollapse, setAllCollapsed, toggleLineSelection,
  }
}

export type Catalog = ReturnType<typeof useCatalog>
