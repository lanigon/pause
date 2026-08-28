/**
 * OpenPGP 智能卡（YubiKey）状态解析。
 *
 * 从 `gpg --card-status` 里把结构化信息抠出来。这么做的价值：
 *  - **PIN 剩余次数能提前知道**，不用等输错了再从 stderr 里猜。
 *    只剩 1 次时可以在用户输入之前就警告 —— 输错第三次卡就锁了，
 *    要拿 PUK 才能解，代价很高。
 *  - **触摸策略能提前知道**，只在真的需要时才提示"请触摸"，
 *    而不是每次都提示（策略为 off 时提示反而误导人）。
 */
export interface CardStatus {
  readonly present: boolean
  readonly reader?: string
  readonly serial?: string
  /** 用户 PIN 还剩几次。0 表示已锁 */
  readonly pinRetriesLeft?: number
  /** 管理员 PIN 还剩几次 */
  readonly adminRetriesLeft?: number
  /** 解密密钥的触摸策略：off / on / fixed / cached */
  readonly decryptTouchPolicy?: string
  /** 卡上有没有解密密钥 */
  readonly hasDecryptKey: boolean
}

const ABSENT: CardStatus = { present: false, hasDecryptKey: false }

/**
 * 解析 `gpg --card-status` 的输出。
 *
 * 关键字段（GnuPG 的输出格式，字段名后面是不定长的点）：
 *   Reader ...........: Yubico YubiKey OTP+FIDO+CCID
 *   Serial number ....: 0006XXXXXX
 *   PIN retry counter : 3 0 3        ← 用户 PIN / 重置码 / 管理员 PIN
 *   Encryption key....: <40 位指纹> 或 [none]
 *   Touch policy .....: off / on / fixed / cached
 */
export function parseCardStatus(output: string): CardStatus {
  if (!/Reader\s*\.*\s*:/.test(output) && !/Application ID/.test(output)) return ABSENT

  const field = (name: string): string | undefined => {
    const m = new RegExp(`${name}\\s*\\.*\\s*:\\s*(.+)`, 'i').exec(output)
    return m?.[1]?.trim()
  }

  // "3 0 3" → 用户 PIN 3 次、重置码 0 次、管理员 PIN 3 次
  const retries = field('PIN retry counter')?.split(/\s+/).map((n) => Number.parseInt(n, 10))

  const encryptionKey = field('Encryption key')
  const hasDecryptKey = encryptionKey !== undefined && !/\[none\]|\[not set\]/i.test(encryptionKey)

  return {
    present: true,
    reader: field('Reader'),
    serial: field('Serial number'),
    pinRetriesLeft: Number.isFinite(retries?.[0]) ? retries![0] : undefined,
    adminRetriesLeft: Number.isFinite(retries?.[2]) ? retries![2] : undefined,
    // 有的 gpg 版本不报触摸策略（要用 ykman 才看得到），拿不到就是 undefined
    decryptTouchPolicy: field('Touch policy')?.toLowerCase(),
    hasDecryptKey,
  }
}

/** 触摸策略要求物理触摸吗。拿不到策略时保守地认为要 —— 提示了不会错，不提示会让人干等 */
export const policyNeedsTouch = (policy: string | undefined): boolean =>
  policy === undefined || policy === 'on' || policy === 'fixed' || policy === 'cached'

/** 只剩这么多次就该警告了 */
export const LOW_PIN_RETRIES = 2
