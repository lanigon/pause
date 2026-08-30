# 后端 API

Base `/api`　响应统一 `{ success, data, error }`　除 `/health` 与 `/auth/login` 外全部需要 JWT。

```jsonc
{ "success": true,  "data": {...}, "error": null }
{ "success": false, "data": null,  "error": { "code": "CONFIG_CHANGED", "message": "配置已更新，请刷新" } }
```

一共 13 个接口。每个请求都会带回一个 `x-request-id` 响应头，报障时给这个值就能定位到日志。

### 错误码

前端按 `code` 分支，`message` 只用于展示。**只列后端真的会 throw 的码** ——
留下产不出来的码，前端会照着写一条永远走不到的分支。

| 分类 | 码 | HTTP |
|---|---|---|
| 通用 | `BAD_REQUEST` `NOT_FOUND` `INTERNAL` | 400 / 404 / 500 |
| 身份 | `UNAUTHORIZED` `TOKEN_EXPIRED` `FORBIDDEN` | 401 / 401 / 403 |
| 配置 | `CONFIG_CHANGED` | 409 |
| 授权 | `SIGNER_SCOPE_DENIED` | 403 |
| 密钥 | `GPG_KEY_MISSING` `GPG_DECRYPT_FAILED` `GPG_WRONG_SECRET` `GPG_TIMEOUT` `GPG_PINENTRY_UNAVAILABLE` `GPG_ADDRESS_MISMATCH` | 500 / 400 / 400 / 504 / 500 / 500 |
| YubiKey | `GPG_CARD_ABSENT` `GPG_CARD_BLOCKED` `GPG_CARD_LOW_RETRIES` `GPG_CARD_NO_KEY` | 503 / 423 / 423 / 500 |
| 链上 | `SIMULATE_FAILED` `BROADCAST_FAILED` `RPC_UNAVAILABLE` | 422 / 502 / 503 |

---

## 1. 登录 `/auth/login` — 就这一个接口

```jsonc
POST /auth/login
{ "address": "0xf39F…", "timestamp": 1787848000000, "nonce": "a1b2…", "signature": "0x…" }
→ { "accessToken": "eyJ…", "expiresIn": 28800, "operator": { "address", "label", "role" } }
```

**只认 EVM 签名**：operator 的身份就是一个 EVM 地址，在 `operators.json` 白名单里就发 token。
拿到 token 后所有需要鉴权的接口都能用，**包括操作 Tron 合约** ——
Tron 钱包只用于「钱包模式」发交易，不参与登录。

挑战消息由前端自己拼，后端用**逐字相同**的模板重建后 `ethers.verifyMessage` 验签：

```
合约管理平台 登录

地址: 0xf39F…
时间: 2026-08-30T16:00:00.000Z
随机数: a1b2c3…

签名此消息即可登录
```

> 改这段文字要同时改三处：`services/auth.service.ts`、`frontend/src/store/api.ts`、
> 以及两个测试。差一个字符验签就过不了，而且是登录直接坏掉。

不需要服务端 nonce（省一次往返，也不用存状态）。防重放两条：
时间戳必须在 ±2 分钟内；用过的签名在内存里记 5 分钟，重复提交直接 `401`。
地址不在白名单 → `403 FORBIDDEN`。

JWT 有效期 8 小时。**签名密钥每次进程启动随机生成**，所以后端一重启所有人都要重新登录。

---

