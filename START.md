# Gitea Codespace 最终设计

本文档定义 codespace 的目标设计，工程实现和优化以本文档为准。

## 目标

Codespace 是 Gitea 内置的远程开发环境能力。

Gitea 是状态、权限、审计、日志、token 和任务队列的唯一权威。Codespace Manager 是尽可能无状态的执行器，只负责领取任务、调用运行时后端、上报日志、上报事实结果。

Gitea 不直接操作 Incus，不代理 codespace 流量，不把镜像、规格、Incus remote、Incus project、初始化脚本等运行侧配置写入 `app.ini`。

## 命名

统一使用单数 `codespace`。

模块：

```text
codespace/
codespace-proto-go/
gitea.dev/codespace
gitea.dev/codespace-proto-go
```

Proto：

```proto
package codespace.v1;
option go_package = "gitea.dev/codespace-proto-go/codespace/v1;codespacev1";
```

## 核心原则

- 用户所有中间状态都在 Gitea 页面查看。
- Gitea 保存完整 operation 日志，manager 离线后仍可审计。
- manager 不保存业务状态；重启后通过任务和实例名恢复执行。
- create/resume/stop/delete 都必须幂等。
- 用户可读 repository 也可以创建 codespace。
- git token 必须以用户权限为基础签发，不能以 manager、系统账户或仓库全局权限代替。
- 下发给实例的 runtime token 绑定 codespace 实例，整个实例生命周期不变化。
- Gitea 根据实例状态启用或禁用 runtime token。
- manager 上报必须带 operation/task 标识，Gitea 只接受当前 active operation 的上报。

## 可见状态

用户可见状态只有：

```text
initializing  初始化中
running       运行中
stopping      停止中
stopped       已停止
error         错误
deleting      销毁中
```

销毁完成后，codespace 从普通列表移除。审计记录和日志保留在后台数据中。

## 页面模型

Gitea 提供独立 codespace 页面：

```text
GET  /codespace
GET  /codespace/{uuid}
GET  /codespace/{uuid}/create
GET  /codespace/{uuid}/logs
POST /codespace/{uuid}/cancel
POST /codespace/{uuid}/retry
POST /codespace/{uuid}/stop
POST /codespace/{uuid}/resume
POST /codespace/{uuid}/delete
```

Repository 页面只负责发起创建：

```text
GET  /{owner}/{repo}/codespace
POST /{owner}/{repo}/codespace
```

创建成功后立即跳转：

```text
/codespace/{uuid}/create
```

初始化页展示：

- 当前状态。
- 当前 operation。
- manager 分配状态。
- 初始化日志。
- 错误原因。
- retry/cancel 操作。

实例详情页展示：

- repo/ref/commit/pull request 信息。
- manager 信息。
- instance 信息。
- runtime token 启用状态。
- ports。
- 最近日志。
- open/stop/resume/delete 管理操作。

## Repository 创建入口

创建入口必须支持细粒度 ref。

创建参数：

- repository ID。
- owner/name。
- ref type: `branch`, `tag`, `commit`, `pull`。
- ref name。
- commit SHA。
- pull request ID。
- target branch。
- head branch。
- head repository。
- manager selector。
- instance type。
- image。
- resource preset。

权限规则：

- 用户对 repository 有读权限即可创建 codespace。
- 创建时记录用户身份、仓库、ref、commit、pull request。
- git token 按创建用户的真实权限签发。
- 只读用户拿到的 token 只能读，不能写。
- 有写权限的用户是否允许 push，由 Gitea token scope 和仓库权限共同决定。
- pull request codespace 必须记录 PR ID、base/head 信息，用于审计。
- fork PR 场景必须按用户对 head/base 仓库的实际权限签发 token。
- pull request codespace 下发给 manager 的 Git 起点是 Gitea 解析后的 `refs/pull/{index}/head` 和锁定的 commit SHA。

安全约束：

- manager 不得拿到超出用户权限的 git token。
- manager 不得用自己的身份替用户访问 repository。
- runtime token 不得访问 Gitea repository API。
- access ticket 只用于用户打开 gateway，不用于 git 权限。

## 创建流程

```text
用户点击 Create
  -> Gitea 校验用户对 repo/ref 的读权限
  -> Gitea 解析 ref，锁定 commit SHA
  -> Gitea 创建 codespace，status=initializing
  -> Gitea 创建 instance runtime token，enabled=true
  -> Gitea 创建 create operation/task
  -> Gitea redirect /codespace/{uuid}/create
  -> 页面通过轮询或 SSE 读取状态和日志
  -> manager 领取 create task
  -> manager 上报初始化日志
  -> manager 创建实例并执行 bootstrap
  -> manager 上报端口和最终结果
  -> Gitea status=running
  -> 页面跳转 /codespace/{uuid}
```

