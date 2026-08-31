# 加一个后端接口

样板很薄 —— 一条路由 + 一个 controller 函数 + 一个 zod schema，三处。
真正要想清楚的是**逻辑放哪一层**。

## 分层

```
routes/          挂路由、串中间件。一行
controllers/     HTTP 的事：解析参数、组装响应。不放业务规则
services/        业务编排：调 core 与 repository，处理"这个操作意味着什么"
core/            领域逻辑：配置注册表、执行编排、身份、同步、操作闭集
repositories/    数据读写。**唯一碰文件系统的地方**
lib/             基础能力（web3 / keys / rpc / utils），零业务依赖
```

判断放哪一层，问一句：**换个前端还成立吗？换个存储还成立吗？**

- 只跟 HTTP 有关（分页参数、状态码、SSE 帧）→ controller
- 换个前端仍然成立（"广播成功才记日志"）→ service 或 core
- 换成数据库要改的 → repository

> 曾经 `sync` 绕过 repository 直接读写 `contracts.json`，`log.controller`
> 直接调 repository 把"地址从 JWT 取"这条规则散在 HTTP 层。两个都修了 ——
> 前者换数据库时会漏，后者换个 controller 写法就可能把安全规则漏掉。

## 三步

### ① Schema（放 controller，因为参数是 HTTP 的事）

```ts
export const thingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  //     ^^^^^ query 参数都是字符串，必须 coerce
  since: z.string().datetime().optional(),
})
```

### ② Controller

```ts
export async function getThings(req: Request, res: Response): Promise<void> {
  const query = validated<z.infer<typeof thingQuerySchema>>(req)
  ok(res, await thingService.list(query))
}
```

`validated()` 取的是中间件校验过的值，不要直接读 `req.query`。
`ok()` 统一包成 `{ success, data, error }` 的信封，前端 `request()` 认这个形状。

### ③ 路由

```ts
router.get('/things', validateQuery(thingQuerySchema), asyncHandler(getThings))
```

四件事按顺序考虑：

| 要素 | 怎么写 | 漏了会怎样 |
|---|---|---|
| `asyncHandler` | 包住所有 async handler | 抛出的错不会进错误中间件，变成挂起的请求 |
| `validateQuery` / `validateBody` | 有参数就要 | 脏数据直接进业务层 |
| 位置在 `router.use(requireAuth)` **之后** | 除非是探针 | 接口裸奔 |
| `requireWriteRole` | 会改变状态的接口 | viewer 也能执行操作 |

## 错误

抛 `AppError(ErrorCode.X, '给人看的话')`，错误中间件会翻成对应状态码。
**不要自己 `res.status(...).json(...)`** —— 那样绕过了统一信封，前端解不出来。

新错误码加在 `lib/utils/errors.ts` 的 `ErrorCode` 与 `DEFAULT_STATUS` 里，
两处都要加。只加前者的话状态码会是 `undefined`。

## 两种特殊形态

**SSE**：响应体本身就是流。用 `openSse(res)`（`lib/utils/sse.ts`），
别自己写响应头和帧格式：

```ts
const stream = openSse(res)
try {
  await doWork((event) => stream.emit(event.phase, event), stream.aborted)
} finally {
  stream.close()          // 一定要，放 finally
}
```

`stream.aborted` 是客户端断开时置位的 `AbortSignal`，传给耗时操作让它提前收手。

> `openSse` 里有一处不显然但要命的细节：断开判断监听的是 **`res`** 而不是
> `req`。请求体被 `express.json` 读完后 `req` 的 `'close'` 会立刻触发，
> 拿它当断开信号会把**每一次正常执行都误报成"已取消"**。
> 已经封在里面了，用 `openSse` 就不会踩到。

现成例子：`gpg.controller.ts` 的 `postBatch`、`registry.controller.ts`
的 `getRegistryStream`。

**长任务**：不要让 HTTP 请求等着。GPG 批量执行是边跑边把进度推回去的，
不是跑完再返回。

## 自查

```bash
npx tsc --noEmit && npx vitest run
```

补测试时优先锁这几类（`tests/http.test.ts` 里有现成例子）：

- **没带 token 返回 401** —— 忘挂 `requireAuth` 就会在这里露馅
- **viewer 调写接口返回 403**
- **参数非法返回 400**，且错误信息说得清是哪个字段
- 响应体的形状（前端靠信封解析）

> 别写"测试自己撑着自己"的接口。之前有三个接口只有测试在调
> （`/state`、`/state/rpc`、`/registry/reload`），生产代码零引用 ——
> 已经删掉了。加接口前先确认真有人要用它。

## 现有接口

| 方法 | 路径 | 谁在用 |
|---|---|---|
| GET | `/health` | `npm run check` 探活。**无需认证** |
| POST | `/auth/login` | 前端登录（EVM 签名换 JWT） |
| GET | `/registry/sync` | 前端启动加载。SSE，带 Lark 同步进度 |
| GET | `/states` | 前端 multicall 读不到时兜底 |
| POST | `/gpg/batch` | 前端执行批量操作。SSE |
| POST | `/gpg/cancel` | 前端取消 |
| GET | `/logs` | 交易日志（按天） |
| GET | `/logs/daily` | 日期选择器的角标 |
| POST | `/logs` | 钱包模式下前端上报（广播成功后） |
