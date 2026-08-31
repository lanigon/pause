# 接一条新链

两种情况，代价差一个数量级，先分清楚要做哪种。

| 情况 | 例子 | 代价 | 风险 |
|---|---|---|---|
| 新的 EVM 链 | Base · Arbitrum · 任意 L2 | 改一行 JSON | 几乎没有，配错了启动就报错 |
| 新的**链族** | Solana · Aptos · Sui | 六个代码改动点 + 三处配置 | 有两处漏了不报错，静默做错事 |

---

## 新的 EVM 链

**零代码。** `backend/data/chains.json` 加一项，再跑一次 `npm run sync` 补 RPC：

```json
{ "key": "base", "type": "evm", "chainId": 8453,
  "explorer": "https://basescan.org", "symbol": "ETH", "decimals": 18 }
```

`type` 填 `evm` 就复用了全部现成实现。两处可选微调：

| 需求 | 改动位置 | 不改的表现 |
|---|---|---|
| 走 Alchemy 的 RPC | `src/lib/rpc/endpoint.ts` 的 `NETWORK_BY_CHAIN_ID` 加一行 | 降级到 ChainList 的公开节点，能用但质量参差 |
| 自定 gas 阶梯 | `src/lib/web3/evm/tx.ts` 的 `POLICY_BY_CHAIN_ID` 加一行 | 用默认策略：首发 2 倍、10s 等回执、最多 4 次 |

Multicall3 不用配 —— 它是确定性部署，几乎每条 EVM 链都在
`0xcA11bde05977b3631167028862bE2a173976CA11`。没部署的链由**运行时**发现
（调一个没有代码的地址会失败），自动回退到并发单点调用。

---

## 新的链族：全部改动点

按「漏了之后有多难发现」从易到难排。

| 类别 | 位置 | 改动内容 | 漏改的表现 |
|---|---|---|---|
| 后端代码 | `src/lib/web3/<族>/` | 实现 `ChainAdapter` | 下一行会拦住 |
| 后端代码 | `src/lib/web3/chains.ts` | `ADAPTERS` 加一行 | **启动直接报错**，服务起不来 |
| 后端代码 | `src/lib/keys/worker.ts` | `signPayload` 与 `deriveAddress` 两个 switch | **明确报错**，两个都有 `default: throw` |
| 后端代码 | `scripts/keys.ts` | `Family` 类型、`FAMILIES`、`deriveAddress` | ★ 见下节，**会报出指向完全错误方向的安全告警** |
| 后端代码 | `scripts/sync.ts` | `probe` 与 `fetchChainlist` 各加一个分支 | 该链**一个可用 RPC 都拿不到**，且理由看起来像节点全挂了 |
| 前端代码 | `src/chain/index.ts` | `FAMILY_LIST` 加一项 | ★ **不报错**，这条链在界面上静默变成一片空白 |
| 配置 | `data/chains.json` | 加链定义 | 合约引用不到链，启动报错 |
| 配置 | `data/rpc.json` | 手填 lark 段应急 | 同上，没有可用 RPC。且下次 `npm run sync` 会把手填的探活判死后删掉 |
| 配置 | `secrets/` | `<族>.key.gpg` + `<族>.address` | GPG 模式整批拒绝执行 |

`scripts/check.ts` **不用改** —— 它按 `GpgKey.available()` 扫 `secrets/` 目录，
本来就是链族无关的。

---

## 后端：实现 ChainAdapter

新建 `backend/src/lib/web3/solana/`，照 `evm/` 或 `tron/` 的样子写。
契约在 `src/lib/web3/ChainAdapter.ts`，分两半。

### meta：纯函数，不碰网络

| 方法 | 职责 | 做错的表现 |
|---|---|---|
| `isValidAddress` | 地址格式判断，不抛错 | 配置校验拦不住手滑，Tron 地址配到 EVM 链上也放行 |
| `normalizeAddress` | **比较用**形式 | 拿 EVM checksum 去比 Tron 地址会误判 |
| `displayAddress` | **展示用**形式 | Tron 这两者不同：hex41 vs base58 |
| `explorerTxUrl` | 浏览器链接 | 各链路径不一样，拼错了点开是 404 |

之所以要求纯函数：校验配置、拼审计信息、格式化日志都要用地址逻辑，
不该为此起一个节点连接，单测也不用 mock 网络。

### tx：所有网络 IO

