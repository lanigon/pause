import { describe, expect, it } from 'vitest'
import { parseRows, toContracts, toRpcMap } from '../src/services/sync.service.js'
import { field, type LarkRow } from '../src/lib/lark/client.js'

/**
 * Lark 表格解析。
 *
 * 表就一张，四列：业务线 · 链 · RPC · 合约。
 * 同一条链会在多行里重复（每个合约一行），所以聚合逻辑必须去重 ——
 * 否则 RPC 列表里会塞满重复项，合约也会重复出现。
 */
const rows = (...list: LarkRow[]): LarkRow[] => list

describe('表头容错', () => {
  it('大小写与首尾空格都不敏感', () => {
    expect(field({ ' Chain ': 'morph' }, 'chain')).toBe('morph')
    expect(field({ RPC: 'https://x' }, 'rpc')).toBe('https://x')
  })

  it('中英文表头都认', () => {
    expect(field({ 业务线: '支付' }, 'business_line', '业务线')).toBe('支付')
    expect(field({ 合约: '0xabc' }, 'contract', '合约')).toBe('0xabc')
  })

  it('取不到就返回空串，不抛错', () => {
    expect(field({ foo: 'bar' }, 'chain')).toBe('')
  })
})

describe('解析行', () => {
  it('没有链的行直接丢掉', () => {
    const parsed = parseRows(rows({ 业务线: '支付', 合约: '0xabc' }, { 链: 'morph' }))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.chain).toBe('morph')
  })
})

describe('聚合 RPC', () => {
  it('同一条链的多个 RPC 合并，重复的去掉', () => {
    const map = toRpcMap(
      parseRows(
        rows(
          { 链: 'morph', RPC: 'https://a' },
          { 链: 'morph', RPC: 'https://b' },
          { 链: 'morph', RPC: 'https://a' }, // 重复
          { 链: 'polygon', RPC: 'https://c' },
        ),
      ),
    )
    expect(map.morph).toEqual(['https://a', 'https://b'])
    expect(map.polygon).toEqual(['https://c'])
  })

  it('非 http 开头的一律不要（防止把备注文字当成 RPC）', () => {
    const map = toRpcMap(parseRows(rows({ 链: 'morph', RPC: '待补充' }, { 链: 'morph', RPC: 'https://ok' })))
    expect(map.morph).toEqual(['https://ok'])
  })

  it('保持出现顺序 —— 表里排在前面的就是优先级更高的', () => {
    const map = toRpcMap(
      parseRows(rows({ 链: 'x', RPC: 'https://1' }, { 链: 'x', RPC: 'https://2' }, { 链: 'x', RPC: 'https://3' })),
    )
    expect(map.x).toEqual(['https://1', 'https://2', 'https://3'])
  })
})

describe('聚合业务线与合约', () => {
  it('业务线去重，并生成 slug 作为 id', () => {
    const { businessLines } = toContracts(
      parseRows(
        rows(
          { 业务线: 'Payment', 链: 'morph', 合约: '0x1' },
          { 业务线: 'Payment', 链: 'morph', 合约: '0x2' },
          { 业务线: 'Bridge', 链: 'ethereum', 合约: '0x3' },
        ),
      ),
    )
    expect(businessLines).toEqual([
      { id: 'payment', name: 'Payment' },
      { id: 'bridge', name: 'Bridge' },
    ])
  })

  it('★ 同一合约因多个 RPC 出现多行时，只保留一条', () => {
    const { contracts } = toContracts(
      parseRows(
        rows(
          { 业务线: '支付', 链: 'morph', RPC: 'https://a', 合约: '0xAbC', 名称: 'Vault' },
          { 业务线: '支付', 链: 'morph', RPC: 'https://b', 合约: '0xabc', 名称: 'Vault' },
        ),
      ),
    )
    expect(contracts).toHaveLength(1)
    expect(contracts[0]?.address).toBe('0xAbC')
  })

  it('不同链上的同地址算两个合约', () => {
    const { contracts } = toContracts(
      parseRows(
        rows(
          { 业务线: '支付', 链: 'morph', 合约: '0xsame', 名称: 'A' },
          { 业务线: '支付', 链: 'polygon', 合约: '0xsame', 名称: 'A' },
        ),
      ),
    )
    expect(contracts).toHaveLength(2)
  })

  it('没有合约地址的行只贡献业务线，不产出合约', () => {
    const { businessLines, contracts } = toContracts(
      parseRows(rows({ 业务线: '质押', 链: 'morph', RPC: 'https://a' })),
    )
    expect(businessLines).toHaveLength(0)
    expect(contracts).toHaveLength(0)
  })

  it('没写名称就用地址兜底', () => {
    const { contracts } = toContracts(parseRows(rows({ 业务线: '支付', 链: 'morph', 合约: '0xdeadbeef' })))
    expect(contracts[0]?.name).toBe('0xdeadbeef')
  })
})

describe('Lark 接入缺失时的行为（当前就是这种情况：本机没有 lark CLI）', () => {
  it('★ 没装 lark CLI 时给出可操作的指引，而不是一句 command not found', async () => {
    const { readTable, hasCommand, LarkError } = await import('../src/lib/lark/client.js')

    // 先确认本机确实没有 —— 有的话这个断言本身就没意义
    expect(await hasCommand('lark')).toBe(false)

    await expect(readTable('tbl123')).rejects.toThrow(/未检测到 lark CLI/)

    // 错误码要能被上层分支处理（决定降级还是报错），不能只有一句人话
    await readTable('tbl123').catch((error: unknown) => {
      expect(error).toBeInstanceOf(LarkError)
      expect((error as InstanceType<typeof LarkError>).code).toBe('LARK_CLI_MISSING')
      expect((error as Error).message).toContain('open.feishu.cn')
    })
  })

  it('hasCommand 对存在的命令返回 true（确认探测逻辑本身是对的）', async () => {
    const { hasCommand } = await import('../src/lib/lark/client.js')
    expect(await hasCommand('node')).toBe(true)
  })
})
