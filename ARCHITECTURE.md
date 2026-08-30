# 技术架构

多链合约运维控制台。后端 Express + TypeScript(`src/` 58 个文件),
前端 Vue 3 + Element Plus(`src/` 23 个文件)。测试 283 + 72,覆盖率 80%。

> 操作方式见 [OPERATIONS.md](OPERATIONS.md);
> 逐项细节见 [docs/BLUEPRINT.md](docs/BLUEPRINT.md) · [docs/API.md](docs/API.md) ·
> [docs/FRONTEND.md](docs/FRONTEND.md) · [docs/ADD-CHAIN.md](docs/ADD-CHAIN.md)。

---

## 1. 后端分层

```
routes/          path → controller，无业务逻辑
   ↓
controllers/     只管 HTTP：ETag、SSE 帧、状态码、参数解析        4 个
   ↓             （与 service 一一对应）
services/        编排：把 core 的能力按接口的需要串起来           4 个
   ↓
core/            领域能力：知道业务，不知道 HTTP                  6 个
   ↓
lib/             通用能力：不知道这是个合约管理平台
                 web3 / keys / rpc / lark / utils

repositories/    唯一碰磁盘的层        models/  表结构(zod schema + 推导的类型)
```

**分层判据是「它知道什么」,不是「它在调谁」:**

| 层 | 检验方式 |
|---|---|
| `lib/` | 能整体搬到别的项目 |
| `core/` | 能脱离 Express 单测 |
| `services/` | 和某个 controller 一一对应 |

三条不变量,`npm test` 之外靠 review 守着:

```
core/ → services/ 或 controllers/          0 处
lib/  → core/ / services/ / controllers/   0 处
每个 controller → 恰好 1 个 service
```

### 为什么有 core 这一层

`core/` 的六个文件里,四个**没有任何一个 service 装得下**:

| 文件 | 消费者跨越了 service 边界 |
|---|---|
| `config` | `server.ts` 启动时就要,还被 3 个 service 用 |
| `identity` | 主要消费者是**中间件**(每个请求验 JWT) |
| `contractState` | `/states` 接口**和**执行前置检查共用 |
| `sync` | `registry.service` **和** `scripts/sync.ts`(CLI)都用 |

另两个(`execution` 268 行、`operations` 22 行)是执行编排与操作闭集。

能力层没有放进 `lib/`,因为 `core/execution` 依赖 `core/config`,
搬进去会立刻打破 `lib/` 对上层零依赖 —— 那正是它能整体搬走的原因。

---

## 2. 链层:两个 adapter

接一条新链族 = 实现一个接口 + 改一行注册表,services / controllers / 前端零改动。

| | **ChainMetaAdapter** | **ChainTxAdapter** |
|---|---|---|
| 性质 | 纯函数,不碰网络 | 所有网络 IO |
| 内容 | 地址校验 / 归一化 / 展示 / 浏览器链接 | 批量读、预演、批量执行、健康探测 |

公共层约 330 行,链专属约 730 行。公共层真正的**逻辑**只有 `runner.ts` 一个批量循环 ——
各链差异通过 `BatchStrategy`(`simulate` / `build` / `broadcast` / `settle` 四个函数)注入。

**循环里没有「序号」这个概念。** nonce 是 EVM 特有的(Tron 靠 ref_block 时间窗,
Solana 靠 recent blockhash),整个待在 `evm/nonce.ts`,runner 和其它链族都不知道它存在。

| | EVM | Tron |
|---|---|---|
| 防重放 | nonce,严格递增无空洞 | ref_block + expiration(60s 过期) |
| 批量读 | Multicall3,一次 RPC | 受限并发 |
| 批量写 | 地址锁内串行取号 | 必须串行(并发会判重复交易) |
| 卡住的救援 | gas 阶梯重发 + 自转账让 nonce | 不需要(过期即作废,不堵后面) |

---

## 3. 六个关键决策

**① 配置能错就让它启动时错**
`core/config` 做跨文件引用完整性校验:合约引用了不存在的链或业务线 → **服务起不来**。
一个拼错的 id 让某个合约在界面上凭空消失,是最难发现的故障。

