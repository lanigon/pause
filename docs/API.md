# 后端 API

Base `/api`　响应统一 `{ success, data, error }`　除 `/health` `/auth/nonce` `/auth/login` 外全部需要 JWT。

```jsonc
{ "success": true,  "data": {...}, "error": null }
{ "success": false, "data": null,  "error": { "code": "CONFIG_CHANGED", "message": "配置已更新，请刷新" } }
```

错误码：`BAD_REQUEST` `UNAUTHORIZED` `TOKEN_EXPIRED` `FORBIDDEN` `NOT_FOUND` `CONFIG_CHANGED`
`SIGNER_SCOPE_DENIED` `GPG_DECRYPT_FAILED` `GPG_TIMEOUT` `SIMULATE_FAILED` `BROADCAST_FAILED`
`JOB_CONFLICT` `RATE_LIMITED` `INTERNAL`

---

## 1. 登录 `/auth/login` — 就这一个接口

```jsonc
POST /auth/login
{ "address": "0xf39F…", "timestamp": 1787848000000, "nonce": "a1b2…", "signature": "0x…" }
→ { "accessToken": "eyJ…", "expiresIn": 900, "operator": { address, label, role, businessLines } }
```

**只认 EVM 签名**：operator 的身份就是一个 EVM 地址，在 `operators.json` 白名单里就发 token。
拿到 token 后所有需要鉴权的接口都能用，**包括操作 Tron 合约** ——
Tron 钱包只用于「钱包模式」发交易，不参与登录。

挑战消息由前端自己拼，后端用同样模板重建后 `ethers.verifyMessage` 验签：

```
合约管理平台 登录

地址: 0xf39F…
时间: 2026-08-27T16:00:00.000Z
随机数: a1b2c3…

签名此消息即可登录，不会发起任何链上交易，也不会花费任何 gas。
```

不需要服务端 nonce（省一次往返，也不用存状态）。防重放两条：
时间戳必须在 ±2 分钟内；用过的签名在内存里记 5 分钟，重复提交直接 401。
地址不在白名单 → `403 FORBIDDEN`。

---

## 2. 配置 `/registry` — 前端渲染的唯一数据源

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/registry` | 一次拿全。**只返回当前操作员有权限的业务线与合约，链和 RPC 随之收窄到这些合约实际涉及的范围** |
| GET | `/states?businessLine=` 或 `?ids=a,b` | 后端读链上状态（兜底；前端平时自己 multicall） |
| POST | `/registry/reload` | 热重载配置，仅 admin |

```jsonc
// GET /registry
{
  "configVersion": "sha256:034d7c0711584bef",
  "businessLines": [{ "id": "payment", "name": "支付" }],
  // 只有合约实际涉及的链。rpcs 由后端三级降级后下发，只含公开的
  // （Alchemy 那种含 API key 的永远留在后端）—— 前端不需要配任何 RPC
  "chains": [{ "key": "morph", "name": "Morph Mainnet", "type": "evm", "chainId": 2818,
               "explorer": "...", "confirmations": 2, "symbol": "ETH", "decimals": 18,
               "rpcs": ["https://rpc.morphl2.io", "https://rpc-quicknode.morphl2.io"],
               "multicall3": "0xcA11bde0..." }],
  "contracts": [{ "id": "payment-vault-morph", "name": "Payment Vault",
                  "businessLine": "payment", "chain": "morph", "address": "0x..." }],
  "signers":   [{ "chainType": "evm", "address": "0x...", "role": "signer",
                  "allowedChains": ["morph"], "businessLines": ["*"], "unlock": "passphrase" }],
  "capabilities": [{ "family": "evm", "name": "EVM", "feeModel": "gas",
                     "walletKinds": ["injected-eip1193"] }],
  "operations":   [{ "kind": "pause", "label": "暂停" }, { "kind": "unpause", "label": "恢复" }]
}
```

---

## 3. GPG 批量执行 `/gpg`

**两步提交**：passphrase 单独走 raw body，绝不进 JSON。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/gpg/batch` | `{ operation, contractIds[], expectedConfigVersion, confirm:"CONFIRM" }` → `{ jobId, itemCount, families }`。**只创建任务并完成全部授权校验，不执行** |
| POST | `/gpg/batch/:jobId/passphrase` | `Content-Type: text/plain`，body 即 passphrase。**后端不解析 body**，原始流直通 GPG 子进程 stdin → `202` |
| GET | `/gpg/job/:jobId/stream` | **SSE**，实时推进度。支持 `Last-Event-ID` 断线重放（EventSource 不能带 header，token 走 `?token=`） |
| GET | `/gpg/job/:jobId` | 轮询兜底：任务快照 |
| POST | `/gpg/job/:jobId/cancel` | 取消尚未执行的剩余部分 |

创建任务时校验：configVersion 匹配 → 数量 ≤ 50 且无重复 → 四道授权关。
**一次任务可以跨多条链、跨多个链族**：按链分组并行发交易，每个链族各开一个 GPG 子进程
（同一个 passphrase 流同时 pipe 给多个子进程）。

### SSE 事件

```
event: start       data: { "phase":"start","message":"开始批量暂停，共 4 个合约","at":... }
event: decrypt     data: { "phase":"decrypt","message":"请触摸 YubiKey 以解锁 evm 密钥…" }   // 仅 yubikey 模式
event: decrypt     data: { "phase":"decrypt","message":"evm 密钥解密成功，签名地址 0x..." }
event: skip        data: { "phase":"skip","contractId":"...","message":"...：合约已处于暂停状态" }
event: sign        data: { "phase":"sign","contractId":"...","message":"...：已签名" }
event: broadcast   data: { "phase":"broadcast","contractId":"...","hash":"0x...","explorerUrl":"..." }
event: confirmed   data: { "phase":"confirmed","contractId":"...","message":"...：已确认" }
event: failed      data: { "phase":"failed","contractId":"...","message":"...：原因" }
event: done        data: { "phase":"done","message":"批量暂停完成：成功 3，失败 0，跳过 1" }
: heartbeat                                                    // 每 15s，防代理断连
```

事件里**不含**任何签名材料、rawTx、私钥、passphrase。

---

## 4. 操作日志 `/logs`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/logs?limit=200&offset=0&address=` | 启动时拉历史，倒序分页 |
| POST | `/logs` | `{ operation }`。地址与时间由后端从 JWT 填，忽略请求体里的任何身份字段 |

```jsonc
{ "address": "0xf39F…2266", "operation": "pause Payment Vault", "ts": "2026-08-27T15:45:43.973Z" }
```

GPG 模式的日志由后端自己写，前端不用上报。

---

## 5. 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 无需认证 |
| GET | `/state` | configVersion、链数、合约数、运行中任务数、日志条数 |
| GET | `/state/rpc` | 各链每个 RPC 的可用性、延迟、区块高度 |

---

## 中间件顺序

```
helmet → cors(白名单)
  → passphrase 路由：跳过 body 解析（保持原始流）
  → 其它路由：express.json(100kb)
  → 路由
      /health · /auth/login  → 无需认证
      其余                   → requireAuth(JWT) → [requireWriteRole] → zod 校验 → controller
  → 404 → errorHandler（生产环境隐藏内部细节）
```

> 没有限流中间件。这是内部运维工具，接口都在 JWT 之后，
> 真要限流应该放在反向代理层，而不是应用里。
