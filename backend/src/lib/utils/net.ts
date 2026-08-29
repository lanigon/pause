/**
 * 网络相关的小工具。不涉及任何链族 ——
 * 放这里是因为 EVM 和 Tron 都要用，而 Tron 不该反过来 import EVM 的模块。
 */

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ])
}

/** 带 apiKey 的 RPC 只暴露 host，不泄露完整 URL */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '[invalid-url]'
  }
}

/**
 * 去掉末尾斜杠。explorer 配成 "https://scan.io/" 时拼出来是双斜杠，部分浏览器直接 404。
 * EVM 拼 /tx/、Tron 拼 /transaction/，路径不同但这条规则是同一条，各写一份迟早分叉。
 */
export const trimSlash = (url: string): string => url.replace(/\/$/, '')