没有可用 manager：

```text
status=initializing
status_reason=waiting_for_manager
operation 保持 queued
页面显示等待 manager
用户可以 cancel
```

manager 创建失败：

```text
operation=failed
status=error
runtime_token_enabled=false
保留完整日志
页面显示 retry/delete
```

manager panic 或进程退出：

```text
task lease timeout
attempts + 1
未超过 max_attempts 时重新 queued
超过 max_attempts 时 status=error
```

manager 离线：

```text
heartbeat timeout
manager 标记 unavailable
已 lease task 等待 lease timeout
task 可被同一个 manager 恢复，或由满足同 scope/capability 的 manager 重试
```

用户取消创建：

```text
POST /codespace/{uuid}/cancel
  -> active operation 标记 cancelled
  -> runtime_token_enabled=false
  -> status=deleting
  -> 创建 delete/cleanup operation
  -> 清理完成后从普通列表移除
```

## 运行中流程

运行中稳定态：

```text
status=running
runtime_token_enabled=true
open 可用
stop/delete 可用
ports 可显示
```

用户打开：

```text
GET /codespace/{uuid}
  -> 用户点击 Open
  -> Gitea 创建 access ticket
  -> redirect manager gateway
  -> gateway 调 ValidateAccessTicket
  -> gateway 建立用户会话
```

## 停止流程

```text
用户点击 Stop
  -> Gitea status=stopping
  -> runtime_token_enabled=false
  -> 创建 stop operation/task
  -> manager 停止实例
  -> manager 上报结果
  -> Gitea status=stopped
```

停止失败：

```text
operation=failed
status=error
runtime_token_enabled=false
页面显示 retry/delete
```

## 恢复流程

```text
用户点击 Resume
  -> Gitea status=initializing
  -> runtime_token_enabled=true
  -> 创建 resume operation/task
  -> manager 只启动已存在实例
  -> manager 补齐必要初始化
  -> manager 上报端口和最终状态
  -> Gitea status=running
```

恢复失败：

```text
operation=failed
status=error
runtime_token_enabled=false
页面显示 retry/delete
```

实例被外部删除：

```text
manager 启动实例时发现 instance 不存在
  -> operation=failed
  -> status=error
  -> 不自动重建实例
  -> 页面显示 delete 或重新创建新的 codespace
```

## 销毁流程

```text
用户点击 Delete
  -> Gitea status=deleting
  -> runtime_token_enabled=false
  -> 创建 delete operation/task
  -> manager 删除实例
  -> manager 上报结果
  -> Gitea soft delete
  -> 普通列表不可见
```

销毁失败：

```text
operation=failed
status=error
runtime_token_enabled=false
页面显示 retry delete
```

## Retry 规则

`retry` 基于当前状态创建新的 operation。

```text
error + last operation create/resume
  -> status=initializing
  -> runtime_token_enabled=true
  -> queue resume/create

error + last operation stop
  -> status=stopping
  -> runtime_token_enabled=false
  -> queue stop

error + last operation delete
  -> status=deleting
  -> runtime_token_enabled=false
  -> queue delete
```

每次 retry 都生成新的 `operation_id`。非 active operation 的上报会被忽略。

## Token 设计

### Manager Registration Token

用于注册 manager。

- scope 支持 global、owner、repo。
- 当前页面展示 active token。
- reset 生成同 scope 新 token。
- 使用后失效。

### Manager Token

用于 manager 调用 control plane。

- 注册成功时返回一次。
- Gitea 只保存 hash/salt。
- 非注册 RPC 使用 manager UUID + manager token header。

### Runtime Token

绑定 codespace 实例。

- 创建 codespace 时生成。
- 整个实例生命周期不变化。
- Gitea 保存 hash/salt。
- manager bootstrap 时注入实例。
- codespace 内部调用 Runtime API 时使用。
- Gitea 通过 `runtime_token_enabled` 控制启用/禁用。

启用规则：

```text
initializing -> true
running      -> true
stopping     -> false
stopped      -> false
error        -> false
deleting     -> false
```

### Git Token

用于实例内 git 操作。

- 由 manager 在 create/resume 时向 Gitea 请求。
- 按创建用户身份和仓库权限签发。
- 绑定 user/repo/codespace/operation。
- 明文只返回给 manager 一次。
- Gitea 保存 hash/salt 和审计信息。
- stop/delete/error 时禁用或吊销。
- 只读用户只能获得只读能力。

### Access Ticket

用于用户从 Gitea 跳转到 manager gateway。

- 短期有效。
- 一次性消费。
- 绑定 user/codespace/action。
- 不授予 git 权限。

