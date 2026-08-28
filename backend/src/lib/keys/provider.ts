/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  KeyProvider —— 「怎么拿到本地私钥」的可插拔接口
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 在 data/signers.json 里用 `source` 字段选，默认 gpg。
 * 加一个新来源（KMS / HSM / 卡上直接签名）：实现接口，在下面注册一行。
 * worker / signer / services 一行都不用改。
 *
 * 唯一的硬约束：实现必须在**子进程内**取密钥，父进程从头到尾不该见到私钥材料。
 */
export interface KeyContext {
  /** 链族，如 evm / tron。决定去哪找密钥 */
  readonly family: string
  /** 配置里声明的地址；取到密钥后派生出来的必须与它一致 */
  readonly expectedAddress: string
  /** provider 自己的配置（gpg 用它区分口令还是 YubiKey） */
  readonly options: Readonly<Record<string, unknown>>
}

export interface KeyProvider {
  /** 注册用的标识，写在 signers.json 的 source 字段里 */
  readonly kind: string
  /** 给人看的名字，出现在日志与前端提示里 */
  readonly label: string

  /**
   * 需要人在场做点什么吗（YubiKey 要触摸）。
   * 为 true 时上层会先推一条提示给前端，否则用户会以为卡住了。
   */
  requiresPresence(context: KeyContext): boolean

  /**
   * 取密钥时独占某个物理设备吗。
   *
   * 为 true 时上层必须**串行**取密钥 —— scdaemon 对智能卡是独占锁，
   * 两个进程同时访问同一张卡会失败。跨链族批量时尤其重要：
   * evm 和 tron 两把密钥如果在同一张 YubiKey 上，并发去取必然打架。
   */
  requiresExclusiveDevice(context: KeyContext): boolean

  /** 取密钥可能要多久（要等人按设备的话得更长） */
  timeoutMs(context: KeyContext): number

  /** 取密钥前的可用性检查：文件在不在、卡插没插、PIN 还剩几次 */
  check(context: KeyContext): Promise<void>

  /**
   * 取密钥并交给回调使用。
   * 回调结束后 provider 立刻清零自己持有的副本 ——
   * 密钥的存活时间严格等于回调，别把它存起来。
   */
  withKey<T>(context: KeyContext, use: (privateKeyHex: string) => T | Promise<T>): Promise<T>
}

/** provider 抛错时带上 code，上层据此给出可操作的建议 */
export class KeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'KeyError'
  }
}

/* ══ 注册表 ══════════════════════════════════════════════════════════════ */
/**
 * 加一种密钥来源 = 实现 KeyProvider + 在下面这行数组里加一项。
 *
 * 惰性求值：gpg.ts 反过来要用本文件的 KeyError，模块初始化期取值会拿到 undefined。
 */
import { gpgProvider } from './gpg.js'

export const DEFAULT_KEY_SOURCE = 'gpg'

const providers = (): readonly KeyProvider[] => [gpgProvider]

export function providerOf(kind: string = DEFAULT_KEY_SOURCE): KeyProvider {
  const provider = providers().find((candidate) => candidate.kind === kind)
  if (!provider) {
    throw new KeyError(
      'KEY_SOURCE_UNKNOWN',
      `未注册的密钥来源: ${kind}。实现 KeyProvider 后请在 lib/keys/provider.ts 注册。`,
    )
  }
  return provider
}

export const supportedKeySources = (): readonly string[] => providers().map((p) => p.kind)
