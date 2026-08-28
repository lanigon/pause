import type { Provider } from 'ethers'
import type { NonceManager } from '../nonce.js'

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