| 方法 | 说明 |
|---|---|
| `readBatch` | 批量只读。有原生批量就用，没有就受限并发 |
| `simulate` | 预演。失败的合约标 SKIPPED，且不消耗序号 |
| `getTransaction` | 按 hash 读一笔交易的当前状态 |
| `executeBatch` | 批量执行，见下 |
| `checkBalance` | 可选。不适用的链族不实现，上层自动跳过 |
| `checkHealth` | 逐个 RPC 探活，**不要只探第一个**，否则测不出单点故障 |
| `reset` | 配置热重载后清空连接缓存 |

三条实现约定，违反会出安全问题：

- 签名材料绝不能写进日志、返回值或任何持久状态 —— 一笔已签名的 pause 泄露出去，任何人都能事后重放
- 待签名负载是不透明的，不要为了「统一」把它拍平成 EVM 的形状
- `executeBatch` 即使链上没有 nonce 概念，也必须对同一地址加锁串行

### executeBatch 只要提供四个方法

公共循环已经写好了（`lib/web3/runner.ts` 的 `runBatch`），它负责那些**不变量**：
预演失败标 SKIPPED、单笔失败不中断整批、签名失败整批中止并结算已广播的。

你只提供一个 `BatchStrategy`：

```ts
const strategy: BatchStrategy = {
  simulate: (item) => /* 会不会失败 */,
  build:    (item) => /* 拼出待签名负载 */,
  broadcast:(signed) => /* 发出去，回 hash */,
  settle:   (item, hash) => /* 等终态，回最终 hash */,
}
return runBatch(items, sign, strategy, hooks, options)
```

开头两行是所有链族共用的前置：

```ts
const from = requireSingleSigner(items, normalizeAddress)
return serializePerSigner(chain.key, from, async () => { /* … */ })
```

### 序号不是通用概念

runner 里**没有「序号」这件事**。

| 链族 | 防重放机制 |
|---|---|
| EVM | 数字 nonce，严格递增、不能留洞。一笔卡住，后面全部堵死 |
| Tron | 没有 nonce。靠 ref_block + expiration 的时间窗 |
| Solana | 常规交易靠 recent blockhash（同样是时间窗）；要严格顺序才用 durable nonce account |

EVM 的取号在自己的 `build` 里、推进在自己的 `broadcast` 成功后（见 `evm/nonce.ts`），
runner 完全不知道。gas 阶梯重发、自转账让 nonce 同理，都是 EVM 内部的事。
新链族按自己的模型来，不需要向任何接口交代。

---

## 后端：注册进 chains.ts

```ts
const ADAPTERS = new Map([
  ['evm', evmAdapter],
  ['tron', tronAdapter],
  ['solana', solanaAdapter],   // ← 加这行
])
```

漏了的话启动时 `assertRegistered` 直接拦下来，服务起不来。**这是好事** ——
比运行时点了暂停才发现没有 adapter 强。

链族标识是字符串不是枚举，所以连枚举定义都不用改。

---

## 后端：签名子进程的两个 switch

`src/lib/keys/worker.ts` 里两个都要加分支：

```ts
signPayload(family, keyHex, payload)   // 怎么签
deriveAddress(family, keyHex)          // 怎么从私钥派生地址
```

两个都有 `default: throw`，漏了会报出明确的错。

> `deriveAddress` 曾经没有 default，任何非 EVM 链族都会静默派生出一个 **Tron 地址**，
> 然后在地址比对处失败，报的是「密钥可能已被替换」—— 一个安全告警，指向完全错误的方向。
> 现在两个都穷举了。

---

## 后端：密钥 CLI 的两个硬编码

**这是现有文档漏掉、也最容易踩的一处。** `backend/scripts/keys.ts` 有它自己的一份链族清单，
和 `lib/web3/chains.ts` 的注册表**没有任何联系**：

```ts
type Family = 'evm' | 'tron'
const FAMILIES: readonly Family[] = ['evm', 'tron']
```

以及它自己的一份 `deriveAddress` —— 注意它是**二选一、没有 default** 的：

```ts
function deriveAddress(family: Family, privateKeyHex: string): string {
  if (family === 'evm') return new Wallet(`0x${privateKeyHex}`).address
  const base58 = tronUtils.address.fromPrivateKey(privateKeyHex)   // ← 剩下全走这里
  ...
}
```

不改会经历这样一串：

| 步骤 | 现象 |
|---|---|
| `npm run keys encrypt solana` | 报「无效的链族: solana」 |
| 若把 `Family` 加上 `solana` 却忘了 `deriveAddress` | 静默派生出一个 **Tron 地址**，写进 `secrets/solana.address` |
| 之后跑 GPG 批量 | worker 正确派生出 Solana 地址 → 与声明地址不符 → 报 **GPG_ADDRESS_MISMATCH「密钥可能已被替换」** |

