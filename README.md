# 合约管理平台

多链合约运维控制台：勾选合约，批量暂停 / 恢复。EVM 多链 + Tron，两种签名方式。

- 怎么用 → [OPERATIONS.md](OPERATIONS.md)
- 怎么设计的 → [ARCHITECTURE.md](ARCHITECTURE.md)

要动代码的时候：

- 接一条新链 → [ADD-CHAIN.md](ADD-CHAIN.md)　新 EVM 链零代码；新链族有四个必改点，其中一个漏了不报错
- 加一个后端接口 → [ADD-API.md](ADD-API.md)　样板三处，重点是逻辑放哪一层
