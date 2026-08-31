# 合约管理平台

多链合约运维控制台：勾选合约，批量暂停 / 恢复。EVM 多链 + Tron，两种签名方式。

- 怎么用 → [OPERATIONS.md](OPERATIONS.md)
- 怎么设计的 → [ARCHITECTURE.md](ARCHITECTURE.md)

要动代码的时候，`reference/` 下有两份：

- 接一条新链 → [reference/ADD-CHAIN.md](reference/ADD-CHAIN.md)　新 EVM 链零代码；
  新链族有六个必改点，其中两个漏了不报错
- 加一个后端接口 → [reference/ADD-API.md](reference/ADD-API.md)　样板三处，重点是逻辑放哪一层
