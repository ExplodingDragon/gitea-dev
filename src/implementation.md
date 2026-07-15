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
- Gitea 侧复用现有 permission、token、SSH key、setting、cron、routing、DBFS、`modules/cache`、`modules/globallock` 和测试组织方式。复用现有基础能力减少新的安全边界和重复实现，让 codespace 行为与 Gitea 现有访问模型一致；Codespace 只增加 cache key/value 结构和纯 lock key helper，需要锁的明确路径直接调用 `globallock.Lock`，不实现 cache adapter、Locker、mutex pool、lock wrapper 或 Redis client。

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

- models 测试覆盖 generation 的 0 初始值、有效值从 1 开始、checked increment 不回绕、operation 版本耗尽无部分写入、Manager generation 耗尽进入 recovering、索引和 token binding。
- services 测试覆盖状态事务、`updated_unix` 更新时间矩阵、`DeleteAccessToken` 返回类型化的 `ErrAccessTokenUsedByCodespace`、`DeleteAccessTokenForCodespaceLifecycle` 复用调用者事务并原子删除 token row/清空 token pair、Codespace PAT 固定名称和列表/409 行为、损坏 token pair 先删除旧 token row、并发 token 请求/吊销、owner 前置清理与 repository 删除置 0 的并发顺序、任意状态 Manager 直接删除事务、日志并发 offset、部分重叠拒绝、截断摘要幂等、日志行边界读取和强制清理。
- RPC 测试覆盖批量独立 claim、Fetch 全请求持有调用方 Manager lock、Fetch 与 Manager/owner 删除并发、observed-only 续租回执与 payload/abort 互斥、续租回执不占 `max_operations`、Fetch 遇到过期 queued 候选时条件 timeout 并继续本批、running observed/payload 在未到期、有效 grace、online 过期和 hard-grace 过期下的四种结果、disabled abort 不续租、单条 payload 构造失败后条件释放、系统错误后已提交 claim 的 running 重发、当前 Manager tags 与 repository owner scope 筛选、transfer/claim 条件更新竞争、deadline/Cron 竞争、过期 UpdateOperation 请求内 timeout 与确定 outcome、五种 UpdateOperation outcome、active operation 存在时同版本错误类型的 stale outcome、active 清空后的目标状态幂等、访问判定 oneof、日志 next/current offset detail，以及 inventory/runtime/metadata 三类 generation 的 stale、同代冲突、升代重报和版本耗尽恢复。
- RPC 测试覆盖 Declare 完整快照原子覆盖、可修改字段、Gateway URL 与 SSH 地址规范化唯一性、失败声明不更新 heartbeat、Declare 容量上限、超过 10000 个 Runtime 拒绝截断 inventory、reported creating 只作为存在证据，以及未绑定 creating 不返回 cleanup。
- integration 测试覆盖 create、stop、resume token 轮换、disabled 时已领取 operation 收敛、session revalidate fail closed，以及用户、组织或 Manager 删除同步清理 Gitea 资源且不产生 Manager instruction。
- integration 测试确认删除后未知 Runtime inventory 被忽略，运行侧残留不触发补偿、墓碑或 Gitea 状态恢复。
- integration 测试覆盖 failed retention 直接清理 Gitea 资源且不联系 Manager，以及账户/Manager 批量删除与 inventory、token、metadata 并发时遵守固定锁序并完成收敛。
- integration 测试覆盖 repository 删除后的本地 create 恢复、resume 无 repository payload、restart grace 内 missing creating 不提前失败、metadata 同 generation TTL 刷新、running fact cache 写失败不提交数据库、数据库失败后相同 generation 补写、stopped/failed 数据库提交后 cache 清理失败仍成功且残留 cache 无法授权、Open Code 部分签发与消费删除失败、inventory instruction 重试及其 operation 版本恢复、operation 版本不一致时 refetch、无 active operation 时明确清除旧上下文，以及空 Fetch 响应不清除 worker。
- integration 测试覆盖 `ENABLED=false` 的排空矩阵、active running stop 只读已有完整 token pair、其他请求不签发/修复/返回 token、重新启用后的现状恢复，以及 stop/failed/deleting 后新 Git/LFS 请求重新认证并拒绝、已进入处理链的请求按现有 Gitea 行为结束。
- integration 测试覆盖单活动 Gitea 进程边界、`CreateCodespace` 记录插入事务与 repository 删除串行、transfer 与 owner 删除串行，以及 owner/repository/Manager/Codespace 固定锁序。用户自助 Web、管理员用户 Web、管理员用户 API、组织 Web、组织 API 五个外部删除入口分别验证前置条件和统一服务顺序；inactive-user Cron 与 user purge 的 last-owner 组织删除也验证相同清理边界。
- integration 测试分别覆盖 memory/twoqueue cache miss 和外部 cache 在 TTL 内保留两种重启结果，确认保留的 Open Code 仍执行完整访问校验、保留的 Metadata 不替代数据库主状态；同时确认 Codespace 明确 TTL 不读取通用 `ITEM_TTL`，Session Provider 不参与 Codespace cache。
- services 测试确认文档列出的写路径直接调用 `globallock.Lock`，代码中不存在 Codespace Locker、mutex pool 或 lock wrapper；repository transfer/delete 与 `CreateCodespace` 记录插入事务通过 `modules/repository.WorkingLockKey` 共用 `repo_working_{repo_id}`，多对象锁按地址、owner、repository、Manager、Codespace 和同层稳定升序取得。pending transfer 创建/取消/拒绝只取得 repository lock，实际 owner 变更取得排序后的原/新 owner lock 和 repository lock。
- cache 测试覆盖读取错误按 miss fail closed、损坏 Open Code/Metadata/index 的固定处理、签发成功当刻 code/index 均存在、index 被单独淘汰后 code 仍完整复检，以及必要 Put/Delete 失败和提交后清理失败的不同结果。
- integration 测试覆盖 Basic、Bearer 和 query PAT 均写入实际 `AccessTokenID`，OAuth2 access token、Actions token/JWT、session、reverse proxy 和 SSH 身份不写 PAT ID；API/Web final guard 与 Git HTTP/LFS adapter 默认拒绝未完成唯一 repository 判定的 bound PAT，raw/archive/download/feed 复用目标，跨 repository 拒绝，并保持现有 HTTP 401/403 适配。当前 token DELETE handler 对三种 PAT 认证都读取 context ID 并验证绑定 token 返回 409、普通 PAT 返回 204；`GET /token` 与其他非 repository 请求验证 403，且默认拒绝发生在 handler 执行前。
- integration 测试确认 repository 数据库删除提交并释放 owner/repository lock 后才执行 `RepositoryCleanupPlan`；文件清理失败沿用 Gitea 现有 system notice 和日志，不回滚数据库结果或创建补偿任务。
- Cron 测试覆盖 100 条 keyset 批次、单记录短事务、单条失败继续、数据库级错误终止和下一轮重试失败项。
- integration 测试覆盖 running/stopped 主动 failed fact、failed inventory 恢复 operation 版本基线、active operation 存在时先 refetch 后 final failed、enabled recovering 上报、disabled failed fact、offline 先 Declare recovering、active operation conflict、transition 对 current-operation/stale-operation/stale-generation/generation-conflict/manager-disabled/manager-offline/codespace-not-found/manager-unregistered 的固定收敛、runtime generation 的 stale/目标幂等/conflict/新版本矩阵、响应丢失幂等、token/cache/session 清理、failed retention 起点不被重试刷新，以及立即本地清理与后续 inventory cleanup。
- Manager/Gateway 测试覆盖完整本地配置解析、同一状态目录单进程锁、五种 UpdateOperation outcome 的 worker 收敛、lease 到期暂停普通 backend 变更和 abort 仅缩减清理、Runtime HTTP 固定 JSON/category 和生命周期矩阵、`POST /boot` 以本地终态持久化为成功线性化点、operation final 或后续 stop/delete 后相同 POST 重试、pending Endpoint generation 期间 boot 结果先持久化且后置 worker 顺序等待、source IP 到 backend identity 唯一反查、backend label 与损坏快照恢复、resume final 后 credential-refresh 在 recovering 无 active operation 时恢复、disabled/offline/resource-absent/更高 operation 收敛、Runtime token 替换并重启 agent、Fetch 退避不阻塞续租、Endpoint pending desired 与 active route 持久化、metadata 提交屏障期间新路由请求返回 503、接受后才关闭受影响 session 并切换 route、Report 失败和生命周期取消保留旧 active route、pending generation 下相同 mutation 重试和不同 mutation 冲突、generation 高水位不回退、固定 upstream root path、HTTP/HTTPS 控制面/用户入口/upstream、Gateway 本地固定 HTTP 失败状态、完整 UUID host 派生、workspace Web SSH 回退、wildcard DNS/TLS、Host 与 binding 匹配、可信转发头、Gateway session cookie 清除、upstream `Set-Cookie` 父域与保留名称过滤、open code 303 清理、HTTP 请求前到期复检、WebSocket/SSH 定时复检、Endpoint 与 SSH 共用 session 上限、TTL/idle/cookie 属性、SSH 四维限流、SSH key 丢失恢复和 secret 轮换响应丢失恢复。
- integration 测试覆盖 State Finalization 主事务成功而内部状态摘要事务失败的情况，确认生命周期结果不回滚且后续 operation 可继续追加同一日志文件；delete done 和其他物理删除路径不重新创建日志。
