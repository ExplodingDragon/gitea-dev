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

Web handler 与 ManagerService RPC handler 不应混在同一个文件。

Runtime HTTP API 属于 Manager，不属于 Gitea route。

## 实现约束

本文档是最终设计基线。

- 不兼容旧 codespace prototype route、proto name、table 或 runtime option form。
- 删除旧 codespace port table 行为。
- 删除前端 runtime 选型输入。
- 删除 `/codespace/{uuid}/create`、`retry`、`cancel`。
- 删除旧 `initializing` 状态。
- 删除旧 task 术语。
- 删除所有 quota 设计和实现。
- 复用 Gitea 现有 permission、token、SSH key、setting、cron、routing、DBFS 和测试组织方式。

实现完成后的最低验证：

```bash
cd gitea
go test ./...
make fmt
make lint-backend
```

## 已知设计缺口

各模块的设计缺口已在对应文档中以 `> **TODO**` 标记，汇总如下：

- [Manager 与 Gateway - Manager 设计](manager-gateway.md)：worker pool 模型、重启恢复策略
- [Manager 与 Gateway - Gateway 设计](manager-gateway.md)：Endpoint 反向代理实现、session 生命周期
- [Manager 与 Gateway - SSH 接入](manager-gateway.md)：认证限流与退避配置
- [Manager 与 Gateway - 日志与脱敏](manager-gateway.md)：Gateway access log
- [Gitea 服务端 - Token 管理](gitea-server.md)：多副本 cache 一致性

> **TODO**: codespace 模块的单元测试/集成测试组织、ManagerService RPC mock 方式、State Finalization 事务测试方案尚未定义。
