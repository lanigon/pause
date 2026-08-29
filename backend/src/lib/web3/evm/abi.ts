/**
 * Solidity ABI —— **只有 EVM 用**。
 *
 * Tron 不需要：TronWeb 要的是方法签名字符串（`paused()`），不是 ABI 对象。
 * 所以这份定义待在 evm/ 里面，不放在 web3 根目录 —— 那会让人以为
 * 每个链族都得有一份 ABI，而异构链（Solana 用 IDL）根本不是这个模型。
 *
 * 平台只做 pause / unpause，这几个方法在所有 Pausable 合约上都一样，
 * 所以配置里不用给每个合约配 ABI，写"业务线、链、地址"就够了。
 */
export const PAUSABLE_ABI = [
  { type: 'function', name: 'paused', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const
