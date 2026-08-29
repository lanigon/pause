/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  签名子进程 —— 私钥这辈子只出现在这个一次性进程的内存里
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 生命周期：
 *   1. 父进程 fork 本脚本，告诉它：哪个链族、声明地址是什么、用哪个密钥来源
 *   2. 通过 KeyProvider 取密钥 —— 怎么取是可插拔的（目前是解本地 GPG 文件）
 *   3. 派生地址 → 与配置声明的比对，不一致立即退出（密钥被换过的检测点）
 *   4. **整个签名会话跑在 provider 的回调里** —— 密钥的存活时间严格等于回调，
 *      收到 done 或超时后回调结束，provider 负责清零
 *   5. 只回传签名结果，绝不回传私钥
 */
import { Wallet, Transaction } from 'ethers'
import { utils as tronUtils } from 'tronweb'
import { EVM, TRON, type ChainFamily } from '../web3/types.js'
import { GpgKey } from './gpg.js'

// ── 与父进程的 IPC 协议 ────────────────────────────────────────────────────

export interface WorkerInit {
  readonly type: 'init'
  readonly family: ChainFamily
  /** provider 自己的配置，如 GPG 的 unlock 方式 */
  /** 配置里声明的地址；派生出来的必须与它一致 */
  readonly expectedAddress: string
  readonly jobTimeoutMs: number
}

interface WorkerSignRequest {
  readonly type: 'sign'
  readonly id: string
  /** 由哪个链族产生的负载，按它分派到对应签名实现 */
  readonly family: ChainFamily
  readonly payload: Record<string, unknown>
}

interface WorkerDone {
  readonly type: 'done'
}

export type WorkerRequest = WorkerInit | WorkerSignRequest | WorkerDone

export type WorkerResponse =
  | { type: 'ready'; address: string }
  /** 需要用户物理触摸设备时先发这个，否则用户会以为卡住了 */
  | { type: 'awaiting-touch'; label: string }
  | { type: 'signed'; id: string; signed: Record<string, unknown> }
  | { type: 'error'; id?: string; reason: string; fatal: boolean; code?: string }

const send = (message: WorkerResponse): void => {
  process.send?.(message)
}

// ── 签名：按链族分派 ────────────────────────────────────────────────────────

/**
 * 接新链族时在这张表里加一项 —— 这是 worker 里唯一需要动的地方。
 * 用什么算法是各链族自己的事，不往外暴露成枚举。
 */
function signPayload(
  family: ChainFamily,
  keyHex: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (family) {
    // secp256k1 + keccak256，EIP-155 交易编码
    case EVM: {
      const wallet = new Wallet(`0x${keyHex}`)
      const tx = Transaction.from({
        chainId: payload.chainId as number,
        to: payload.to as string,
        data: payload.data as string,
        value: payload.value as string,
        nonce: payload.nonce as number,
        gasLimit: payload.gasLimit as string,
        ...(payload.type === 2
          ? {
              type: 2,
              maxFeePerGas: payload.maxFeePerGas as string,
              maxPriorityFeePerGas: payload.maxPriorityFeePerGas as string,
            }
          : { type: 0, gasPrice: payload.gasPrice as string }),
      })
      tx.signature = wallet.signingKey.sign(tx.unsignedHash)
      // rawTx 立刻回传给父进程去广播，worker 不保留任何副本
      return { rawTx: tx.serialized, nonce: payload.nonce as number }
    }

    // secp256k1 + sha256，Tron 交易编码
    case TRON: {
      const signed = tronUtils.crypto.signTransaction(keyHex, payload)
      return { signedTx: signed as unknown as Record<string, unknown> }
    }

    default:
      throw new Error(`未实现 ${family} 链族的签名（在 lib/keys/worker.ts 的 signPayload 里补充）`)
  }
}

/**
 * 派生地址，用于和声明地址比对。
 *
 * 必须和 signPayload 一样穷举链族，**不能 else 兜底** ——
 * 兜底的话，接一条新链会静默派生出一个 Tron 地址，然后在地址比对处失败，
 * 报出来的是"密钥可能已被替换"这种安全告警，指向完全错误的方向。
 */
function deriveAddress(family: ChainFamily, keyHex: string): string {
  switch (family) {
    case EVM:
      return new Wallet(`0x${keyHex}`).address

    case TRON: {
      const base58 = tronUtils.address.fromPrivateKey(keyHex)
      if (base58 === false) throw new Error('无法从私钥派生 Tron 地址')
      return base58
    }

    default:
      throw new Error(`未实现 ${family} 链族的地址派生（在 lib/keys/worker.ts 的 deriveAddress 里补充）`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/** 只有 init 之后才会有值：把 sign 请求交给正在跑的会话 */
let handleSign: ((request: WorkerSignRequest) => void) | null = null
let finish: (() => void) | null = null

process.on('message', (message: WorkerRequest) => {
  if (message.type === 'init') {
    void run(message)
    return
  }
  if (message.type === 'sign') {
    handleSign?.(message)
    return
  }
  if (message.type === 'done') finish?.()
})

async function run(init: WorkerInit): Promise<void> {
  const key = await GpgKey.of(init.family)

  try {
    await key.check()

    // 需要人去按设备的话，先告诉前端
    if (await key.needsTouch()) send({ type: 'awaiting-touch', label: 'YubiKey' })

    /**
     * 整个签名会话跑在回调里：私钥的存活时间就是这个回调的执行时间，
     * 回调一结束立刻清零。父进程从头到尾看不到密钥材料。
     */
    await key.withKey(async (keyHex: string) => {
      const address = deriveAddress(init.family, keyHex)

      // 密钥被换过的检测点 —— 不一致立即中止，不给任何签名机会
      if (address.toLowerCase() !== init.expectedAddress.toLowerCase()) {
        send({
          type: 'error',
          code: 'GPG_ADDRESS_MISMATCH',
          reason: '取到的密钥派生地址与配置声明的不一致，密钥可能已被替换',
          fatal: true,
        })
        exit(2)
      }

      send({ type: 'ready', address })
      await serveSignRequests(keyHex, init.jobTimeoutMs)
    })

    exit(0)
  } catch (error) {
    send({ type: 'error', reason: messageOf(error), fatal: true, code: codeOf(error) })
    exit(1)
  }
}

/** 一直处理 sign 请求，直到父进程说 done 或超时 */
function serveSignRequests(keyHex: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // 二级超时：父进程失联时 worker 也会自己退出，不挂着密钥常驻
    const timer = setTimeout(() => {
      send({ type: 'error', reason: '签名会话超时', fatal: true, code: 'GPG_TIMEOUT' })
      resolve()
    }, timeoutMs)
    timer.unref()

    finish = () => {
      clearTimeout(timer)
      resolve()
    }

    handleSign = (request) => {
      try {
        send({ type: 'signed', id: request.id, signed: signPayload(request.family, keyHex, request.payload) })
      } catch (error) {
        // 单笔签名失败不一定是密钥问题（可能负载有问题），交给父进程判断
        send({ type: 'error', id: request.id, reason: messageOf(error), fatal: false })
      }
    }
  })
}

function exit(code: number): never {
  handleSign = null
  finish = null
  process.exit(code)
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined

// 任何非正常退出路径也要收尾
process.on('uncaughtException', (error) => {
  send({ type: 'error', reason: messageOf(error), fatal: true })
  exit(1)
})
process.on('SIGTERM', () => exit(0))
process.on('SIGINT', () => exit(0))
