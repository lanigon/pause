import { readFile, readdir } from 'node:fs/promises'
import { env } from '../../config/env.js'
import { KeyError } from './provider.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  本地密钥的发现
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 后端持有哪些链族的密钥，**由 secrets/ 目录里有什么决定**，不再配表。
 *
 * 约定死的两个文件（都由 `npm run keys encrypt` 生成）：
 *   secrets/<链族>.key.gpg    GPG 加密的私钥
 *   secrets/<链族>.address    对应的地址，明文
 *
 * 为什么还要存地址：它是**防止密钥文件被掉包**的控制点 ——
 * 解密后派生出来的地址必须和它一致，不一致立即拒绝。
 * 由加密脚本顺手写出来，没有人工填写的环节，也就不会填错或忘填。
 *
 * 路径固定还带来一个好处：配置里从不出现路径，也就不存在路径穿越。
 */

export interface LocalKey {
  readonly family: string
  /**
   * 声明地址。两个用途：
   *   发交易时的 from；解密后派生出来的地址必须与它一致，不一致说明密钥被换了。
   */
  readonly address: string
}

const KEY_SUFFIX = '.key.gpg'

export const keyPathFor = (family: string, dir: string = env.SECRETS_DIR): string =>
  `${dir}/${family}${KEY_SUFFIX}`

export const addressPathFor = (family: string, dir: string = env.SECRETS_DIR): string =>
  `${dir}/${family}.address`

/** secrets/ 下有哪些链族的密钥。目录不存在就是一把都没有 */
export async function availableKeys(dir: string = env.SECRETS_DIR): Promise<readonly LocalKey[]> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const families = files
    .filter((name) => name.endsWith(KEY_SUFFIX))
    .map((name) => name.slice(0, -KEY_SUFFIX.length))
    .sort()

  return Promise.all(families.map(async (family) => ({ family, address: await readAddress(family, dir) })))
}

export async function keyFor(family: string, dir: string = env.SECRETS_DIR): Promise<LocalKey> {
  const key = (await availableKeys(dir)).find((candidate) => candidate.family === family)
  if (!key) {
    throw new KeyError(
      'KEY_MISSING',
      `没有 ${family} 链族的密钥。先跑 npm run keys encrypt 生成 ${keyPathFor(family, dir)}`,
    )
  }
  return key
}

/**
 * 读声明地址。
 *
 * 缺这个文件不能放行 —— 没有它就没法在解密后核对身份，
 * 等于把「密钥被掉包」这个检查静默关掉了。
 */
async function readAddress(family: string, dir: string): Promise<string> {
  const path = addressPathFor(family, dir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new KeyError(
      'ADDRESS_MISSING',
      `${keyPathFor(family, dir)} 存在但缺少 ${path}。` +
        '这个文件用于核对解密出来的密钥是不是被换过，不能省。重跑 npm run keys encrypt 生成。',
    )
  }

  const address = raw.trim()
  if (!address) throw new KeyError('ADDRESS_MISSING', `${path} 是空的`)
  return address
}
