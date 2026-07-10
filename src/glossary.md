# 术语

<span id="codespace"></span>
## Codespace
Gitea 中的一条远程开发环境记录。

<span id="runtime-instance"></span>
## Runtime Instance
Manager 创建的 VM、容器或工作负载。

<span id="codespace-manager"></span>
## Codespace Manager
运行侧 worker，负责注册、领取 operation、管理 Runtime Instance、上传日志、上报 Runtime Metadata。

<span id="codespace-gateway"></span>
## Codespace Gateway
Manager deployment 内的用户 Endpoint 与 SSH 接入组件。

<span id="manager-service"></span>
## ManagerService
Gitea 实现、Manager 调用的 Connect RPC over HTTP 服务。

<span id="runtime-http-api"></span>
## Runtime HTTP API
Manager 实现、Runtime Instance 使用 Runtime Token 调用的 HTTP/JSON API。

<span id="operation"></span>
## Operation
一次异步生命周期操作，类型为 create、resume、stop、delete。

<span id="manager-matching"></span>
## Manager Matching
Gitea 按 owner scope 和 repository tag 匹配可以领取 create operation 的 Manager。

<span id="manager-capacity"></span>
## Manager Capacity
Manager 最近上报的本地 create/resume 可接收能力快照，用于展示、诊断和 FetchOperation 领取判断。

<span id="endpoint"></span>
## Endpoint
Runtime 声明的可打开入口，使用 endpoint_id 标识。

<span id="gateway-open-token"></span>
## Gateway Open Token
Gitea 为打开 Endpoint 签发的一次性短期 opaque token。

<span id="gitea-token"></span>
## Gitea Token
Gitea 签发给 Runtime Instance 做 git 访问的 access token。

<span id="registration-token"></span>
## Registration Token
管理员创建的明文凭据，存储在 `codespace_manager_token` 表。Manager 通过 `RegisterManager` 注册并获得 manager secret。设计与 `action_runner_token` 一致（明文存储、唯一索引查找）。

<span id="runtime-token"></span>
## Runtime Token
Manager 签发给 Runtime Instance 调用 Runtime HTTP API 的 token。

<span id="manager-secret"></span>
## Manager Secret
Manager 调用 ManagerService RPC 的长期凭据。

<span id="runtime-metadata"></span>
## Runtime Metadata
Manager 上报到 Gitea 本地 cache 的动态运行时信息。

<span id="interactive-access"></span>
## Interactive Access
open Endpoint、SSH、resume。

<span id="administrative-permission"></span>
## Administrative Permission
查看最小信息、日志、stop、delete。

<span id="state-finalization"></span>
## State Finalization
Gitea 根据 operation 结果推导 codespace 主状态的服务逻辑。

<span id="state-reconciliation"></span>
## State Reconciliation
Gitea 后台任务处理 operation 超时、过期上报、状态分歧和清理。

<span id="stale-report"></span>
## Stale Report
Manager 上报中的 `codespace_uuid`、`operation_rversion`、`manager_id` 或 operation status 与当前 codespace 状态不匹配。

<span id="state-divergence"></span>
## State Divergence
Gitea 记录状态与 Manager 上报的 Runtime Instance 实际状态不一致。

<span id="runtime-inventory"></span>
## Runtime Inventory
Manager 通过 `ReportInstances` 上报的本地 Runtime Instance 快照，用于 Gitea 计算 expected/reported 差异。

<span id="manager-instruction"></span>
## Manager Instruction
Gitea 返回给 Manager 的调和指令，例如 cleanup_local_runtime。

## 命名规则

- codespace 创建者字段统一为 `user_id`。
- repository owner 仍为 `repository.owner_id -> user.id`。
- Endpoint 字段统一为 `endpoint_id`。
- Endpoint 唯一性范围是单个 `codespace_uuid`。
- Endpoint 不是端口模型。
- 动态运行时数据统一称为 Runtime Metadata。
