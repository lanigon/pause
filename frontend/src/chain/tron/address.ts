import { decodeBase58, encodeBase58, getBytes, sha256, toBeHex } from 'ethers'

/**
 * Tron 地址的两种形态互转。
 *
 * 不引 tronweb —— 前端只需要这两个函数，而 tronweb 是个几 MB 的包，
 * 为两个纯计算把它塞进 bundle 不划算。base58check 用 ethers 现成的
 * sha256 与 encodeBase58 就能拼出来。
 *
 *   base58   T 开头，人看的、区块浏览器用的
 *   hex41    41 + 20 字节，节点接口用的
 *   hex20    0x + 20 字节，**ABI 编码里的 address 用的**（和 EVM 一样）
 */

/** hex20（0x…）→ base58。合约返回的地址是 hex20，要显示就得转 */
export function toBase58(hex20: string): string {
  const payload = `0x41${hex20.replace(/^0x/, '').toLowerCase()}`
  // base58check：末尾接 4 字节双 sha256 校验和
  const checksum = sha256(sha256(payload)).slice(2, 10)
  return encodeBase58(payload + checksum)
}

/** hex20 → hex41，节点的 getaccount 在 visible:false 时要这个 */
export const toHex41 = (hex20: string): string => `41${hex20.replace(/^0x/, '').toLowerCase()}`

/**
 * base58 → hex20，用于把钱包给的地址塞进 ABI 编码。
 * 不是合法 base58 地址时返回 undefined —— 宁可不查，也不要拿垃圾去编码。
 */
export function fromBase58(base58: string): string | undefined {
  try {
    // 解出来是 25 字节：1 字节 0x41 前缀 + 20 字节地址 + 4 字节校验和
    const full = getBytes(toBeHex(decodeBase58(base58), 25))
    if (full[0] !== 0x41) return undefined

    const payload = full.slice(0, 21)
    const expected = sha256(sha256(payload)).slice(2, 10)
    const actual = Buffer.from(full.slice(21)).toString('hex')
    if (expected !== actual) return undefined

    return `0x${Buffer.from(payload.slice(1)).toString('hex')}`
  } catch {
    return undefined
  }
}
