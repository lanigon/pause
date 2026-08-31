# 操作手册

多链合约运维控制台。勾选合约,批量暂停 / 恢复。EVM 多链 + Tron。

> 深入了解设计见 [ARCHITECTURE.md](ARCHITECTURE.md)。改代码看 `reference/`，
> 接口逐条与更细的参考在本地 `docs/`（不入库）。

---

## 1. 前置准备

按你要用的功能装，不是全都必需。


| 用途      | 需要什么               | 装法与验证                                     |
| ------- | ------------------ | ----------------------------------------- |
| 必需      | Node ≥ 20          | `node -v`。低于 20 起不来                       |
| 必需      | npm ≥ 9 或 pnpm ≥ 8 | `npm -v`。两个都实测过，见 §10                     |
| 必需      | 浏览器 EVM 钱包         | MetaMask / OKX / Rabby 任一。**登录只认 EVM 签名** |
| 必需      | 白名单里的地址            | 你的地址要在 `backend/data/operators.json` 里    |
| GPG 批量  | GnuPG              | `brew install gnupg`，验 `gpg --version`    |
| GPG 批量  | 运维私钥               | `npm run keys encrypt` 生成到 `secrets/`     |
| YubiKey | 插着的 OpenPGP 卡      | `gpg --card-status` 能看到卡                  |
| YubiKey | `GNUPGHOME` 设对     | 用独立密钥环时**必填**，见 §7                        |
| 飞书同步    | lark CLI 并已登录      | 不装就跳过同步，只用本地 `data/`                      |
| Tron 交易 | TronLink 等 Tron 钱包 | 只有钱包模式发 Tron 交易才需要                        |


只用「钱包签名」模式的话，前四行就够了 —— GnuPG、YubiKey、飞书都不用装。

---

## 2. 装依赖，然后让脚本告诉你还差什么

**在仓库根目录跑**，四条：

```bash
npm run setup                          # 装前后端两边的依赖
cp backend/.env.example backend/.env   # 三个变量都可以不填，见 §7
npm run sync rpc                       # 拉 RPC（ChainList 公开数据，无需凭证）
npm run check                          # ← 这一步告诉你还差什么
```

根目录的 `package.json` 只做转发（`npm --prefix backend run …`），没有 workspaces
也没有依赖 —— 前后端各自的 `install` 布局不受影响。想在子目录里跑也一样：
`cd backend && npm run check`。

`sync` 后面那个 `rpc` **不能省** —— 不带子命令只会打印用法，什么都不做，
而且退出码是 0，看起来像成功了。

`npm run check` 按五组跑一遍，**不在第一个错误停下**，全部跑完再汇总：


| 组         | 查什么                                               |
| --------- | ------------------------------------------------- |
| 运行环境      | Node 版本、npm 版本、**npm 缓存在不在同步盘**、前后端两边的 `node_modules` 装没装 |
| GPG 与运维密钥 | gpg 可执行、`GNUPGHOME`、YubiKey 在不在、密钥文件与权限、声明地址、解锁方式 |
| 数据        | `data/` 下的配置能否通过校验、**每条有合约的链**有几个可用 RPC（没有合约的链不查） |
| 飞书        | lark CLI 装没装、`data/sync.json` 配没配、能不能拉到数据         |
| 服务        | 后端起没起、前端起没起                                       |


输出分两档，**每条都带下一步做什么**：

```
3 项必须处理：
  ✗ 运维密钥：secrets/ 下没有密钥文件
      → npm run keys encrypt
2 项建议处理（不影响启动）：
  ⚠ lark CLI：没装
      → 不装就只用本地 data/
```

没有 `✗` 就会给一句结论 —— 全绿是「全部通过，可以开工」，只剩 ⚠ 是
「没有阻塞项，可以开工」。有 `✗` 时退出码是 1，能直接接进 CI。

它**不解密、不碰 YubiKey**，所以随手跑不会消耗 PIN 尝试次数。
要验密钥能不能真的解开，用 `npm run keys verify`。

---

## 3. 起服务

```bash
npm run dev        # 后端 → http://localhost:8787
npm run dev:web    # 另开一个终端 → http://localhost:5173
```

浏览器打开 5173，点顶栏 **EVM** 连钱包并签名登录。

---

## 4. 日常操作

```
连钱包登录 → 左侧勾业务线 → 右侧勾合约 → 选签名方式 → 批量暂停/恢复
```

