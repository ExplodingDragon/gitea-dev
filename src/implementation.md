# 实施

## 代码组织

Gitea 侧代码按以下方向拆分：

```text
routers/api/codespace/manager.go
routers/web/codespace/repo.go
routers/web/codespace/user.go
services/codespace/
models/codespace/
modules/codespace/
```

Web handler 与 ManagerService RPC handler 分别放在 Web 与 API/Connect 入口下。这样组织代码可以让页面交互、Manager RPC 鉴权和服务层状态推进保持清晰边界，后续测试也能分别覆盖用户请求和 Manager 请求。

Runtime HTTP API 由 Manager 实现，路由与 Gitea route 分离。

## 迁移目标

本文档是最终设计基线。

实现以本文档描述的 Gitea 内置 codespace 模型为准：

- 路由、proto name、table 和 runtime option form 使用本文档定义的新命名。统一命名可以让 Web、RPC、DB 和文档保持一一对应，减少 prototype 遗留概念进入正式实现。
- Runtime 选型由 Manager 本地配置和 repository tag 匹配决定。Gitea UI 保持为创建、打开和管理入口，用户不在前端选择具体 backend，这样可以让运行侧能力由管理员集中维护。
- 生命周期入口使用 `create / open / resume / stop / delete`。这些动作覆盖用户需要的完整生命周期，并与状态机中的 operation 类型保持一致。
- 主状态使用 `queued / booting / running / stopping / stopped / resuming / deleting / error`。`booting` 表达首次创建初始化，`resuming` 表达停止后恢复，两者分开可以让 UI、日志和超时策略更准确。
- 异步生命周期统一称为 operation。使用同一术语可以复用 claim、lease、finalization 和 reconciliation 逻辑，避免 task、job 等 CI/CD 术语与 codespace 生命周期混淆。
- 容量控制由 Manager 通过 `capacity_total / capacity_available` 上报。Gitea 保存最近容量快照用于 UI、诊断和 FetchOperation 准入，真实资源占用由 Manager 控制，因为只有 Manager 能看到本地 Runtime 队列、backend 限制和启动中实例。
- Gitea 侧复用现有 permission、token、SSH key、setting、cron、routing、DBFS 和测试组织方式。复用现有基础能力可以减少新的安全边界和重复实现，让 codespace 行为与 Gitea 现有访问模型一致。

实现完成后的最低验证：

```bash
cd gitea
go test ./...
make fmt
make lint-backend
```

## 测试组织

测试按层组织：

- `models/codespace`：状态字段、索引、查询、token binding 反查。
- `services/codespace`：权限判定、State Finalization、repository delete pre-cleanup、repo-bound token、日志 offset。
- `routers/api/codespace`：ManagerService RPC auth、FetchOperation claim、UpdateOperation 幂等。
- `routers/web/codespace`：create/open/stop/resume/delete 页面行为。
- `integration`：create -> claim -> log -> done -> open token -> delete 全链路。

测试辅助：

- ManagerService 使用 fake Manager identity。
- Runtime Metadata 使用 cache fake。
- Git repo/ref 解析复用 Gitea 现有 repository test fixture。
- DBFS 日志使用测试 DB。
- State Finalization 覆盖并发和重复终态。

这样设计的原因是 codespace 的主要风险集中在权限、状态事务、token 生命周期和异步 claim。服务层测试覆盖核心规则，路由测试覆盖 Web/RPC 输入输出，集成测试覆盖跨层事务边界。Manager backend 不进入 Gitea 服务层测试，可以避免运行侧实现细节影响 Gitea 状态权威测试。
