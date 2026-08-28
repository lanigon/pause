import type { Provider } from 'ethers'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVM nonce 管理
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * nonce 是 **EVM 特有的**，不是一个跨链族的通用概念：
 *
 *   EVM     数字 nonce，严格递增、不能留洞。一笔卡住，后面全部堵死
 *   Tron    没有。靠 ref_block + expiration 在时间窗内防重放
 *   Solana  常规交易靠 recent blockhash（同样是时间窗）；
 *           要严格顺序才用 durable nonce account，值还是个 blockhash 字符串
 *
 * 所以它整个待在 evm/ 里面，runner 和其他链族都不知道它存在 ——
 * 不该让每条异构链去适配一个只对 EVM 成立的模型。
 *
 * 两条不变量由 adapter 的调用位置保证（见 evm/adapter.ts）：
 *   取号在 build 里 → build 只在预演通过后调用 → 预演失败不消耗序号
 *   推进在 broadcast 成功后 → 广播失败序号让给下一笔 → 不留空洞
 */
export interface NonceManager {
  /** 分配当前这一笔的 nonce */
  next(): number
  /** 推进。**只在广播成功后调用** */
  commit(): void
  /** 开工前发现的问题，交给上层推给用户。不阻断执行 */
  readonly warnings: readonly string[]
}

/**
 * 基准序号每批**现读链上的 pending 值**，不用本地缓存 ——
 * 缓存会在别处也发了交易时失准，而失准的表现是整批全部卡死。
 */
export async function evmNonceManager(
  provider: Provider,
  signer: string,
  chainKey: string,
): Promise<NonceManager> {
  const [pending, mined] = await Promise.all([
    provider.getTransactionCount(signer, 'pending'),
    provider.getTransactionCount(signer, 'latest'),
  ])

  let offset = 0
  const warnings: string[] = []

  /**
   * pending 和 latest 的差 = 已广播但还没打包的笔数。
   *
   * 不为零时，这一批全都会排在它们后面 —— 那几笔要是卡死了，
   * 本批**一笔都上不了链**，但界面上每一笔都会显示「已广播」。
   * 紧急暂停时这是最坏的一种失败：看起来做了，其实什么都没发生。
   */
  if (pending > mined) {
    warnings.push(
      `${chainKey}：签名地址有 ${pending - mined} 笔交易还没上链（nonce ${mined}~${pending - 1}），` +
        '本批会排在它们后面；如果那几笔卡死，本批也会一起卡住',
    )
  }

  return {
    next: () => pending + offset,
    commit: () => {
      offset += 1
    },
    warnings,
  }
}
