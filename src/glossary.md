# 术语

<span id="codespace"></span>
## Codespace
Gitea 中的一条远程开发环境记录。

<span id="runtime-instance"></span>
## Runtime Instance
Manager 创建的 VM、容器或工作负载。

<span id="codespace-manager"></span>
## Codespace Manager
运行侧 worker，负责注册、领取 operation、管理 Runtime Instance、上传日志、上报 Runtime Metadata。删除 Manager 表示删除 Gitea 注册身份及其绑定的 Gitea 资源，不表示远程 Runtime 已回收。

<span id="codespace-gateway"></span>
## Codespace Gateway
Manager deployment 内的用户 Endpoint 与 SSH 接入组件。

<span id="manager-service"></span>
## ManagerService
Gitea 实现、Manager 调用的 Connect RPC over HTTP/HTTPS 服务；scheme 由部署配置决定。

<span id="runtime-http-api"></span>
## Runtime HTTP API
Manager 实现、Runtime Instance 使用 Runtime Token 调用的 HTTP(S)/JSON API；是否要求 HTTPS 由 Manager 配置决定。

<span id="operation"></span>
## Operation
Gitea 当前下发给 Manager 的异步生命周期操作，类型为 create、resume、stop、delete。operation 只表示 active 指令，完成后不保留历史状态；disabled 后返回的 `abort_create|abort_resume` 是现有 create/resume 的清理命令，不增加新的 operation 类型。

<span id="manager-matching"></span>
## Manager Matching
Gitea 按 owner scope 和 repository tag 匹配可以领取 create operation 的 Manager。

<span id="manager-capacity"></span>
## Manager Capacity
Manager 通过 Declare 明确字段上报、由 Gitea 规范化写入 `meta_json` 的本地 create/resume 可接收能力快照，用于管理页面展示和诊断。`FetchOperations` 领取判断以 request 中 `capacity_total / capacity_available` 声明值为准。

<span id="endpoint"></span>
## Endpoint
使用 `endpoint_id` 标识的可打开入口。普通 Endpoint 来自 Runtime Metadata；每个 running Codespace 另有稳定的 `workspace` 逻辑入口，Manager 在 Runtime 声明同名 Endpoint 时连接该 upstream，否则连接默认 Web SSH。

<span id="gateway-open-token"></span>
## Gateway Open Token
Gitea 为打开 Endpoint 签发的一次性短期 opaque token。采用 OAuth2 Authorization Code 模式：Gitea 作为 Authorization Server 签发 authorization code（`hex(CryptoRandomBytes(32))`），Gateway 作为 Client 以 Manager 身份提交 code 换取 open binding。完整流程见 [Gitea 服务端 - Gateway Open Token](gitea-server.md#gateway-open-token)。

<span id="gitea-token"></span>
## Gitea Token
Gitea 签发给 Runtime Instance 做 git 访问的 access token。

<span id="registration-token"></span>
## Registration Token
管理员创建的明文凭据，存储在 `codespace_manager_token` 表。Manager 通过 `RegisterManager` 注册并获得 manager secret。设计与 `action_runner_token` 一致。

<span id="runtime-token"></span>
## Runtime Token
Manager 签发给 Runtime Instance 调用 Runtime HTTP API 的 token。

<span id="manager-secret"></span>
## Manager Secret
Manager 调用 ManagerService RPC 的长期凭据。

<span id="runtime-metadata"></span>
## Runtime Metadata
Manager 上报到 Gitea 本地 cache 的动态运行时信息。每个 codespace 使用单调递增的 `metadata_generation`，旧快照不能覆盖新快照。

<span id="interactive-access"></span>
## Interactive Access
open Endpoint、SSH、resume。

<span id="administrative-permission"></span>
## Administrative Permission
查看最小信息、日志、stop、delete。

<span id="state-finalization"></span>
## State Finalization
Gitea 根据 operation 结果、timeout、missing Runtime 或 failed fact 写入 codespace 主状态、token 和 active operation 结果的服务逻辑。物理删除路径直接删除记录与日志，不追加内部状态摘要。

<span id="state-reconciliation"></span>
## State Reconciliation
Gitea 将数据库主状态与当前有效事实收敛到明确结果的规则集合。周期任务只处理数据库可判断的 operation 超时、Manager 可用性和 token binding；Runtime inventory 差异在 `ReportInstances` 请求内处理。

<span id="stale-report"></span>
## Stale Report
Manager 上报中的 `codespace_uuid`、`operation_rversion`、`manager_id` 或 operation status 与 Gitea 当前 active operation 不匹配。

<span id="state-divergence"></span>
## State Divergence
Gitea 记录状态与 Manager 上报的 Runtime Instance 实际状态不一致。

<span id="runtime-inventory"></span>
## Runtime Inventory
Manager 通过 `ReportInstances` 上报的本地 Runtime Instance 快照。完整快照使用单调递增的 `inventory_generation`，Gitea 只用最新版本计算 expected/reported 差异。inventory 中的 failed 表示 Runtime identity 仍存在但 Manager 已确认不可恢复：无 active operation 时用它取得 transition 版本，有 active operation 时用它取得 refetch 指令；两种情况都不由 inventory 直接改写持久主状态。

<span id="manager-instruction"></span>
## Manager Instruction
Gitea 返回给 Manager 的互斥调和动作：cleanup local Runtime、上报 Runtime transition、重新获取当前 operation、清除旧 operation 上下文或停止本地 Runtime。每条 instruction 只设置一个 action；transition action 携带 Gitea 当前 operation 版本。cleanup 只针对 Gitea 中仍存在且能确认 Manager binding 冲突或主状态为 failed 的记录；用户、组织、Manager、Codespace 或 failed retention 已直接删除后，未知 UUID 不返回 instruction。

<span id="minimal-info"></span>
## Minimal Info
面向列表页、站点管理员管理视图和 repository 删除后的弱关联展示的缩略字段集，只包含识别对象、判断状态和发起允许动作所需信息（`uuid`、`status`、`created_unix`、`user_id`、`ref_type`、`manager_id` 等），不含 token、internal SSH、Endpoint upstream 或日志正文。完整字段定义见 [Gitea 服务端 - Minimal Info](gitea-server.md#minimal-info)。

## 命名规则

- codespace 创建者字段统一为 `user_id`。
- repository owner 仍为 `repository.owner_id -> user.id`。
- Endpoint 字段统一为 `endpoint_id`。
- Endpoint 唯一性范围是单个 `codespace_uuid`。
- Endpoint 不是端口模型。
- 动态运行时数据统一称为 Runtime Metadata。

实现验收点：

- operation、Runtime fact、inventory 和 metadata 使用不同术语及版本，不混用 `operation_rversion`。
- 文档中的 Codespace、Manager、Gateway、Runtime Instance 和 token 名称与接口定义一致。
- “删除 Manager”与“Codespace delete operation 清理 Runtime”是两个不同动作，不混用。
