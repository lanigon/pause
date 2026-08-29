import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { env } from '../config/env.js'
import {
  chainsFileSchema,
  contractsFileSchema,
  operatorsFileSchema,
} from '../config/config.schema.js'
import type { BusinessLine, ContractDef } from '../models/contract.model.js'
import type { Chain } from '../models/chain.model.js'
import type { Operator } from '../models/operator.model.js'
import { readText, readJson, writeJsonAtomic, fileExists } from '../lib/utils/jsonFile.js'
import { EMPTY_RPC_FILE, type RpcFile } from '../lib/rpc/endpoint.js'
import { AppError, ErrorCode } from '../lib/utils/errors.js'

/**
 * 配置读取。只做三件事：读磁盘 → 解析 ${ENV} → 单文件 schema 校验。
 * 跨文件引用完整性由 registry.service 负责。
 *
 * 只有三个配置文件：
 *   chains.json     RPC 数据
 *   contracts.json  合约数据（业务线也在里面）
 *   operators.json  登录身份（谁能登录）
 */

interface ZodLike {
  safeParse: (value: unknown) => {
    success: boolean
    data?: unknown
    error?: { issues: Array<{ path: (string | number)[]; message: string }> }
  }
}

export interface RawConfigBundle {
  readonly chains: readonly Chain[]
  readonly businessLines: readonly BusinessLine[]
  readonly contracts: readonly ContractDef[]
  readonly operators: readonly Operator[]
  readonly configVersion: string
}

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g

/** 配置内容指纹：任何一个字节变化都会换 configVersion */
function configVersionOf(...parts: readonly string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return `sha256:${hash.digest('hex').slice(0, 16)}`
}

/** 解析 ${VAR} 引用；变量缺失直接抛错，不留字面量当 URL 用 */
function resolveEnvRefs(raw: string, fileName: string): string {
  return raw.replace(ENV_REF, (_match, name: string) => {
    const value = process.env[name]
    if (value === undefined || value === '') {
      throw new AppError(
        ErrorCode.INTERNAL,
        `${fileName} 引用了环境变量 \${${name}}，但它未设置。请在 .env 中补上或删掉该条目。`,
      )
    }
    return JSON.stringify(value).slice(1, -1)
  })
}

async function readConfigFile(dir: string, fileName: string): Promise<{ raw: string; resolved: unknown }> {
  const filePath = join(dir, fileName)
  if (!(await fileExists(filePath))) {
    throw new AppError(ErrorCode.INTERNAL, `配置文件不存在: ${filePath}`)
  }
  const raw = await readText(filePath)
  try {
    return { raw, resolved: JSON.parse(resolveEnvRefs(raw, fileName)) }
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw new AppError(ErrorCode.INTERNAL, `${fileName} 不是合法 JSON`, { cause })
  }
}


function validate<T>(fileName: string, schema: ZodLike, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = (result.error?.issues ?? [])
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new AppError(ErrorCode.INTERNAL, `${fileName} 校验失败 → ${detail}`)
  }
  return result.data as T
}

export async function loadRawConfig(configDir: string = env.DATA_DIR): Promise<RawConfigBundle> {
  const dir = resolve(configDir)

  const chainsFile = await readConfigFile(dir, 'chains.json')
  const contractsFile = await readConfigFile(dir, 'contracts.json')
  const operatorsFile = await readConfigFile(dir, 'operators.json')

  const chains = validate<{ chains: Chain[] }>('chains.json', chainsFileSchema, chainsFile.resolved)
  const contracts = validate<{ businessLines: BusinessLine[]; contracts: ContractDef[] }>(
    'contracts.json',
    contractsFileSchema,
    contractsFile.resolved,
  )
  const operators = validate<Operator[]>('operators.json', operatorsFileSchema, operatorsFile.resolved)

  return {
    chains: chains.chains,
    businessLines: contracts.businessLines,
    contracts: contracts.contracts,
    operators,
    // 用解析前的原文算指纹：环境变量值不参与，免得把私有 RPC 混进语义
    configVersion: configVersionOf(chainsFile.raw, contractsFile.raw, operatorsFile.raw),
  }
}

/**
 * 读 data/rpc.json。
 *
 * 文件读写归 repository 管 —— lib/rpc 只负责"这条链能用哪些 RPC"，
 * 不该自己去碰文件系统。将来换成数据库时也只改这里。
 * 没有这个文件不算错：还没跑过 npm run sync 而已，返回空结构照常启动。
 */
export const readRpcFile = (dataDir: string = env.DATA_DIR): Promise<RpcFile> =>
  readJson<RpcFile>(join(resolve(dataDir), 'rpc.json'), EMPTY_RPC_FILE)


/**
 * contracts.json 的内容形状。业务线与合约同在一个文件里，读写必须成对 ——
 * 合约引用业务线 id，分开写会留下引用不到业务线的中间态。
 */
export interface ContractsFile {
  readonly businessLines: readonly BusinessLine[]
  readonly contracts: readonly ContractDef[]
}

const EMPTY_CONTRACTS: ContractsFile = { businessLines: [], contracts: [] }

const contractsPath = (dataDir: string): string => join(resolve(dataDir), 'contracts.json')

/**
 * 读 data/contracts.json 的原始内容（不解析 ${ENV}、不校验 schema）。
 *
 * 给 Lark 同步比对用：它要的是"磁盘上现在是什么"，校验过的那份在
 * loadRawConfig 那条路上。文件不存在返回空清单 —— 还没同步过而已，不是错。
 */
export const readContracts = (dataDir: string = env.DATA_DIR): Promise<ContractsFile> =>
  readJson<ContractsFile>(contractsPath(dataDir), EMPTY_CONTRACTS)

/**
 * 覆盖写 data/contracts.json。
 *
 * 只取这两个字段：调用方传进来的往往还带着解析过程的信息（跳过了哪些行），
 * 那些是事件里的内容，混进磁盘就会被下次 schema 校验拒掉。
 */
export const saveContracts = (payload: ContractsFile, dataDir: string = env.DATA_DIR): Promise<void> =>
  writeJsonAtomic(contractsPath(dataDir), {
    businessLines: payload.businessLines,
    contracts: payload.contracts,
  })
