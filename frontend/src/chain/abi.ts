/**
 * 平台用到的全部合约方法。
 *
 * 只有这几个 —— 平台只做 pause / unpause，这些方法在所有 Pausable 合约上都一样，
 * 所以配置里不用给每个合约配 ABI，只要写"业务线、链、地址"。
 *
 * 两处在用：multicall 读状态、钱包模式编码交易。共用一份，
 * 免得改了一处漏另一处（之前钱包那边压根没有 pause，EVM 钱包模式一直是坏的）。
 */
export const PAUSABLE_ABI = [
  'function paused() view returns (bool)',
  'function pause()',
  'function unpause()',
]

/**
 * 这份 ABI 能编码哪些方法 —— **从 ABI 自己推导**，不另写一份清单，
 * 否则又是一处会漂移的重复。
 *
 * 为什么需要它：操作按钮是**后端下发**的（/registry 的 operations），
 * 而这份 ABI 是前端写死的。后端加一种操作，按钮会自动出现，
 * 但钱包模式走到编码这一步才会发现前端根本不认识它。
 *
 * GPG 模式不受影响 —— 那边由后端编码，前端只传操作名。
 */
const ENCODABLE: ReadonlySet<string> = new Set(
  PAUSABLE_ABI.map((signature) => /function\s+(\w+)/.exec(signature)?.[1]).filter(
    (name): name is string => name !== undefined,
  ),
)

export const canEncode = (method: string): boolean => ENCODABLE.has(method)

/**
 * 只读的权限查询。**和 PAUSABLE_ABI 分开**：
 * canEncode 是从 PAUSABLE_ABI 推导的，用来拦「后端下发了前端编码不了的操作」。
 * 把这两个 view 方法混进去，canEncode('getOperators') 会返回 true —— 那是错的，
 * 它们不是可执行的操作，前端永远不该给它们发交易。
 */
export const OPERATORS_ABI = [
  'function getOperators(uint256 offset, uint256 limit) view returns (address[])',
  'function isOperator(address account) view returns (bool)',
]

/**
 * 一次读回多少个 operator。
 *
 * 合约端是分页接口，没有总数可问，所以靠「返回条数是否等于 limit」判断有没有下一页。
 * 取 50 是因为运维要看的是「谁能动这个合约」，几十个已经足够判断；
 * 真有上百个 operator 的合约，界面上列全了也没人看得过来，标一句"还有更多"更有用。
 */
export const OPERATOR_PAGE = 50

/**
 * 一个 32 字节的字里是不是干净的 0 或 1。
 *
 * 两个链族都要这道守卫：合约地址误配成预编译地址时，它对任意调用都返回哈希，
 * 长度对但值不是 0/1，解出来就成了"已暂停"，紧急暂停会被静默跳过。
 */
export const isBoolWord = (data: string): boolean => /^0{63}[01]$/.test(data.replace(/^0x/, ''))
