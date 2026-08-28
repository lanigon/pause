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
