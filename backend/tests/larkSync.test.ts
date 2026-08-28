import { describe, expect, it } from 'vitest'
import { parseRows, toContracts } from '../src/services/sync.service.js'
import { field, type LarkRow } from '../src/lib/lark/client.js'
import type { Chain } from '../src/models/chain.model.js'

/**
 * Lark 表格解析。
 *
 * 表就一张，四列：**业务线 · 链 · chainId · 合约地址**。
 *
 * chainId 是链的真身份 —— B 列的「链」是给人看的标签，会写成各种样子，
 * 定位到哪条链一律以 chainId 为准。解析不了的行跳过并报告，
 * 不能拖垮整次同步（50 行错 1 行，另外 49 个合约照样该更新）。
 */
const rows = (...list: LarkRow[]): LarkRow[] => list

const CHAINS = [
  { key: 'morph', name: 'Morph Mainnet', type: 'evm', chainId: 2818 },
  { key: 'ethereum', name: 'Ethereum', type: 'evm', chainId: 1 },
  { key: 'polygon', name: 'Polygon', type: 'evm', chainId: 137 },
] as unknown as Chain[]

const parse = (...list: LarkRow[]) => toContracts(parseRows(list), undefined, CHAINS)

describe('表头容错', () => {
  it('大小写与首尾空格都不敏感', () => {
    expect(field({ ' Chain ': 'morph' }, 'chain')).toBe('morph')
    expect(field({ RPC: 'https://x' }, 'rpc')).toBe('https://x')
  })

  it('中英文表头都认', () => {
    expect(field({ 业务线: '支付' }, 'business_line', '业务线')).toBe('支付')
    expect(field({ 合约: '0xabc' }, 'contract', '合约')).toBe('0xabc')
  })

  it('下划线、连字符、内部空格都不影响匹配', () => {
    expect(field({ 'chain id': '1' }, 'chainId')).toBe('1')
    expect(field({ chain_id: '1' }, 'chainId')).toBe('1')
    expect(field({ 'Chain-ID': '1' }, 'chainId')).toBe('1')
  })

  it('一行里有多个别名时，按调用方给的优先级取', () => {
    expect(field({ address: '0xB', 合约: '0xA' }, '合约', 'address')).toBe('0xA')
    expect(field({ address: '0xB', 合约: '0xA' }, 'address', '合约')).toBe('0xB')
  })

  it('取不到就返回空串，不抛错', () => {
    expect(field({ foo: 'bar' }, 'chain')).toBe('')
  })
})

describe('解析行', () => {
  it('链名和 chainId 都没有的行直接丢掉', () => {
    const parsed = parseRows(rows({ 业务线: '支付', 合约: '0xabc' }, { 链: 'morph' }))
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.chain).toBe('morph')
  })

  it('chainId 列认多种写法，并转成数字', () => {
    expect(parseRows(rows({ chainId: '2818', 链: 'morph' }))[0]?.chainId).toBe(2818)
    expect(parseRows(rows({ 'chain id': '2818', 链: 'morph' }))[0]?.chainId).toBe(2818)
    expect(parseRows(rows({ 链id: '2818', 链: 'morph' }))[0]?.chainId).toBe(2818)
  })

  it('表格里的数字常带逗号或空格，要能吃掉', () => {
    expect(parseRows(rows({ chainId: '728,126,428', 链: 'tron' }))[0]?.chainId).toBe(728126428)
    expect(parseRows(rows({ chainId: ' 137 ', 链: 'polygon' }))[0]?.chainId).toBe(137)
  })

  it('chainId 不是正整数就当没填，退回按链名匹配', () => {
    expect(parseRows(rows({ chainId: 'N/A', 链: 'morph' }))[0]?.chainId).toBeNull()
    expect(parseRows(rows({ chainId: '0', 链: 'morph' }))[0]?.chainId).toBeNull()
    expect(parseRows(rows({ chainId: '2.5', 链: 'morph' }))[0]?.chainId).toBeNull()
  })
})

