# 接入新链

## 情况 ①：加一条新的 EVM 链（Base / Arbitrum / 任意 L2）

**零代码。** 只改 `backend/data/chains.json`：

```jsonc
{
  "key": "base",                      // 唯一标识，同时也是展示名
  "type": "evm",                      // 已注册的链族，直接复用 EVM adapter
  "chainId": 8453,
  "explorer": "https://basescan.org",
  "symbol": "ETH",
  "decimals": 18
}
```

再在 `contracts.json` 里把合约的 `chain` 指向 `"base"`，然后 `POST /api/registry/reload`。
前端侧边栏、列表、multicall、批量执行全部自动生效。

**不用填的三样**：

- **RPC** —— `npm run sync` 会从 Lark / ChainList 补上，写进 `data/rpc.json`
- **`multicall3` 地址** —— 确定性部署，每条链都是同一个地址，写死在代码里。
  没部署的链由运行时发现：调一个没有代码的地址会失败，自动回退并发单点调用
- **`confirmations`** —— 统一等 1 个确认，真正的验证是回执之后再读一次链上状态

> 想给某条链更激进的 gas 策略（出块慢、竞争激烈），在
> `lib/web3/evm/tx.ts` 的 `POLICY_BY_CHAIN_ID` 加一行。目前只有以太坊主网配了。

---

## 情况 ②：加一个新链族（Solana / Aptos / Sui）

实现**一个接口**，改**一行注册表**。services / controllers / routes / 前端一行都不用动。
链族标识是字符串不是枚举，所以连枚举定义都不用改。

### 第 1 步：实现 `ChainAdapter`

新建 `backend/src/lib/web3/solana/`，照抄 `tron/` 的结构：

```
lib/web3/solana/
├── client.ts     连接池 + 地址转换 + 只读调用
├── tx.ts         拼装 + 广播 + 回执解析
└── adapter.ts    把上面拼成 { name, meta, tx }
```

接口全文见 `lib/web3/ChainAdapter.ts`。分两半：

**`meta`（纯函数，不碰网络）**

| 方法 | 说明 |
|------|------|
| `isValidAddress` | 地址是否符合本链族格式（不抛错，用于校验分支） |
| `normalizeAddress` | 归一化为**比较用**形式（EVM 是 checksum，Tron 是 hex41） |
| `displayAddress` | **展示用**形式（Tron 是 base58）。两者绝不混用 |
| `explorerTxUrl` | 拼浏览器链接 |

**`tx`（所有网络 IO）**

| 方法 | 说明 |
|------|------|
| `readBatch` | 批量只读。有原生批量接口就用，没有就受限并发 |
| `simulate` | 链下预演。**不是**安全边界，真正的不变量由合约保证 |
| `getTransaction` | 按 hash 查状态 |
| `executeBatch` | ★ 批量执行，序号 / 加锁 / 并发策略自己决定 |
| `checkBalance?` | 可选。不适用的链族（如 Tron 用能量模型）不实现，上层自动跳过 |
| `checkHealth` | 逐个 RPC 探测（不走 fallback，否则测不出单点故障） |
| `reset` | 热重载时清连接缓存 |

`executeBatch` 内部复用 `lib/web3/runner.ts` 的 `runBatch`，只需提供一个 `BatchStrategy`：

```ts
const strategy: BatchStrategy = {
  simulate:  (item) => ...,          // 会不会 revert
  build:     (item) => ...,          // 拼出待签名负载；会过期的链必须现场构建
  broadcast: (signed) => ...,        // 发出去，返回 hash
  settle:    (item, hash) => ...,    // 等终态；内部可重发，所以返回最终 hash
}
return runBatch(items, sign, strategy, hooks, options)
```

这样这些**规则**你不用重写：预演失败跳过、单笔失败不中断整批、
签名失败整批中止**但已广播的必须等到终态再一起汇报**。

> **注意 `BatchStrategy` 里没有「序号」。** nonce 是 EVM 特有的（Tron 靠 ref_block 时间窗，
> Solana 常规交易靠 recent blockhash），整个待在 `evm/nonce.ts` 里。
> EVM 在自己的 `build` 里取号、在自己的 `broadcast` 成功后推进 ——
> 「预演失败不消耗序号」这条也就由构造保证了：`build` 只在预演通过后才被调用。
>
> 不要为了你的链去给公共循环加序号参数。

**三条实现约定**（违反会出安全问题）：

- 签名材料绝不能写进日志、返回值或任何持久状态 —— 一笔已签名的 pause 泄露出去，
  任何人都能事后重放它
- 待签名负载是不透明的，不要为了「统一」把它拍平成 EVM 的形状
- 即使链上没有 nonce 概念，也**必须**对同一地址加锁串行（`serializePerSigner`）——
  并发广播在 Tron 会因 ref_block 相同被判重复交易

### 第 2 步：注册

`backend/src/lib/web3/chains.ts`

```ts
const ADAPTERS = new Map([
  ['evm', evmAdapter],
  ['tron', tronAdapter],
  ['solana', solanaAdapter],   // ← 加这一行
])
```

### 第 3 步：签名

`backend/src/lib/keys/worker.ts` 里按链族加一个签名分支（Solana 是 ED25519）。

### 第 4 步（可选）：前端

**读状态**：`frontend/src/chain/multicall.ts` 的 `READERS` 加一行。不加的话状态显示「未知」。

**钱包**：`frontend/src/chain/wallet.ts` 的 `DISCOVERY` 加一行 + `FAMILIES` 加一项
（`signsIn: false`，登录只认 EVM）。只用 GPG 模式的话这步可以跳过。

### 完成

启动时 `assertRegistered()` 会校验 `chains.json` 里出现的每个 `type` 都已注册，
漏了**直接起不来** —— 不会等到运行时才发现。
