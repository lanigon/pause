# 加一个后端接口

样板三处：一条路由、一个 controller 函数、一个 zod schema。
真正要想清楚的只有一件事 —— **逻辑放哪一层**。

---

## 分层判据

| 层 | 职责 | 检验方式 | 放错的表现 |
|---|---|---|---|
| `routes/` | path → controller，串中间件 | 一行，没有别的 | 业务逻辑散进路由表，看不出接口有几个 |
| `controllers/` | 解析参数、组装响应、SSE 帧、状态码 | 换个前端就得改的东西 | — |
| `services/` | 编排：把 core 与 repository 串成一个接口要的样子 | 与某个 controller 一一对应 | 编排散在 controller 里，换写法就漏 |
| `core/` | 领域能力：配置、执行、身份、同步、操作闭集 | 能脱离 Express 单测 | 领域规则被 HTTP 绑住，脚本用不了 |
| `repositories/` | 数据读写。**唯一碰文件系统的地方** | 换成数据库只改这里 | 换存储时会漏掉绕过去的那条路 |
| `lib/` | web3 / keys / rpc / utils，零业务依赖 | 能整体搬到别的项目 | — |

判断放哪层，问两句：**换个前端还成立吗？换个存储还成立吗？**

- 只跟 HTTP 有关（分页参数、状态码、SSE 帧）→ controller
- 换个前端仍然成立（「广播成功才记日志」）→ service 或 core
- 换成数据库要改的 → repository

> 两处踩过的坑：`sync` 曾绕过 repository 直接读写 `contracts.json`，换存储时会漏；
> `log.controller` 曾直接调 repository，把「地址一律从 JWT 取」这条安全规则散在 HTTP 层，
> 换个 controller 写法就可能丢掉。两个都已经修了。

---

## 走一遍：加 GET /tx/:chain/:hash

需求：给一个 hash，回它当前在链上的状态。日志里点进去之前想先确认一眼时用。

这个例子挑得不随意 —— `ChainTxAdapter.getTransaction` 已经在两个链族里实现好了，
但**目前没有任何生产代码调它**。加这个接口正好把它接上。

### 先定层

| 问题 | 归类 | 落点 |
|---|---|---|
| `chain` 是不是一条已知的链 | 配置的事 | `core/config.getChain` 已有 |
| 怎么按链族去问节点 | 链的事 | `lib/web3` 的 `tx(family).getTransaction` 已有 |
| 「先查链存不存在，再去问节点」 | 编排 | 新写：`services/tx.service.ts` |
| 路径参数怎么校验、响应长什么样 | HTTP | 新写：`controllers/tx.controller.ts` |

core 与 lib 一行不用动。

### schema 与 controller

schema 写在 controller 里 —— 参数形状是 HTTP 的事，不是领域概念。

```ts
// src/controllers/tx.controller.ts
import type { Request, Response } from 'express'
import { z } from 'zod'
import * as txService from '../services/tx.service.js'
import { validated } from '../middlewares/validate.middleware.js'
import { ok } from '../lib/utils/response.js'

export const txParamsSchema = z.object({
  chain: z.string().min(1).max(64),
  hash: z.string().min(1).max(128),
})

export async function getTx(req: Request, res: Response): Promise<void> {
  const { chain, hash } = validated<z.infer<typeof txParamsSchema>>(req)
  ok(res, await txService.snapshot(chain, hash))
}
```

### service

```ts
// src/services/tx.service.ts
import { getChain } from '../core/config.js'
import { tx, meta } from '../lib/web3/index.js'
import type { TransactionSnapshot } from '../lib/web3/types.js'

/** 链不存在时 getChain 直接抛 NOT_FOUND，不用在这里再判一次 */
export async function snapshot(
  chainKey: string,
  hash: string,
): Promise<TransactionSnapshot & { explorerUrl: string }> {
  const chain = getChain(chainKey)
  const snap = await tx(chain.type).getTransaction(chain, hash)
  return { ...snap, explorerUrl: meta(chain.type).explorerTxUrl(chain, hash) }
}
```

