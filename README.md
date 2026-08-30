# 合约管理平台 — 多链合约运维控制台

勾选合约，批量暂停 / 恢复。支持 EVM 多链 + Tron，两种签名方式。

```
operator/
├── OPERATIONS.md      ★ 操作手册：起服务、日常操作、常见情况、紧急暂停最短路径
├── ARCHITECTURE.md    ★ 技术架构：分层、链层设计、六个关键决策
├── docs/              以下是逐项细节，按需查
│   ├── BLUEPRINT.md   架构参考手册（数据流、安全模型、边界条件）
│   ├── API.md         后端接口（13 个）
│   ├── FRONTEND.md    前端结构
│   └── ADD-CHAIN.md   接入新链（EVM 零代码 / 新链族一个 adapter）
├── backend/           Express + TypeScript + ethers v6 + TronWeb（src/ 57 个文件）
│   ├── data/          ★ 全部 JSON：chains · contracts · operators · rpc · sync · operations
│   ├── secrets/       ★ <链族>.key.gpg 加密私钥 + <链族>.address 声明地址，已 gitignore
│   ├── scripts/       keys（密钥管理）· sync（拉 RPC/合约）· check（启动前排查）
│   └── src/           routes → controllers → services → core → lib
└── frontend/          Vue 3 + Vite + TS + Element Plus + Pinia（src/ 18 个文件）
```

## 快速开始

```bash
# 后端
cd backend
cp .env.example .env   # 只有一个变量 ALCHEMY_API_KEY，不填也能跑
npm install            # 或 pnpm install
npm run sync           # 拉 RPC（ChainList 公开数据，无需任何凭证）
npm run check          # 启动前排查：环境 / 密钥 / 数据 / Lark / 服务，全部跑完再汇总
npm run dev            # → http://localhost:8787

# 前端（另开终端）
cd frontend
cp .env.example .env
npm install
npm run dev            # → http://localhost:5173
```

打开 http://localhost:5173，点顶栏「EVM」连钱包并签名登录。
登录地址必须在 `backend/data/operators.json` 白名单里（默认放了 Hardhat 演示账户）。

**配置极简**：三个环境变量都可以不填 —— `ALCHEMY_API_KEY`（RPC 降级）、
`GPG_BINARY`（默认 `gpg`）、`GNUPGHOME`（默认 `~/.gnupg`）。
但 **用 YubiKey 或独立密钥环时 `GNUPGHOME` 必须设对**：不设的话 gpg 去找默认密钥环，
永远解不开，而报错看起来像「口令错」。`npm run check` 会替你确认。
端口、路径、超时全在 `src/config/env.ts` 里当常量；**JWT 密钥生产环境每次启动随机生成**
（重启后要重新登录，代价换来「没有长期密钥可泄露」；开发环境缓存在 `secrets/.jwt-dev`）；
GPG 口令 / PIN 由本机的 gpg-agent 负责，不进配置、也不经过 HTTP。

**角色即权限**：`admin`（可热重载配置）· `operator`（可执行暂停/恢复）· `viewer`（只读）。
三种角色都能看全部业务线，区别只在能不能动。

## 配置 GPG 运维密钥

批量执行需要后端持有加密的运维私钥。按链族约定放在 `secrets/`：

```
secrets/evm.key.gpg   secrets/evm.address
secrets/tron.key.gpg  secrets/tron.address
```

`.address` 是明文的声明地址，用来核对密钥有没有被换过 —— **缺了不能放行**，
没有它就等于把「密钥被掉包」这个检查静默关掉了。

```bash
cd backend
npm run keys encrypt     # 选链族 → 输入私钥（隐藏输入）→ 确认派生地址 → 设置 passphrase
                         # 自动写入 secrets/<链族>.key.gpg（权限 0600）
npm run keys verify      # 解密验证，并与 <链族>.address 比对
npm run keys status      # 查看密钥文件状态（不解密，不消耗 PIN 次数）
```

私钥只从 TTY 隐藏输入读取，**不进命令行参数、不进环境变量、不进 shell history**。
需要本机装 GnuPG（`brew install gnupg`）。

支持两种解锁方式：`passphrase`（对称加密，输口令）与 `yubikey`（PIN + 触摸设备）。
**用哪种是探测出来的，不配置** —— 看密钥文件本身加上卡在不在。
写死成 yubikey 的话，卡拔了照样按 YubiKey 处理，白等 120 秒还提示你去摸一个不存在的设备。

## 加一个合约

编辑 `backend/data/contracts.json`，三行搞定：

```jsonc
{ "id": "my-vault", "name": "My Vault",
  "businessLine": "payment", "chain": "morph", "address": "0x..." }
```

然后 `POST /api/registry/reload`（或重启）。不用配 ABI、不用配可执行动作 ——
平台只做 pause/unpause，这些在所有 Pausable 合约上都一样。

引用了不存在的链或业务线会在**启动时**报错，服务直接起不来 —— 不会等到点下去才发现。

## 加一条链

新 EVM 链只改 `chains.json`（不用填 RPC、不用填 multicall3 地址），零代码。
新链族实现一个 adapter。见 [docs/ADD-CHAIN.md](docs/ADD-CHAIN.md)。

## 数据来源

合约清单可以由飞书表格维护 —— 表格地址填在 `data/sync.json` 的 `larkUrl`
（**不是环境变量**：它不是密钥，是团队共享配置，该和其它配置一起入库）。

前端每次加载会走 `GET /registry/sync`，
后端拉 Lark → 与本地比对 → 有差异才更新，过程通过 SSE 推给前端。

**Lark 挂了不影响用**：拉不到就说明原因、继续用本地数据；
解析出 0 个合约一律当异常，绝不覆盖本地（表格一次误操作就把合约清空，
紧急时会找不到东西可暂停）。

## 安全要点

- **口令 / PIN 从不经过 HTTP** —— 前端不输入也不传任何密钥材料，
  由后端本机的 gpg-agent + pinentry 直接问用户
- 私钥只在一次性子进程内存中；gpg 用独立进程组，超时杀整组
- 解密后派生的地址必须与 `secrets/<链族>.address` 一致，否则立即中止（防密钥被替换）
- 已签名的 rawTx 不进日志、不进 API、不进前端 —— 泄露出去任何人都能重放这笔 pause
- 只有 `operators.json` 白名单地址能登录（只认 EVM 签名）；JWT 8 小时，只存前端内存
- 前端不配任何 RPC —— 由后端下发，且**只给公开的**（Alchemy 那种含 key 的永远留在后端）
- 访问日志**请求头一个都不落盘**，Authorization 根本没机会进日志对象
- 权限三层，各管一件事：能不能登录（白名单 + 验签）· 能不能动（角色）· 有没有密钥（链族）

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest，262 个用例
npm run test:cov     # 覆盖率
npm run lint
```

**v1 单实例部署**：运行中的任务与已用签名去重表存于内存，不支持水平扩展。
交易日志落盘，重启不丢。生产环境用 HTTPS 并收紧 `CORS_ORIGINS`。
