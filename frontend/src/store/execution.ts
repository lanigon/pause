import { ref } from 'vue'
import * as api from './api'
import type { Catalog } from './catalog'
import type { Session } from './session'
import type { ExecutionEvent, OperationKind } from '../types'

/**
 * 终态：拿到就清掉"进行中"标记。
 *
 * skip 也是终态 —— 漏了它的话，被跳过的合约会永久显示"已跳过"，
 * 把真实的 paused 状态挡住，直到刷新页面。
 */
const TERMINAL_PHASES = new Set(['confirmed', 'failed', 'skip'])

/** 一批跑完的结果，用来决定给用户看什么颜色的提示 */
export interface BatchOutcome {
  readonly ok: number
  readonly failed: number
}

/**
 * 批量执行：GPG（后端签）与钱包（前端逐笔签）两条路。
 * 进度都归一到同一条事件流，弹窗只认 events。
 */
export function useExecution(catalog: Catalog, session: Session) {
  /** 本次执行的实时进度，来自 SSE。刷新页面即清空 */
  const events = ref<ExecutionEvent[]>([])
  /** 本次执行的失败原因（带错误码与建议），成功时为 null */
  const failure = ref<{ message: string; code?: string; hint?: string } | null>(null)
  const running = ref(false)
  let abortController: AbortController | null = null

  function appendEvent(event: ExecutionEvent): void {
    events.value = [event, ...events.value].slice(0, 500)
  }

  /**
   * 一个请求做完：POST 过去，响应体就是 SSE 流，边收边更新。
   * **不传任何密钥材料** —— 后端本地解 GPG 文件，需要时调本机的 YubiKey。
   */
  async function runGpgBatch(operation: OperationKind): Promise<BatchOutcome> {
    const registry = catalog.registry.value
    if (!registry) throw new Error('配置未加载')
    const ids = catalog.selectedContracts.value.map((c) => c.id)
    if (ids.length === 0) throw new Error('请先勾选合约')

    running.value = true
    events.value = []
    failure.value = null
    abortController = new AbortController()

    try {
      await api.runBatch(operation, ids, registry.configVersion, onEvent, abortController.signal)
    } catch (error) {
      // 用户主动取消不算错误
      if ((error as Error).name !== 'AbortError') {
        failure.value = { message: (error as Error).message }
      }
    } finally {
      running.value = false
      abortController = null
      clearPending(ids)
      // 无论成败都把链上状态和交易日志刷一遍；跳回今天才看得到刚做的
      await Promise.all([catalog.refreshStates(), catalog.jumpToToday()])
    }

    // 成败以事件流为准 —— 后端把每个合约的终态都推过来了
    const confirmed = new Set(
      events.value.filter((e) => e.phase === 'confirmed' && e.contractId).map((e) => e.contractId),
    )
    return { ok: confirmed.size, failed: ids.length - confirmed.size }
  }

  /**
   * 取消正在跑的批量任务。
   * 两头都做：断开 SSE 连接（后端会收到 close 并中止），再调一次取消接口兜底。
   */
  async function cancelBatch(): Promise<void> {
    abortController?.abort()
    await api.cancelBatch().catch(() => undefined)
  }

  function onEvent(event: ExecutionEvent): void {
    appendEvent(event)

    if (event.phase === 'error') {
      failure.value = { message: event.message, code: event.code, hint: event.hint }
    }
    if (!event.contractId) return

    catalog.markContract(event.contractId, {
      // 终态清掉进行中标记
      pending: TERMINAL_PHASES.has(event.phase) ? undefined : event.phase,
      ...(event.hash ? { hash: event.hash } : {}),
      ...(event.explorerUrl ? { explorerUrl: event.explorerUrl } : {}),
    })
  }

  /**
   * 一批跑完后把「进行中」标记全部清干净。
   *
   * 事件流可能因为取消、连接断开而中途停下，那些合约会永远卡在"签名中"，
   * 把真实状态挡住。所以不管怎么结束，都按参与本批的合约逐个清一遍。
   */
  function clearPending(contractIds: readonly string[]): void {
    for (const id of contractIds) catalog.markContract(id, { pending: undefined })
  }

  /* ── 钱包模式：逐笔签名 ── */

  async function runWalletBatch(operation: OperationKind): Promise<BatchOutcome> {
    const targets = [...catalog.selectedContracts.value]
    running.value = true
    events.value = []
    failure.value = null
    let ok = 0

    try {
      for (const contract of targets) {
        const chain = catalog.chainOf(contract.chain)
        if (!chain) continue
        try {
          // 用用户实际连的那个钱包，不猜 window.ethereum
          const wallet = session.wallets.value[chain.type]
          if (!wallet) throw new Error(`未连接 ${chain.type} 钱包`)
          const hash = await wallet.sendTransaction(chain, contract.address, operation)
          // 走 onEvent 而不是 appendEvent —— 顺带把哈希写进合约状态，
          // 列表里的"交易"列才有东西可点
          onEvent({
            phase: 'broadcast',
            at: Date.now(),
            contractId: contract.id,
            chainKey: chain.key,
            message: `${contract.name}：已广播 ${hash.slice(0, 10)}…`,
            hash,
          })
          ok += 1
          // 广播成功了才上报 —— 没发出去的不记
          await api.postLog({
            operation,
            contract: contract.id,
            chain: contract.chain,
            hash,
            status: 'broadcast',
          })
        } catch (err) {
          onEvent({
            phase: 'failed',
            at: Date.now(),
            contractId: contract.id,
            chainKey: chain.key,
            message: `${contract.name} 失败：${(err as Error).message}`,
          })
        }
      }
      // 跳回今天：用户可能正翻着前几天的记录，不跳的话刚做的操作看不见
      await Promise.all([catalog.refreshStates(), catalog.jumpToToday()])
      return { ok, failed: targets.length - ok }
    } finally {
      running.value = false
      clearPending(targets.map((c) => c.id))
    }
  }

  /**
   * 关掉进度弹窗 = 丢掉这一轮的进度。
   *
   * failure 必须跟着一起清 —— 只清 events 的话，下一轮执行前打开弹窗，
   * 顶上还挂着上一轮的红色错误横幅，会被当成这次就失败了。
   * 由 store 提供而不是让组件写 events：清哪些字段是这块自己的事，
   * 组件漏掉一个就是这种脏状态。
   */
  function clearEvents(): void {
    events.value = []
    failure.value = null
  }

  /** 退出登录时的整体复位，比 clearEvents 多做一件事：把正在跑的请求也中止掉 */
  function resetExecution(): void {
    abortController?.abort()
    abortController = null
    clearEvents()
    running.value = false
  }

  return {
    events, failure, running,
    runGpgBatch, runWalletBatch, cancelBatch, clearEvents, resetExecution,
  }
}
