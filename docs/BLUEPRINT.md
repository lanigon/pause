# 合约管理平台 — 架构

多链合约运维控制台：勾选合约，批量暂停 / 恢复。
后端 Express + TypeScript（`src/` 57 个文件），前端 Vue 3 + Element Plus（`src/` 18 个文件）。

---

## 1. 页面

```
┌──────────────────────────────────────────────────────────────────────┐
│  合约管理平台        [EVM · 0xf39F…2266]  [Tron]  [Alice(Admin)]     │ WalletBar
├──────────┬───────────────────────────────────────────────────────────┤
│ 业务线    │  [ 钱包签名 | GPG 批量 ]                       ← 签名方式 │
│ ☑ 支付 2 │  ┌────────────────────────────────────────────────────┐  │
│ ☐ 跨链桥 0│ │ ☑ ▾ 支付   2   已选 2                              │  │
│          │  │   ☑ Payment Vault    morph   ● 运行中              │  │ ContractList
│          │  │   ☑ USDT Gateway     tron    ⏸ 已暂停             │  │
│          │  └────────────────────────────────────────────────────┘  │
│          │  已选 2        [全部收起] [刷新状态] [批量恢复] [批量暂停] │
│          ├───────────────────────────────────────────────────────────┤
│          │  交易日志                                  [✓ 自动滚动]   │
│          │  08-30 10:32:03  已广播   暂停  payment-vault @morph      │ OperationLog
│          │  08-30 10:32:09  已确认   暂停  payment-vault @morph      │
└──────────┴───────────────────────────────────────────────────────────┘
```

侧边栏多选业务线，右侧一条业务线一块，每块可折叠、可独立全选。

---

## 2. 数据：全部 JSON，都在 `backend/data/`

| 文件 | 内容 |
|------|------|
| `chains.json` | 链定义：`key` / `type` / `chainId` / `explorer` / `symbol` / `decimals`。**不含 RPC、不含 name、不含 multicall3** |
| `contracts.json` | 业务线定义 + 合约（`id` / `name` / **业务线 / 链 / 地址**） |
| `operators.json` | 登录白名单。角色即权限：`admin` 可热重载 · `operator` 可执行 · `viewer` 只读。三者都能看全部业务线 |
| `rpc.json` | RPC，由 `npm run sync` 生成。运行时只读，不做外网调用 |
| `sync.json` | 数据从哪来：飞书表格链接。空着就跳过同步、只用本地数据 |
| `operations.json` | 交易日志（运行时追加，已 gitignore） |

后端签名密钥**不在 `data/` 里配**，按约定放在 `secrets/`：

```
secrets/<链族>.key.gpg    GPG 加密的私钥
secrets/<链族>.address    对应地址，明文 —— 用来核对密钥有没有被换过
```

早先有个 `signers.json` 声明「链族 / 地址 / 解锁方式」，去掉了：地址放在密钥文件旁边
更难写错，解锁方式则改成**探测**（见 §7），配置里那份反而会和现实对不上。

几处刻意的「不配置」：

- **不配 ABI、不配可执行动作** —— 平台只做 pause/unpause，在所有 Pausable 合约上都一样，内置在 `lib/web3/evm/abi.ts`
- **不配 `multicall3` 地址** —— Multicall3 用确定性部署，每条链都落在同一个地址，写死在代码里。没部署的链由运行时发现（调用失败自动回退并发单点）
- **不配 `name`** —— `key` 同时就是展示名，再配一个只是同一件事写两遍
- **不配 `confirmations`** —— 统一等 1 个确认，真正的验证是回执之后**再读一次链上状态**

### RPC 三级降级

```
① Lark（飞书表格）   团队维护的付费/自建节点，最可靠。可能含鉴权信息 → 按 URL 形态判断能否下发前端
② Alchemy            唯一的环境变量 ALCHEMY_API_KEY 按 chainId 现拼
                     ★ 含密钥，永久 public:false，绝不下发前端
③ ChainList          chainid.network 的公开 RPC，兜底。全部可下发前端
```

