/**
 * 合约管理操作的闭集。
 *
 * 不落盘 —— operations.json 里存的只是 'pause' / 'unpause' 这个字符串，
 * 这里定义的是「有哪些操作、各自的前置条件与预期结果」，是执行器的领域知识。
 *
 * GPG 批量执行是最高危的入口，它接受的 action 必须是编译期可穷举的受控集合，
 * 不能让调用方传任意方法名进来（那等于开放"调任意合约方法"的能力）。
 */
export enum OperationKind {
  PAUSE = 'pause',
  UNPAUSE = 'unpause',
}

const OPERATION_LABEL: Readonly<Record<OperationKind, string>> = Object.freeze({
  [OperationKind.PAUSE]: '暂停',
  [OperationKind.UNPAUSE]: '恢复',
})

const ALL_KINDS = Object.values(OperationKind)

export const labelOf = (kind: OperationKind): string => OPERATION_LABEL[kind]

/** 下发前端：可选的操作列表 */
export const listOperations = (): readonly { kind: OperationKind; label: string }[] =>
  ALL_KINDS.map((kind) => ({ kind, label: OPERATION_LABEL[kind] }))

/**
 * 平台从合约上读什么。
 *
 * 就一个字段 —— 平台只关心停没停。以前还读了 owner()，但从来没有任何地方
 * 显示它，等于每次 multicall 白读一倍。
 *
 * 放在这里而不是 web3 层：读哪个字段是**业务决定**的，不是链的性质。
 * web3 那边只负责"按这个方法名去链上取值"。
 */
export const PAUSED_READ = {
  key: 'paused',
  method: 'paused',
  args: [] as readonly unknown[],
  returns: 'bool',
  label: '暂停状态',
} as const

/** 一个合约要读的全部字段。加字段就在这里加一项 */
export const CONTRACT_READS = [PAUSED_READ] as const

/**
 * 操作的前置条件与预期结果，都围绕 paused() 这一个状态字段。
 *   pause   要求当前 paused === false，执行后应变为 true
 *   unpause 反之
 */
export const requiredPausedState = (kind: OperationKind): boolean => kind === OperationKind.UNPAUSE

export const expectedPausedState = (kind: OperationKind): boolean => kind === OperationKind.PAUSE