## 2. 配置 `/registry` — 前端渲染的唯一数据源

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/registry` | 纯本地，立刻返回。带 `ETag`，配置没变回 `304` |
| GET | `/registry/sync` | **SSE**。先跟 Lark 对一遍再给数据。`?force=1` 跳过节流 |
| GET | `/states?businessLine=` 或 `?ids=a,b` | 后端读链上状态（兜底；前端平时自己 multicall） |
| POST | `/registry/reload` | 热重载配置，**仅 admin** |

**不按人裁剪** —— 只有一份预计算好的 DTO，所有能登录的人看到的内容都一样。
角色的区别只在能不能动（`viewer` 由 `requireWriteRole` 在写接口上拦）。

```jsonc
// GET /registry
{
  "configVersion": "sha256:034d7c0711584bef",
  "businessLines": [{ "id": "payment", "name": "支付" }],
  // 只有合约实际涉及的链。rpcs 由后端三级降级后下发，且**只含公开的**
  //（Alchemy 那种含 API key 的永远留在后端）—— 前端不需要配任何 RPC
  "chains": [{ "key": "morph", "type": "evm", "chainId": 2818,
               "explorer": "https://explorer.morphl2.io",
               "symbol": "ETH", "decimals": 18,
               "rpcs": ["https://rpc.morphl2.io", "https://rpc-quicknode.morphl2.io"] }],
  "contracts": [{ "id": "payment-vault-morph", "name": "Payment Vault",
                  "businessLine": "payment", "chain": "morph", "address": "0x..." }],
  "operations": [{ "kind": "pause", "label": "暂停" }, { "kind": "unpause", "label": "恢复" }]
}
```

> DTO 里**没有** `signers`，也没有 `capabilities` —— 前端不需要知道后端用哪把密钥签。

### `/registry/sync` 的 SSE 事件

```
event: source    data: { "phase":"source","ok":true,"message":"从 Lark 拉到 12 行" }
event: diff      data: { "phase":"diff","ok":true,"message":"2 处变更","changes":["新增合约 …"] }
event: apply     data: { "phase":"apply","ok":true,"message":"已写入并重载" }
event: registry  data: { …与 GET /registry 相同…, "synced": { "changed":true, "fromLark":true } }
```

**Lark 出任何问题都不影响拿到数据**：事件里说明原因（`code` 如 `LARK_EMPTY`、`THROTTLED`），
`registry` 事件照发本地版本。这是紧急暂停工具，可用性优先于数据新鲜度。
不想等同步的场景（轮询、降级）走 `GET /registry`。

---

## 3. GPG 批量执行 `/gpg`

**一个请求做完全部事情**，响应体就是 SSE 流。前端**不传任何密钥材料**。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/gpg/batch` | `{ operation, contractIds[], expectedConfigVersion, confirm:"CONFIRM" }` → **响应即 SSE** |
| POST | `/gpg/cancel` | 取消**本操作者**正在跑的任务 |

没有 jobId、没有两步提交、没有 passphrase 接口、没有断线重放 ——
口令 / PIN 由后端本机的 gpg-agent + pinentry 直接问用户，从不经过 HTTP。

请求进来先做授权校验（configVersion 比对 → 链族有密钥），**不过就走正常的 JSON 错误响应**，
还没切到 SSE。切到 SSE 之后所有错误都以事件形式推送，不再改 HTTP 状态码。

一次任务可以跨多条链、跨多个链族：按链分组并行，每个链族各开一个 GPG 子进程。

### 为什么 cancel 要单独一个接口

前端 `cancelBatch()` 已经先 `abort()` 断开 SSE（后端收到 close 会中止）。
这个接口是给三种情况兜底的，它们的共同点是**那条连接已经不在了**：

- **页面刷新后** —— 新页面没有原来那条 SSE，但后端任务还在跑，不然要空转到 180 秒超时
- 换个标签页 / 另一台设备取消
- 中间有代理缓冲，后端没及时看到断连

所以它按**操作者地址**取消，不是按连接。已经广播出去的拦不住 —— 那是链上的事了；
取消只保证还没签的不签、没发的不发。

### SSE 事件

```
event: start       data: { "phase":"start","message":"开始批量暂停，共 4 个合约","at":… }
event: decrypt     data: { "phase":"decrypt","message":"请触摸 YubiKey 以解锁 evm 密钥…" }  // 仅 yubikey
event: decrypt     data: { "phase":"decrypt","message":"evm 密钥解密成功，签名地址 0x…" }
event: simulate    data: { "phase":"simulate","contractId":"…","message":"…：预演通过，预计 gas …" }
event: balance     data: { "phase":"balance","message":"签名地址余额可发约 120 笔" }
event: skip        data: { "phase":"skip","contractId":"…","message":"…：合约已处于暂停状态" }
event: sign        data: { "phase":"sign","contractId":"…","message":"…：已签名" }
event: broadcast   data: { "phase":"broadcast","contractId":"…","hash":"0x…","explorerUrl":"…" }
event: confirmed   data: { "phase":"confirmed","contractId":"…","message":"…：已确认" }
event: failed      data: { "phase":"failed","contractId":"…","message":"…：原因","code":"…","hint":"…" }
event: done        data: { "phase":"done","message":"批量暂停完成：成功 3，失败 0，跳过 1" }
: heartbeat                                                    // 每 15s，防代理断连
```

