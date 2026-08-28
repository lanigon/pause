# 前端结构

Vue 3 + TS + Element Plus + Pinia，**单页无路由，11 个文件**。

```
frontend/src/
├── main.ts                          挂载 Vue / Pinia / Element Plus
├── App.vue                          布局：顶栏 + 侧边栏 + 列表 + 日志
├── types.ts                         与 /api/registry 对齐的类型
├── api.ts                           全部后端调用（含 SSE）。JWT 只存内存
├── store.ts                         唯一 Pinia store：身份 / 配置 / 选中 / 状态 / 日志
├── chain/
│   ├── wallet.ts                    钱包适配：EVM(EIP-1193) + Tron(TronLink)，按链族分派
│   └── multicall.ts                 Multicall3 批量读 paused()/owner()，按链并行
└── components/
    ├── WalletBar.vue                顶栏：连 EVM / Tron，首个连上的钱包签名登录
    ├── AppSidebar.vue               侧边栏：业务线，带合约数与"有暂停中"红点
    ├── ContractList.vue             tab(签名方式) + 表格 + 勾选 + 批量按钮
    └── OperationLog.vue             操作日志：历史 + SSE 事件 + 本地操作
```

## 设计模式与后端一致

**钱包适配层**照搬后端 adapter 思路：一个 `WalletAdapter` 接口，EVM / Tron 两套实现，
`walletFor(family)` 分派。加新链族在 `ADAPTERS` 加一行，组件零改动。

**组件不直接调 api**，全部经 store —— 状态只有一处可变。

## 两种模式

**GPG 批量模式**（默认）
勾选 → 输入 CONFIRM → 输入 passphrase → `POST /gpg/batch` → `POST .../passphrase` →
开 SSE → 行内实时显示 `签名中 / 广播中 / 已确认`，同时追加到操作日志。

**钱包模式**
勾选 → 逐笔弹 MetaMask / TronLink → 每笔广播后 `POST /logs` 留档。
非当前钱包链族的合约行自动禁选。

## 链上状态由前端读

`chain/multicall.ts` 按链分组并行：EVM 走 Multicall3 一次 RPC 读完一条链的所有合约，
Tron 走受限并发（5 QPS）。不占后端 RPC 配额，切业务线时刷新很快。
某条链读失败不影响其它链，该链合约显示"未知"。

## 依赖

`vue` `pinia` `element-plus` `@element-plus/icons-vue` `ethers`
dev：`vite` `typescript` `vue-tsc` `@vitejs/plugin-vue`

不装 tronweb —— Tron 只读用 `fetch` 直接调 TronGrid HTTP API，签名用 TronLink 注入的 `window.tronWeb`。