describe('按 chainId 定位链', () => {
  it('★ chainId 说了算 —— B 列的链名写成什么样都不影响', () => {
    // 「Morph 主网」不是 chains.json 里的 key 也不是 name，但 chainId 对
    const { contracts } = parse({ 业务线: '支付', 链: 'Morph 主网', chainId: '2818', 合约: '0xa' })
    expect(contracts[0]?.chain).toBe('morph')
  })

  it('★ chainId 在 chains.json 里没有时跳过该行，并说清要先补链定义', () => {
    const { contracts, skipped } = parse({ 业务线: '支付', 链: 'Base', chainId: '8453', 合约: '0xa', 名称: 'Vault' })
    expect(contracts).toHaveLength(0)
    expect(skipped[0]).toContain('chainId 8453')
    expect(skipped[0]).toContain('先补上链定义')
  })

  it('★ 一行坏不能拖垮其余的 —— 好行照常同步', () => {
    const { contracts, skipped } = parse(
      { 业务线: '支付', 链: 'morph', chainId: '2818', 合约: '0xa', 名称: 'A' },
      { 业务线: '支付', 链: 'Base', chainId: '8453', 合约: '0xb', 名称: 'B' },
      { 业务线: '支付', 链: 'ethereum', chainId: '1', 合约: '0xc', 名称: 'C' },
    )
    expect(contracts.map((c) => c.name)).toEqual(['A', 'C'])
    expect(skipped).toHaveLength(1)
  })

  it('没填 chainId 时退回按链名匹配，key 和显示名都认', () => {
    expect(parse({ 业务线: '支付', 链: 'morph', 合约: '0xa' }).contracts[0]?.chain).toBe('morph')
    expect(parse({ 业务线: '支付', 链: 'Morph Mainnet', 合约: '0xa' }).contracts[0]?.chain).toBe('morph')
  })

  it('既没 chainId 也匹配不上链名时跳过，并说清两条路', () => {
    const { skipped } = parse({ 业务线: '支付', 链: '某条新链', 合约: '0xa', 名称: 'X' })
    expect(skipped[0]).toContain('没填 chainId')
    expect(skipped[0]).toContain('某条新链')
  })

  it('跳过的行要指名道姓，否则运维不知道去改哪一行', () => {
    const { skipped } = parse({ 业务线: '支付', 链: 'Base', chainId: '8453', 合约: '0xa', 名称: 'Bridge Vault' })
    expect(skipped[0]).toContain('Bridge Vault')
  })
})

describe('聚合业务线与合约', () => {
  it('业务线去重，并生成 slug 作为 id', () => {
    const { businessLines } = parse(
      { 业务线: 'Payment', 链: 'morph', 合约: '0x1' },
      { 业务线: 'Payment', 链: 'morph', 合约: '0x2' },
      { 业务线: 'Bridge', 链: 'ethereum', 合约: '0x3' },
    )
    expect(businessLines).toEqual([
      { id: 'payment', name: 'Payment' },
      { id: 'bridge', name: 'Bridge' },
    ])
  })

  it('★ 同一合约重复出现时只保留一条，大小写不同也算同一个', () => {
    const { contracts } = parse(
      { 业务线: '支付', 链: 'morph', chainId: '2818', 合约: '0xAbC', 名称: 'Vault' },
      { 业务线: '支付', 链: 'Morph 主网', chainId: '2818', 合约: '0xabc', 名称: 'Vault' },
    )
    expect(contracts).toHaveLength(1)
    expect(contracts[0]?.address).toBe('0xAbC')
  })

  it('不同链上的同地址算两个合约', () => {
    const { contracts } = parse(
      { 业务线: '支付', 链: 'morph', chainId: '2818', 合约: '0xsame', 名称: 'A' },
      { 业务线: '支付', 链: 'polygon', chainId: '137', 合约: '0xsame', 名称: 'A' },
    )
    expect(contracts).toHaveLength(2)
  })

  it('没有合约地址的行只贡献业务线，不产出合约', () => {
    const { businessLines, contracts } = parse({ 业务线: '质押', 链: 'morph', chainId: '2818' })
    expect(businessLines).toHaveLength(0)
    expect(contracts).toHaveLength(0)
  })

  it('没写名称就用地址兜底', () => {
    const { contracts } = parse({ 业务线: '支付', 链: 'morph', 合约: '0xdeadbeef' })
    expect(contracts[0]?.name).toBe('0xdeadbeef')
  })
})

