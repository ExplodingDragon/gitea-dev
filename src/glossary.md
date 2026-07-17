# 术语

<span id="codespace"></span>
## Codespace
Gitea 中的一条远程开发环境记录。

<span id="runtime-instance"></span>
## Runtime Instance
Manager 创建的 VM、容器或工作负载。

<span id="codespace-manager"></span>
## Codespace Manager
运行侧服务，负责注册、领取 operation、管理 Runtime Instance、上传日志和上报 Runtime Metadata。删除 Manager 时，Gitea 删除其注册身份及绑定的 Gitea 资源并同步返回；运行侧 Runtime 是否回收由部署运维负责。这样账户和身份删除不依赖 Manager 在线。

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
Gitea 当前下发给 Manager 的异步生命周期操作，类型为 create、resume、stop、delete。operation 只表示 active 指令，完成后不保留历史状态；站点进入排空模式后返回的 `abort_create|abort_resume` 是现有 create/resume 的清理命令，不增加新的 operation 类型。

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
Gitea 为 Runtime Instance 签发的独立 opaque 开发凭据，使用 `gcs_` 前缀并存储在 `codespace_gitea_token`。它代表 Codespace 创建用户，仅在 Codespace 工作状态且创建用户满足当前登录限制时授权新请求，用于绑定 repository 的 Git/LFS 和开发协作 API；它不是普通 PAT。登录限制只改变请求授权，不删除或轮换工作状态中的 Token 行。

<span id="registration-token"></span>
## Registration Token
管理员为 owner scope 创建的当前明文注册凭据，存储在 `codespace_manager_token` 表，每个 owner 最多一行。Manager 通过 `RegisterManager` 注册并获得 manager secret；轮换原地替换，停用物理删除，不保存历史。

<span id="runtime-token"></span>
## Runtime Token
Manager 签发给 Runtime Instance 调用 Runtime HTTP API 的 token。

<span id="manager-secret"></span>
## Manager Secret
Manager 调用 ManagerService RPC 的长期凭据。

<span id="runtime-metadata"></span>
## Runtime Metadata
Manager 上报到 Gitea 缓存的动态运行时信息。缓存未命中后由 Manager 重建，外部缓存实现在 TTL 内保留的合法快照可以继续使用；每个 Codespace 使用单调递增的 `metadata_generation`，Gitea 只接受当前版本或更高版本。

<span id="interactive-access"></span>
## Interactive Access
open Endpoint、SSH、resume。

<span id="administrative-permission"></span>
## Administrative Permission
查看最小信息、日志、stop、delete。

<span id="state-finalization"></span>
## State Finalization
主状态写入流程。Gitea 根据 operation 结果、超时、Runtime 缺失或 failed 运行状态报告，在同一事务中写入 Codespace 主状态、Token 结果并清空 active operation。物理删除路径直接删除记录与日志。

<span id="state-reconciliation"></span>
## State Reconciliation
状态差异处理规则。Gitea 比较数据库主状态与 Manager 当前有效报告，并按状态表写入唯一确定的结果。周期任务处理数据库可以独立判断的 operation 超时和 Manager 可用性；Runtime inventory 差异在 `ReportInstances` 请求内处理，Codespace Token 由签发和生命周期事务维护。

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
Gitea 返回给 Manager 的互斥处理动作：删除本地 Runtime、上报 Runtime 状态变化、重新获取当前 operation、清除旧 operation 上下文或停止本地 Runtime。每条 instruction 只设置一个 action；transition action 携带 Gitea 当前 operation 版本。cleanup 只针对 Gitea 中仍存在且能确认 Manager 绑定冲突或主状态为 failed 的记录。用户、组织、Manager、Codespace 或 failed retention 已直接删除后，未知 UUID 保持无动作，因为 Gitea 没有足够信息授权破坏运行侧资源。

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

- operation、Runtime 状态报告、inventory 和 metadata 使用不同术语及版本，各自使用对应的版本字段。
- 文档中的 Codespace、Manager、Gateway、Runtime Instance 和 token 名称与接口定义一致。
- “删除 Manager”与“Codespace delete operation 清理 Runtime”是两个不同动作，不混用。
