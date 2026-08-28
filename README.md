# 合约管理平台 — 多链合约运维控制台

勾选合约，批量暂停 / 恢复。支持 EVM 多链 + Tron，两种签名方式。

```
operator/
├── docs/
│   ├── BLUEPRINT.md   架构、数据流、安全模型、边界条件
│   ├── API.md         后端接口
│   ├── FRONTEND.md    前端结构
│   └── ADD-CHAIN.md   接入新链（EVM 零代码 / 新链族一个 adapter）
├── backend/           Express + TypeScript + ethers v6 + TronWeb（45 个文件）
│   ├── data/          ★ 全部 JSON：chains · contracts · operators · signers · rpc · operations
│   ├── secrets/       ★ GPG 加密的运维私钥，gitignore
│   ├── scripts/       两个：keys（密钥管理）· sync（从 Lark/ChainList 拉数据）
│   └── src/           routes → controllers → services → repositories
└── frontend/          Vue 3 + Vite + TS + Element Plus + Pinia（11 个文件）
```

## 快速开始

```bash
# 后端
cd backend
cp .env.example .env   # 只有一个变量 ALCHEMY_API_KEY，不填也能跑
npm install            # 或 pnpm install
npm run sync rpc       # 拉 RPC（ChainList 公开数据，无需任何凭证）
npm run dev            # → http://localhost:8787

# 前端（另开终端）
cd frontend
cp .env.example .env
npm install          # 或 pnpm install
npm run dev          # → http://localhost:5173
```

打开 http://localhost:5173，点顶栏「EVM」连钱包并签名登录。
登录地址必须在 `backend/data/operators.json` 白名单里（默认放了 Hardhat 演示账户）。

**配置极简**：环境变量只有一个 `ALCHEMY_API_KEY`，还可以不填。
端口、路径、超时全在 `src/config/env.ts` 里当常量；JWT 密钥每次启动随机生成；
GPG 口令/PIN 由本机的 gpg-agent 负责，不进配置。

**角色即权限**：`admin`（可热重载配置）· `operator`（可执行暂停/恢复）· `viewer`（只读）。
三种角色都能看全部业务线，区别只在能不能动。

## 配置 GPG 运维密钥

批量执行需要后端持有加密的运维私钥。固定两个文件：`secrets/evm.key.gpg` 与 `secrets/tron.key.gpg`。

```bash
cd backend
npm run key:encrypt          # 或 pnpm key:encrypt
#   选链族 → 输入私钥（隐藏输入）→ 确认派生地址 → 设置 passphrase
#   自动写入 secrets/<链族>.key.gpg（权限 0600），并提示更新 operators.json 里的地址

npm run key:verify           # 解密验证，并与 operators.json 声明的地址比对
npm run key:status           # 查看密钥文件状态（不解密）
```

私钥只从 TTY 隐藏输入读取，**不进命令行参数、不进环境变量、不进 shell history**。
需要本机装 GnuPG（`brew install gnupg`）。

## 加一个合约

编辑 `backend/data/contracts.json`，三行搞定：

```jsonc
{ "id": "my-vault", "name": "My Vault",
  "businessLine": "payment", "chain": "morph", "address": "0x..." }
```

然后 `POST /api/registry/reload`（或重启）。不用配 ABI、不用配可执行动作 ——
平台只做 pause/unpause，这些在所有 Pausable 合约上都一样。

## 加一条链

新 EVM 链只改 `chains.json`（不用填 RPC，`npm run sync rpc` 会补上），零代码。
新链族实现一个 adapter。见 [docs/ADD-CHAIN.md](docs/ADD-CHAIN.md)。

## 安全要点

- passphrase 从 HTTP 请求体**流式直通** GPG 子进程 stdin，全程不在 JS 里落地
- 私钥只在一次性子进程内存中；gpg 独立进程组，超时杀整组
- 解密后派生的地址必须与配置声明一致，否则立即中止（防密钥被替换）
- 已签名的 rawTx 不进日志、不进 API、不进前端
- 只有 `operators.json` 白名单地址能登录（只认 EVM 签名）；JWT 8 小时，只存前端内存
- JWT 密钥每次启动随机生成，没有长期密钥可泄露（代价：重启后要重新登录）
- 前端不配任何 RPC —— 由后端下发，且只给公开的（Alchemy 那种含 key 的永远留在后端）
- 授权四道关：链族有密钥 → 密钥授权该链 → 密钥授权该业务线 → 操作员有该业务线权限

**v1 单实例部署**：任务与登录 nonce 存于内存，不支持水平扩展。
