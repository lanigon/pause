import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonCollectionStore } from '../src/repositories/jsonStore.js'
import { readJson, fileExists } from '../src/lib/utils/jsonFile.js'

/**
 * JSON 存储 —— 全后端唯一碰磁盘的地方。
 * 它坏了所有落盘数据都会坏，所以并发写、截断、原子性都要测。
 */
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const store = (maxItems = 100) =>
  new JsonCollectionStore<{ id: string; v: number }>({ baseDir: dir, fileName: 'x.json', maxItems })

describe('读', () => {
  it('文件不存在时返回 fallback，不抛错（首次启动就是这种情况）', async () => {
    expect(await readJson(join(dir, 'nope.json'), { items: [] })).toEqual({ items: [] })
  })

  it('空文件也走 fallback', async () => {
    await writeFile(join(dir, 'empty.json'), '', 'utf8')
    expect(await readJson(join(dir, 'empty.json'), { ok: true })).toEqual({ ok: true })
  })

  it('内容不是合法 JSON 时抛错，而不是静默返回 fallback', async () => {
    await writeFile(join(dir, 'bad.json'), '{ 这不是 json', 'utf8')
    await expect(readJson(join(dir, 'bad.json'), {})).rejects.toThrow(/JSON 解析失败/)
  })
})

describe('集合存储', () => {
  it('追加后能读回来', async () => {
    const s = store()
    await s.append({ id: 'a', v: 1 })
    await s.append({ id: 'b', v: 2 })
    expect((await s.all()).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('★ 超过上限时丢最旧的，保留最新的', async () => {
    const s = store(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) await s.append({ id, v: 0 })
    expect((await s.all()).map((i) => i.id)).toEqual(['c', 'd', 'e'])
  })

  it('批量追加也遵守上限', async () => {
    const s = store(2)
    await s.appendMany([{ id: 'a', v: 0 }, { id: 'b', v: 0 }, { id: 'c', v: 0 }])
    expect((await s.all()).map((i) => i.id)).toEqual(['b', 'c'])
  })

  it('空数组不写盘', async () => {
    const s = store()
    await s.appendMany([])
    expect(await fileExists(join(dir, 'x.json'))).toBe(false)
  })

  it('落盘内容可被重新加载（重启不丢）', async () => {
    await store().append({ id: 'persisted', v: 42 })
    const reloaded = store()
    expect((await reloaded.all())[0]).toEqual({ id: 'persisted', v: 42 })
  })

  it('★ 并发写不会互相覆盖（串行队列）', async () => {
    const s = store(1000)
    await Promise.all(Array.from({ length: 30 }, (_, i) => s.append({ id: `n${i}`, v: i })))
    expect(await s.count()).toBe(30)

    // 落盘的也得是 30 条，不能只剩最后一次写的
    const onDisk = JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')) as { items: unknown[] }
    expect(onDisk.items).toHaveLength(30)
  })

  it('★ 写入是原子的：不留 .tmp 残file', async () => {
    const s = store()
    await s.append({ id: 'a', v: 1 })
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('文件权限是 0600（日志里可能有地址，不该全局可读）', async () => {
    const s = store()
    await s.append({ id: 'a', v: 1 })
    const info = await stat(join(dir, 'x.json'))
    expect((info.mode & 0o777).toString(8)).toBe('600')
  })

  it('★ 返回的快照是冻结的，调用方改不动内部状态', async () => {
    const s = store()
    await s.append({ id: 'a', v: 1 })
    const snapshot = await s.all()
    // 冻结数组，push 在严格模式下直接抛错
    expect(() => (snapshot as { id: string; v: number }[]).push({ id: 'x', v: 0 })).toThrow()
    expect(await s.count()).toBe(1)
  })
})