也就是说，`worker.ts` 里已经修好的那个坑，在 CLI 里还留着一份。
三处都要改：`Family`、`FAMILIES`、`deriveAddress`。

---

## 前端：目录与注册表

新建 `frontend/src/chain/solana/`，实现 `chain/types.ts` 里的契约：

```ts
discover(): Promise<readonly WalletAdapter[]>   // 这个链族装了哪些钱包
readState(chain, contracts, viewer?)            // 读链上状态
explorerTxUrl / explorerAddressUrl              // 浏览器链接
```

然后在 `frontend/src/chain/index.ts` 的 `FAMILY_LIST` 里加一项。
**组件、store、api 一行都不用改。**

`WalletAdapter` 里两个方法对异构链有明确的退路：

| 方法 | 无此概念时的实现 |
|---|---|
| `currentChainId()` | 返回 `null`（契约里写明了） |
| `switchChain(chain)` | 实现成 no-op。Solana 的 cluster 由 RPC 端点决定，不由钱包切 |

`readState` 读不到的合约**不要放进结果**，而不是塞个 `false` ——
「状态未知」和「确定没暂停」是两回事，快捷勾选靠这个区分。

钱包发现的机制每个链族都不一样：

| 链族 | 机制 | 注意 |
|---|---|---|
| EVM | EIP-6963 广播 | 事件名 `eip6963:` 小写 |
| Tron | TIP-6963 广播 | 事件名 `TIP6963:` 大写 |
| Solana | Wallet Standard | 不是 6963 那套 |

选定 provider 后**不要回落全局对象**，否则装了多个钱包时会出现「点了 A 却用 B 签名」。

> ⚠️ 前端这一步漏了**不会报错**，只会静默做错事 —— 所以有专门的测试盯着
> （`frontend/tests/newFamily.test.ts`）：未注册的链族读状态返回空、
> 浏览器链接返回 `#` 而不是瞎猜路径、找钱包返回空列表而不抛错。
> **绝不拿 EVM 的 multicall 去打一条异构链。**

---

## 配置：chains.json 的字段

| 字段 | 约束 | 异构链的取值 |
|---|---|---|
| `key` | `^[a-z0-9][a-z0-9-]*$`，≤64，唯一 | 同时也是界面上显示的名字，不另配 name |
| `type` | 同一个正则 | 链族标识，要和 `chains.ts` 里注册的字符串一致 |
| `chainId` | 正整数 | 见下节，**不能随便填** |
| `explorer` | 合法 URL | 末尾斜杠会被 `trimSlash` 去掉 |
| `symbol` | 1–12 字符 | 原生币符号，余额显示要用 |
| `decimals` | 0–18 | SOL 是 9 |

### chainId 在异构链上的含义

Solana 没有 EVM 意义上的 chainId，但 schema 要求一个正整数。它被用在七处：

| 用途 | 位置 | 异构链适用性 |
|---|---|---|
| 飞书表 C 列配对到链 | `core/sync.ts` 的 `resolveChain` | **成立**，且要求全局唯一 |
| ChainList 查公开 RPC | `scripts/sync.ts` 的 `fetchChainlist` | 不成立，会查到别的链 |
| RPC 探活比对 | `scripts/sync.ts` 的 `probe`（发 `eth_chainId`） | 不成立 |
| Alchemy URL 拼接 | `lib/rpc/endpoint.ts` 的 `NETWORK_BY_CHAIN_ID` | 不成立 |
| ethers Network | `evm/client.ts` | EVM 专用 |
| gas 策略选择 | `evm/tx.ts` 的 `POLICY_BY_CHAIN_ID` | EVM 专用 |
| 前端 provider 与切链 | `evm/read.ts` · `evm/wallet.ts` | EVM 专用 |

两条要求：

- **全局唯一** —— `resolveChain` 用 `Map<chainId, Chain>` 配对，撞了后面的悄悄覆盖前面的，且 `core/config.ts` 只查 `key` 重复、不查 `chainId` 重复
- **避开所有真实 EVM chainId** —— 否则 `fetchChainlist` 会按这个数字给你返回一条**真 EVM 链**的 RPC，塞进 Solana 的候选列表

Tron 用的是它自己 EVM 兼容层的 `728126428`。Solana 没有对应值，
建议填一个明显是占位的大数，并且**同时给 `scripts/sync.ts` 加分支**（下节）——
加了分支之后 ChainList 那条路根本不走，撞不撞就无所谓了。

---

## 配置：RPC 来源

后端的 RPC 候选按三级降级合并去重（见 `lib/rpc/endpoint.ts`）：