`RpcProvider` 把三级合并成一个有序候选列表交给 ethers 的 `FallbackProvider`，
所以「降级」既发生在配置层（哪个来源提供）也发生在运行时（某个节点挂了自动切下一个）。

**前端不配任何 RPC** —— multicall 用的 RPC 由后端下发，且只给公开的。

---

## 3. 五条数据流

**登录** —— 只有一个接口，只认 EVM 签名。
挑战消息由前端自己拼（含时间戳 + 随机数），后端用同样模板重建后验签 —— 不需要服务端 nonce，
省一次往返也不用存状态。防重放靠时间窗（±2 分钟）+ 已用签名内存去重（5 分钟）。
拿到 token 后所有接口都能用，包括操作 Tron 合约（Tron 钱包只用于钱包模式发交易，**不参与登录**）。

**加载** —— `GET /registry` 一次拿全，内存里预计算好，请求路径上零计算。
**不按人裁剪**：只有一份 DTO，所有能登录的人看到的内容都一样，角色的区别只在能不能动。

**同步** —— `GET /registry/sync`（SSE）：先跟 Lark 对一遍再给数据。
三条硬约束：Lark 挂了不挡控制台；解析出 0 个合约绝不覆盖本地；TTL 缓存 + 互斥防止每次刷页面都打 Lark。

**读状态** —— 前端自己用 **Multicall3** 按链批量读 `paused()`，一条链一次 RPC。
不占后端配额，切业务线时刷新很快。没部署 Multicall3 的链回退并发单调；Tron 用受限并发。
前端拿不到 RPC 时（公开节点常常没有 CORS 头）退回 `GET /states` 让后端代读。

**执行（GPG 模式）** —— **一个请求做完**，响应体就是 SSE 流。

```
勾选 → 二次确认（输入 CONFIRM）
 → POST /gpg/batch   { operation, contractIds, expectedConfigVersion, confirm }
 ← 响应即 SSE：解密 → [请触摸 YubiKey] → 逐笔 预演/余额/签名/广播/确认 → 完成
```

没有 jobId、没有任务过期、没有断线重放：连接断了后端就收到 close 并中止，
状态由落盘的交易日志兜底。前端**不传任何密钥材料**。

另有 `POST /gpg/cancel`，**按操作者地址取消**而不是按连接 —— 页面刷新后原来那条 SSE 已经没了，
但后端任务还在跑，只能靠它停掉（否则要空转到 180 秒超时）。

**执行（钱包模式，默认）** —— 前端逐笔用钱包签名广播，每笔广播成功后 `POST /logs` 留档。
后端不提供任何「可签名数据」接口。

---

## 4. 后端分层

```
backend/src/
├── routes/          path → controller，无业务逻辑（1 个文件）
├── controllers/     只管 HTTP：ETag、SSE 帧、状态码、参数解析（4 个）
├── services/        编排，一个 controller 一个（4 个）
├── core/            ★ 领域能力，不知道 HTTP 的存在（6 个）
├── repositories/    ★ 唯一碰磁盘的层：jsonStore（公共组件）+ config + log
├── models/          表结构：zod schema + 由它推导的类型（5 个）
├── middlewares/     logging(pino-http) / auth(JWT) / validate(zod) / error
├── config/          env（常量）+ config.schema（文件信封）
└── lib/             ★ 与本平台无关的通用能力，对上层零依赖
    ├── web3/        链层，见 §5
    ├── keys/        GPG 解密 + 签名子进程
    ├── rpc/         三级降级
    ├── lark/        飞书表格客户端
    └── utils/       errors / logger / sse / mutex / net / jsonFile / response
```

### controller ↔ service 一一对应

