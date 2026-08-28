# 合约管理平台 — 架构

多链合约运维控制台：勾选合约，批量暂停 / 恢复。
前端 Vue 3 + Element Plus（11 个文件），后端 Express + TypeScript（47 个文件）。

---

## 1. 页面

```
┌──────────────────────────────────────────────────────────────────────┐
│  合约管理平台        [EVM · 0xf39F…2266]  [Tron]  [Alice(Admin)] │ WalletBar
├──────────┬───────────────────────────────────────────────────────────┤
│ 业务线    │  [ GPG 批量模式 | 钱包模式 ]                   ← 签名方式 │
│ ● 支付 3 │  ┌────────────────────────────────────────────────────┐  │
│ ○ 跨链 1🔴│ │ ☑ Payment Vault    Morph   ● 运行中                │  │
│ ○ 质押 0 │  │ ☑ Payment Router   Morph   ● 运行中                │  │ ContractList
│ ○ 代币 0 │  │ ☐ USDT Gateway     Tron    ⏸ 已暂停                │  │
│          │  └────────────────────────────────────────────────────┘  │
│          │  已选 2 个        [刷新状态] [批量恢复] [批量暂停]        │
│          ├───────────────────────────────────────────────────────────┤
│          │  操作日志                                  [✓ 自动滚动]  │
│          │  10:32:01  0xf39F…2266  正在解密运维密钥…                │ OperationLog
│          │  10:32:03  0xf39F…2266  Payment Vault：已广播            │
│          │  10:32:09  0xf39F…2266  Payment Vault：已确认            │
└──────────┴───────────────────────────────────────────────────────────┘
```

---

## 2. 数据：全部 JSON，都在 `backend/data/`

| 文件 | 内容 |
|------|------|
| `chains.json` | 链定义：key / name / type / chainId / explorer / symbol / multicall3。**不含 RPC** |
| `contracts.json` | 业务线定义 + 合约（id / name / **业务线 / 链 / 地址**） |
| `operators.json` | 登录白名单。角色即权限：`admin` 可热重载配置 · `operator` 可执行 · `viewer` 只读。三者都能看全部业务线 |
| `signers.json` | 后端密钥声明：链族、声明地址、解锁方式。不是登录身份，所以和 operators 分开 |
| `rpc.json` | RPC，由 `npm run sync rpc` 生成。运行时只读，不做外网调用 |
| `operations.json` | 操作记录（运行时生成，已 gitignore） |

合约不配 ABI、不配可执行动作 —— 平台只做 pause/unpause，这些在所有 Pausable 合约上都一样，内置在 `web3/abi.ts`。
加一个合约就三行：业务线、链、地址。

### RPC 三级降级

```
① Lark（飞书表格）   团队维护的付费/自建节点，最可靠。可能含鉴权信息 → 按 URL 形态判断能否下发前端
② Alchemy            唯一的环境变量 ALCHEMY_API_KEY 按 chainId 现拼，覆盖 41 条链
                     ★ 含密钥，permanently public:false，绝不下发前端
③ ChainList          chainid.network 的公开 RPC，兜底。全部可下发前端
```

`RpcProvider` 把三级合并成一个有序候选列表交给 ethers 的 `FallbackProvider`，
所以"降级"既发生在配置层（哪个来源提供）也发生在运行时（某个节点挂了自动切下一个）。

**前端不配任何 RPC** —— multicall 用的 RPC 由后端下发，且只给公开的。

---

## 3. 四条数据流

**登录**：**只有一个接口**，只认 EVM 签名。
挑战消息由前端自己拼（含时间戳 + 随机数），后端用同样模板重建后验签 —— 不需要服务端 nonce，
省一次往返也不用存状态。防重放靠时间窗（±2 分钟）+ 已用签名内存去重（5 分钟）。
拿到 token 后所有接口都能用，包括操作 Tron 合约（Tron 钱包只用于钱包模式发交易，不参与登录）。

**加载**：`GET /registry` 一次拿全。**只返回当前操作员有权限的业务线与合约，链和 RPC 随之收窄到这些合约实际涉及的范围**。

**读状态**：前端自己用 **Multicall3** 按链批量读 `paused()` / `owner()`，一条链一次 RPC。
不占后端配额，切业务线时刷新很快。没部署 Multicall3 的链回退并发单调；Tron 用受限并发。

