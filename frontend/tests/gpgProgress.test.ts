import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import GpgProgress from '../src/components/GpgProgress.vue'
import { useStore } from '../src/store'
import type { ExecutionEvent, Registry } from '../src/types'

/**
 * 弹窗的「交易结果」tab。
 *
 * 这里的逻辑是把一条时间线**折叠成一个合约一行**，最容易错的是折叠规则：
 * 终态（已确认/失败/跳过）一旦拿到就不能再被后来的过程事件盖掉，
 * 否则一笔已确认的交易会显示成"签名中"，运维会以为还没发出去而重复操作。
 */
vi.mock('../src/store/api', () => ({
  syncRegistry: vi.fn(),
  getRegistry: vi.fn(),
  getLogs: vi.fn(),
  getStates: vi.fn(),
  setToken: vi.fn(),
  login: vi.fn(),
  randomNonce: () => 'n',
  buildLoginMessage: () => 'm',
  runBatch: vi.fn(),
  cancelBatch: vi.fn(),
  postLog: vi.fn(),
}))
vi.mock('../src/chain/multicall', () => ({ readStates: vi.fn() }))
vi.mock('../src/chain/wallet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/chain/wallet')>()), walletFor: vi.fn() }))

const REGISTRY = {
  configVersion: 'v1',
  businessLines: [{ id: 'pay', name: '支付' }],
  chains: [],
  contracts: [
    { id: 'a', name: '收款合约', businessLine: 'pay', chain: 'morph', address: '0xa' },
    { id: 'b', name: '结算合约', businessLine: 'pay', chain: 'tron', address: 'Tb' },
  ],
  signers: [],
  operations: [],
} as unknown as Registry

/** events 是倒序存的（新的在前），这里按真实顺序传入自动反转 */
function mountWith(events: ExecutionEvent[]) {
  const store = useStore()
  store.registry = REGISTRY
  store.mode = 'gpg'
  store.events = [...events].reverse()
  return mount(GpgProgress, { global: { plugins: [ElementPlus] } })
}

const rowsOf = (wrapper: ReturnType<typeof mountWith>) =>
  (wrapper.vm as unknown as { rows: { name: string; phase: string; message: string; hash?: string }[] }).rows

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('交易结果折叠', () => {
  it('一个合约一行，取它的终态', () => {
    const wrapper = mountWith([
      { phase: 'sign', at: 1, contractId: 'a', message: '已签名' },
      { phase: 'broadcast', at: 2, contractId: 'a', message: '已广播', hash: '0xh' },
      { phase: 'confirmed', at: 3, contractId: 'a', message: '已确认', hash: '0xh' },
    ])

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: '收款合约', phase: 'confirmed', hash: '0xh' })
  })

  it('★ 终态不能被后来的过程事件盖掉', () => {
    // 多链并行时，别的链的过程事件会晚于这条链的终态到达
    const wrapper = mountWith([
      { phase: 'confirmed', at: 1, contractId: 'a', message: '已确认', hash: '0xh' },
      { phase: 'sign', at: 2, contractId: 'a', message: '已签名' },
    ])

    expect(rowsOf(wrapper)[0]?.phase).toBe('confirmed')
  })

  it('还没有终态时显示当前进行到哪一步', () => {
    const wrapper = mountWith([
      { phase: 'decrypt', at: 1, contractId: 'a', message: '解密中' },
      { phase: 'sign', at: 2, contractId: 'a', message: '已签名' },
    ])

    expect(rowsOf(wrapper)[0]?.phase).toBe('sign')
  })

  it('多个合约各占一行，互不干扰', () => {
    const wrapper = mountWith([
      { phase: 'confirmed', at: 1, contractId: 'a', message: '已确认', hash: '0x1' },
      { phase: 'failed', at: 2, contractId: 'b', message: '预演失败' },
    ])

    const rows = rowsOf(wrapper)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.phase).sort()).toEqual(['confirmed', 'failed'])
  })

  it('没有 contractId 的全局事件（开始/完成）不进结果表', () => {
    const wrapper = mountWith([
      { phase: 'start', at: 1, message: '开始批量暂停' },
      { phase: 'confirmed', at: 2, contractId: 'a', message: '已确认', hash: '0x1' },
      { phase: 'done', at: 3, message: '完成' },
    ])

    expect(rowsOf(wrapper)).toHaveLength(1)
  })

  it('合约名已经单独一列了，消息里重复的前缀要去掉', () => {
    const wrapper = mountWith([
      { phase: 'skip', at: 1, contractId: 'a', message: '收款合约：合约已处于暂停状态' },
    ])

    expect(rowsOf(wrapper)[0]?.message).toBe('合约已处于暂停状态')
  })

  it('★ 关闭时清干净：失败横幅不能带到下一轮', () => {
    const wrapper = mountWith([
      { phase: 'failed', at: 1, contractId: 'a', message: '预演失败' },
    ])
    const store = useStore()
    store.failure = { message: '没检测到 YubiKey', code: 'CARD_ABSENT' }

    ;(wrapper.vm as unknown as { close: () => void }).close()

    expect(store.events).toEqual([])
    expect(store.failure).toBeNull()
  })

  it('配置里找不到的合约用 id 兜底，不能显示成空白', () => {
    const wrapper = mountWith([
      { phase: 'failed', at: 1, contractId: 'ghost', chainKey: 'morph', message: '合约不存在' },
    ])

    expect(rowsOf(wrapper)[0]).toMatchObject({ name: 'ghost', message: '合约不存在' })
  })
})