| controller | service | 接口 |
|---|---|---|
| `auth` | `auth.service` | `POST /auth/login` |
| `registry` | `registry.service` | `/registry` `/registry/sync` `/states` `/registry/reload` `/state` `/state/rpc` `/health` |
| `gpg` | `gpg.service` | `POST /gpg/batch` `POST /gpg/cancel` |
| `log` | `log.service` | `GET /logs` `GET /logs/daily` `POST /logs` |

### core/ 是什么

被多个 service 复用、且**不知道 HTTP 存在**的能力。都能脱离 Express 单测。

| 文件 | 职责 |
|---|---|
| `config.ts` | 配置真相：加载 + 跨文件引用完整性校验 + 建索引 + 预计算 DTO |
| `execution.ts` | 执行编排引擎：授权 → 前置检查 → 按链分组并行 → emit 事件 → 汇总 |
| `sync.ts` | Lark 同步：拉取 → 比对 → 有差异才写盘 |
| `contractState.ts` | 读链上状态（`/states` 与执行前置检查共用） |
| `identity.ts` | JWT 签发与校验（校验是每个请求都要做的，被中间件用） |
| `operations.ts` | 操作闭集 + 领域规则（前置条件、预期结果） |

### 三条依赖不变量

```
core/ → services/ 或 controllers/      ：0 处
lib/  → core/ / services/ / controllers/ / repositories/ ：0 处
每个 controller → 恰好 1 个 service
```

第二条是 `lib/` 能整体搬到别的项目的原因。**能力层没有放进 `lib/`**，正因为
`core/execution` 需要 `core/config`，搬进去会立刻打破它。

### 环境变量：3 个，都可以不填

| 变量 | 说明 |
|---|---|
| `ALCHEMY_API_KEY` | RPC 三级降级的第二级。不填就只用 Lark / ChainList |
| `GPG_BINARY` | gpg 可执行文件，默认 PATH 里的 `gpg` |
| `GNUPGHOME` | 自定义密钥环位置，默认 `~/.gnupg` |

`GNUPGHOME` 虽然「可以不填」，但**用 YubiKey 或独立密钥环时必须设对** ——
不设的话 gpg 会去找默认密钥环，永远解不开，而报出来的错**看起来像「口令错」**，
很容易查错方向。它由 `gpgEnv()` 显式转发给 gpg 子进程（不转发就等于没设）。
路径也别太长：gpg-agent 的 socket 有长度限制，超了直接起不来，`npm run check` 会量。

飞书表格地址**不在环境变量里**，在 `data/sync.json`。它不是密钥，是团队共享配置，
和 chains / contracts / operators 同一性质 —— 换表格该走改配置提 PR 那条路，
而不是每个人各自在 `.env` 里填一份（填错了别人还看不见）。
访问控制在本机 lark CLI 的登录态上，不在这个 URL 上。

它**不参与 `configVersion`** —— 换个表格地址不该让前端弹「配置已更新，请刷新」，
所以没走 `loadRawConfig` 那条路。

其余全在 `src/config/env.ts` 里当常量：端口、路径、超时、CORS。
**JWT 密钥生产环境每次启动随机生成** —— 单实例部署没必要固化，少一个会泄露的长期密钥
（代价是重启后要重新登录）。开发环境缓存在 `secrets/.jwt-dev`，
因为 `tsx watch` 改一行就重启，每次都把人踢下线没法测。GPG 口令/PIN 不在配置里，由本机的 gpg-agent 负责。

---

## 5. web3 层：两个 adapter

| | **ChainMetaAdapter** | **ChainTxAdapter** |
|---|---|---|
| 性质 | 纯函数，**不碰网络** | **所有网络 IO** |
| 方法 | `isValidAddress` `normalizeAddress`（比较用）`displayAddress`（展示用）`explorerTxUrl` | `readBatch` `simulate` `getTransaction` `executeBatch` `checkBalance?` `checkHealth` `reset` |
| 为什么分 | 校验配置、拼审计信息时都要用地址逻辑，但不该为此起节点；单测不用 mock 网络 | 重连、限流、序号锁、批量策略关在一个盒子里 |