**执行（GPG 模式）**：**一个请求做完**，响应体就是 SSE 流。
```
勾选 → 二次确认（输入 CONFIRM）
 → POST /gpg/batch   { operation, contractIds, expectedConfigVersion, confirm }
 ← 响应即 SSE：解密 → [请触摸 YubiKey] → 逐笔 预演/余额检查/签名/广播/确认 → 完成
```
没有 jobId、没有任务过期、没有断线重放、没有 cancel —— 连接断了就是任务结束，
状态由落盘的交易日志兜底。前端不传任何密钥材料。

**执行（钱包模式）**：前端逐笔用 MetaMask / TronLink 签名广播，每笔完成后 `POST /logs` 留档。
后端不提供任何"可签名数据"接口。

---

## 4. 后端分层

```
backend/src/
├── routes/          path → controller，无业务逻辑（1 个文件）
├── controllers/     解析请求 → 调 service → 返回（4 个，对应 4 组接口）
├── services/        业务逻辑（4 个）：auth / registry / batch / job
├── repositories/    ★ 唯一碰磁盘的层：jsonStore（公共组件）+ config + log
├── rpc/             RPC 三级降级：types / sources / RpcProvider
├── keys/            密钥：unlock（解锁方式）+ signer（GPG 子进程会话）
├── web3/            ★ 链层，见下（11 个文件）
├── models/          领域类型（5 个）
├── middlewares/     auth(JWT) / error / validate
├── workers/         GPG 签名子进程
├── config/          env + zod schema
└── utils/           errors / logger / mutex / response
```

45 个文件。数据读写全部经 `repositories/jsonStore.ts` —— 日后换数据库只改这一个文件。

### 环境变量只有 1 个

`ALCHEMY_API_KEY`，而且可以不填（降级到 Lark / ChainList）。

其余全在 `src/config/env.ts` 里当常量：端口、路径、超时、CORS。
JWT 密钥每次启动随机生成 —— 单实例部署没必要固化，少一个会泄露的长期密钥。
GPG 口令/PIN 不在配置里，由本机的 gpg-agent 负责。

---

## 5. web3 层：两个 adapter

| | **ChainMetaAdapter** | **ChainTxAdapter** |
|---|---|---|
| 性质 | 纯函数，**不碰网络** | **所有网络 IO** |
| 方法 | `isValidAddress` `normalizeAddress`（比较用）`displayAddress`（展示用）`explorerTxUrl` `capabilities` | `readBatch` `simulate` `getTransaction` `executeBatch` `checkHealth` `reset` |
| 为什么分 | 校验配置、拼审计信息时都要用地址逻辑，但不该为此起节点；单测不用 mock 网络 | 重连、限流、nonce 锁、批量策略关在一个盒子里 |

注册表 `web3/chains.ts` 每个链族只有一行 `{ name, meta, tx }`。

**EVM 与 Tron 的差异全部封在各自 adapter 内：**

| | EVM | Tron |
|---|---|---|
| 防重放 | nonce，必须递增且无空洞 | ref_block + expiration（60s 过期） |
| 批量读 | Multicall3，一次 RPC | 受限并发（TronGrid 有 QPS 限制） |
| 批量写 | nonce 排序后可并发广播 | **必须串行**（并发会被判重复交易） |
| 拼装时机 | 可提前 | **每次签名前现场构建** |
| 地址 | EIP-55 checksum | 比较用 hex41，展示用 base58 |
| 回执 | `status` 0/1 | `SUCCESS`/`REVERT`/`OUT_OF_ENERGY`/`OUT_OF_TIME` |

---

## 6. 上链保障（gas 阶梯重发）

运维操作卡在内存池等于没执行，所以：

```
首发 gas = 节点推荐值 × N        （以太坊主网 N=8，其它链 N=2）
   ↓ 等 T 毫秒                   （主网 30s，其它 10s）
拿到回执？→ 结束
   ↓ 没拿到
multicall 查合约状态
   ├─ 状态已达成 → 认定成功（可能交易生效了只是回执慢，也可能别人先做了）
   └─ 状态没变   → gas 翻倍，用**同一个 nonce** 发替换交易，最多 4 次
```

同 nonce 是关键：这是"替换"不是"再发一笔"，最终只有一笔上链。

---

## 7. 密钥解锁：可插拔