- 左侧业务线**可多选**,右侧一条业务线一块,每块能折叠、能单独全选
- 顶部「需暂停 / 需恢复」按当前链上状态快捷勾选
- 执行前要手输 **CONFIRM**
- 结果看下方交易日志(按日期查,可翻历史)
- 每个合约下面默认展开它的 **operator 名单**(从合约的 `getOperators` 读)与各自的主链币余额,
余额为 0 标红。连了钱包时会标出哪个是你,不是 operator 会直接提示

### 两种签名方式,怎么选


|     | **钱包签名**(默认) | **GPG 批量**      |
| --- | ------------ | --------------- |
| 谁签  | 你自己的钱包       | 服务器上的运维密钥       |
| 过程  | 逐笔弹钱包,签之前看得见 | 一次性跑完,SSE 实时推进度 |
| 适合  | 日常、少量、要自己确认  | 批量、紧急、合约多       |
| 前提  | 装了对应链族的钱包    | 服务器上配好密钥        |


**GPG 模式下前端不输入任何口令** —— 口令 / PIN 由服务器本机的 pinentry 问。
用 YubiKey 时界面会推「请触摸设备」,需要有人去按**那台服务器上**插着的 key。

---

## 5. 配置密钥(只有用 GPG 模式才需要)

```bash
npm run keys encrypt    # 选链族 → 输私钥(隐藏输入) → 确认地址 → 设口令
npm run keys verify     # 解密验证,并与声明地址比对
npm run keys status     # 看状态,不解密、不消耗 PIN 次数
npm run keys doctor     # 一条命令验完整条链路(插上 YubiKey 后想快速确认就用它)
```

三个都要交互式终端 —— 私钥与口令只从 TTY 读，不能用管道或重定向喂进去。

生成两个文件,按链族约定放在 `secrets/`:

```
secrets/evm.key.gpg    加密的私钥
secrets/evm.address    明文地址 —— 用来核对密钥有没有被换过,缺了不能放行
```

私钥只从 TTY 隐藏输入读取,**不进命令行参数、不进环境变量、不进 shell history**。
需要本机装 GnuPG(`brew install gnupg`)。

解锁方式(口令 / YubiKey)**是探测出来的,不用配** —— 看密钥文件本身加上卡在不在。

---

## 6. 改配置

**加一个合约** —— 编辑 `backend/data/contracts.json`:

```jsonc
{ "id": "my-vault", "name": "My Vault",
  "businessLine": "payment", "chain": "morph", "address": "0x...",
  // 可选：有权暂停它的地址。配了就会在列表里显示这个地址的余额 ——
  // 紧急暂停时最怕按下去才发现那个地址没气了
  "operator": "0x..." }
```

**加一条 EVM 链** —— 编辑 `backend/data/chains.json`,不用填 RPC:

```jsonc
{ "key": "base", "type": "evm", "chainId": 8453,
  "explorer": "https://basescan.org", "symbol": "ETH", "decimals": 18 }
```

改完在界面上点侧边栏的「重新同步」即可生效(它会重载本地配置),或重启后端。
**引用了不存在的链或业务线会在启动时直接报错**,服务起不来 —— 不会等到点下去才发现。

加**新链族**(Solana 等)要写代码 —— 实现一个 `ChainAdapter` + 在 `lib/web3/chains.ts` 注册一行,
另有五处要跟着改。[reference/ADD-CHAIN.md](reference/ADD-CHAIN.md) 有分步说明,
其中密钥 CLI 和前端注册表那两处**漏了不报错**。

---

## 7. 配置项

**环境变量三个,都可以不填**(`backend/.env`):


|                   | 说明                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `ALCHEMY_API_KEY` | RPC 降级的第二级                                                                                     |
| `GPG_BINARY`      | gpg 路径,默认 PATH 里的 `gpg`                                                                        |
| `GNUPGHOME`       | ⚠️ **用 YubiKey 或独立密钥环时必须设对**。不设的话 gpg 去找默认密钥环,永远解不开,而**报错看起来像「口令错」**。路径也别太长,`npm run check` 会量 |


**飞书表格地址在 `backend/data/sync.json`**,不是环境变量 —— 它是团队共享配置,该和其它配置一起入库。填了之后前端每次加载会先跟表格对一遍。

---

## 8. 常见情况


