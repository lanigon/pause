import { join } from 'node:path'
import { readJson, writeJsonAtomic } from '../lib/utils/jsonFile.js'
import { KeyedMutex } from '../lib/utils/mutex.js'
import { logger } from '../lib/utils/logger.js'

/**
 * 追加型集合存储：内存持有全量，写入走原子整文件替换。
 * demo 规模（万级以内）足够；量大了把这个类换成数据库实现，上层无感知。
 */
interface CollectionStoreOptions {
  readonly baseDir: string
  readonly fileName: string
  /** 保留的最大条数，超出丢弃最旧的 */
  readonly maxItems: number
}

export class JsonCollectionStore<T> {
  private items: readonly T[] = []
  private loaded = false
  private readonly filePath: string
  /**
   * 串行化整个「读-改-写」，不只是写盘那一下。
   *
   * 只锁写盘是不够的：并发调用会各自读到同一份旧快照，各自算出
   * 「旧快照 + 自己那条」，最后一个写的赢，前面的全丢。
   * 日志是不 await 地写的（recordSafe），这种并发一定会发生。
   */
  private readonly lock = new KeyedMutex()

  constructor(private readonly options: CollectionStoreOptions) {
    this.filePath = join(options.baseDir, options.fileName)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    const raw = await readJson<{ items?: T[] }>(this.filePath, { items: [] })
    this.items = Object.freeze(Array.isArray(raw.items) ? raw.items : [])
    this.loaded = true
    logger.info({ file: this.filePath, count: this.items.length }, '集合存储已加载')
  }

  /** 返回新数组，绝不原地 push（不可变约定） */
  async append(item: T): Promise<T> {
    await this.appendMany([item])
    return item
  }

  async appendMany(newItems: readonly T[]): Promise<void> {
    if (newItems.length === 0) return

    await this.lock.runExclusive(this.filePath, async () => {
      await this.load()
      const merged = [...this.items, ...newItems]
      // 超上限就丢最旧的
      this.items = Object.freeze(
        merged.length > this.options.maxItems
          ? merged.slice(merged.length - this.options.maxItems)
          : merged,
      )
      await writeJsonAtomic(this.filePath, { items: this.items })
    })
  }

  /** 只读快照。数组已冻结，调用方改不动内部状态 */
  async all(): Promise<readonly T[]> {
    await this.load()
    return this.items
  }

  async count(): Promise<number> {
    await this.load()
    return this.items.length
  }
}
