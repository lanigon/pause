import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GpgKey,
  KeyError,
  UnlockMethod,
  decryptArgsWithSecret,
  encryptArgs,
  isCardBlocked,
  isPinentryUnavailable,
  parseCardStatus,
  remainingPinAttempts,
} from '../src/lib/keys/gpg.js'
import { ErrorCode } from '../src/lib/utils/errors.js'

/**
 * 本地 GPG 密钥。
 *
 * 一把密钥 = secrets/ 下两个固定名字的文件。没有配置表 ——
 * 有哪个文件就有哪个链族，解锁方式探出来，地址由加密脚本写在旁边。
 *
 * 这里的测试价值集中在两处：
 *   · **归类准不准** —— 分错了用户会被引导去做错的事。最坏是把
 *     "pinentry 弹不出来"误报成"PIN 错了"，用户一遍遍重试，三次锁卡。
 *   · **该拦的有没有拦住** —— 缺声明地址就等于把"密钥被掉包"的检查关掉了。
 */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keys-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const putKey = (family: string, address?: string): Promise<unknown> =>
  Promise.all([
    writeFile(join(dir, `${family}.key.gpg`), 'ciphertext'),
    ...(address === undefined ? [] : [writeFile(join(dir, `${family}.address`), address)]),
  ])

describe('找密钥', () => {
  it('有哪个 .key.gpg 就有哪个链族', async () => {
    await putKey('evm', '0xabc')
    await putKey('tron', 'TAbc')

    expect((await GpgKey.available(dir)).map((k) => k.family)).toEqual(['evm', 'tron'])
  })

  it('目录里的杂物不算（.jwt-dev、备份文件之类）', async () => {
    await writeFile(join(dir, '.jwt-dev'), 'x')
    await writeFile(join(dir, 'evm.key.gpg.bak'), 'x')

    expect(await GpgKey.available(dir)).toEqual([])
  })

  it('目录压根不存在时返回空，不炸', async () => {
    await rm(dir, { recursive: true, force: true })
    expect(await GpgKey.available(dir)).toEqual([])
  })

  it('路径完全由链族推出来 —— 配置里从不出现路径，也就没有路径穿越', async () => {
    await putKey('evm', '0xabc')
    const key = await GpgKey.of('evm', dir)

    expect(key.path).toBe(`${dir}/evm.key.gpg`)
    expect(key.addressPath).toBe(`${dir}/evm.address`)
  })

  it('要一个没有的链族时，错误里要写清楚怎么补', async () => {
    await expect(GpgKey.of('solana', dir)).rejects.toThrow(/npm run keys encrypt/)
  })
})

describe('声明地址（防密钥被掉包）', () => {
  it('两头的空白要去掉 —— 文件末尾多个换行是常态', async () => {
    await putKey('evm', '  0xabc \n\n')
    expect(await (await GpgKey.of('evm', dir)).address()).toBe('0xabc')
  })

  it('★ 有密钥但缺地址文件 → 抛错，不静默放行', async () => {
    await putKey('evm')
    await expect((await GpgKey.of('evm', dir)).address()).rejects.toThrow(/不能省/)
  })

  it('★ 地址文件是空的也要抛错', async () => {
    await putKey('evm', '   \n')
    await expect((await GpgKey.of('evm', dir)).address()).rejects.toThrow(/是空的/)
  })

  it('错误码在 ErrorCode 里 —— 不然拿不到 HTTP 状态码，也匹配不上给用户的提示', async () => {
    await putKey('evm')
    const error = await (await GpgKey.of('evm', dir)).address().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(KeyError)
    expect(Object.values(ErrorCode)).toContain((error as KeyError).code)
  })
})

describe('gpg 参数', () => {
  it('★ 服务端解密不带 loopback —— 口令由本机 gpg-agent 负责，后端进程不碰', () => {
    // 服务端那条路走的是 GpgKey.withKey 内部的 decryptArgs，参数里没有这两个
    const scriptArgs = decryptArgsWithSecret('f.gpg')
    expect(scriptArgs).toContain('--pinentry-mode')
    expect(scriptArgs).toContain('loopback')
  })

  it('★ 口令绝不出现在 gpg 参数里（argv 会被 ps 看到）', () => {
    const all = [...decryptArgsWithSecret('f.gpg'), ...encryptArgs(), ...encryptArgs('ABC123')]
    expect(all).not.toContain('--passphrase')
  })

  it('给了 recipient 就走非对称（YubiKey 形态），没给就对称', () => {
    expect(encryptArgs('ABC123')).toContain('--recipient')
    expect(encryptArgs()).toContain('--symmetric')
  })
})

describe('YubiKey 卡状态', () => {
  it('★ PIN retry counter 的三个数里，第一个才是用户 PIN', () => {
    // 三个数分别是用户 PIN、重置码、Admin PIN。取错了会把 0 当成"还能试"
    const card = parseCardStatus('Reader ...: Yubico\nPIN retry counter : 2 0 3\n')
    expect(card.pinRetriesLeft).toBe(2)
  })

  it('认出卡在不在，以及有没有解密密钥', () => {
    const withKey = parseCardStatus('Application ID ...: D276\nEncryption key....: ABCD1234\n')
    expect(withKey.present).toBe(true)
    expect(withKey.hasDecryptKey).toBe(true)

    const noKey = parseCardStatus('Application ID ...: D276\nEncryption key....: [none]\n')
    expect(noKey.hasDecryptKey).toBe(false)
  })

  it('空输出 = 没插卡', () => {
    expect(parseCardStatus('').present).toBe(false)
  })
})

describe('解锁方式（探测，不是配置）', () => {
  it('★ 对称加密的文件 → 口令模式，不去碰卡', async () => {
    // 真跑 gpg --list-packets：一个不是 gpg 格式的文件会解析失败，
    // 落到 asymmetric 分支，再查卡 —— 没卡就还是口令模式
    await putKey('evm', '0xabc')
    expect(await (await GpgKey.of('evm', dir)).unlock()).toBe(UnlockMethod.PASSPHRASE)
  })

  it('没插卡时绝不返回 YUBIKEY —— 否则白等 120 秒还让人去摸一个不存在的设备', async () => {
    await putKey('evm', '0xabc')
    expect(await (await GpgKey.of('evm', dir)).needsTouch()).toBe(false)
  })
})

describe('错误归类', () => {
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
