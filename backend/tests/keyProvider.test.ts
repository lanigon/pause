import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEY_SOURCE,
  KeyError,
  providerOf,
  supportedKeySources,
} from '../src/lib/keys/provider.js'
import { UnlockMethod } from '../src/lib/keys/gpg.js'

/**
 * 密钥来源的可插拔抽象。
 * 「怎么拿到本地私钥」与「拿到之后怎么用」解耦：
 * 将来接 KMS / HSM / 卡上直接签名，只需实现接口再注册一行。
 */
describe('密钥来源注册表', () => {
  it('默认是本地 GPG 文件', () => {
    expect(DEFAULT_KEY_SOURCE).toBe('gpg')
    expect(supportedKeySources()).toContain('gpg')
  })

  it('不传就用默认', () => {
    expect(providerOf().kind).toBe('gpg')
  })

  it('★ 未注册的来源抛错，不静默降级到默认（配置写错要能发现）', () => {
    expect(() => providerOf('kms')).toThrow(KeyError)
    expect(() => providerOf('kms')).toThrow(/未注册的密钥来源/)
  })

  it('错误带 code，上层据此给建议', () => {
    try {
      providerOf('hsm')
      expect.unreachable()
    } catch (error) {
      expect((error as KeyError).code).toBe('KEY_SOURCE_UNKNOWN')
    }
  })
})

describe('gpg 来源', () => {
  const ctx = (unlock: UnlockMethod, family = 'evm') => ({
    family,
    expectedAddress: '0x1111111111111111111111111111111111111111',
    options: { unlock },
  })

  it('★ 超时按解锁方式来：YubiKey 要留时间给人按', () => {
    const provider = providerOf('gpg')
    const passphrase = provider.timeoutMs(ctx(UnlockMethod.PASSPHRASE))
    const yubikey = provider.timeoutMs(ctx(UnlockMethod.YUBIKEY))
    expect(yubikey).toBeGreaterThan(passphrase)
  })

  it('★ 密钥文件不存在时报 GPG_KEY_MISSING，而不是含糊的解密失败', async () => {
    const provider = providerOf('gpg')
    try {
      await provider.check(ctx(UnlockMethod.PASSPHRASE, 'nonexistentfamily'))
      expect.unreachable('应该抛错')
    } catch (error) {
      expect((error as KeyError).code).toBe('GPG_KEY_MISSING')
    }
  })

  it('实现了接口的全部方法', () => {
    const provider = providerOf('gpg')
    expect(provider.kind).toBeTypeOf('string')
    expect(provider.label).toBeTypeOf('string')
    expect(provider.check).toBeTypeOf('function')
    expect(provider.withKey).toBeTypeOf('function')
    expect(provider.timeoutMs).toBeTypeOf('function')
  })
})
