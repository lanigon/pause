import { BatchItemStatus, TxStatus } from '../lib/web3/types.js'
import type {
  BatchItem,
  BatchItemResult,
  ChainFamily,
  SignPayloadFn,
} from '../lib/web3/types.js'
import { meta, tx } from '../lib/web3/chains.js'
import { SigningAbortedError } from '../lib/web3/runner.js'
import type { ContractDef } from '../models/contract.model.js'
import type { OperationKind } from './operations.js'
import {
  PAUSED_READ,
  expectedPausedState,
  labelOf,
  requiredPausedState,
} from './operations.js'
import type { AuthContext } from './identity.js'
import { getChain } from './config.js'
import { groupBy } from '../lib/utils/collection.js'
import { readStates } from './contractState.js'
import { AppError, ErrorCode, messageOf } from '../lib/utils/errors.js'
import { logger } from '../lib/utils/logger.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  交易执行器 —— 批量操作的编排中枢
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 流程：前置检查（读当前状态，见 contractState.service）→ 按链分组**并行**
 *      → 各链 adapter.executeBatch → 每一步 emit 事件（SSE 推前端 + 写操作日志）→ 汇总
 *
 * 这里只有会改链上状态的那一半。纯只读的状态查询在 contractState.service，
 * 它的调用方（controller）不该为了读一个 paused 就把整条写路径拖进来。
 *
 * 它不知道私钥从哪来（sign 是注入的回调），也不知道事件推到哪去（emit 是注入的），
 * 所以可以脱离 HTTP 与 GPG 单独测试。
 */

interface ExecuteParams {
  readonly operation: OperationKind
  readonly contracts: readonly ContractDef[]
  /** 链族 → 签名地址。执行器只要知道 from 是谁 */
  readonly signers: ReadonlyMap<ChainFamily, { readonly address: string }>
  readonly actor: AuthContext
  /** 按链族取签名回调 —— 跨链族批量时每个链族一把密钥、一个子进程 */
  readonly signFor: (family: ChainFamily) => SignPayloadFn
  readonly emit: EmitFn
  readonly signal?: AbortSignal
}


/* ════════════════════ 类型 ════════════════════ */

/** 执行过程的阶段。前端按它更新列表行状态与操作日志。 */
export enum Phase {
  START = 'start',
  /** GPG 解密；YubiKey 场景下会先推一条"请触摸设备" */
  DECRYPT = 'decrypt',
  /** 预演：eth_call 通过 + 预计 gas */
  SIMULATE = 'simulate',
  /** 签名地址余额预警：不够发 100 笔就提醒 */
  BALANCE = 'balance',
  SKIP = 'skip',
  SIGN = 'sign',
  BROADCAST = 'broadcast',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  DONE = 'done',
  ERROR = 'error',
}

/**
 * 执行事件 —— 后端与前端之间执行期的唯一通信协议。
 * SSE 推的是它，操作日志记的也是它，所以字段必须全部可公开
 * （不含签名材料、私钥、passphrase）。
 */
export interface ExecutionEvent {
  readonly phase: Phase
  readonly at: number
  readonly contractId?: string
  readonly chainKey?: string
  readonly message: string
  readonly hash?: string
  readonly explorerUrl?: string
  /** 失败时的错误码，前端据此分支处理（如引导去插 YubiKey） */
  readonly code?: string
  /** 失败时给用户的下一步建议 */
  readonly hint?: string
}

export type EmitFn = (event: Omit<ExecutionEvent, 'at'>) => void

export interface ExecutionItem {
  readonly contractId: string
  readonly contractName: string
  readonly chainKey: string
  readonly status: BatchItemStatus
  readonly hash?: string
  readonly explorerUrl?: string
  readonly blockNumber?: number
  readonly reason?: string
}

export interface ExecutionSummary {
  readonly succeeded: number
  readonly failed: number
  readonly skipped: number
  readonly items: readonly ExecutionItem[]
}

/* ════════════════════ 授权 ════════════════════ */

/**
 * 执行前的校验：所选合约涉及的每个链族都得配了密钥，缺一个就整批拒绝。
 * 不做"部分放行"—— 半停半没停的中间态比全不执行更危险。
 *
 * 人的权限已经在 HTTP 层挡过了：能登录说明在白名单里，
 * 能走到这里说明角色不是 viewer。
 */
