# 接入新链

## 情况 ①：加一条新的 EVM 链（Base / Arbitrum / 任意 L2）

**零代码。** 只改 `backend/data/chains.json`：

```jsonc
{
  "key": "base",
  "name": "Base",
  "type": "evm",                    // 已注册的链族，直接复用 EVM adapter
  "chainId": 8453,
  "explorer": "https://basescan.org",
  "confirmations": 3,
  "symbol": "ETH",
  "decimals": 18,
  "rpcs": ["https://mainnet.base.org"],
  "multicall3": "0xcA11bde05977b3631167028862bE2a173976CA11"
}
```

再在 `contracts.json` 里把合约的 `chain` 指向 `"base"`，`POST /api/registry/reload`。
前端侧边栏、列表、multicall、批量执行全部自动生效。

> `multicall3` 填 `null` 也能用，只是前端会退回并发单点调用，慢一些。
> RPC 写成 `"${BASE_PRIVATE_RPC}"` 就会被识别为私有：只在后端使用，不下发前端。

---

## 情况 ②：加一个新链族（Solana / Aptos / Sui）

实现**一个接口**，改**一行注册表**。services / controllers / routes / 前端一行都不用动。
链族标识是字符串不是枚举，所以连枚举定义都不用改。

### 第 1 步：实现 `ChainAdapter`

新建 `backend/src/web3/solana/`，照抄 `tron/` 的结构（两个文件）：

```
web3/solana/
├── client.ts     连接池 + 只读 + 拼装 + 广播 + 回执解析
└── adapter.ts    把上面拼成 { name, meta, tx }
```

接口全文见 `backend/src/web3/types.ts`。分两半：

**`meta`（纯函数，不碰网络）**

| 方法 | 说明 |
|------|------|
| `capabilities` | `{ feeModel, walletKinds }`，下发前端决定显示 gas 还是 energy、连哪种钱包 |
| `isValidAddress` | 地址是否符合本链族格式 |
| `normalizeAddress` | 归一化为**比较用**形式（Tron 是 hex41） |
| `displayAddress` | **展示用**形式（Tron 是 base58）。两者绝不混用 |
| `explorerTxUrl` | 拼浏览器链接 |

**`tx`（所有网络 IO）**

| 方法 | 说明 |
|------|------|
| `readBatch` | 批量只读。有原生批量接口就用，没有就受限并发 |
| `simulate` | 链下预演。**不是**安全边界，真正的不变量由合约保证 |
| `getTransaction` | 按 hash 查状态 |
| `executeBatch` | ★ 批量执行，序号/加锁/并发策略自己决定 |
| `checkHealth` | 逐个 RPC 探测（不走 fallback，否则测不出单点故障） |
| `reset` | 热重载时清连接缓存 |

`executeBatch` 内部复用 `web3/executor/runner.ts` 的 `runBatch`，只需提供一个 `BatchStrategy`：

```ts
const strategy: BatchStrategy = {
  nextSequence: () => recentBlockhash ? undefined : nonce,  // 无序号模型返回 undefined
  commitSequence: () => { /* 节点接受后才推进 */ },
  simulate:  (item) => ...,
  build:     (item, seq) => ...,   // 会过期的链必须现场构建
  broadcast: (signed) => ...,
  settle:    (item, hash, seq) => ...,
}
return runBatch(items, sign, strategy, hooks, options)
```

这样"预演失败不消耗序号、单笔失败不中断整批、签名失败整批中止"这些规则你不用重写。

**三条实现约定**（违反会出安全问题）：
- 签名材料绝不能写进日志、返回值或任何持久状态
- 待签名负载是不透明的，不要为了"统一"把它拍平成 EVM 的形状
- 即使链上没有 nonce 概念，也必须对同一地址加锁串行 —— 并发广播在 Tron 会被判重复

### 第 2 步：注册

`backend/src/web3/chains.ts`
```ts
const ADAPTERS = new Map([
  ['evm', evmAdapter],
  ['tron', tronAdapter],
  ['solana', solanaAdapter],   // ← 加这一行
])
```

### 第 3 步：签名

`backend/src/workers/gpgSigner.worker.ts` 的 `signPayload` 里按 `SignatureScheme` 加一个分支
（Solana 是 `ED25519`）。

### 第 4 步（可选）：前端钱包

`frontend/src/chain/wallet.ts` 的 `ADAPTERS` 加一个实现（Phantom 等），钱包模式才需要。
只用 GPG 模式的话这步可以跳过。

### 完成

启动时 `assertRegistered()` 会校验 `chains.json` 里出现的每个 `type` 都已注册，漏了直接起不来。