const URL_OK = 'https://demo.feishu.cn/base/AbC123Token?table=tblXYZ789&view=vewABC'

/**
 * 表格链接解析。
 *
 * 配置里只让填一个 URL，所以这层是"配错了会怎样"的唯一防线 ——
 * 报错必须说清楚下一步做什么，否则表现就是"同步不到数据"，没人查得动。
 */
describe('表格链接解析', () => {
  it('从标准 base 链接里解出 appToken / tableId / viewId', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    expect(parseLarkUrl(URL_OK)).toEqual({
      appToken: 'AbC123Token',
      tableId: 'tblXYZ789',
      viewId: 'vewABC',
      isWiki: false,
    })
  })

  it('没有 view 参数也行 —— 不带就是整张表', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    expect(parseLarkUrl('https://x.feishu.cn/base/T1?table=tbl1').viewId).toBeUndefined()
  })

  it('国际版 larksuite.com 和国内版一样认', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    expect(parseLarkUrl('https://x.larksuite.com/base/T1?table=tbl1').appToken).toBe('T1')
  })

  it('知识库托管的表格标出来 —— token 语义不同，出错时提示要不一样', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    const ref = parseLarkUrl('https://x.feishu.cn/wiki/W1?table=tbl1')
    expect(ref).toMatchObject({ appToken: 'W1', tableId: 'tbl1', isWiki: true })
  })

  it('★ 只复制到多维表格首页（没有 ?table=）时，要说清楚该点开具体那张表', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    // 这是最常见的配错方式
    expect(() => parseLarkUrl('https://x.feishu.cn/base/T1')).toThrow(/点开具体的那张表/)
  })

  it('粘了个裸 table id 而不是链接时，直接告诉他要贴地址栏的链接', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    expect(() => parseLarkUrl('tblXYZ789')).toThrow(/复制浏览器地址栏/)
  })

  it('链接对但不是多维表格（没有 /base/ 或 /wiki/）时也要说清楚', async () => {
    const { parseLarkUrl } = await import('../src/lib/lark/client.js')
    expect(() => parseLarkUrl('https://x.feishu.cn/docx/D1')).toThrow(/找不到 \/base\/ 或 \/wiki\//)
  })

  it('空值不当成"配了个坏链接"，报错要分得开', async () => {
    const { parseLarkUrl, LarkError } = await import('../src/lib/lark/client.js')
    try {
      parseLarkUrl('   ')
    } catch (error) {
      expect((error as InstanceType<typeof LarkError>).code).toBe('LARK_BAD_URL')
    }
  })
})

describe('Lark 接入缺失时的行为（当前就是这种情况：本机没有 lark CLI）', () => {
  it('★ 没装 lark CLI 时给出可操作的指引，而不是一句 command not found', async () => {
    const { readTable, hasCommand, LarkError } = await import('../src/lib/lark/client.js')

    // 先确认本机确实没有 —— 有的话这个断言本身就没意义
    expect(await hasCommand('lark')).toBe(false)

    await expect(readTable(URL_OK)).rejects.toThrow(/未检测到 lark CLI/)

    // 错误码要能被上层分支处理（决定降级还是报错），不能只有一句人话
    await readTable(URL_OK).catch((error: unknown) => {
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
