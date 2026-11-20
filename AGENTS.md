# NestCloud-Sdk 维护约定

- 本仓库提供共享包 `@nest-cloud/sdk`。将可复用的启动、日志、配置、服务发现和通用中间件维护在 `src/`，业务服务负责自身的业务逻辑。
- 修改公共导出、配置、跨服务协议、事务或追踪行为时，检查 NestCloud 与 SolaCloud 消费方的兼容性。更新对应的模块文档；`docs/` 按能力拆分，README 用于导航和接入。
- 使用现有的配置、日志和远程调用接口。声明新增配置的默认值、校验与降级行为。会话签名密钥及 Redis 凭据从部署配置获取。
- 行为测试位于 `src/__tests__/`。对可复现问题添加回归测试。数据库集成测试使用显式提供的专用 PostgreSQL 测试地址。
- 在根目录运行 `pnpm lint`、`pnpm test`、`pnpm tsgo` 和 `pnpm build`。向其他包提供的声明依赖放入 `dependencies`。
- 安装开发依赖时 Husky 自动启用 `pre-commit`。提交时 lint-staged 格式化已暂存文件，并对匹配的代码执行 oxlint。

## Git 分支约束

- `dev/master` 是项目的主开发分支。新功能在 `feature/*` 分支上开发，完成后可合入 `dev/master`。
- 修复 bug 统一使用固定分支 `feature/test`，修复完成后可合入 `dev/master`。
- 每次合入 `dev/master` 后，必须将本地 `dev/master` 推送到对应的远端 `dev/master`，从 `feature/test` 合入时也要推送。
- 推送成功后，删除本次合入的 `feature/*` 本地分支及其对应的远端分支（如存在）。删除前须确认待删分支的最新提交已包含在远端 `dev/master` 中。固定分支 `feature/test` 在本地和远端均须保留。
- `master` 用于打包和创建发布标签（tag）。只有 `dev/master` 可以合入 `master`，且每次合入都必须生成合并提交（`--no-ff`）。