```
lark        rpc.json 的 lark 段，手工维护，最可靠
alchemy     用 ALCHEMY_API_KEY 拼的，含密钥，永不下发前端
chainlist   chainlist.org 的公开节点，兜底，质量参差
```

`npm run sync rpc` 只负责后两级，而它有两处 EVM 假设：

| 位置 | 假设 | 对 Solana 的后果 |
|---|---|---|
| `fetchChainlist` | 按 chainId 去 chainlist.org 查 | 查不到，或查到一条完全无关的 EVM 链 |
| `probe` | 发 `eth_chainId` 并比对返回值 | 所有节点判死，输出「该链没有可用 RPC」 |

Tron 已经有现成的处理方式，照抄即可：

```ts
// fetchChainlist：写死已知端点，不走 ChainList
if (chain.type === 'solana') { map[chain.key] = [...SOLANA_ENDPOINTS]; continue }

// probe：换成这条链自己的健康检查
if (chain.type === 'solana') { /* POST getHealth / getSlot */ }
```

**`probe` 那个分支不是可选的。** 手工填 `data/rpc.json` 的 lark 段确实能让当下跑通：

```json
{ "syncedAt": "…", "lark": { "solana": ["https://api.mainnet-beta.solana.com"] }, "chainlist": {} }
```

但只要有人再跑一次 `npm run sync rpc`，这几条就没了 —— 脚本对 lark 段
「原样保留」指的是不去外面重新拉，**探活照跑**：

| 步骤 | 结果 |
|---|---|
| `verifyAll(lark, …)` | 对手填的 Solana 端点逐条 `probe` |
| `probe` 发 `eth_chainId` | Solana 节点不认这个方法，全部判死 |
| `if (alive.length > 0)` | 一条都没活下来，这个 key **整条从输出里消失** |
| 写回 `rpc.json` | 手填的内容被覆盖掉了 |

表现是「昨天还好好的，今天这条链没有可用 RPC 了」，而中间只跑了一次同步。
所以顺序是：先加 `probe` 分支，再谈手不手填。

> 下发前端的只有 `public: true` 的节点。带 apiKey 的 URL 一律 `public: false` ——
> 判断规则在 `endpoint.ts` 的 `looksPublic`：有 query 参数、路径里有 20 位以上长串、
> 带 basic auth，三者任一即视为私有。前端 `readState` 用的就是这批公开 RPC。

---

## 配置：密钥文件

```bash
cd backend && npm run keys encrypt      # 生成 secrets/solana.key.gpg 与 secrets/solana.address
```

有哪个 `<链族>.key.gpg` 就有哪个链族的密钥，不用配表。
`.address` 是防掉包的控制点 —— 解密后派生的地址必须和它一致，缺了不能放行。

**私钥必须能表示成 32 字节 hex。** 这是一条硬约束，两处各有一份相同的正则：

| 位置 | 作用 |
|---|---|
| `scripts/keys.ts` 的 `normalizePrivateKey` | 加密时校验输入 |
| `src/lib/keys/gpg.ts` 的 `normalize` | 解密后校验产物 |

```ts
/^[0-9a-fA-F]{64}$/     // 64 个十六进制字符 = 32 字节
```

Solana 钱包（Phantom 等）导出的通常是 **64 字节的 base58 私钥**（32 字节种子 + 32 字节公钥）。
要先取前 32 字节种子转成 hex 再喂进去，签名侧用 `Keypair.fromSeed` 还原。
直接贴 base58 会被 `normalizePrivateKey` 拒掉，报「私钥格式不对」。

---

## 配置：合约

`backend/data/contracts.json` 里 `chain` 填新链的 key：

```json
{ "id": "sol-vault", "name": "Vault", "businessLine": "payment",
  "chain": "solana", "address": "…", "operator": "…" }
```

`address` 与 `operator` 的格式**不在 schema 里校验**，交给 `meta.isValidAddress` 按链分派 ——
那里还知道这个合约配在哪条链上，能报出「地址不符合 solana 链的格式」这种有用的话。
配错了启动就报错，服务起不来。

---

## 异构链的硬约束

写 adapter 之前先对一遍，这些是框架层面定死的：