export function assertAuthorized(params: {
  readonly contracts: readonly ContractDef[]
  /** 只关心「这个链族有没有密钥」，不关心密钥长什么样 */
  readonly signers: ReadonlyMap<ChainFamily, unknown>
}): void {
  const missing = [
    ...new Set(
      params.contracts
        .map((contract) => getChain(contract.chain).type)
        .filter((family) => !params.signers.has(family)),
    ),
  ]

  if (missing.length > 0) {
    throw new AppError(
      ErrorCode.SIGNER_SCOPE_DENIED,
      `未配置这些链族的签名密钥：${missing.join('、')}`,
    )
  }
}

/* ════════════════════ 执行 ════════════════════ */


/**
 * 授权**不在这里查**：batch.service.plan() 已经查过，而且必须由它查 ——
 * 那是读 passphrase 之前的最后一道关。从 plan() 到这里没有任何一步能改动
 * contracts / signers，再查一遍只会让人以为两处各管一半，将来删错那一处。
 */
export async function execute(params: ExecuteParams): Promise<ExecutionSummary> {
  const { operation, contracts, emit } = params
  const label = labelOf(operation)

  emit({ phase: Phase.START, message: `开始批量${label}，共 ${contracts.length} 个合约` })

  const { executable, skipped } = await preflight(contracts, operation, emit)
  if (executable.length === 0) {
    emit({ phase: Phase.DONE, message: '没有需要执行的合约' })
    return { succeeded: 0, failed: 0, skipped: skipped.length, items: skipped }
  }

  // ★ 按链分组并行：不同链彼此独立，同链内部由 adapter 保证串行与序号
  const perChain = await Promise.all(
    [...groupBy(executable, (c) => c.chain).entries()].map(([chainKey, group]) =>
      runChain({ ...params, chainKey, group }),
    ),
  )

  const items = [...skipped, ...perChain.flat()]
  const summary = summarize(items)

  emit({
    phase: Phase.DONE,
    message: `批量${label}完成：成功 ${summary.succeeded}，失败 ${summary.failed}，跳过 ${summary.skipped}`,
  })
  return summary
}

/**
 * 前置检查：只做 UX 早失败。
 * 已经 paused 的合约不用再发一笔必然 revert 的 pause，白花 gas。
 * 真正的不变量由合约自己保证 —— 从这里到打包之间状态仍可能变化。
 */
async function preflight(
  contracts: readonly ContractDef[],
  operation: OperationKind,
  emit: EmitFn,
): Promise<{ executable: readonly ContractDef[]; skipped: readonly ExecutionItem[] }> {
  const required = requiredPausedState(operation)
  const states = await readStates(contracts.map((c) => c.id))

  const executable: ContractDef[] = []
  const skipped: ExecutionItem[] = []

  for (const contract of contracts) {
    const paused = states.get(contract.id)?.paused

    // 读不到状态（RPC 挂了）不算失败：交给链上去判，别因为读不到就漏掉紧急暂停
    if (paused === undefined || paused === required) {
      executable.push(contract)
      continue
    }

    const reason = required ? '合约当前未暂停，无需恢复' : '合约已处于暂停状态'
    skipped.push({
      contractId: contract.id,
      contractName: contract.name,
      chainKey: contract.chain,
      status: BatchItemStatus.SKIPPED,
      reason,
    })
    emit({
      phase: Phase.SKIP,
      contractId: contract.id,
      chainKey: contract.chain,
      message: `${contract.name}：${reason}`,
    })
  }

  return { executable, skipped }
}

/** 余额低于这个笔数就提醒 —— 运维密钥没油是最容易被忽视的故障 */
const LOW_BALANCE_RUNS = 100

