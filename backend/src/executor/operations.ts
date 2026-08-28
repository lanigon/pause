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
 * 操作的前置条件与预期结果，都围绕 paused() 这一个状态字段。
 *   pause   要求当前 paused === false，执行后应变为 true
 *   unpause 反之
 */
export const requiredPausedState = (kind: OperationKind): boolean => kind === OperationKind.UNPAUSE

export const expectedPausedState = (kind: OperationKind): boolean => kind === OperationKind.PAUSE
