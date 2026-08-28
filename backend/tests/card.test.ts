import { describe, expect, it } from 'vitest'
import { LOW_PIN_RETRIES, parseCardStatus, policyNeedsTouch } from '../src/lib/keys/card.js'

/**
 * `gpg --card-status` 输出解析。
 *
 * 提前读出 PIN 剩余次数是关键：输错第三次卡就锁了，要 PUK 才能解。
 * 与其等用户输错再从 stderr 里猜，不如在他动手之前就拦下来。
 */
const SAMPLE = `Reader ...........: Yubico YubiKey OTP+FIDO+CCID
Application ID ...: D2760001240103040006123456780000
Application type .: OpenPGP
Version ..........: 3.4
Manufacturer .....: Yubico
Serial number ....: 12345678
Name of cardholder: Ops Key
Signature PIN ....: not forced
Key attributes ...: rsa2048 rsa2048 rsa2048
Max. PIN lengths .: 127 127 127
PIN retry counter : 3 0 3
Signature counter : 7
Touch policy .....: cached
Signature key ....: AAAA BBBB CCCC DDDD EEEE  FFFF 0000 1111 2222 3333
Encryption key....: 1111 2222 3333 4444 5555  6666 7777 8888 9999 AAAA
Authentication key: [none]`

describe('解析卡状态', () => {
  it('把关键字段都抠出来', () => {
    const card = parseCardStatus(SAMPLE)
    expect(card.present).toBe(true)
    expect(card.reader).toBe('Yubico YubiKey OTP+FIDO+CCID')
    expect(card.serial).toBe('12345678')
    expect(card.hasDecryptKey).toBe(true)
    expect(card.decryptTouchPolicy).toBe('cached')
  })

  it('★ PIN retry counter "3 0 3"：第一个是用户 PIN，第三个是管理员 PIN', () => {
    const card = parseCardStatus(SAMPLE)
    expect(card.pinRetriesLeft).toBe(3)
    expect(card.adminRetriesLeft).toBe(3)
  })

  it('★ PIN 用完时能识别出来（0 次 = 已锁）', () => {
    const card = parseCardStatus(SAMPLE.replace('PIN retry counter : 3 0 3', 'PIN retry counter : 0 0 3'))
    expect(card.pinRetriesLeft).toBe(0)
  })

  it('★ 只剩 1~2 次要能触发警告（再错就锁卡）', () => {
    const card = parseCardStatus(SAMPLE.replace('PIN retry counter : 3 0 3', 'PIN retry counter : 1 0 3'))
    expect(card.pinRetriesLeft).toBeLessThanOrEqual(LOW_PIN_RETRIES)
  })

  it('卡上没有解密密钥时 hasDecryptKey 为 false', () => {
    const card = parseCardStatus(SAMPLE.replace(/Encryption key\.\.\.\.: .*/, 'Encryption key....: [none]'))
    expect(card.hasDecryptKey).toBe(false)
  })

  it('输出不是卡状态时认定为无卡，不瞎解析', () => {
    expect(parseCardStatus('gpg: OpenPGP card not available').present).toBe(false)
    expect(parseCardStatus('').present).toBe(false)
  })

  it('缺字段不崩，缺的就是 undefined', () => {
    const card = parseCardStatus('Reader ...........: Some Reader\nApplication type .: OpenPGP')
    expect(card.present).toBe(true)
    expect(card.pinRetriesLeft).toBeUndefined()
    expect(card.serial).toBeUndefined()
  })
})

describe('触摸策略', () => {
  it('on / fixed / cached 都要触摸', () => {
    expect(policyNeedsTouch('on')).toBe(true)
    expect(policyNeedsTouch('fixed')).toBe(true)
    expect(policyNeedsTouch('cached')).toBe(true)
  })

  it('off 不用触摸', () => {
    expect(policyNeedsTouch('off')).toBe(false)
  })

  it('★ 读不到策略时保守地认为要触摸 —— 多提示一句不会错，不提示会让人干等', () => {
    expect(policyNeedsTouch(undefined)).toBe(true)
  })
})
