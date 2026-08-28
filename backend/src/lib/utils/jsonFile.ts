import { readFile, writeFile, rename, mkdir, access, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { constants } from 'node:fs'
import { KeyedMutex } from './mutex.js'
import { AppError, ErrorCode } from './errors.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JSON 文件读写 —— 基础能力，不涉及任何业务
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 全后端只有这里碰 fs。其它层一律经过它，好处：
 *  - 原子写入、并发串行、错误封装只实现一遍
 *  - 日后换存储介质只改这一个文件
 */
const writeMutex = new KeyedMutex()

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (cause) {
    throw new AppError(ErrorCode.INTERNAL, `读取文件失败: ${filePath}`, { cause })
  }
}

/** 读 JSON；文件不存在返回 fallback（便于首次启动） */
export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  if (!(await fileExists(filePath))) return fallback
  const raw = await readText(filePath)
  if (raw.trim() === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch (cause) {
    throw new AppError(ErrorCode.INTERNAL, `JSON 解析失败: ${filePath}`, { cause })
  }
}

/**
 * 原子写入：写临时文件 → rename 替换，同一路径的写入串行。
 * 避免进程中途挂掉留下半个文件，也避免并发写互相覆盖。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeMutex.runExclusive(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmpPath, filePath)
    } catch (cause) {
      await unlink(tmpPath).catch(() => undefined)
      throw new AppError(ErrorCode.INTERNAL, `写入文件失败: ${filePath}`, { cause })
    }
  })
}
