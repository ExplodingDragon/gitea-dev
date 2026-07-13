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

Web handler 与 ManagerService RPC handler 分别放在 Web 与 API/Connect 入口下。页面交互、Manager RPC 鉴权和服务层状态推进各自清晰，后续测试也能分别覆盖用户请求和 Manager 请求。

Runtime HTTP API 由 Manager 实现，路由与 Gitea route 分离。

实现验收点：

- Web handler、Manager RPC handler、服务层和数据模型之间没有反向依赖。
- Runtime HTTP API 不注册到 Gitea router。

## 迁移目标

本文档是最终设计基线。

实现以本文档描述的 Gitea 内置 codespace 模型为准：

- 路由、proto name、table 和 runtime option form 使用本文档定义的新命名。统一命名让 Web、RPC、DB 和文档保持一一对应，减少 prototype 遗留概念进入正式实现。
- Runtime 选型由 Manager 本地配置和 repository tag 匹配决定。Gitea UI 保持为创建、打开和管理入口，用户在前端选择代码上下文，管理员在 Manager 侧维护运行能力。
- 生命周期入口使用 `create / open / resume / stop / delete`。这些动作覆盖用户需要的完整生命周期，并与状态机中的 operation 类型保持一致。
- 主状态使用 `creating / running / stopped / deleting / failed`。`queued / booting / stopping / resuming / metadata_rebuilding / recovering` 由主状态、operation 字段和 Manager 运行态派生，用于 UI 和失败分类，不写入 `codespace.status`。
- 异步生命周期统一称为 operation。统一术语后，领取、lease、状态写入和 reconciliation 可以使用同一套处理逻辑，也能和 task、job 等 CI/CD 术语区分开。
- 容量控制由 Manager 通过 `capacity_total / capacity_available` 上报。Declare 中的最近容量快照只用于 UI 和诊断；`FetchOperations` 只使用本次 request 的容量判断 create/resume 领取。真实资源占用由 Manager 控制，因为只有 Manager 能看到本地 Runtime 队列、backend 限制和启动中实例。
- Gitea 侧复用现有 permission、token、SSH key、setting、cron、routing、DBFS 和测试组织方式。复用现有基础能力减少新的安全边界和重复实现，让 codespace 行为与 Gitea 现有访问模型一致。

实现完成后的最低验证：

```bash
cd gitea
go test ./...
make fmt
make lint-backend
```

实现验收点：

- 实现命名、主状态、operation 类型和路由与最终设计文档一致。
- Gitea 不包含具体 Runtime backend 驱动或本地容量计数。

## 测试组织

测试按层组织：

- `models/codespace`：状态字段、索引、查询、token binding 反查。
- `services/codespace`：权限判定、State Finalization、repository delete pre-cleanup、repo-bound token、日志规范化编码和 offset。
- `routers/api/codespace`：ManagerService RPC auth、`FetchOperations` 领取、UpdateOperation 幂等。
- `routers/web/codespace`：create/open/stop/resume/delete 页面行为。
- `integration`：create -> fetch operation -> log -> done -> open token -> delete 完整流程。
- `integration`：覆盖未绑定同步 delete、resume 后 token 轮换、running operation 重发、旧 generation 拒绝和 Gateway session revalidate。

测试辅助：

- ManagerService 使用 fake Manager identity。
- Runtime Metadata 使用 cache fake。
- Git repo/ref 解析复用 Gitea 现有 repository test fixture。
- DBFS 日志使用测试 DB。
- State Finalization 覆盖并发和重复终态。

Codespace 的主要风险集中在权限、状态事务、token 生命周期和异步领取。服务层测试覆盖核心规则，路由测试覆盖 Web/RPC 输入输出，集成测试覆盖跨层事务边界。Manager backend 不进入 Gitea 服务层测试，可以让测试重点保持在 Gitea 数据库状态和服务行为上。

实现验收点：

- models 测试覆盖非空 generation 默认值、索引和 token binding。
- services 测试覆盖状态事务、所有 PAT 删除入口的 repo-bound token 保护、损坏 token pair 先删除旧 token row、并发 token 请求/吊销、用户删除后拒绝补签、日志并发 offset、截断摘要幂等、日志行边界读取和强制清理。
- RPC 测试覆盖批量 claim、单条 payload 构造失败后继续、系统错误整批回滚、running payload 重发、disabled abort、deadline/Cron 竞争、`resource_absent`、访问判定 oneof、日志 next/current offset detail、旧 operation 上下文和 generation 基线恢复。
- integration 测试覆盖 create、stop、resume token 轮换、disabled 时已领取 operation 收敛、session revalidate、用户删除 token 清理且不补签和 delete。
- integration 测试覆盖 repository 删除后的本地 create 恢复、resume 无 repository payload、metadata 同 generation TTL 刷新、inventory instruction 重试、operation 版本不一致时 refetch、无 active operation 时明确清除旧上下文，以及空 Fetch 响应不清除 worker。
- Manager/Gateway 测试覆盖 Runtime HTTP 固定 JSON 和错误状态、`/boot` 不返回 Gitea token、Runtime Token 三重绑定、当前快照崩溃恢复、Fetch 退避不阻塞续租、Endpoint host 固定到所属 Runtime、HTTP/HTTPS 控制面/用户入口/upstream、gateway base path、可信转发头覆盖、open code 303 清理、session 上限/TTL/idle/cookie 属性和 secret 轮换响应丢失恢复。
