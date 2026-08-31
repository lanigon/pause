import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { WalletAdapter } from '../src/chain'
import type { Registry } from '../src/types'

/**
 * 登录会话与账户变更监听。
 *
 * 这里锁的是一条"不会报错、只会静默做错事"的：账户变更监听只加不减。
 * 退出登录后监听器还活着的话，用户在 MetaMask 里换个账号，回调照样把
 * connected.evm 写成新地址 —— 顶栏绿着显示「已连接」，实际没有 operator，
 * 点什么都不动。紧急暂停时这几秒的困惑代价很大。
 */
const REGISTRY: Registry = {
  configVersion: 'v1',
  businessLines: [{ id: 'pay', name: '支付' }],
  chains: [],
  contracts: [],
  signers: [],
  operations: [],
}

vi.mock('../src/store/api', () => ({
  syncRegistry: vi.fn(async () => ({ ...REGISTRY, synced: { changed: false, fromLark: true } })),
  getRegistry: vi.fn(async () => REGISTRY),
  getLogs: vi.fn(async () => ({ items: [] })),
  setToken: vi.fn(),
  login: vi.fn(async () => ({
    accessToken: 't',
    expiresIn: 60,
    operator: { address: '0xme', label: '我', role: 'admin' },
  })),
  randomNonce: () => 'n',
  buildLoginMessage: () => 'm',
  runBatch: vi.fn(),
  cancelBatch: vi.fn(),
  postLog: vi.fn(),
}))


/**
 * 模拟一个真钱包：解绑之后就不再回调。
 * 这正是 provider.removeListener 的语义，测的就是我们有没有去调它。
 */
function mockWallet(address: string) {
  const listeners = new Set<(next: string | null) => void>()
  const wallet: WalletAdapter = {
    id: 'mock',
    family: 'evm',
    label: 'Mock',
    isInstalled: () => true,
    connect: async () => address,
    signMessage: async () => '0xsig',
    sendTransaction: async () => '0xhash',
    currentChainId: async () => 1,
    switchChain: async () => undefined,
    onAccountChange(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  /** 用户在钱包里换了账号 */
  const emit = (next: string | null): void => listeners.forEach((l) => l(next))
  return { wallet, listeners, emit }
}

async function store() {
  const { useStore } = await import('../src/store')
  return useStore()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('账户变更监听', () => {
  it('连上之后换账号，顶栏跟着变', async () => {
    const s = await store()
    const { wallet, emit } = mockWallet('0xme')
    await s.connect(wallet)

    emit('0xother')
    expect(s.connected.evm).toBe('0xother')
  })

  it('★ 退出登录要解绑 —— 否则换账号会把顶栏刷成"已连接"，可没有 operator', async () => {
    const s = await store()
    const { wallet, listeners, emit } = mockWallet('0xme')
    await s.connect(wallet)

    s.disconnect()
    expect(listeners.size).toBe(0)

    emit('0xother')
    expect(s.connected.evm).toBeNull()
    expect(s.operator).toBeNull()
  })

  it('★ 重连同一个链族不叠加监听 —— 叠加的话一次换账号会触发好几遍', async () => {
    const s = await store()
    const { wallet, listeners } = mockWallet('0xme')

    await s.connect(wallet)
    await s.connect(wallet)

    expect(listeners.size).toBe(1)
  })

  it('用户在钱包里断开（账号变 null）会走登出，监听一并摘掉', async () => {
    const s = await store()
    const { wallet, listeners, emit } = mockWallet('0xme')
    await s.connect(wallet)
    expect(s.operator).not.toBeNull()

    emit(null)

    expect(s.operator).toBeNull()
    expect(listeners.size).toBe(0)
  })
})