async function runChain(
  params: ExecuteParams & { chainKey: string; group: readonly ContractDef[] },
): Promise<readonly ExecutionItem[]> {
  const { chainKey, group, operation, signers, signFor, emit } = params
  const chain = getChain(chainKey)
  const signer = signers.get(chain.type)!
  const txAdapter = tx(chain.type)
  const metaAdapter = meta(chain.type)
  const nameOf = new Map(group.map((c) => [c.id, c.name]))
  const named = (id: string): string => nameOf.get(id) ?? id

  const items: BatchItem[] = group.map((contract) => ({
    id: contract.id,
    request: {
      contractAddress: contract.address,
      fromAddress: signer.address,
      // OperationKind 的值就是合约方法名：pause / unpause
      method: operation,
      args: [],
    },
    // 等回执超时后拿它去查状态：已达成就不重发（见 evm/tx.ts 的 confirmWithEscalation）
    stateCheck: { method: PAUSED_READ.method, expected: expectedPausedState(operation) },
  }))

  // 只提醒一次，不用每笔都查
  let balanceChecked = false
  const warnIfLowBalance = async (gasEstimate?: string): Promise<void> => {
    if (balanceChecked || !gasEstimate || !txAdapter.checkBalance) return
    balanceChecked = true

    const result = await txAdapter.checkBalance(chain, signer.address, BigInt(gasEstimate))
    if (result === null) return

    const enough = result.runs >= LOW_BALANCE_RUNS
    emit({
      phase: Phase.BALANCE,
      chainKey,
      message: enough
        ? `${chain.key}：签名地址余额 ${result.balance} ${result.symbol}，约够发 ${result.runs} 笔`
        : `⚠️ ${chain.key}：签名地址余额 ${result.balance} ${result.symbol}，` +
          `按当前 gas 价格只够发 ${result.runs} 笔（低于 ${LOW_BALANCE_RUNS} 笔，请及时充值）`,
    })
  }

  let results: readonly BatchItemResult[]
  try {
    results = await txAdapter.executeBatch(
      chain,
      items,
      signFor(chain.type),
      {
        onSimulate: (id, result) => {
          // 预演不通过时不要说"通过" —— 紧跟着的 skip 事件会说明原因。
          // 早先这里无条件报"预演通过"，然后立刻跟一条 REVERT，非常误导人。
          if (!result.ok) return

          emit({
            phase: Phase.SIMULATE,
            contractId: id,
            chainKey,
            message: result.gasEstimate
              ? `${named(id)}：预演通过，预计消耗 ${result.gasEstimate} gas`
              : `${named(id)}：预演通过`,
          })
          // 第一笔拿到 gas 估算后，顺便查一下签名地址的油还够不够
          void warnIfLowBalance(result.gasEstimate)
        },
        onSkip: (id, reason) =>
          emit({ phase: Phase.SKIP, contractId: id, chainKey, message: `${named(id)}：${reason}` }),
        // 整批性的提醒，不属于任何一个合约（如开工前就有悬空交易）
        onWarning: (message) => emit({ phase: Phase.BALANCE, chainKey, message: `⚠️ ${message}` }),
        onSign: (id) =>
          emit({ phase: Phase.SIGN, contractId: id, chainKey, message: `${named(id)}：已签名` }),
        onBroadcast: (id, hash) =>
          emit({
            phase: Phase.BROADCAST,
            contractId: id,
            chainKey,
            message: `${named(id)}：已广播`,
            hash,
            explorerUrl: metaAdapter.explorerTxUrl(chain, hash),
          }),
        onSettle: (id, result) =>
          emit({
            phase: result.status === TxStatus.CONFIRMED ? Phase.CONFIRMED : Phase.FAILED,
            contractId: id,
            chainKey,
            message: `${named(id)}：${result.status === TxStatus.CONFIRMED ? '已确认' : (result.reason ?? '未上链')}`,
            // 必须带 hash：否则日志里的"已确认"点不进浏览器。
            // 用 result.hash 而不是广播时那个 —— gas 阶梯重发可能换过
            hash: result.hash,
            explorerUrl: metaAdapter.explorerTxUrl(chain, result.hash),
          }),
        onFail: (id, reason) =>
          emit({ phase: Phase.FAILED, contractId: id, chainKey, message: `${named(id)}：${reason}` }),
      },
      { signal: params.signal },
    )
  } catch (error) {
    // 签名失败 = 密钥有问题，该链中止；已完成的部分仍要汇报
    if (error instanceof SigningAbortedError) {
      emit({ phase: Phase.ERROR, chainKey, message: `签名失败，${chain.key} 剩余操作已中止` })
      results = error.completed
    } else {
      const reason = messageOf(error)
      logger.error({ chainKey, reason }, '链上批量执行异常')
      emit({ phase: Phase.ERROR, chainKey, message: `${chain.key} 执行异常：${reason}` })
      return group.map((contract) => ({
        contractId: contract.id,
        contractName: contract.name,
        chainKey,
        status: BatchItemStatus.FAILED,
        reason,
      }))
    }
  }

  return results.map((result): ExecutionItem => ({
    contractId: result.id,
    contractName: named(result.id),
    chainKey,
    status: result.status,
    hash: result.hash,
    explorerUrl: result.hash ? metaAdapter.explorerTxUrl(chain, result.hash) : undefined,
    blockNumber: result.blockNumber,
    reason: result.reason,
  }))
}

/* ════════════════════ 工具 ════════════════════ */

function summarize(items: readonly ExecutionItem[]): ExecutionSummary {
  let succeeded = 0
  let failed = 0
  let skipped = 0
  for (const item of items) {
    if (item.status === BatchItemStatus.CONFIRMED) succeeded += 1
    else if (item.status === BatchItemStatus.SKIPPED) skipped += 1
    else failed += 1
  }
  return { succeeded, failed, skipped, items }
}
