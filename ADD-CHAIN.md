# 接入一条新链

两种情况，代价差很远，先分清楚你要做哪种。

## 情况一：新的 EVM 链（Base / Arbitrum / 任意 L2）

**零代码。** 在 `backend/data/chains.json` 加一行，再跑一次 `npm run sync` 补 RPC：

```json
{ "key": "base", "type": "evm", "chainId": 8453,
  "explorer": "https://basescan.org", "symbol": "ETH", "decimals": 18 }
```

`type` 填 `evm` 就复用了全部现成实现。两处可选的微调：

| 想要什么 | 改哪 | 不改会怎样 |
|---|---|---|
| 走 Alchemy 的 RPC | `backend/src/lib/rpc/endpoint.ts` 的 `NETWORK_BY_CHAIN_ID` 加一行 | 降级到 ChainList 的公开节点，能用但质量参差 |
| 自定 gas 阶梯 | `backend/src/lib/web3/evm/tx.ts` 的 `POLICY_BY_CHAIN_ID` 加一行 | 用默认策略（首发 2 倍、10s 等回执） |

Multicall3 不用配 —— 它是确定性部署，几乎每条 EVM 链都在
`0xcA11bde05977b3631167028862bE2a173976CA11`。没部署的链会在运行时被发现
（调一个没有代码的地址会失败），自动回退到并发单点调用。

---

## 情况二：新的**链族**（Solana / Aptos / Sui）

要写代码，但边界是清楚的：**四个必改点，一个都不能漏**。

前三个漏了会在启动时或调用时明确报错；**第四个漏了不报错，只会静默做错事** ——
这是最需要盯的地方。

### ① 后端：实现 ChainAdapter

新建 `backend/src/lib/web3/solana/`，照 `evm/` 或 `tron/` 的样子写。
契约在 `backend/src/lib/web3/ChainAdapter.ts`，分两半：

**`meta`** —— 纯函数，不碰网络：

```ts
isValidAddress(address)          // 地址格式。这条决定了配置校验能不能拦住手滑
normalizeAddress(address)        // 比较用的形式
displayAddress(address)          // 展示用的形式（Tron 这两者不同：hex41 vs base58）
explorerTxUrl(chain, hash)       // 各链路径不一样，拼错了点开是 404
```

**`tx`** —— 所有链上 IO：

```ts
readBatch(chain, calls)          // 批量读。有 multicall 就用，没有就受限并发
simulate(chain, request)         // 预演。失败的合约会被跳过且不消耗序号
executeBatch(chain, items, ...)  // 批量执行，见下
checkHealth(chain, timeoutMs)    // 逐个 RPC 探活，不要只探第一个
reset()                          // 丢掉缓存的连接
```

`executeBatch` 的公共循环已经写好了（`lib/web3/runner.ts` 的 `runBatch`），
你只要提供四个方法：`simulate` / `build` / `broadcast` / `settle`。
循环本身负责那些**不变量**：单笔失败不中断整批、签名失败整批中止并结算已广播的。

开头两行是所有链族共用的前置：

```ts
const from = requireSingleSigner(items, normalizeAddress)
return serializePerSigner(chain.key, from, async () => { /* … */ })
```

> **nonce 不是通用概念，不用管它。**
> EVM 有数字 nonce（严格递增、不能留洞），Tron 靠 ref_block + expiration 的时间窗，
> Solana 常规交易用 recent blockhash。runner 里**没有序号这个概念** ——
> EVM 是在自己的 `build` 里取号、`broadcast` 成功后推进（见 `evm/nonce.ts`）。
> 你的链族按自己的模型来，不需要向任何接口交代。

### ② 后端：注册一行

`backend/src/lib/web3/chains.ts`：

```ts
const ADAPTERS = new Map([
  ['evm', evmAdapter],
  ['tron', tronAdapter],
  ['solana', solanaAdapter],   // ← 加这行
])
```

漏了会怎样：启动时 `assertRegistered` 直接拦下来，服务起不来。**这是好事**，
比运行时才发现没有 adapter 强。

### ③ 后端：签名子进程

`backend/src/lib/keys/worker.ts` 里**两个** switch 都要加分支：

```ts
signPayload(family, keyHex, payload)   // 怎么签
deriveAddress(family, keyHex)          // 怎么从私钥派生地址
```

两个都有 `default: throw`，漏了会报出明确的错。

> 曾经 `deriveAddress` 没有 default，任何非 EVM 链族都会静默派生出一个
> **Tron 地址**，然后在地址比对处失败，报的是"密钥可能已被替换"——
> 一个安全告警，指向完全错误的方向。现在两个都穷举了。

### ④ 前端：新建目录 + 注册一行

新建 `frontend/src/chain/solana/`，实现 `frontend/src/chain/types.ts` 里的契约：

```ts
discover(): Promise<readonly WalletAdapter[]>   // 这个链族装了哪些钱包
readState(chain, contracts)                     // 读链上状态
explorerTxUrl / explorerAddressUrl              // 浏览器链接
```

然后在 `frontend/src/chain/index.ts` 的 `FAMILY_LIST` 里加一项。
**组件、store、api 一行都不用改。**

⚠️ **这一步漏了不会报错**，只会静默做错事 —— 所以有专门的测试盯着
（`frontend/tests/newFamily.test.ts`）：

- 未注册的链族读状态返回空，**绝不拿 EVM 的 multicall 去打一条异构链**
- 浏览器链接返回 `#` 而不是瞎猜路径
- 找钱包返回空列表，界面显示"没有检测到钱包"，不抛错

---

## 还需要配的两样

**密钥**（GPG 模式要用）：

```bash
npm run keys encrypt      # 生成 secrets/solana.key.gpg 与 secrets/solana.address
```

有哪个 `<链族>.key.gpg` 就有哪个链族的密钥，不用配表。
`.address` 是防掉包的控制点 —— 解密后派生的地址必须和它一致。

**合约**：`backend/data/contracts.json` 里 `chain` 填新链的 key。
地址格式由 `meta.isValidAddress` 按链校验，配错了启动就报错。

---

## 做完自查

```bash
cd backend  && npx tsc --noEmit && npx vitest run
cd frontend && npx vue-tsc --noEmit && npx vitest run
npm run check                # 环境、密钥、数据、RPC 一起过一遍
```

再跑一次 `frontend/tests/newFamily.test.ts` 和 `backend/tests/newFamily.test.ts` ——
它们专门锁那些"漏了不报错"的地方。
