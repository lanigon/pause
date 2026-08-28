/**
 * 平台用到的全部合约方法。
 *
 * 只有这几个 —— 平台只做 pause / unpause，这些方法在所有 Pausable 合约上都一样，
 * 所以配置里不用给每个合约配 ABI，只要写"业务线、链、地址"。
 *
 * 两处在用：multicall 读状态、钱包模式编码交易。共用一份，
 * 免得改了一处漏另一处（之前钱包那边压根没有 pause，EVM 钱包模式一直是坏的）。
 */
export const PAUSABLE_ABI = [
  'function paused() view returns (bool)',
  'function pause()',
  'function unpause()',
]
