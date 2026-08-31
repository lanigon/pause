import type { ContractDef } from '../models/contract.model.js'
import type { OperationKind } from '../core/operations.js'
import { labelOf } from '../core/operations.js'
import type { AuthContext } from '../core/identity.js'
import { assertAuthorized, execute, Phase } from '../core/execution.js'
import type { ChainFamily, SignPayloadFn } from '../lib/web3/index.js'
import type { ExecutionEvent } from '../core/execution.js'
import { getChain, getContract, getRegistry } from '../core/config.js'
import { openSessions } from '../lib/keys/signer.js'
import { GpgKey } from '../lib/keys/gpg.js'
import * as logRepo from '../repositories/log.repository.js'
import { AppError, ErrorCode, badRequest, messageOf } from '../lib/utils/errors.js'
import { logger } from '../lib/utils/logger.js'

/**
 * GPG 批量执行。
 *
 * 整个流程在**一个 HTTP 请求**里完成：请求进来 → 执行 → 响应体是 SSE 流，边执行边推进度。
 *
 * 解密由本机的 gpg-agent / pinentry 负责，前端不传任何密钥材料。
 * 所以没有 jobId、没有任务过期、没有断线重放、没有 cancel ——
 * 连接断了就是任务结束，状态由操作日志兜底（刷新页面能看到已完成的部分）。
 */

export interface BatchPlan {
  readonly operation: OperationKind
  readonly contracts: readonly ContractDef[]
  readonly signers: ReadonlyMap<ChainFamily, SignerInfo>
  readonly actor: AuthContext
}

/**
 * 在跑的任务。
 * 按操作员记着，这样取消接口能只中止自己发起的那些；
 * 优雅退出时则全部中止，让 GPG 子进程被清理。
 */
const running = new Map<AbortController, string>()

/** 取消该操作员正在跑的批量任务，返回中止了几个 */
export function cancelFor(address: string): number {
  let count = 0
  for (const [controller, owner] of running) {
    if (owner.toLowerCase() !== address.toLowerCase()) continue
    controller.abort()
    count += 1
  }
  return count
}

/** 优雅退出：中止所有在跑的任务 */
export function abortAll(): void {
  for (const controller of running.keys()) controller.abort()
  running.clear()
}


/**
 * 校验并生成执行计划。
 * **在读 passphrase 之前调用** —— 授权不通过的话，密钥材料根本不用参与。
 */
export async function plan(params: {
  operation: OperationKind
  contractIds: readonly string[]
  actor: AuthContext
  expectedConfigVersion: string
}): Promise<BatchPlan> {
  const registry = getRegistry()

  // 配置漂移：前端看到的配置必须和后端当前一致
  if (params.expectedConfigVersion !== registry.configVersion) {
    throw new AppError(ErrorCode.CONFIG_CHANGED, '配置已更新，请刷新页面后重试')
  }

  if (params.contractIds.length === 0) throw badRequest('至少要选择一个合约')
  if (new Set(params.contractIds).size !== params.contractIds.length) {
    throw badRequest('合约列表中有重复项')
  }

  const contracts = params.contractIds.map(getContract)
  const signers = await signersFor(contracts)

  /**
   * 挡在读口令**之前**：所选合约涉及的每个链族都得有密钥，缺一个就整批拒绝。
   * 不做"部分放行" —— 半停半没停的中间态比全不执行更危险。
   *
   * 人的权限已经在 HTTP 层挡过了（能登录说明在白名单里，能走到这儿说明不是 viewer）。
   */
  assertAuthorized({ contracts, signers })

  return { operation: params.operation, contracts, signers, actor: params.actor }
}

/** 链族 → 那把密钥声明的签名地址 */
interface SignerInfo {
  readonly family: ChainFamily
  readonly address: string
}

/** 这批合约涉及哪些链族 → 各自的签名密钥。一次任务可以跨链、跨链族 */
async function signersFor(contracts: readonly ContractDef[]): Promise<ReadonlyMap<ChainFamily, SignerInfo>> {
  const families = new Set(contracts.map((contract) => getChain(contract.chain).type))
  const entries = await Promise.all(
    [...families].map(async (family) => {
      const key = await GpgKey.of(family)
      return [family, { family, address: await key.address() }] as const
    }),
  )
  return new Map(entries)
}

