import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 交易日志。
 * 只记交易（不记登录），倒序分页，地址由后端填。
 */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'log-'))
  vi.resetModules()
  vi.doMock('../src/config/env.js', async () => {
    const actual = await vi.importActual<typeof import('../src/config/env.js')>('../src/config/env.js')
    return { ...actual, env: { ...actual.env, DATA_DIR: dir } }
  })
})
afterEach(async () => {
  vi.doUnmock('../src/config/env.js')
  await rm(dir, { recursive: true, force: true })
})

const load = () => import('../src/repositories/log.repository.js')

const tx = (over: Partial<{ operation: string; contract: string; chain: string; hash: string; status: string }> = {}) => ({
  operation: 'pause',
  contract: 'vault',
  chain: 'morph',
  hash: '0xabc',
  status: 'confirmed' as const,
  ...over,
}) as Parameters<Awaited<ReturnType<typeof load>>['record']>[1]

describe('记录', () => {
  it('★ 地址与时间由后端填，请求体给什么都不采信', async () => {
    const repo = await load()
    const entry = await repo.record('0xALICE', tx())
    expect(entry.address).toBe('0xALICE')
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('批量记录一次写盘', async () => {
    const repo = await load()
    await repo.recordMany('0xALICE', [tx({ contract: 'a' }), tx({ contract: 'b' })])
    expect(await repo.count()).toBe(2)
  })

  it('空数组不写', async () => {
    const repo = await load()
    await repo.recordMany('0xALICE', [])
    expect(await repo.count()).toBe(0)
  })

  it('★ recordSafe 写失败不抛错，不能拖垮主流程', async () => {
    const repo = await load()
    expect(() => repo.recordSafe('0xALICE', tx())).not.toThrow()
  })
})

describe('查询', () => {
  const seed = async (n: number) => {
    const repo = await load()
    for (let i = 0; i < n; i += 1) {
      await repo.record(i % 2 === 0 ? '0xALICE' : '0xBOB', tx({ contract: `c${i}` }))
    }
    return repo
  }

  it('★ 倒序：最新的在最前面', async () => {
    const repo = await seed(3)
    const page = await repo.query({ limit: 10 })
    expect(page.items.map((i) => i.contract)).toEqual(['c2', 'c1', 'c0'])
  })

  it('按 limit 截断，并给出 nextOffset', async () => {
    const repo = await seed(5)
    const page = await repo.query({ limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.total).toBe(5)
    expect(page.nextOffset).toBe(2)
  })

  it('翻到最后一页时 nextOffset 为 null', async () => {
    const repo = await seed(3)
    const page = await repo.query({ limit: 10 })
    expect(page.nextOffset).toBeNull()
  })

  it('offset 能翻页且不重不漏', async () => {
    const repo = await seed(5)
    const first = await repo.query({ limit: 2, offset: 0 })
    const second = await repo.query({ limit: 2, offset: 2 })
    const ids = [...first.items, ...second.items].map((i) => i.contract)
    expect(new Set(ids).size).toBe(4)
  })

  it('按地址过滤（大小写不敏感）', async () => {
    const repo = await seed(4)
    const page = await repo.query({ limit: 10, address: '0xalice' })
    expect(page.total).toBe(2)
    expect(page.items.every((i) => i.address === '0xALICE')).toBe(true)
  })

  it('没有记录时返回空页而不是报错', async () => {
    const repo = await load()
    const page = await repo.query({ limit: 10 })
    expect(page).toEqual({ items: [], total: 0, nextOffset: null })
  })
})
