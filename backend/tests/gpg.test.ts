import { describe, expect, it } from 'vitest'
import {
  decryptArgsWithSecret,
  encryptArgs,
  gpgProvider,
  isCardBlocked,
  isPinentryUnavailable,
  remainingPinAttempts,
} from '../src/lib/keys/gpg.js'
import { UnlockMethod } from '../src/models/signer.model.js'

const ctx = (unlock: UnlockMethod) =>
  ({ family: 'evm', address: '0x0', options: { unlock } }) as never

/**
 * gpg provider 与错误归类。
 *
 * 这块的价值全在"分类准不准"：分错了用户就会被引导去做错的事 ——
 * 最坏的情况是把"pinentry 弹不出来"误报成"PIN 错了"，
 * 用户一遍遍重试，三次之后 YubiKey 就锁了。
 */
describe('gpg provider', () => {
  it('yubikey 要求设备在场并独占，passphrase 不要求', () => {
    expect(gpgProvider.requiresPresence(ctx(UnlockMethod.PASSPHRASE))).toBe(false)
    expect(gpgProvider.requiresPresence(ctx(UnlockMethod.YUBIKEY))).toBe(true)
    // scdaemon 对卡是独占锁，多个会话必须串行开
    expect(gpgProvider.requiresExclusiveDevice(ctx(UnlockMethod.YUBIKEY))).toBe(true)
  })

  it('yubikey 超时更长（要留时间给人伸手摸一下）', () => {
    expect(gpgProvider.timeoutMs(ctx(UnlockMethod.YUBIKEY))).toBeGreaterThan(
      gpgProvider.timeoutMs(ctx(UnlockMethod.PASSPHRASE)),
    )
  })

  it('脚本解密才用 loopback（脚本是交互式的，当场问当场用）', () => {
    const args = decryptArgsWithSecret('secrets/evm.key.gpg')
    expect(args).toContain('--pinentry-mode')
    expect(args).toContain('loopback')
    expect(args).toContain('--decrypt')
  })

  it('口令绝不出现在 gpg 参数里（argv 会被 ps 看到）', () => {
    const all = [...decryptArgsWithSecret('f.gpg'), ...encryptArgs(), ...encryptArgs('ABC123')]
    expect(all).not.toContain('--passphrase')
  })

  it('给了 recipient 就走非对称（YubiKey 形态），没给就对称', () => {
    expect(encryptArgs('ABC123')).toContain('--recipient')
    expect(encryptArgs()).toContain('--symmetric')
  })
})

describe('gpg 错误归类', () => {
  it('识别出还剩几次 PIN 尝试', () => {
    expect(remainingPinAttempts('gpg: card: 2 attempts left')).toBe(2)
    expect(remainingPinAttempts('Remaining attempts: 1')).toBe(1)
    expect(remainingPinAttempts('3 more tries remaining')).toBe(3)
  })

  it('没有次数信息时返回 null，不瞎猜', () => {
    expect(remainingPinAttempts('gpg: decryption failed')).toBeNull()
    expect(remainingPinAttempts('')).toBeNull()
  })

  it('识别卡被锁死', () => {
    expect(isCardBlocked('gpg: card is blocked')).toBe(true)
    expect(isCardBlocked('PIN blocked, use PUK')).toBe(true)
    expect(isCardBlocked('gpg: bad passphrase')).toBe(false)
  })

  it('★ 识别 pinentry 弹不出来 —— 绝不能误报成口令错', () => {
    const real =
      'gpg: problem with the agent: Inappropriate ioctl for device\ngpg: decryption failed: Bad session key'
    expect(isPinentryUnavailable(real)).toBe(true)
    expect(isPinentryUnavailable('gpg: bad passphrase')).toBe(false)
  })
})
