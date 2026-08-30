# 前端结构

Vue 3 + TS + Element Plus + Pinia，**单页无路由，`src/` 18 个文件**。

```
frontend/src/
├── main.ts                    挂载 Vue / Pinia / Element Plus
├── App.vue                    布局：顶栏 + 侧边栏 + 列表 + 日志
├── types.ts                   与 /api/registry 对齐的类型
├── day.ts                     本地日历日 ↔ UTC 时间窗的换算，只此一处
├── labels.ts                  执行阶段的中文名，只此一份
├── chain/
│   ├── abi.ts                 内置 Pausable ABI
│   ├── wallet.ts              钱包适配：EVM(EIP-6963) + Tron(TIP-6963)，按链族分派
│   └── multicall.ts           Multicall3 批量读 paused()，按链并行
├── store/                     唯一的 Pinia store，由三块组合而成
│   ├── index.ts               组合 + 跨块调用（connect / disconnect）
│   ├── api.ts                 全部后端调用（含自己解 SSE 帧）。JWT 只存内存
│   ├── session.ts             身份与签名方式
│   ├── catalog.ts             配置目录、链上状态、勾选、折叠
│   └── execution.ts           批量执行与进度事件
└── components/
    ├── WalletBar.vue          顶栏：连 EVM / Tron，列出装了哪些钱包
    ├── AppSidebar.vue         侧边栏：业务线多选 + 同步状态
    ├── ContractList.vue       签名方式 + 分组表格 + 勾选 + 批量按钮
    ├── GpgProgress.vue        GPG 执行进度弹窗（过程 / 结果两个 tab）
    └── OperationLog.vue       交易日志
```

## store 为什么拆成三块

```
session    身份与签名方式（谁在操作、用什么签）
catalog    配置目录与链上状态（能看到什么、现在什么状态）
execution  批量执行与进度事件（正在做什么、结果如何）
```

三块之间**不互相 import**，跨块的调用只发生在 `store/index.ts`（比如「连上钱包 → 去加载数据」）。
组件也不直接调 `api`，全部经 store —— 状态只有一处可变。

## 钱包适配：和后端同一套思路

一个 `WalletAdapter` 接口，EVM / Tron 两套实现，`discoverWallets(family)` 分派。
加新链族在 `DISCOVERY` 加一行，组件零改动。

**为什么要「发现」而不是直接连**：用户同时装 MetaMask、OKX、Rabby 是常态，
它们会抢 `window.ethereum`，谁最后注入谁赢 —— 直接连的话用户根本不知道自己在用哪个。
所以两边都走广播式发现，每个钱包各自应答，带上自己的名字、图标和**独立的 provider**：

| | EVM | Tron |
|---|---|---|
| 发现 | `eip6963:requestProvider` | `TIP6963:requestProvider` |
| provider | 各自的 EIP-1193 对象 | `window.tron`（TIP-1193） |
| 授权 | `eth_requestAccounts` | `eth_requestAccounts`（老版 `tron_requestAccounts`） |
| 读链 | `eth_chainId` | `eth_chainId` |
| 切链 | EIP-3326 | TIP-3326（同名方法） |

> ⚠ 两个事件名**大小写不一样**：EVM 是小写 `eip6963:`，Tron 规范写的是大写 `TIP6963:`。
> 别「顺手统一」，改成小写就收不到应答了。

Tron 还兼容老版接口（`window.tronLink` + `window.tronWeb`，没有读链/切链能力，
只能靠 `tronWeb.fullNode.host` 反推在哪个网络，对不上就拒绝发送）。

**选定 provider 后绝不回落到全局 `window.tronWeb`** —— 装了多个 Tron 钱包时那个全局变量
归谁全看注入顺序，回落等于「点了 A 却用 B 签名」，正是 TIP-6963 要消灭的问题。

## 两种模式

**钱包签名（默认）**
勾选 → 输入 CONFIRM → 逐笔弹钱包 → 每笔广播成功后 `POST /logs` 留档。
发交易前**先确保钱包在对的网络上**（切不动就拒绝发送）；
非当前钱包链族的合约行自动禁选，且不计入全选的分母。

**GPG 批量**
勾选 → 输入 CONFIRM → `POST /gpg/batch`，响应就是 SSE 流 →
`GpgProgress` 弹窗展开每一步，行内同步显示 `预演中 / 签名中 / 广播中 / 已确认`。
**前端不输入也不传任何密钥材料** —— 口令 / PIN 由后端本机的 pinentry 问，
YubiKey 场景下需要有人去按服务器上插着的那把 key。

默认是钱包模式：它是「用自己的钱包、签之前看得见」的那条路。
GPG 走的是后端那把运维密钥，权限更大，要显式切过去才用。

## 链上状态由前端读

`chain/multicall.ts` 按链分组并行：EVM 走 Multicall3 一次 RPC 读完一条链的所有合约，
Tron 走受限并发（5 并发，TronGrid 有 QPS 限制）。不占后端 RPC 配额，切业务线时刷新很快。

某条链读失败不影响其它链，该链合约显示「未知」。整体一个都没读到时
（公开 RPC 常常不带 CORS 头，浏览器直接拦掉）退回 `GET /states` 让后端代读。

**bool 返回值严格校验**：必须是 32 字节的 0 或 1。解码器会把任何非零值当成 `true`，
但真正的 Pausable 合约只会返回 0 或 1 —— 返回别的说明这个地址不是我们以为的合约
（比如误配成预编译地址 `0x…0002`，它对任意 calldata 都返回哈希）。
紧急暂停时把「地址配错了」显示成「已暂停」会让运维直接跳过它，
所以读不到（显示未知）远好过读错。后端两处用的是同一条判定，三处必须一致。

## 列表交互

- 侧边栏**多选**业务线，右侧一条业务线一块
- 每块可**折叠**（纯视图状态，不动已勾选的合约），折叠后表头仍显示「已选 N」——
  不然收起一组、忘了里面还选着东西，直接点批量暂停就操作到看不见的合约了
- 每块可**独立全选**，只动这条线，其余业务线的勾选原样保留（顶部那个全选是整体替换）
- 全选框的分母只算**可操作**的合约 —— 钱包模式下另一链族的根本勾不动，
  算进去会让全选框永远到不了全选态

## 交易日志

按**交易哈希去重、保留最新状态**：GPG 模式后端会为同一笔写两条（广播时、确认后），
钱包模式只有 broadcast 一条。之前只显示终态，导致**钱包模式发出去的交易永远看不见**。

日期按本地日历日切（见 `day.ts`）—— ts 存的是 UTC，直接按 UTC 切日的话，
晚上八点之后的操作会被算进「明天」，运维查当天记录时找不到自己刚做的事。

## 依赖

`vue` `pinia` `element-plus` `@element-plus/icons-vue` `ethers`
dev：`vite` `typescript` `vue-tsc` `@vitejs/plugin-vue`

**不装 tronweb** —— Tron 只读用 `fetch` 直接调 TronGrid HTTP API，
签名用钱包注入的 `tronWeb`（`transactionBuilder` + `trx.sign` + `sendRawTransaction`）。

> 广播必须检查返回里的 `result` 字段。`txID` 是签名时本地算出来的，
> 广播被拒绝它照样有值 —— 只看 txID 会返回一个从未上链的哈希，
> 上层当成「已广播」记进日志，界面还显示成功。
