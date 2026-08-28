/**
 * 内置 ABI。
 *
 * 平台只做 pause / unpause 两个操作，涉及的方法在所有 Pausable 合约上都一样，
 * 所以不需要为每个合约配 ABI 文件 —— 配置里只要写"业务线、链、地址"就够了。
 *
 * 将来要支持更多操作，在这里补方法即可，配置格式不用动。
 */
export const PAUSABLE_ABI = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

export type AbiFragment = (typeof PAUSABLE_ABI)[number]

/** 合约状态的主字段：列表标签、guard、重发时的状态检查都用它 */
export const PAUSED_READ = {
  key: 'paused',
  method: 'paused',
  args: [] as readonly unknown[],
  returns: 'bool',
  label: '暂停状态',
} as const

const OWNER_READ = {
  key: 'owner',
  method: 'owner',
  args: [] as readonly unknown[],
  returns: 'address',
  label: 'Owner',
} as const

export const CONTRACT_READS = [PAUSED_READ, OWNER_READ] as const
