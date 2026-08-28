import { loadRawConfig, type RawConfigBundle } from '../repositories/config.repository.js'
import { assertRegistered, meta, resetAll, type ChainFamily } from '../lib/web3/index.js'
import type { Chain } from '../models/chain.model.js'
import type { BusinessLine, ContractDef } from '../models/contract.model.js'
import type { SignerDef } from '../models/signer.model.js'
import type { Operator } from '../models/operator.model.js'
import { listOperations } from '../executor/operations.js'
import { AppError, ErrorCode, notFound } from '../lib/utils/errors.js'
import { logger } from '../lib/utils/logger.js'
import { rpcProvider } from '../lib/rpc/rpcProvider.js'

/**
 * 配置注册表：进程内唯一的配置真相来源。
 *
 * 分工：
 *   config.repository → 读磁盘 + 单文件 schema 校验
 *   registry.service  → 跨文件引用完整性校验 + 建索引 + 生成下发前端的 DTO
 */

interface RegistryDto {
  readonly configVersion: string
  readonly businessLines: readonly BusinessLine[]
  readonly chains: readonly (Chain & { rpcs: readonly string[] })[]
  readonly contracts: readonly ContractDef[]
  readonly signers: readonly SignerDef[]
  readonly operations: readonly unknown[]
}

export interface Registry {
  readonly configVersion: string
  readonly loadedAt: number
  readonly chains: ReadonlyMap<string, Chain>
  readonly businessLines: readonly BusinessLine[]
  readonly contracts: ReadonlyMap<string, ContractDef>
  /** 按链族索引：一个链族一把密钥 */
  readonly signers: ReadonlyMap<ChainFamily, SignerDef>
  readonly operators: ReadonlyMap<string, Operator>
  readonly byBusinessLine: ReadonlyMap<string, readonly ContractDef[]>
}

let current: Registry | null = null

export function getRegistry(): Registry {
  if (!current) throw new AppError(ErrorCode.INTERNAL, '配置尚未加载，服务未正确启动')
  return current
}

export const getConfigVersion = (): string => getRegistry().configVersion

/** 启动与热重载都走这里。校验不过就抛错，绝不让半个错误配置生效。 */
export async function loadRegistry(configDir?: string): Promise<Registry> {
  const next = build(await loadRawConfig(configDir))
  current = next
  resetAll() // 换了配置就得丢掉旧 RPC 连接
  cachedDto = null // 预计算的下发数据要作废重算

  // 提前算好，第一个请求就不用等
  dto()

  logger.info(
    {
      configVersion: next.configVersion,
      chains: next.chains.size,
      contracts: next.contracts.size,
      businessLines: next.businessLines.length,
      signers: next.signers.size,
      operators: next.operators.size,
    },
    '配置已加载',
  )
  return next
}

// ── 跨文件引用完整性校验 ────────────────────────────────────────────────────

function build(raw: RawConfigBundle): Registry {
  const problems: string[] = []

  // 每个链族都必须已注册 adapter，否则运行时才发现就晚了
  assertRegistered(raw.chains.map((c) => c.type))

  const chains = uniqueIndex(raw.chains, (c) => c.key, 'chains.json 链 key 重复', problems)
  const businessLineIds = new Set(raw.businessLines.map((b) => b.id))
  const contracts = uniqueIndex(raw.contracts, (c) => c.id, 'contracts.json 合约 id 重复', problems)

  for (const contract of raw.contracts) {
    const where = `合约 ${contract.id}`
    const chain = chains.get(contract.chain)

    if (!chain) {
      problems.push(`${where}: 引用了不存在的链 "${contract.chain}"`)
    } else if (!meta(chain.type).isValidAddress(contract.address)) {
      // Tron 地址配到 EVM 链上是最常见的手滑
      problems.push(`${where}: 地址 "${contract.address}" 不符合 ${chain.type} 链的格式`)
    }

    if (!businessLineIds.has(contract.businessLine)) {
      problems.push(`${where}: 引用了不存在的业务线 "${contract.businessLine}"`)
    }
  }

  // 一个链族一把密钥。授权范围不在这里配 —— 由登录的人的 businessLines 决定
  const signers = new Map<ChainFamily, SignerDef>()
  for (const signer of raw.signers) {
    const where = `signer ${signer.chainType}`
    if (signers.has(signer.chainType)) problems.push(`${where}: 同一链族只能配一把密钥`)
    signers.set(signer.chainType, signer)

    if (!meta(signer.chainType).isValidAddress(signer.address)) {
      problems.push(`${where}: 地址 "${signer.address}" 不符合 ${signer.chainType} 链的格式`)
    }
  }

  if (problems.length > 0) {
    throw new AppError(
      ErrorCode.INTERNAL,
      `配置校验失败（${problems.length} 项）：\n  - ${problems.join('\n  - ')}`,
    )
  }

  return {
    configVersion: raw.configVersion,
    loadedAt: Date.now(),
    chains,
    businessLines: raw.businessLines,
    contracts,
    signers,
    operators: indexOperators(raw.operators),
    byBusinessLine: groupBy(raw.contracts, (c) => c.businessLine),
  }
}

