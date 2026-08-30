/**
 * 集合小工具。不含任何领域知识 —— 和 net.ts 一样，是"换个项目也能用"的那类。
 */

/**
 * 按 key 分桶。
 *
 * 这个项目里到处要按链分组：建业务线索引、执行编排按链并行发交易、
 * 状态读取按链批量 eth_call。三处用的是同一个动作，没必要各写一遍。
 */
export function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const bucket = map.get(key)
    if (bucket) bucket.push(item)
    else map.set(key, [item])
  }
  return map
}
