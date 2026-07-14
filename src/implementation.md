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
- `services/codespace`：权限判定、State Finalization、repository/owner delete pre-cleanup、repo-bound token、日志规范化编码和 offset。
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

- models 测试覆盖 generation 的 0 初始值、有效值从 1 开始、checked increment 不回绕、索引和 token binding。
- services 测试覆盖状态事务、所有 PAT 删除入口的 repo-bound token 保护、损坏 token pair 先删除旧 token row、并发 token 请求/吊销、用户或组织删除关联资源事务、任意状态 Manager 直接删除事务、日志并发 offset、部分重叠拒绝、截断摘要幂等、日志行边界读取和强制清理。
- RPC 测试覆盖批量独立 claim、Fetch 遇到过期 queued 候选时条件 timeout 并继续本批、单条 payload 构造失败后条件释放、系统错误后已提交 claim 的 running 重发、当前 Manager tags 与 repository owner scope 筛选、transfer/claim 条件更新竞争、disabled abort、deadline/Cron 竞争、过期 UpdateOperation 请求内 timeout 与确定 outcome、五种 UpdateOperation outcome、同版本错误 operation 类型的 stale outcome、访问判定 oneof、日志 next/current offset detail、旧 operation 上下文和 generation 基线恢复。
- RPC 测试覆盖 Declare 完整快照原子覆盖、可修改字段、Gateway URL 与 SSH 地址规范化唯一性、失败声明不更新 heartbeat、Declare 容量上限、超过 10000 个 Runtime 拒绝截断 inventory、reported creating 只作为存在证据，以及未绑定 creating 不返回 cleanup。
- integration 测试覆盖 create、stop、resume token 轮换、disabled 时已领取 operation 收敛、session revalidate fail closed，以及用户、组织或 Manager 删除同步清理 Gitea 资源且不产生 Manager instruction。
- integration 测试确认删除后未知 Runtime inventory 被忽略，运行侧残留不触发补偿、墓碑或 Gitea 状态恢复。
- integration 测试覆盖 failed retention 直接清理 Gitea 资源且不联系 Manager，以及账户/Manager 批量删除与 inventory、token、metadata 并发时遵守固定锁序并完成收敛。
- integration 测试覆盖 repository 删除后的本地 create 恢复、resume 无 repository payload、restart grace 内 missing creating 不提前失败、metadata 同 generation TTL 刷新、running fact 数据库提交前后的 cache 故障与相同 generation 补写、stopped/failed fact cache 清理重试、inventory instruction 重试及其 operation 版本恢复、operation 版本不一致时 refetch、无 active operation 时明确清除旧上下文，以及空 Fetch 响应不清除 worker。
- integration 测试覆盖 running/stopped 主动 failed fact、failed inventory 恢复 operation 版本基线、active operation 存在时先 refetch 后 final failed、enabled recovering 上报、disabled failed fact、offline 先 Declare recovering、active operation conflict、runtime generation 的 stale/目标幂等/conflict/新版本矩阵、响应丢失幂等、token/cache/session 清理、failed retention 起点不被重试刷新，以及立即本地清理与后续 inventory cleanup。
- Manager/Gateway 测试覆盖完整本地配置解析、同一状态目录单进程锁、五种 UpdateOperation outcome 的 worker 收敛、Runtime HTTP 固定 JSON/category 和生命周期矩阵、`/boot` 唯一终态上报及 operation final 后相同 POST 重试、source IP 到 backend identity 唯一反查、backend label 与损坏快照恢复、resume final 后 credential-refresh 后置恢复、更高 stop/delete 取消旧后置 worker、Runtime token 替换并重启 agent、Fetch 退避不阻塞续租、Endpoint 本地持久化与 metadata 接受后的成功边界、pending generation 下相同 mutation 重试和不同 mutation 冲突、生命周期变化取消 pending mutation 后返回 conflict 且 generation 高水位不回退、目标变化关闭 session、固定 upstream root path、HTTP/HTTPS 控制面/用户入口/upstream、Gateway 本地固定 HTTP 失败状态、完整 UUID host 派生、workspace Web SSH 回退、wildcard DNS/TLS、Host 与 binding 匹配、可信转发头、Gateway session cookie 清除、upstream `Set-Cookie` 父域与保留名称过滤、open code 303 清理、HTTP 请求前到期复检、WebSocket/SSH 定时复检、Endpoint 与 SSH 共用 session 上限、TTL/idle/cookie 属性、SSH 四维限流、SSH key 丢失恢复和 secret 轮换响应丢失恢复。
- integration 测试覆盖 State Finalization 主事务成功而内部状态摘要事务失败的情况，确认生命周期结果不回滚且后续 operation 可继续追加同一日志文件；delete done 和其他物理删除路径不重新创建日志。