注册表 `lib/web3/chains.ts` 每个链族只有一行 `{ name, meta, tx }`。

公共层约 330 行、链专属约 730 行。公共层里真正的**逻辑**只有 `runner.ts` 一个批量循环——
各链的差异通过 `BatchStrategy`（`simulate` / `build` / `broadcast` / `settle` 四个函数）注入。

**循环里没有「序号」这个概念。** nonce 是 EVM 特有的（Tron 靠 ref_block 时间窗，
Solana 靠 recent blockhash），整个待在 `evm/nonce.ts` 里，runner 和其他链族都不知道它存在。

**EVM 与 Tron 的差异全部封在各自 adapter 内：**

| | EVM | Tron |
|---|---|---|
| 防重放 | nonce，必须递增且无空洞 | ref_block + expiration（60s 过期） |
| 批量读 | Multicall3，一次 RPC | 受限并发（TronGrid 有 QPS 限制） |
| 批量写 | 地址锁内串行取号 | **必须串行**（并发会被判重复交易） |
| 拼装时机 | 可提前 | **每次签名前现场构建** |
| 地址 | EIP-55 checksum | 比较用 hex41，展示用 base58 |
| 回执 | `status` 0/1 | `SUCCESS`/`REVERT`/`OUT_OF_ENERGY`/`OUT_OF_TIME` |
| 卡住的救援 | gas 阶梯重发 + 自转账让 nonce | 无需要（交易会过期作废，不会堵后面） |

---

## 6. 上链保障（gas 阶梯重发）

运维操作卡在内存池等于没执行，所以：

```
首发 gas = 节点推荐值 × N        （以太坊主网 N=8，其它链 N=2）
   ↓ 等 T 毫秒                   （主网 30s，其它 10s）
拿到回执？→ 结束
   ↓ 没拿到
再读一次链上状态
   ├─ 状态已达成 → 认定成功（可能交易生效了只是回执慢，也可能别人先做了）
   └─ 状态没变   → gas 翻倍，用**同一个 nonce** 发替换交易，最多 4 次
        ↓ 还是不行
      用同一 nonce 发一笔**自转账**（21000 gas，24× 价格）把它顶掉
```

同 nonce 是关键：这是「替换」不是「再发一笔」，最终只有一笔上链。

最后那步自转账本质是「取消」，所以**前后各查一次链上状态** ——
绝不能把一次已经生效的暂停给取消掉。不做的话，卡住的 nonce N 会让 N+1、N+2 永远排不上，
同批后面的合约全部「广播成功但永不确认」，界面看起来却像都发出去了。

---

## 7. 密钥解锁：可插拔

两种方式共用同一条通道。**用哪种是探测出来的，不是配置项**：

| | **passphrase** | **yubikey** |
|---|---|---|
| 密钥文件 | gpg 对称加密（AES256） | 加密给卡上的 OpenPGP 公钥 |
| 用户输入 | 口令 | PIN |
| 需要触摸 | 否 | **是** —— 后端会先推一条「请触摸设备」给前端 |
| 输错重试 | 可以 | **绝不自动重试**，连错 3 次锁卡 |
| 解密超时 | 60s | 120s（要留时间给人伸手去按） |
| 前置检查 | 文件在不在 | 还要查卡在不在、PIN 还剩几次 |

探测看的是密钥文件本身（`gpg --list-packets`，不需要口令）加上卡在不在：

```
对称加密                      → 口令
加密给公钥 + 卡在且有解密密钥  → YubiKey（要触摸、要独占、超时给足）
加密给公钥 + 卡不在           → 口令（密钥在钥匙环里，gpg-agent 会问它的口令）
```

最后一条是配置做不到的：写死 `yubikey` 的话，卡拔了照样按 YubiKey 处理，
白等 120 秒还提示用户去摸一个不存在的设备。

