/**
 * 执行阶段的中文名。**只此一份** ——
 * 以前列表和进度弹窗各写了一份，同一个阶段在两处叫的名字不一样
 * （列表说"预演中"、弹窗说"预演"），运维会以为是两件事；
 * 加一个新阶段还得记着改两个文件，漏一处就露出英文原名。
 *
 * ongoing 是"进行时"的说法，只有列表的状态列用得上 ——
 * 那一格说的是这个合约此刻正卡在哪一步，语气和弹窗里逐条列出的名词不同。
 */
const PHASES: Readonly<Record<string, { label: string; ongoing?: string }>> = {
  start: { label: '开始' },
  decrypt: { label: '解密密钥' },
  simulate: { label: '预演', ongoing: '预演中' },
  balance: { label: '余额' },
  skip: { label: '跳过', ongoing: '已跳过' },
  sign: { label: '签名', ongoing: '签名中' },
  broadcast: { label: '广播', ongoing: '广播中' },
  confirmed: { label: '已确认' },
  failed: { label: '失败' },
  done: { label: '完成' },
  error: { label: '错误' },
}

/** 认不出的阶段直接显示原始值 —— 后端加了新阶段时，界面照样说得出它是什么 */
export const phaseLabel = (phase: string): string => PHASES[phase]?.label ?? phase

/**
 * 列表状态列上的"正在做什么"。
 *
 * 没标 ongoing 的阶段一律显示"处理中"：那一格只需要让人认出这个合约正忙着，
 * 具体到哪一步弹窗里有；硬把名词塞进去会出现"余额""开始"这种读不通的状态。
 */
export const pendingLabel = (phase: string): string => PHASES[phase]?.ongoing ?? '处理中'