/** 执行。每一步都调 emit 往 SSE 推。 */
export async function run(
  batch: BatchPlan,
  emit: (event: ExecutionEvent) => void,
  /** 外部中止信号（客户端断开连接时用） */
  external?: AbortSignal,
): Promise<void> {
  const { operation, contracts, signers, actor } = batch
  const abort = new AbortController()
  running.set(abort, actor.address)
  external?.addEventListener('abort', () => abort.abort(), { once: true })

  let sessions: Awaited<ReturnType<typeof openSessions>> | null = null

  try {
    emit(event(Phase.DECRYPT, `正在解密运维密钥（${[...signers.keys()].join('、')}）…`))

    sessions = await openSessions(
      [...signers.values()].map((key) => ({
        family: key.family,
        expectedAddress: key.address,
      })),
      // 需要物理触摸时立刻推给前端，否则用户会以为卡住了
      (family, label) => emit(event(Phase.DECRYPT, `请触摸 ${label} 以解锁 ${family} 密钥…`)),
    )

    for (const [family, session] of sessions) {
      emit(event(Phase.DECRYPT, `${family} 密钥解密成功，签名地址 ${session.address}`))
    }

    const signFor = (family: ChainFamily): SignPayloadFn => {
      const session = sessions?.get(family)
      if (!session) throw new AppError(ErrorCode.INTERNAL, `${family} 链族没有可用的签名会话`)
      return session.sign
    }

    await execute({
      operation,
      contracts,
      signers,
      actor,
      signFor,
      // 每条事件先落日志再推给前端 —— 日志是持久的，SSE 断了也不丢
      emit: (partial) => {
        const full = { ...partial, at: Date.now() }
        logTx(actor.address, operation, full)
        emit(full)
      },
      signal: abort.signal,
    })
  } catch (error) {
    // 走到这里说明是全局性失败：密钥解不开、或整条链的 RPC 全挂了。
    // 单笔交易的失败不会到这，它们已经在 RPC 降级 + gas 翻倍重发里兜过一轮了。
    const reason = messageOf(error)
    const code = error instanceof AppError ? error.code : ErrorCode.INTERNAL
    logger.error({ operation, code, reason }, '批量任务失败')

    emit({
      phase: Phase.ERROR,
      at: Date.now(),
      message: `批量${labelOf(operation)}失败：${reason}`,
      code,
      hint: hintFor(code),
    })
  } finally {
    // 无论成败都关掉全部签名会话，绝不留常驻持钥进程
    if (sessions) for (const session of sessions.values()) session.close()
    running.delete(abort)

    // 被取消的话补一条事件与日志 —— 用户要能在日志里看到"这批是被我掐掉的"
    if (abort.signal.aborted) {
      emit(event(Phase.ERROR, `批量${labelOf(operation)}已被取消`))
      logRepo.recordSafe(actor.address, {
        operation,
        contract: `${contracts.length} 个合约`,
        chain: '-',
        hash: '',
        status: 'cancelled',
      })
    }
  }
}

const event = (phase: Phase, message: string): ExecutionEvent => ({
  phase,
  at: Date.now(),
  message,
})

/**
 * 把执行事件落成交易日志。
 *
 * 只记三种：广播出去了、最终确认、最终失败。
 * 预演跳过（合约本来就是目标状态）不算交易，不记。
 *
 * 失败在正常情况下应该很罕见 —— 单个节点挂了有 RPC 三级降级兜着，
 * 交易卡在内存池有 gas 翻倍重发兜着，能走到 failed 的基本只剩
 * "整条链的 RPC 全挂"或"合约真的 revert 了"这两种。
 */
function logTx(address: string, operation: OperationKind, e: ExecutionEvent): void {
  if (!e.contractId || !e.chainKey) return

  const status =
    e.phase === Phase.BROADCAST
      ? 'broadcast'
      : e.phase === Phase.CONFIRMED
        ? 'confirmed'
        : e.phase === Phase.FAILED
          ? 'failed'
          : null

  if (status === null) return

  logRepo.recordSafe(address, {
    operation,
    contract: e.contractId,
    chain: e.chainKey,
    hash: e.hash ?? '',
    status,
  })
}

/**
 * 失败原因对应的下一步建议。
 * 光说"解密失败"没用 —— 用户要知道是去插卡、去服务器上解锁、还是配置写错了。
 */
function hintFor(code: string): string | undefined {
  switch (code) {
    case ErrorCode.GPG_KEY_MISSING:
      return '在后端机器上运行 `npm run keys encrypt` 生成密钥文件'
    case ErrorCode.GPG_PINENTRY_UNAVAILABLE:
      return '后端没有终端，pinentry 弹不出来。先在那台机器上手动 `gpg --decrypt secrets/<链族>.key.gpg` 让 agent 缓存凭据，或改用 YubiKey'
    case ErrorCode.GPG_CARD_ABSENT:
      return '把 YubiKey 插到运行后端的那台机器上，再重试'
    case ErrorCode.GPG_CARD_BLOCKED:
      return 'PIN 已连错 3 次，设备被锁。需要用 PUK 解锁后才能继续'
    case ErrorCode.GPG_WRONG_SECRET:
      return '口令/PIN 不对。注意 YubiKey 连错 3 次会锁卡，确认后再试'
    case ErrorCode.GPG_ADDRESS_MISMATCH:
      return '这是安全事件：密钥文件解出来的地址和 secrets/<链族>.address 里声明的对不上。先确认密钥没被替换，再用 `npm run keys verify` 核对'
    case ErrorCode.GPG_TIMEOUT:
      return 'YubiKey 可能在等触摸。去按一下插在后端机器上的那把 key'
    case ErrorCode.RPC_UNAVAILABLE:
      return '该链没有可用 RPC。运行 `npm run sync rpc`，或配上 ALCHEMY_API_KEY'
    case ErrorCode.SIGNER_SCOPE_DENIED:
      return '跑 `npm run keys encrypt` 生成对应链族的 secrets/<链族>.key.gpg'
    default:
      return undefined
  }
}