### 路由

```ts
// src/routes/index.ts —— 必须在 router.use(requireAuth) 之后
router.get(
  '/tx/:chain/:hash',
  validateParams(txParamsSchema),
  asyncHandler(tx.getTx),
)
```

> `validateParams` 现在还没有 —— 已有的两个是 `validateBody` 与 `validateQuery`。
> 路径参数照 `validateQuery` 抄一份即可，同样把结果写进 `req.validatedQuery`，
> `validated<T>(req)` 就能取到。

---

## 路由行的五个要素

| 要素 | 适用场景 | 漏改的表现 |
|---|---|---|
| `asyncHandler` | 所有 async handler | 抛出的错进不了错误中间件，请求挂着不返回 |
| `validateBody` / `validateQuery` | 有参数就要 | 脏数据直接进业务层 |
| 位置在 `router.use(requireAuth)` **之后** | 除非是探针 | 接口裸奔，不用登录就能调 |
| `requireWriteRole` | 会改变状态的接口 | viewer 账号也能执行操作 |
| `ok()` / `fail()` | 所有响应 | 绕过统一信封，前端 `request()` 解不出来 |

---

## 参数校验的两条路

| 来源 | 中间件 | controller 里的取法 | 差异原因 |
|---|---|---|---|
| body | `validateBody(schema)` | `req.body as z.infer<typeof schema>` | 中间件把校验后的值写回了 `req.body` |
| query | `validateQuery(schema)` | `validated<z.infer<typeof schema>>(req)` | Express 5 的 `req.query` 是 getter，写不回去，只能挂到 `req.validatedQuery` |

query 参数全是字符串，数字必须 `z.coerce`：

```ts
limit: z.coerce.number().int().min(1).max(500).default(200)
//     ^^^^^^^^ 少了它，limit=200 会因为「不是 number」被拒
```

**不要直接读 `req.query`** —— 那是没校验、没转型的原始值。

---

## 错误处理

抛 `AppError`，错误中间件负责翻成状态码与信封：

```ts
throw new AppError(ErrorCode.CONFIG_CHANGED, '配置已更新，请刷新页面后重试')
```

三条规矩：

| 规矩 | 说明 |
|---|---|
| 不要自己 `res.status(...).json(...)` | 绕过统一信封，前端解不出来 |
| 新错误码两处都要加 | `lib/utils/errors.ts` 的 `ErrorCode` 与 `DEFAULT_STATUS`。只加前者，状态码会是 `undefined` |
| 只加真的会被 throw 的码 | 后端从不产出的码，前端会照着写一条永远走不到的分支，而且从代码上看不出它是死的 |

现成的快捷构造：`badRequest(message, details?)`、`notFound(message)`。

生产环境下未归类的异常只回「服务器内部错误」—— GPG 与节点的原始报错可能含路径、密钥文件名。

---

## SSE 形态

响应体本身就是流。用 `openSse(res)`，不要自己写响应头和帧格式。

```ts
const stream = openSse(res)
try {
  await doWork((event) => stream.emit(event.phase, event), stream.aborted)
} finally {
  stream.close()          // 一定要，放 finally
}
```

**切流的那一刻是一道分界线**：

| 阶段 | 错误的表达方式 | 例子 |
|---|---|---|
| `openSse` 之前 | 正常的 JSON 错误响应 + 状态码 | `gpg.controller` 的 `plan()` 授权校验 |
| `openSse` 之后 | 只能推事件，状态码已经定死 200 | 执行过程中的任何失败 |

所以能校验的都要在 `openSse` 之前校验完。

`stream.aborted` 是客户端断开时置位的 `AbortSignal`，传给耗时操作让它提前收手。

> `openSse` 里有一处不显然但要命的细节：断开判断监听的是 **`res`** 而不是 `req`。
> 请求体被 `express.json` 读完后 `req` 的 `'close'` 会立刻触发，拿它当断开信号
> 会把**每一次正常执行都误报成「已取消」**。已经封在里面了，用 `openSse` 就不会踩到。

