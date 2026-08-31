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

/** 直接写 operations.json 造带指定时间戳的记录 —— record() 用的是当前时间 */
async function seed(
  entries: readonly { ts: string; hash: string; address?: string }[],
): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    join(dir, 'operations.json'),
    JSON.stringify({
      items: entries.map((e) => ({
        operation: 'pause',
        contract: 'vault',
        chain: 'morph',
        status: 'confirmed',
        address: e.address ?? '0xAlice',
        hash: e.hash,
        ts: e.ts,
      })),
    }),
  )
}

describe('按时间窗查（日志按天看）', () => {
  it('★ 左闭右开 —— 一笔交易只能落进一天，不会同时出现在相邻两天', async () => {
    await seed([
      { ts: '2026-08-28T15:59:59.999Z', hash: '0xbefore' },
      { ts: '2026-08-28T16:00:00.000Z', hash: '0xstart' },
      { ts: '2026-08-29T15:59:59.999Z', hash: '0xlast' },
      { ts: '2026-08-29T16:00:00.000Z', hash: '0xnext' },
    ])
    const repo = await load()

    const page = await repo.query({
      from: '2026-08-28T16:00:00.000Z',
      to: '2026-08-29T16:00:00.000Z',
      limit: 100,
    })

    expect(page.items.map((i) => i.hash).sort()).toEqual(['0xlast', '0xstart'])
  })

  it('不传时间窗就是全部', async () => {
    await seed([
      { ts: '2020-01-01T00:00:00.000Z', hash: '0xold' },
      { ts: '2026-08-29T00:00:00.000Z', hash: '0xnew' },
    ])
    const repo = await load()

    expect((await repo.query({ limit: 100 })).total).toBe(2)
  })

  it('★ 时间戳坏掉的不藏 —— 藏了运维会以为交易没发出去', async () => {
    await seed([{ ts: 'not-a-date', hash: '0xbad' }])
    const repo = await load()

    const page = await repo.query({
      from: '2026-08-29T00:00:00.000Z',
      to: '2026-08-30T00:00:00.000Z',
      limit: 100,
    })

    expect(page.items.map((i) => i.hash)).toEqual(['0xbad'])
  })

  it('时间窗和地址筛选叠加', async () => {
    await seed([
      { ts: '2026-08-29T03:00:00.000Z', hash: '0xa', address: '0xAlice' },
      { ts: '2026-08-29T04:00:00.000Z', hash: '0xb', address: '0xBob' },
    ])
    const repo = await load()

    const page = await repo.query({
      from: '2026-08-29T00:00:00.000Z',
      to: '2026-08-30T00:00:00.000Z',
      address: '0xalice',
      limit: 100,
    })

    expect(page.items.map((i) => i.hash)).toEqual(['0xa'])
  })

  it('那天没有记录时返回空，total 也是 0', async () => {
    await seed([{ ts: '2026-08-29T03:00:00.000Z', hash: '0xa' }])
    const repo = await load()

    const page = await repo.query({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T00:00:00.000Z',
      limit: 100,
    })

    expect(page.items).toEqual([])
    expect(page.total).toBe(0)
  })
})

describe('每日笔数（日期选择器的角标）', () => {
  it('★ 按交易哈希去重 —— GPG 一笔交易写两条，不去重日历上的数会翻倍', async () => {
    await seed([
      // 同一笔交易：广播时一条、确认后一条
      { ts: '2026-08-29T03:00:00.000Z', hash: '0xsame' },
      { ts: '2026-08-29T03:00:05.000Z', hash: '0xsame' },
      { ts: '2026-08-29T04:00:00.000Z', hash: '0xother' },
    ])
    const repo = await load()

    expect(await repo.dailyCounts({ offsetMinutes: 0 })).toEqual({ '2026-08-29': 2 })
  })

  it('★ 按本地日历日分组 —— 同一条记录在不同时区落在不同天', async () => {
    // UTC 8/29 20:00 = 北京 8/30 04:00
    await seed([{ ts: '2026-08-29T20:00:00.000Z', hash: '0xlate' }])
    const repo = await load()

    expect(await repo.dailyCounts({ offsetMinutes: 0 })).toEqual({ '2026-08-29': 1 })
    expect(await repo.dailyCounts({ offsetMinutes: -480 })).toEqual({ '2026-08-30': 1 })
  })

  it('时间窗外的不计', async () => {
    await seed([
      { ts: '2026-07-01T00:00:00.000Z', hash: '0xold' },
      { ts: '2026-08-29T00:00:00.000Z', hash: '0xnew' },
    ])
    const repo = await load()

    const counts = await repo.dailyCounts({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
      offsetMinutes: 0,
    })
    expect(counts).toEqual({ '2026-08-29': 1 })
  })

  it('时间戳坏掉的不计入任何一天，也不炸', async () => {
    await seed([
      { ts: 'not-a-date', hash: '0xbad' },
      { ts: '2026-08-29T00:00:00.000Z', hash: '0xgood' },
    ])
    const repo = await load()

    expect(await repo.dailyCounts({ offsetMinutes: 0 })).toEqual({ '2026-08-29': 1 })
  })

  it('没有记录时返回空对象', async () => {
    await seed([])
    const repo = await load()
    expect(await repo.dailyCounts({ offsetMinutes: 0 })).toEqual({})
  })
})