**② 口令从不经过 HTTP**
前端不输入也不传任何密钥材料。GPG 解密由服务器本机的 gpg-agent + pinentry 负责,
私钥只在一次性子进程内存里,用完 `exit`。派生地址必须与 `secrets/<链族>.address` 一致,
否则立即中止 —— 防密钥被掉包。

**③ 上链保障:等回执 → 查状态 → 同 nonce 提价重发 → 自转账让 nonce**
运维操作卡在内存池等于没执行。最后那步本质是「取消」,所以前后各查一次链上状态 ——
**绝不能把一次已经生效的暂停给取消掉**。
不做的话,卡住的 nonce N 会让 N+1、N+2 永远排不上,同批后面的合约全部
「广播成功但永不确认」,而界面看起来像都发出去了。

**④ 签名失败中止时,已广播的必须等到终态再一起汇报**
否则上层以为什么都没发生,既不记日志也不刷界面,而实际上已经有合约被暂停了。
紧急场景里最危险的一类失败是「看起来没做,其实做了」。

**⑤ 链上状态宁可读不到,也不能读错**
`paused()` 的返回必须是 32 字节的 0 或 1。解码器会把任何非零值当 true,
但真正的 Pausable 合约只会返回 0 或 1 —— 返回别的说明这个地址不是我们以为的合约。
把「地址配错了」显示成「已暂停」,运维就会直接跳过它。前后端三处用同一条判定。

**⑥ 可用性优先于数据新鲜度**
Lark 同步挂了不挡控制台;解析出 0 个合约一律当异常,绝不覆盖本地
(表格一次误操作就把合约清空,紧急时会找不到东西可暂停)。

---

## 4. 前端

```
store/     唯一的 Pinia store，三块组合：session / catalog / execution
           三块之间不互相 import，跨块调用只在 index.ts
chain/     evm/ 与 tron/ 各一套 read + wallet，index.ts 按链族分派
components/ 5 个
```

**钱包发现走广播式标准**:EVM 用 EIP-6963,Tron 用 TIP-6963 —— 装了多个钱包时
`window.ethereum` 归谁全看注入顺序,广播式发现让每个钱包各自应答、各带自己的 provider,
点哪个就用哪个。选定后**绝不回落全局对象**,否则就是「点了 A 却用 B 签名」。

> ⚠ 两个事件名大小写不同(`eip6963:` 小写 / `TIP6963:` 大写),别顺手统一。

**链上状态由前端读**:Multicall3 按链批量,不占后端 RPC 配额。
读不到时(公开 RPC 常常没有 CORS 头)退回 `GET /states` 让后端代读。

---

## 5. 一条领域事实横跨三处

「平台做 pause / unpause」这件事同时活在:

```
core/operations.ts        操作语义（有哪些、前置条件、预期结果）
lib/web3/evm/abi.ts       它在 EVM 上的编码（Solidity ABI）
frontend/chain/abi.ts     钱包模式的编码（跨包，测试管不到）
```

分开是对的 —— `core` 是链无关的,Solidity ABI 只对 EVM 成立(Tron 要方法签名字符串,
Solana 用 IDL)。但**加一种操作忘了改 ABI,编译期查不出来**,要等到
`encodeFunctionData` 才炸,而那时人已经点了按钮、输过 CONFIRM。

所以:后端用测试守着前两处同步(`executor.test.ts`),
前端用 `canEncode()` 在编码前挡一道,报人话而不是 ethers 的原始错误。

---

## 6. 边界与限制

**v1 单实例**:运行中的任务、已用签名去重表存于内存,不支持水平扩展。
交易日志落盘,重启不丢。

SSE 每 15s 发心跳防代理断连,**没有断线重放** —— 断了就是任务结束,状态由日志兜底。
另有 `POST /gpg/cancel` 按**操作者地址**取消(不是按连接),
用于页面刷新后、换设备、代理缓冲这三种「连接已经没了但任务还在跑」的情况。