| 项 | 约束 | 说明 |
|---|---|---|
| 操作名 | `pause` / `unpause` 这两个字符串直接被当成「要调什么」传给 adapter | `core/execution.ts` 里是 `method: operation`。EVM 走 ABI 编码，Tron 补 `()` 成方法签名，Solana 要在 adapter 内部映射到指令 |
| 读取字段 | 只读 `paused`，定义在 `core/operations.ts` 的 `CONTRACT_READS` | 是业务决定，不是链的性质 |
| 读的返回类型 | `ReadCall.returns` 只有 `'bool' \| 'address'`，但**是可选提示** | EVM 完全忽略它。Solana 反序列化账户数据时也可以忽略，**不必扩这个联合类型** |
| bool 防呆 | 返回值必须是干净的 0 或 1，否则视为读不到 | 地址误配成预编译地址时它对任意调用都返回哈希，解出来会成为「已暂停」，紧急暂停就被静默跳过了 |
| 地址大小写 | `worker.ts` 的地址比对两边同时 `toLowerCase` | 对 base58 这条比较偏松但不会误判。**adapter 内部不要**再 lower，base58 是大小写敏感的 |
| 一批一个签名地址 | `requireSingleSigner` 强制 | 混着来的话「这是第几笔」的账没法算 |
| 同地址串行 | `serializePerSigner` 强制 | 并发广播在 Tron 会因 ref_block 相同被判重复交易 |
| 签名算法 | 由你自己决定，不往接口暴露 | EVM/Tron 都是 secp256k1，Solana 是 ed25519 |

---

## 走一遍：接 Solana

按顺序做，每步都有可验证的结果。

| 步 | 内容 | 验证 |
|---|---|---|
| 一 | `data/chains.json` 加 `{ key: "solana", type: "solana", chainId: <占位大数>, explorer: "https://explorer.solana.com", symbol: "SOL", decimals: 9 }` | `npm run dev` 报「未注册的链族: solana」—— 说明配置读到了 |
| 二 | 写 `src/lib/web3/solana/{client,tx,adapter}.ts`，`chains.ts` 注册一行 | 服务能起来 |
| 三 | 给 `scripts/sync.ts` 的 `probe` 与 `fetchChainlist` 各加一个分支，跑 `npm run sync rpc` | `npm run check` 的「数据」组显示 solana 有可用 RPC，且**再跑一次 sync 之后仍然有** |
| 四 | `data/contracts.json` 加一个 Solana 合约 | 启动不报地址格式错 |
| 五 | 写 `frontend/src/chain/solana/{wallet,read}.ts`，`chain/index.ts` 注册一项 | 界面上这条链的合约能显示状态，顶栏出现 Solana 按钮 |
| 六 | `worker.ts` 两个 switch 加 ed25519 分支 | — |
| 七 | `scripts/keys.ts` 三处加 solana | `npm run keys encrypt solana` 能跑通，`secrets/solana.address` 里是个 base58 地址 |
| 八 | `npm run keys verify` | 解密后派生的地址与声明地址一致 |
| 九 | 界面上选一个 Solana 合约跑 GPG 批量 | 进度流走完，交易日志里出现记录 |

第五步和第七步是两个「漏了不报错」的点，务必单独确认。

---

## 漏改的表现

按发现难度排，越靠下越阴。

| 漏掉的东西 | 表现 | 发现时机 |
|---|---|---|
| `chains.ts` 注册 | 「未注册的链族: solana」 | 启动 |
| `chains.json` 里的链 | 「合约 x 引用了不存在的链」 | 启动 |
| `worker.ts` 的 switch | 「未实现 solana 链族的签名」 | 第一次点执行 |
| RPC | 「链 solana 没有可用的 RPC」 | 第一次读状态 |
| `secrets/solana.key.gpg` | 「未配置这些链族的签名密钥」，整批拒绝 | 点执行时，读口令**之前** |
| `keys.ts` 的 `deriveAddress` | **「密钥可能已被替换」的安全告警**，指向完全错误的方向 | 第一次跑 GPG 批量 |
| 前端 `FAMILY_LIST` | **不报错**。这条链的合约状态全是「未知」、浏览器链接是 `#`、顶栏没有这个链族的按钮 | 可能一直没人发现 |

---

## 做完自查

```bash
cd backend  && npx tsc --noEmit && npx vitest run
cd frontend && npx vue-tsc --noEmit && npx vitest run
cd backend  && npm run check          # 环境、密钥、数据、RPC 一起过一遍
```

两个 `newFamily.test.ts` 专门锁那些「漏了不报错」的地方，要单独看它们过没过：

| 文件 | 锁住的内容 |
|---|---|
| `backend/tests/newFamily.test.ts` | 未注册链族明确报错、启动时被拦下；runner 里没有任何 EVM 专属概念；`BatchStrategy` 就四个方法；批次前置对所有链族通用 |
| `frontend/tests/newFamily.test.ts` | 未注册链族读状态返回空、链接返回 `#`、找钱包返回空列表而不抛错 |

新链族接完之后，把它加进这两个测试的用例里 —— 它们现在守的是「未注册时不乱来」，
接完之后还要守「注册了就真的走自己那条路」。