// ── 查询 ────────────────────────────────────────────────────────────────────

export function getChain(chainKey: string): Chain {
  const chain = getRegistry().chains.get(chainKey)
  if (!chain) throw notFound(`链不存在: ${chainKey}`)
  return chain
}

export function getContract(contractId: string): ContractDef {
  const contract = getRegistry().contracts.get(contractId)
  if (!contract) throw notFound(`合约不存在: ${contractId}`)
  return contract
}

export function getSigner(chainType: ChainFamily): SignerDef {
  const signer = getRegistry().signers.get(chainType)
  if (!signer) throw notFound(`未配置 ${chainType} 链族的后端签名密钥`)
  return signer
}

export const findOperator = (normalizedAddress: string): Operator | undefined =>
  getRegistry().operators.get(normalizedAddress.toLowerCase())

export const contractsOf = (businessLine: string): readonly ContractDef[] =>
  getRegistry().byBusinessLine.get(businessLine) ?? []

// ── 下发前端的 DTO ──────────────────────────────────────────────────────────


/**
 * 下发前端的数据 —— **加载配置时就算好，放在内存里，请求来了直接给**。
 *
 * 前端会频繁拉这个接口（切业务线、刷新状态），每次都重新过滤链、拼 RPC、
 * 展开对象是白费的。所以在 loadRegistry() 时预计算一次，请求路径上零计算。
 *
 * 只有一份 —— 角色即权限，所有能登录的人看到的内容都一样，
 * 区别只在能不能动（viewer 只读，由后端的 requireWriteRole 拦）。
 */
let cachedDto: RegistryDto | null = null

export function dto(): RegistryDto {
  if (cachedDto) return cachedDto

  const registry = getRegistry()
  const contracts = [...registry.contracts.values()]

  // 只保留合约实际涉及的链；RPC 由后端提供，且只给公开的
  const usedChains = new Set(contracts.map((contract) => contract.chain))
  const chains = [...registry.chains.values()]
    .filter((chain) => usedChains.has(chain.key))
    .map((chain) => ({ ...chain, rpcs: rpcProvider.publicUrlsFor(chain) }))

  cachedDto = Object.freeze({
    configVersion: registry.configVersion,
    businessLines: registry.businessLines,
    chains,
    contracts,
    signers: [...registry.signers.values()],
    operations: listOperations(),
  })
  return cachedDto
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

function uniqueIndex<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  duplicateMessage: string,
  problems: string[],
): ReadonlyMap<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    if (map.has(key)) problems.push(`${duplicateMessage}: "${key}"`)
    map.set(key, item)
  }
  return map
}

/** 登录白名单 */
function indexOperators(operators: readonly Operator[]): ReadonlyMap<string, Operator> {
  const map = new Map<string, Operator>()
  for (const operator of operators.filter((o) => o.enabled)) {
    map.set(operator.address.toLowerCase(), operator)
  }
  return map
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = map.get(key)
    if (bucket) bucket.push(item)
    else map.set(key, [item])
  }
  return map
}
