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

## 待决策项

以下内容进入实现前需要完成设计决策。列出这些项的目的是明确它们影响的实现范围，避免开发时临时决定跨模块行为。

- [Manager 与 Gateway - Manager 设计](manager-gateway.md)：worker pool 模型、重启恢复策略
- [Manager 与 Gateway - Gateway 设计](manager-gateway.md)：Endpoint 反向代理实现、session 生命周期
- [Manager 与 Gateway - SSH 接入](manager-gateway.md)：认证限流与退避配置
- [Manager 与 Gateway - 日志与脱敏](manager-gateway.md)：Gateway access log
- [Gitea 服务端 - Token 管理](gitea-server.md)：多副本 cache 一致性

测试设计需要覆盖 codespace 服务层权限判定、ManagerService RPC mock、State Finalization 事务、repository 删除 pre-cleanup、repo-bound token 判定和日志 offset 追加。测试组织单独成章后再进入实现，可以保证状态机、权限和 token 边界在实现阶段有稳定验证方式。
