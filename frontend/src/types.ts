/** 与后端 /api/registry 对齐的类型。字段少而关键，多余的一律不取。 */

export type ChainFamily = 'evm' | 'tron' | string

export interface Chain {
  key: string
  type: ChainFamily
  chainId: number
  explorer: string
  symbol: string
  decimals: number
  rpcs: string[]
}

export interface BusinessLine {
  id: string
  name: string
}

/** 一个合约只有四件事：叫什么、属于哪条业务线、在哪条链、地址多少 */
export interface Contract {
  id: string
  name: string
  businessLine: string
  chain: string
  address: string
}

export interface Signer {
  chainType: ChainFamily
  address: string
  allowedChains: string[]
  allowedBusinessLines: string[]
}

/**
 * 操作名由后端 /registry 下发（services/operations.ts 里的那个闭集），前端不再自备清单 ——
 * 写死成两个字面量的话，后端每加一种操作，前端都得跟着改一次才用得上。
 * 保留 pause / unpause 只为编辑器提示，写法与上面的 ChainFamily 一致。
 */
export type OperationKind = 'pause' | 'unpause' | string

export interface Operation {
  kind: OperationKind
  label: string
}

export interface Registry {
  configVersion: string
  businessLines: BusinessLine[]
  chains: Chain[]
  contracts: Contract[]
  signers: Signer[]
  operations: Operation[]
}

export type TxLogStatus = 'broadcast' | 'confirmed' | 'failed' | 'cancelled'

/** 交易日志：谁、对哪个合约做了什么、交易哈希、什么状态、什么时候 */
export interface OperationLog {
  address: string
  operation: string
  contract: string
  chain: string
  hash: string
  status: TxLogStatus
  ts: string
}

/** 角色即权限：admin/operator 能操作，viewer 只读。都能看全部业务线 */
export interface Operator {
  address: string
  label: string
  role: 'admin' | 'operator' | 'viewer'
}

/** 合约链上状态。前端自己 multicall 读出来的 */
export interface ContractState {
  paused?: boolean
  /** 执行中的实时状态，来自 SSE */
  pending?: string
  hash?: string
  explorerUrl?: string
}

/** SSE 推来的执行事件 */
export interface ExecutionEvent {
  phase:
    | 'start'
    /** GPG 解密；YubiKey 场景下会先来一条"请触摸设备" */
    | 'decrypt'
    /** 预演通过，带预计 gas */
    | 'simulate'
    /** 签名地址余额预警 */
    | 'balance'
    | 'skip'
    | 'sign'
    | 'broadcast'
    | 'confirmed'
    | 'failed'
    | 'done'
    | 'error'
  at: number
  contractId?: string
  chainKey?: string
  message: string
  hash?: string
  explorerUrl?: string
  /** 失败时的错误码，据此分支处理（如引导去插 YubiKey） */
  code?: string
  /** 失败时给用户的下一步建议 */
  hint?: string
}

/** 签名模式：tab 切的就是这个 */
export type SignMode = 'wallet' | 'gpg'

/* ── Lark 同步 ── */

/** 同步阶段：拉取 → 比对 → 应用 */
export type SyncPhase = 'source' | 'diff' | 'apply'

export interface SyncEvent {
  phase: SyncPhase
  at: number
  ok: boolean
  message: string
  /** 失败/跳过时的原因码，如 LARK_CLI_MISSING、LARK_EMPTY、THROTTLED */
  code?: string
  /** 变更摘要，一条一句人话 */
  changes?: string[]
}

export interface SyncResult {
  /** 本地数据是否被更新 */
  changed: boolean
  /** 是否真的拉到了 Lark 数据 */
  fromLark: boolean
}