## Manager 认证

非注册 RPC 使用：

```text
x-codespace-manager-uuid: <manager uuid>
x-codespace-manager-token: <manager token>
```

Gitea 认证流程：

- 按 UUID 找 manager。
- 检查 manager active。
- hash 请求 token。
- constant-time compare。
- 检查 manager scope 是否允许领取目标 operation。

## Manager 执行模型

manager 尽可能无状态。

manager 本地只需要：

- manager UUID。
- manager token。
- control plane URL。
- gateway URL。
- provisioner 配置。

manager 不保存：

- codespace 权威状态。
- operation 权威状态。
- 用户权限。
- git token 权威状态。
- runtime token 启用状态。

manager 执行要求：

- `create` 幂等：实例不存在时创建；实例存在时继续启动和 bootstrap。
- `resume` 幂等：只启动已存在实例；实例不存在视为错误，不重建。
- `stop` 幂等：实例不存在或已停止视为成功。
- `delete` 幂等：实例不存在视为成功。
- 日志实时 append 到 Gitea。
- 最终结果通过 `FinishTask` 上报。
- 所有上报带 `operation_id` 和 `task_id`。

## Operation / Task 模型

`codespace_operation`：

```text
id
uuid
codespace_id
type=create|resume|stop|delete
status=queued|leased|running|succeeded|failed|cancelled
attempts
max_attempts
lease_manager_id
lease_deadline_unix
created_unix
updated_unix
finished_unix
error_message
log_filename
log_length
log_size
log_indexes
log_expired
```

operation 是 Gitea 内部执行状态，不直接暴露为用户可见状态。

任务领取：

```text
queued
  -> manager FetchTask
leased
  -> manager 开始执行后上报 running
running
  -> FinishTask succeeded/failed
```

lease 超时：

```text
leased/running + lease_deadline expired
  -> attempts + 1
  -> attempts < max_attempts: queued
  -> attempts >= max_attempts: failed, codespace status=error
```

## 日志模型

Codespace 日志不保存大量行数据到数据库。Gitea 参考 Actions 的日志模型，将日志内容追加到 DBFS 文件，数据库只保存 operation 的日志元数据和行偏移索引。

文件前缀：

```text
codespace_log/
  {manager_id}/
    {codespace_uuid}/
      {operation_uuid}.log
```

日志读取 API：

```text
GET  /codespace/{uuid}/logs
POST /codespace/{uuid}/logs
```

POST 请求：

```json
{
  "cursor": 0,
  "limit": 500
}
```

POST 响应：

```json
{
  "cursor": 10,
  "lines": [
    {
      "index": 1,
      "timestamp": 1720000000.123,
      "message": "..."
    }
  ],
  "expired": false
}
```

日志要求：

- append-only。
- 支持初始化页实时显示。
- 支持错误后审计。
- 支持 manager 崩溃前最后日志保留。
- 读取按 cursor/offset 增量获取，不一次性加载全量日志。
- 行偏移由 Gitea 维护，前端只回传 cursor。
- 前端复用 Actions 日志 command/ANSI/TTY 解析与高亮方式。
- manager 上报日志必须带 active `operation_id`。
- 日志目录第一层按 `manager_id` 分组，删除 manager 时可以删除该 manager 下全部日志。
- 删除 codespace 实例成功后，Gitea 同步删除该 codespace 的日志文件。
- `cleanup_codespace` 定时任务按 `LOG_RETENTION_DAYS` 清理已完成 operation 的旧日志。

## Codespace 数据模型

`codespace`：

```text
id
uuid
owner_id
repo_id
ref_type
ref_name
commit_sha
pull_id
target_branch
head_repo
head_branch
manager_id
active_operation_id
instance_name
instance_type
image
resource_preset
status
status_reason
gateway_url
workdir
runtime_token_hash
runtime_token_salt
runtime_token_enabled
last_active_unix
created_unix
updated_unix
stopped_unix
deleted_unix
error_message
```

状态变更只由 Gitea control plane 写入。

## Port 模型

manager 或 runtime 上报端口到 Gitea。

`codespace_port`：

```text
codespace_id
name
port
protocol
visibility
description
public_url
status
created_unix
updated_unix
```

端口访问权限：

- private: codespace owner。
- org: organization member。
- public: 需要 manager 和 Gitea 配置同时允许。

## Control Plane RPC

服务：

