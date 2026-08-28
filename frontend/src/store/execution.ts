import { ref } from 'vue'
import * as api from './api'
import type { Catalog } from './catalog'
import type { Session } from './session'
import type { ExecutionEvent, OperationKind } from '../types'

/** 终态：拿到就不再被后续过程事件覆盖 */
const TERMINAL_PHASES = new Set(['confirmed', 'failed'])

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
  async function runGpgBatch(operation: OperationKind): Promise<void> {
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
      // 无论成败都把链上状态和交易日志刷一遍
      await Promise.all([catalog.refreshStates(), catalog.reloadLogs()])
    }
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

  /* ── 钱包模式：逐笔签名 ── */

  async function runWalletBatch(operation: OperationKind): Promise<void> {
    running.value = true
    events.value = []
    failure.value = null
    try {
      for (const contract of catalog.selectedContracts.value) {
        const chain = catalog.chainOf(contract.chain)
        if (!chain) continue
        try {
          // 用用户实际连的那个钱包，不猜 window.ethereum
          const wallet = session.wallets.value[chain.type]
          if (!wallet) throw new Error(`未连接 ${chain.type} 钱包`)
          const hash = await wallet.sendTransaction(chain, contract.address, operation)
          appendEvent({
            phase: 'broadcast',
            at: Date.now(),
            contractId: contract.id,
            chainKey: chain.key,
            message: `${contract.name}：已广播 ${hash.slice(0, 10)}…`,
            hash,
          })
          // 广播成功了才上报 —— 没发出去的不记
          await api.postLog({
            operation,
            contract: contract.id,
            chain: contract.chain,
            hash,
            status: 'broadcast',
          })
        } catch (err) {
          appendEvent({
            phase: 'failed',
            at: Date.now(),
            contractId: contract.id,
            chainKey: chain.key,
            message: `${contract.name} 失败：${(err as Error).message}`,
          })
        }
      }
      await Promise.all([catalog.refreshStates(), catalog.reloadLogs()])
    } finally {
      running.value = false
    }
  }

  function resetExecution(): void {
    abortController?.abort()
    abortController = null
    events.value = []
    failure.value = null
    running.value = false
  }

  return { events, failure, running, runGpgBatch, runWalletBatch, cancelBatch, resetExecution }
}