**后端运行时不持有任何口令** —— 解密交给本机的 gpg-agent + pinentry。
无终端后台运行时 pinentry 弹不出来会失败，错误码 `GPG_PINENTRY_UNAVAILABLE`
明确指出这一点（而不是误报成「口令错」）。

> YubiKey 在这里的角色是**保护密钥文件**，不是直接做链上签名 ——
> OpenPGP 卡无法为 secp256k1 以太坊交易做原生签名，所以仍然是
> 「卡解密出私钥 → 子进程内存里签名 → 立即清零」。

## 8. GPG 安全模型

```
前端（不传任何密钥材料）
      │  POST /gpg/batch
      ▼
父进程 ──spawn──▶ worker 子进程 ──spawn──▶ gpg ◀──── 本机 gpg-agent / pinentry
                        │                              （口令 / PIN / 触摸都在这里）
                        ▼
                 私钥（只在子进程内存）
                        ▼
              派生地址 == secrets/<链族>.address？
                否 → 立即退出（GPG_ADDRESS_MISMATCH）
                是 → 连续签完 N 笔 → 清零 → exit
```

- **口令从不经过 HTTP**：既不进请求体也不进 JSON，由本机的 pinentry 直接问用户
- 私钥只在一次性子进程内存中，用完 `process.exit(0)`
- gpg 用独立进程组，超时杀整组，防孤儿进程持有密钥
- 已签名的 rawTx 只在广播函数内的局部变量存在 —— 泄露出去任何人都能重放这笔 pause
- 无常驻解锁 session

---

## 9. 权限

三层，各管一件事，不重复：

1. **能不能登录** —— 地址在 `operators.json` 白名单里，且 EVM 签名验得过
2. **能不能动** —— 角色不是 `viewer`（HTTP 层 `requireWriteRole` 拦）
3. **有没有密钥** —— 所选合约涉及的每个链族都配了签名密钥，缺一个整批拒绝

早期版本给后端密钥又配了一套 `allowedChains` / `allowedBusinessLines`，后来去掉了 ——
能操作什么由**登录的人**决定，给密钥再配一套是重复的，反而容易配错留下漏洞。
`assertAuthorized` 现在只关心「这个链族有没有密钥」，不关心密钥长什么样。

不做「部分放行」—— 半停半没停的中间态比全不执行更危险。

---

## 10. 边界条件

1. 跨链、跨链族批量 → 按链分组**并行**，每个链族各开一个 GPG 子进程
2. 已 paused 再点暂停 → 前置检查跳过，不消耗 nonce、不花 gas
3. 状态读不到（RPC 挂了）→ **不跳过**，交给链上判断，别因为读不到就漏掉紧急暂停
4. 预演失败 → 标 skipped 且不消耗序号（取号在 `build` 里，而 build 只在预演通过后才调）
5. 广播失败 → 序号让给下一笔，不留空洞
6. 签名失败 → 密钥有问题，整批中止，**但已广播的必须等到终态再一起汇报** ——
   否则上层以为什么都没发生，而实际上已经有合约被暂停了
7. 配置在任务创建后变化 → 整批中止（`expectedConfigVersion` 比对，`CONFIG_CHANGED`）
8. SSE 每 15s 发一次心跳注释防代理断连；**没有断线重放**，断了就是任务结束
9. 钱包在错误的链 → EVM 自动 `wallet_switchEthereumChain`，链未添加则 `wallet_addEthereumChain`；
   Tron 走 TIP-3326 的同名方法，切不动就拒绝发送
10. 钱包模式下勾选了另一链族的合约 → 该行禁选，且不计入全选的分母

---

## 11. 部署与限制

**v1 单实例**：运行中的任务、已用签名去重表都存于内存，不支持水平扩展。
交易日志落盘，重启不丢。

**必须做的**：`secrets/` 与 `.env` 已在 `.gitignore`；生产用 HTTPS；`CORS_ORIGINS` 白名单收紧。
JWT 密钥不需要配置 —— 每次启动随机生成。