| 现象                         | 原因 / 处理                                               |
| -------------------------- | ----------------------------------------------------- |
| 登录后什么都没有                   | 只连了 Tron。**Tron 不参与登录**,身份是 EVM 地址,去连 EVM 钱包          |
| 「配置已更新,请刷新」                | 后端配置在你操作期间变了。刷新页面重新勾选                                 |
| 合约状态显示「未知」                 | 那条链的 RPC 读不到。**不影响执行** —— 状态读不到不会跳过,交给链上判断            |
| 余额显示「—」                    | 那个地址的余额读不到。**不会显示成 0** —— 0 和读不到必须区分                  |
| 「读不到 operator 名单」          | 合约没有 `getOperators(uint256,uint256)` 方法,或那条链读不到。不影响暂停 |
| 提示「你当前的钱包不是这个合约的 operator」 | 合约的 `isOperator` 说了不是。**钱包模式下会失败**,改用 GPG 模式或换个钱包     |
| 提示「请触摸 YubiKey」            | 去按**服务器**上插着的那把 key,不是你本机的                            |
| 报「口令错」但口令没错                | 大概率是 `GNUPGHOME` 没设对。跑 `npm run check`                |
| 装依赖时刷一屏 `tar checksum failure` | npm 缓存被写坏了，最常见是缓存目录在 iCloud/Dropbox 里 —— `npm run check` 会直接指出来。**它只是 warn、退出码 0，但被跳过的文件是真没落盘**，之后会在莫名其妙的地方报 Cannot find module。先 `npm cache verify`，不行就 `npm cache clean --force` 后重装 |
| 交易卡着不确认                    | 后端会自动提高 gas 重发(最多 4 次),再不行用自转账让出 nonce。不用手动干预         |
| 想中途停下                      | 弹窗里「取消执行」。**已广播的拦不住** —— 只保证还没签的不签、没发的不发              |
| 页面刷新了但任务还在跑                | 重新登录后再点一次取消即可(取消是按人不按连接的)                             |


---

## 9. 紧急暂停的最短路径

```
1. 连 EVM 钱包登录
2. 左侧勾中出事的业务线
3. 顶部点「需暂停(N)」 —— 一键勾中所有还在运行的
4. 确认签名方式:急且合约多 → GPG 批量;少量 → 钱包签名
5. 点「批量暂停」,输 CONFIRM
6. 看进度弹窗 / 交易日志确认结果
```

几条设计上的保证,紧急时可以放心:

- **已经暂停的会自动跳过**,不浪费 gas、不占 nonce
- **一笔卡住不会堵死后面的** —— 后端会用自转账把 nonce 让出来
- **不做部分放行** —— 缺任何一个链族的密钥就整批拒绝,不会留下半停半没停的中间态
- 状态读不到**不会**导致跳过 —— 宁可多发一笔,也不漏掉紧急暂停

---

## 10. 开发

```bash
npm test           # 两边一起跑：后端 278 + 前端 109
npm run typecheck  # 两边一起
npm run build      # 两边一起
```

只想跑一边就进对应目录：`cd backend && npm test`。
后端另有 `npm run test:cov`（当前 80.84%）。

### npm 与 pnpm 都可以

两个包管理器都实测过：typecheck、全部测试、build 三项在两边都通过。

两点已知差异，不影响使用：

- **仓库里只有 `package-lock.json`**。pnpm 没有 lockfile，每次 `pnpm install`
重新解析版本 —— 能装上，但不保证和别人装的完全一致。要复现就用 npm。
- pnpm 10 默认拦截依赖的构建脚本，会警告 `Ignored build scripts: esbuild、vue-demi`。
实测无影响（esbuild 现在走平台预编译二进制），不用管，也可以跑
`pnpm approve-builds` 放行。

> 有个坑是实测才发现的：`req.operator` 的类型增强原来写成
> `declare module 'express-serve-static-core'`，在 npm 的扁平布局下只有一份
> 类型包所以碰巧能用；pnpm 的严格布局下装了两份（4.x 与 5.x），
> 增强打在错的那份上，typecheck 直接报 `Property 'operator' does not exist`。
> 已改成 `declare global { namespace Express }`，两边都过。

**v1 单实例**:运行中的任务与已用签名去重表存于内存,不支持水平扩展。
交易日志落盘,重启不丢。生产用 HTTPS 并收紧 `CORS_ORIGINS`。