前端拿不了浏览器的 `EventSource`（它只支持 GET、不支持自定义头），
所以 `store/api.ts` 里自己解帧 —— 新增 SSE 接口时前端照 `readSse` 复用即可。

现成例子：`gpg.controller.postBatch`、`registry.controller.getRegistryStream`。

---

## 身份与审计

| 事项 | 做法 | 理由 |
|---|---|---|
| 取当前操作者 | `currentOperator(req)` | 从 JWT 还原，挂在 `req.operator` 上 |
| 写审计日志的地址 | **一律从 JWT 取，忽略请求体里的身份字段** | 否则任何登录用户都能伪造成别人的操作记录 |
| token 位置 | `Authorization: Bearer` 头 | SSE 例外，走 query，且**仅对 GET 生效** |
| 请求头落盘 | 一个都不落 | serializer 只放行 reqId / method / url / IP |
| 链路追踪 | 每个请求回写 `x-request-id` 响应头 | 排查时能把散落的日志串回一次请求 |

健康检查路径在 `SILENT_PATHS` 里，不记访问日志 —— 它被轮询，逐条记会淹没有用的行。

---

## 响应信封

```ts
{ success: boolean, data: T | null, error: { code, message, details? } | null }
```

前端 `request()` 认这个形状。`ok(res, data, status = 200)` 与 `fail(...)` 各管一半。

---

## 测试要锁的四类

`tests/http.test.ts` 里有现成例子，优先锁这四类：

| 用例 | 锁住的内容 |
|---|---|
| 没带 token 返回 401 | 忘挂 `requireAuth` 会在这里露馅 |
| viewer 调写接口返回 403 | 忘挂 `requireWriteRole` |
| 参数非法返回 400，且说得清是哪个字段 | schema 挂没挂、coerce 有没有漏 |
| 响应体的形状 | 前端靠信封解析 |

跑一遍：

```bash
npm --prefix backend run typecheck && npm --prefix backend test
```

改动只在后端时用上面这条；两边都动了就在仓库根跑 `npm run typecheck && npm test`。

---

## 反模式

| 反模式 | 理由 |
|---|---|
| 只有测试在调的接口 | 曾经有三个（`/state`、`/state/rpc`、`/registry/reload`），生产零引用，已删。加接口前先确认真有人要用 |
| controller 直接调 repository | 业务规则会散在 HTTP 层，换个写法就漏 |
| 让 HTTP 请求等一个长任务跑完 | GPG 批量是边跑边推进度的，不是跑完再返回 |
| 为了「统一」把 SSE 接口也做成先返回 jobId 再轮询 | 多一份任务状态要维护，而连接断了本来就有落盘日志兜底 |
| 直接读 `req.query` / `req.body` 而不过 schema | 拿到的是没校验没转型的原始值 |

---

## 现有接口

| 方法 | 路径 | 认证 | 调用方 |
|---|---|---|---|
| GET | `/health` | 无 | `npm run check` 与部署探针 |
| POST | `/auth/login` | 无 | 前端登录，EVM 签名换 JWT |
| GET | `/registry/sync` | JWT | 前端启动加载。SSE，带 Lark 同步进度，`?force=1` 顺带重载本地配置 |
| POST | `/gpg/batch` | JWT + write | 批量执行。SSE，响应体即进度流 |
| POST | `/gpg/cancel` | JWT + write | 按操作者地址取消，不是按连接 |
| GET | `/logs` | JWT | 交易日志，倒序分页 + 时间窗 |
| GET | `/logs/daily` | JWT | 日期选择器的角标 |
| POST | `/logs` | JWT | 钱包模式广播成功后上报 |

八个。取数只有 `/registry/sync` 一个入口 —— 它是一条状态流，
过程中的每一步都是事件，结束时给出全量配置，所以不需要另一个接口去问「现在什么情况」。
