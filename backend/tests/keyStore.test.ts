import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 本地密钥的发现。
 *
 * 以前靠 data/signers.json 声明「有哪些链族的密钥、地址是多少、怎么解锁」。
 * 现在全部由 secrets/ 目录决定 —— 有哪个文件就有哪个链族，
 * 地址由加密脚本写在旁边，解锁方式探测得出。少一张表，也少一处能填错的地方。
 */
let dir: string

/** 目录作为参数传进去，不动全局状态 —— 测试之间互不干扰 */
const load = () => import('../src/lib/keys/store.js')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'keys-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('从 secrets/ 发现密钥', () => {
  it('有哪个 .key.gpg 就有哪个链族', async () => {
    await writeFile(join(dir, 'evm.key.gpg'), 'x')
    await writeFile(join(dir, 'evm.address'), '0xabc\n')
    await writeFile(join(dir, 'tron.key.gpg'), 'x')
    await writeFile(join(dir, 'tron.address'), 'TAbc')

    const { availableKeys } = await load()
    expect((await availableKeys(dir)).map((k) => k.family)).toEqual(['evm', 'tron'])
  })

  it('地址两头的空白要去掉 —— 文件末尾多个换行是常态', async () => {
    await writeFile(join(dir, 'evm.key.gpg'), 'x')
    await writeFile(join(dir, 'evm.address'), '  0xabc \n\n')

    const { keyFor } = await load()
    expect((await keyFor('evm', dir)).address).toBe('0xabc')
  })

  it('★ 有密钥但缺地址文件 → 抛错，不静默放行', async () => {
    // 缺了它就没法核对解密出来的密钥是不是被换过，等于把这个检查关掉了
    await writeFile(join(dir, 'evm.key.gpg'), 'x')

    const { availableKeys } = await load()
    await expect(availableKeys(dir)).rejects.toThrow(/ADDRESS_MISSING|缺少/)
  })

  it('★ 地址文件是空的也要抛错', async () => {
    await writeFile(join(dir, 'evm.key.gpg'), 'x')
    await writeFile(join(dir, 'evm.address'), '   \n')

    const { availableKeys } = await load()
    await expect(availableKeys(dir)).rejects.toThrow(/是空的/)
  })

  it('要一个没有的链族时，错误里要写清楚怎么补', async () => {
    const { keyFor } = await load()
    await expect(keyFor('solana', dir)).rejects.toThrow(/npm run keys encrypt/)
  })

  it('secrets 目录压根不存在时返回空，不炸', async () => {
    await rm(dir, { recursive: true, force: true })
    const { availableKeys } = await load()
    expect(await availableKeys(dir)).toEqual([])
    await mkdir(dir, { recursive: true })
  })

  it('目录里的杂物不算密钥（.jwt-dev、备份文件之类）', async () => {
    await writeFile(join(dir, '.jwt-dev'), 'x')
    await writeFile(join(dir, 'evm.key.gpg.bak'), 'x')
    const { availableKeys } = await load()
    expect(await availableKeys(dir)).toEqual([])
  })
})