```proto
service CodespaceService {
  rpc RegisterManager(RegisterManagerRequest) returns (RegisterManagerResponse);
  rpc DeclareManager(DeclareManagerRequest) returns (DeclareManagerResponse);
  rpc Ping(PingRequest) returns (PingResponse);
  rpc FetchTask(FetchTaskRequest) returns (FetchTaskResponse);
  rpc AppendLog(AppendLogRequest) returns (AppendLogResponse);
  rpc FinishTask(FinishTaskRequest) returns (FinishTaskResponse);
  rpc ReportCodespaceStatus(ReportCodespaceStatusRequest) returns (ReportCodespaceStatusResponse);
  rpc ReportCodespacePorts(ReportCodespacePortsRequest) returns (ReportCodespacePortsResponse);
  rpc RequestGitToken(RequestGitTokenRequest) returns (RequestGitTokenResponse);
  rpc RevokeGitToken(RevokeGitTokenRequest) returns (RevokeGitTokenResponse);
  rpc ValidateAccessTicket(ValidateAccessTicketRequest) returns (ValidateAccessTicketResponse);
}
```

关键约束：

- `RegisterManager` 不使用 manager auth。
- 其他 manager RPC 使用 manager auth header。
- task/log/status/ports/git token 请求必须带 `operation_id`。
- Gitea 只接受 active operation 的上报。
- `RequestGitToken` 只允许携带 `codespace_id` 和 `operation_id`，Gitea 根据 codespace 权威记录查 owner/repo 后签发。
- `ValidateAccessTicket` 用于 gateway 用户访问校验。

Manager operation payload 只包含运行侧必要信息：

```text
instance_name
instance_type
image
resource_preset
repo_url
repo_full_name
start_ref
start_sha
init_script
```

Gitea 不向 manager 下发 `user_id`、`repo_id`、PR base/head 审计字段；这些字段只保存在 Gitea 数据库中。

## Manager 能力声明

Manager 声明：

```json
{
  "gateway_url": "https://codespace.example.com",
  "version": "0.1.0",
  "labels": ["linux", "incus"],
  "max_concurrency": 10,
  "current_concurrency": 2,
  "supported_instance_types": ["container", "vm"],
  "images": ["images:debian/12", "images:ubuntu/24.04"],
  "resource_presets": [
    {
      "name": "small",
      "cpu": "2",
      "memory": "4GiB",
      "disk": "40GiB"
    }
  ],
  "features": {
    "web": true,
    "ssh": true,
    "port_preview": true,
    "public_port": false
  },
  "default_init_script": "./bootstrap-codespace.sh"
}
```

Gitea 使用这些能力渲染创建表单和选择可用 manager。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
GRPC_TIMEOUT = 30s
MANAGER_OFFLINE_TIMEOUT = 120s
TASK_LEASE_TIMEOUT = 300s
ACCESS_TICKET_EXPIRE = 60s
GIT_TOKEN_EXPIRE = 24h
REGISTRATION_TOKEN_EXPIRE = 24h
LOG_RETENTION_DAYS = 365
OPERATION_MAX_ATTEMPTS = 3
CREATE_WAIT_TIMEOUT = 30m
```

Manager 使用配置文件：

```text
codespace.yaml
codespace.yml
codespace.json
```

配置内容：

- Gitea URL。
- manager ID。
- manager UUID。
- manager token。
- manager name。
- gateway URL。
- poll interval。
- ping interval。
- capabilities。
- provisioner 类型。
- Incus remote/project/socket。
- bootstrap 参数。

客户端命令：

```bash
gitea-codespace register
gitea-codespace serve
```

`register` 交互输入 Gitea URL、registration token、manager name，并立即调用 Gitea `RegisterManager`。
注册成功后在当前目录写入 `codespace.yaml`，保存的是 Gitea 返回的实际 `manager.uuid` 和 `manager.token`。
用户输入的 registration token 不保存。

`serve` 只读取配置文件启动 gateway/runtime API 和 manager worker，不再自动注册。
manager 启动后先用配置中的 UUID/token 调用 `DeclareManager`，再进入 `Ping` / `FetchTask` 循环。

## 数据库支持

schema 使用 xorm model/migration 同步，不依赖数据库专用 SQL。

表：

- `codespace_manager`
- `codespace_registration_token`
- `codespace`
- `codespace_operation`
- `codespace_port`
- `codespace_access_ticket`
- `codespace_git_token`

文件数据：

- `codespace_log/{manager_id}/{codespace_uuid}/{operation_uuid}.log`

## 验证命令

Proto：

```bash
cd codespace-proto-go
go test ./...
```

Codespace client：

```bash
cd codespace
go test ./...
```

Gitea 定向编译测试：

```bash
cd gitea
go test ./models/codespace ./routers/web/codespace ./routers/web ./services/context ./modules/setting -run '^$'
```

Gitea 格式和 lint：

```bash
cd gitea
make fmt
make lint-backend
```