事件里**不含**任何签名材料、rawTx、私钥、口令。
`failed` / `error` 带 `code` 与 `hint`，前端据此引导下一步（比如「去插 YubiKey」）。

---

## 4. 交易日志 `/logs`

**只记交易**，不记登录之类的行为 —— 日志面板要回答的是「链上发生了什么」。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/logs?limit=&offset=&address=&from=&to=` | 倒序分页。`from`/`to` 是 ISO 时间窗 `[from, to)` |
| GET | `/logs/daily?from=&to=&offsetMinutes=` | 每天各有几笔，给日期选择器打角标 |
| POST | `/logs` | 钱包模式广播成功后上报 |

```jsonc
// POST /logs —— 地址与时间由后端从 JWT 填，忽略请求体里的任何身份字段
{ "operation": "pause", "contract": "payment-vault-morph",
  "chain": "morph", "hash": "0x…", "status": "broadcast" }

// 一条日志
{ "address": "0xf39F…2266", "operation": "pause", "contract": "payment-vault-morph",
  "chain": "morph", "hash": "0x…", "status": "confirmed", "ts": "2026-08-30T15:45:43.973Z" }
```

`status`：`broadcast` 已发出 · `confirmed` / `failed` 最终结果 · `cancelled` 用户中途取消（没发出去）。

**GPG 模式由后端自己写两条**（广播时一条、确认后一条，同一个 `hash`）；
**钱包模式只有 broadcast 一条** —— 前端不等确认。所以前端按 `hash` 去重、保留最新那条。

`/logs/daily` 要传浏览器的 `getTimezoneOffset()`，后端按**本地日历日**分组 ——
不然日历上标的数和点进去看到的对不上。

---

## 5. 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | **无需认证**。存活探针，返回 uptime |
| GET | `/state` | configVersion、链数、合约数、运行中任务数、日志条数。**全读内存，很快** |
| GET | `/state/rpc` | 各链每个 RPC 的可用性、延迟、区块高度。**会真的去探测，慢一个量级** |

`/state` 与 `/state/rpc` 分开就是因为快慢差一个量级 —— 合并会让顶栏的健康指示被 RPC 探测拖住。

`/state/rpc` 的返回里**不含 `rawUrl`**：那个字段带 apiKey，只在进程内用来对回节点。

---

## 中间件顺序

顺序即安全边界，见 `src/app.ts`：

```
httpLogger(pino)  ← 排最前：被 helmet / cors 挡掉的请求也要留痕
  → helmet → cors(白名单) → express.json(100kb)
  → /api 路由
      /health · /auth/login  → 无需认证
      ────── router.use(requireAuth) ──────  ← 这行往下全部要 JWT
      其余 → [requireWriteRole] → zod 校验 → asyncHandler(controller)
  → 404 → errorHandler（生产环境隐藏内部细节）
```

> ⚠ `router.use(requireAuth)` 是**位置敏感**的：在它上面加路由 = 悄悄开一个免认证接口，
> 不会有任何报错。见 `src/routes/index.ts` 里那条分界注释。

日志方面有三个刻意的取舍：**请求头一个都不落盘**（serializer 只放行 reqId / method / url / ip，
Authorization 根本没机会进日志对象）；健康检查不记；SSE 那条路由照常记
（它的 responseTime 就是整批耗时，客户端中途断开也会记一行）。

> 没有限流中间件。这是内部运维工具，接口都在 JWT 之后，
> 真要限流应该放在反向代理层，而不是应用里。