两种方式共用同一条流式通道，差异全在 `keys/unlock.ts` 的 profile 里：

| | **passphrase** | **yubikey** |
|---|---|---|
| 密钥文件 | gpg 对称加密（AES256） | 加密给卡上的 OpenPGP 公钥 |
| 用户输入 | 口令 | PIN |
| 需要触摸 | 否 | **是** —— 后端会先推一条"请触摸设备"给前端 |
| 输错重试 | 可以 | **绝不自动重试**，连错 3 次锁卡 |
| 解密超时 | 60s | 120s（要留时间给人伸手去按） |
| 前置检查 | 无 | `gpg --card-status`，卡不在就直接拒绝，不浪费 PIN 尝试次数 |

在 `data/signers.json` 里用 `unlock` 字段声明，默认 `passphrase`。

**后端运行时不持有任何口令** —— 解密交给本机的 gpg-agent + pinentry。
无终端后台运行时 pinentry 弹不出来会失败，报错会明确指出这一点（而不是误报成"口令错"）。

> YubiKey 在这里的角色是**保护密钥文件**，不是直接做链上签名 ——
> OpenPGP 卡无法为 secp256k1 以太坊交易做原生签名，所以仍然是
> 「卡解密出私钥 → 子进程内存里签名 → 立即清零」。

## 8. GPG 安全模型

```
HTTP 请求体(passphrase) ──pipe──▶ 父进程(不读取) ──pipe──▶ worker stdin ──pipe──▶ gpg stdin
                                                                          ↓
                                                              私钥（只在子进程内存）
                                                                          ↓
                                                        派生地址 == 配置声明地址？
                                                          否 → 立即退出(code 2)
                                                          是 → 连续签完 N 笔 → 清零 → exit
```

- passphrase **全程不在 JS 里落地**：不 JSON.parse、不进变量、不进 argv（`ps` 可见）、不进 IPC
- 私钥只在一次性子进程内存中，用完 `process.exit(0)`
- gpg 用 `detached:true` 建独立进程组，超时 `kill(-pgid)` 杀整组，防孤儿进程持有密钥
- 已签名的 rawTx 只在广播函数内的局部变量存在 —— 泄露出去任何人都能重放这笔 pause
- 无常驻解锁 session：每次批量操作现输 passphrase

---

## 9. 权限

三层，各管一件事，不重复：

1. **能不能登录** —— 地址在 `operators.json` 白名单里，且 EVM 签名验得过
2. **能不能动** —— 角色不是 `viewer`（HTTP 层 `requireWriteRole` 拦）
3. **有没有密钥** —— 所选合约涉及的每个链族都配了签名密钥，缺一个整批拒绝

早期版本给后端密钥又配了一套 `allowedChains`/`allowedBusinessLines`，
后来去掉了 —— 能操作什么由**登录的人**决定，给密钥再配一套是重复的，反而容易配错留下漏洞。

不做"部分放行"—— 半停半没停的中间态比全不执行更危险。

---

## 10. 边界条件

1. 跨链、跨链族批量 → 按链分组**并行**，每个链族各开一个 GPG 子进程（共用同一 passphrase 流）
2. 已 paused 再点暂停 → 前置检查跳过，不消耗 nonce、不花 gas
3. 状态读不到（RPC 挂了）→ **不跳过**，交给链上判断，别因为读不到就漏掉紧急暂停
4. 预演失败 → 标 skipped 且不消耗序号，不留 nonce 空洞
5. 广播失败 → 序号让给下一笔
6. 签名失败 → 密钥有问题，该链整批中止（已完成的部分仍汇报）
7. 配置在任务创建后变化 → 整批中止（`expectedConfigVersion` 比对）
8. SSE 断线 → `Last-Event-ID` 重放漏掉的事件
9. 钱包在错误的链 → 自动 `wallet_switchEthereumChain`，链未添加则 `wallet_addEthereumChain`
10. 钱包模式下勾选了另一链族的合约 → 该行禁选

---

## 11. 部署与限制

**v1 单实例**：job、登录 nonce 存于内存，不支持水平扩展。操作日志 JSONL 落盘，重启不丢。

**必须做的**：`JWT_SECRET` 用 `openssl rand -hex 32` 生成；`secrets/` 与 `.env` 已在 `.gitignore`；
生产用 HTTPS（passphrase 走请求体）；`CORS_ORIGINS` 白名单收紧。
