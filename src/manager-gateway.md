# Manager 与 Gateway

## Manager 设计

Manager 通过 [ManagerService RPC](rpc-spec.md) 与 Gitea 通信。完整 proto 定义见 [RPC 接口定义](rpc-spec.md)。

### 注册与认证

Manager 注册参考 Gitea Actions runner 方式。

命令：

```text
gitea-codespace register
gitea-codespace serve
```

注册流程：

1. Gitea 创建一次性 registration secret。
2. `gitea-codespace register` 通过 `RegisterManager` 兑换该 registration secret。
3. Gitea 创建 Manager 记录，返回一次性明文 `manager_uuid + manager_secret`。
4. Manager 将凭据保存到本地配置。
5. `gitea-codespace serve` 使用该凭据调用后续所有 RPC。

registration secret 设计：

- registration secret 存放在 `codespace_manager_registration_secret` 表。
- registration secret 明文只在创建或重置时展示一次。
- 数据库只保存 `secret_hash / secret_salt / is_active / expires_unix / consumed_unix / created_by`。
- 创建或重置 registration secret 时，旧的未消费 registration secret 置为 inactive。
- `RegisterManager` 消费 registration secret 时在数据库事务内校验 active、未过期、未消费，并写入 `consumed_unix`。
- 并发重复消费只能有一个成功。
- Gitea 重启不影响未过期且未消费的 registration secret。
- 重置 registration secret 只影响尚未消费的注册凭据，不影响任何现有 Manager 的 manager secret。

### Manager 规则

- Manager 不按 owner、organization 或 repository 分组。统一 Manager 池通过 tag 匹配。`admin_state` 只表示管理态，不表示在线态；在线态由 `last_online_unix` 和 timeout 推导。

Declare 声明：

- `gateway_url`
- `gateway_ssh_addr`
- `gateway_internal_ssh_public_key`
- `tags`
- `capacity_total`
- `capacity_available`
- 可选诊断 `meta_json`

### Manager Capacity

- `capacity_total > 0`
- `0 <= capacity_available <= capacity_total`
- create/resume 需要 Manager 在本次 `FetchOperation` 中声明可接收，且 `capacity_available > 0`。stop/delete 不受 `capacity_available` 限制。
- capacity 是 Manager 最近上报的本地可接收能力快照，不是 Gitea quota。
- Manager 是实际运行容量权威，自行确保不拉取超过本地真实容量的 create/resume [Operation](glossary.md#operation)。
- Gitea 只保证 operation 不被重复领取，不保护 Manager 的本地运行并发。
- `DeclareManager` 和 `FetchOperation` 使用 request 中的 `capacity_total / capacity_available` 覆盖数据库中的 `last_capacity_total / last_capacity_available`。

Manager 主动 pull operation；满载时不拉取 create/resume，queued operation 自然等待。Gitea 看不到 Manager 本地 Runtime 队列、资源占用和启动中任务，不是真实容量权威，只保存最近容量快照用于 UI、诊断和本次 `FetchOperation` 准入检查。

> **TODO**: Manager worker pool 模型、并发控制、任务调度策略、以及 `codespace_uuid + generation` 到本地 Runtime Instance 的确定性映射规则尚未定义。

> **TODO**: Manager 重启恢复策略：graceful shutdown 和重启后的 operation recovery、lease 恢复、正在运行的 Runtime Instance 重新发现等机制尚未定义。

### Manager 禁用与删除

- 常规管理操作支持禁用。物理删除前需确认无未删除 codespace 引用该 Manager。
- disabled Manager 只能执行清理和状态分歧上报，不能服务新建、恢复、open 或 SSH。
- disabled Manager 可调用 `DeclareManager`。
- disabled Manager 可调用 `FetchOperation`，但只能领取已绑定给自己的 `stop|delete`。
- disabled Manager 可调用 `UpdateOperation` 和 `UpdateLog`，但仅限自己已领取的 `stop|delete`。
- disabled Manager 可调用 `ReportInstances`。
- disabled Manager 拒绝 `FetchOperation(create|resume)`、`ReportRuntimeMetadata`、`RequestGiteaToken`、`ValidateOpenToken`、`VerifySSHPassword` 和 `VerifySSHPublicKey`。
- 仍有未删除 codespace 引用时，不允许物理删除 Manager 记录。
- 完整移除 Manager 前先删除或清理其所有 codespace。

### Manager Secret

[Manager Secret](glossary.md#manager-secret) 用于认证已注册 Manager 调用 ManagerService RPC。

规则：

- 只在 `RegisterManager` 响应中返回一次。
- 由 Manager 保存在本地配置。
- Gitea 只保存 hash/salt。
- 使用常量时间比较（`subtle.ConstantTimeCompare`）。
- registration secret 和 manager secret 是两个不同生命周期的凭据。
- registration secret 只用于 `gitea-codespace register` 调用 `RegisterManager`。
- manager secret 只用于已注册 Manager 调用后续 ManagerService RPC。
- 重置 registration secret 只影响尚未消费的注册凭据，不影响任何现有 Manager 的 manager secret。
- 已注册 Manager 的 manager secret 继续有效，除非管理员显式重置该 Manager 的 manager secret、禁用 Manager，或物理删除 Manager 记录。
- manager secret 明文只在 `RegisterManager` 成功或管理员显式重置该 Manager secret 时展示一次。
- Manager secret reset 是针对单个 Manager 的管理动作。
- reset 时 Gitea 生成新的 manager secret hash/salt，旧 manager secret 立即失效。
- Manager 需要更新本地配置后重新 `serve` 或重新 `DeclareManager`。
- Manager secret reset 由具备管理权限的 Gitea 用户主动触发。

### Runtime Token

[Runtime Token](glossary.md#runtime-token) 只由 Manager 生成和校验。

Gitea 侧由 Manager 生成和校验 Runtime Token，Runtime Token 不出现在 ManagerService RPC 中。

Runtime Token 只用于 Runtime Instance 调用 Runtime HTTP API。Runtime HTTP API 属于 Manager 私有面。Manager 可以把 Runtime Token 与本地 Runtime Instance、source IP 和 generation 绑定。

## Runtime HTTP API

`CODESPACE_MANAGER_BASE_URL` 是 Runtime Instance 访问 Manager Runtime HTTP API 的根地址。

Runtime HTTP API 属于 Manager 私有运行网络，不属于 Gitea 路由。

所有请求使用：

```text
Authorization: Bearer <CODESPACE_RUNTIME_TOKEN>
Content-Type: application/json
```

网络规则：

- 只允许 Runtime Instance 私网 source IP 调用。
- source IP 与 Runtime Token 同时校验。
- 禁止公网、浏览器页面或普通用户终端直接调用。

路径前缀：

```text
{CODESPACE_MANAGER_BASE_URL}/api/runtime/v1
```

最小接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/runtime/v1/boot` | 查询初始化所需的完整 boot session 信息 |
| `POST` | `/api/runtime/v1/boot` | 上报初始化完成结果（一次调用） |
| `GET` | `/api/runtime/v1/endpoints/{endpoint_id}` | 查询单个 Endpoint 当前声明 |
| `POST` | `/api/runtime/v1/endpoints/{endpoint_id}` | 创建 Endpoint |
| `PUT` | `/api/runtime/v1/endpoints/{endpoint_id}` | 更新 Endpoint |
| `DELETE` | `/api/runtime/v1/endpoints/{endpoint_id}` | 删除 Endpoint |

Runtime Instance 只需要获取初始化信息和声明可打开入口。生命周期状态、Gitea token、日志和 Runtime Metadata 都由 Manager 统一转接到 Gitea，接口面保持在 boot/endpoints 可减少 Runtime 与 Gitea 设计的耦合。

### GET /boot

- Runtime Instance 启动后调用，用于查询初始化所需的完整 boot session 信息。
- 返回 Manager 当前 Runtime Token 绑定的信息。
- 不改变 boot 状态。
- 返回内容包含：

| 字段 | 来源 |
| --- | --- |
| `codespace_uuid` | Operation payload |
| `generation` | Operation payload |
| `operation_uuid` | Operation payload |
| `operation_type` | `create` / `resume` |
| `server_time_unix` | Manager 当前时间 |
| `workspace_dir` | Manager 本地决定 |
| `runtime_token_bound_source_ip` | Manager 记录 |
| `gitea_repo_clone_url` | Operation payload |
| `gitea_repo_web_url` | Operation payload |
| `gitea_base_repo_clone_url` | Operation payload |
| `gitea_base_repo_web_url` | Operation payload |
| `gitea_head_repo_clone_url` | Operation payload |
| `gitea_head_repo_web_url` | Operation payload |
| `gitea_repo_id` | Operation payload |
| `gitea_repo_full_name` | Operation payload |
| `gitea_owner_id` | Operation payload |
| `gitea_owner_name` | Operation payload |
| `gitea_owner_type` | Operation payload |
| `gitea_owner_display_name` | Operation payload |
| `gitea_ref_type` | Operation payload |
| `gitea_ref_name` | Operation payload |
| `gitea_commit_sha` | Operation payload |
| `gitea_pull_id` | Operation payload |
| `gitea_token` | Gitea `RequestGiteaToken` |
| `codespace_name` | Manager 派生（`cs-{short_uuid}`） |
| `codespace_owner_name` | Operation payload |
| `codespace_repo_name` | Operation payload |
| `codespace_ssh_user` | Operation payload |
| `gateway_internal_ssh_public_key` | Manager 配置 |

`GET /boot` 规则：

- 这些信息由 Manager 根据 Gitea operation payload 和 Manager 本地配置组合生成。
- `workspace_dir` 由 Manager 决定，不来自 Gitea payload。
- `gitea_token` 来自 Gitea `RequestGiteaToken`。
- `codespace_name` 使用 `cs-{short_uuid}` 派生规则。
- `runtime_token_bound_source_ip` 只用于 Runtime 自检，不参与 Gitea 权限判断。

### POST /boot

- Runtime 初始化完成后调用一次。
- 成功后 Manager 将 boot 结果作为 create/resume operation 的完成依据之一。
- 重复调用返回 conflict，不覆盖第一次结果。
- 请求内容包含：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `success` | 是 | `true` / `false` |
| `stage` | 否 | 当前 boot stage |
| `message` | 否 | 状态消息 |
| `started_unix` | 否 | 启动时间戳 |
| `completed_unix` | 否 | 完成时间戳 |

`success=true` 时额外包含：

| 字段 | 说明 |
| --- | --- |
| `workspace_head_sha` | 当前 HEAD SHA，必须与锁定 `commit_sha` 一致 |
| `internal_ssh_host` | 内部 SSH host |
| `internal_ssh_port` | 内部 SSH port |
| `internal_ssh_user` | 内部 SSH user |
| `internal_ssh_host_key_fingerprint` | 内部 SSH host key fingerprint |

`POST /boot` 规则：

- `success=true` 时，workspace checkout 到锁定 `commit_sha`。
- `success=true` 时，`workspace_head_sha == commit_sha`。
- `success=true` 时，internal SSH 信息完整，且 internal SSH 可被 Gateway 连通。
- `success=false` 时，Manager 将 create/resume operation 标记 failed。
- `POST /boot` 不上报 Endpoint。
- boot 完成后，Runtime 仍可增删改 Endpoint，但不能再次 `POST /boot`。

### Endpoint API

- `GET /endpoints/{endpoint_id}` 查询单个 [Endpoint](glossary.md#endpoint) 当前声明，不存在返回 404。
- `POST /endpoints/{endpoint_id}` 创建 Endpoint，已存在返回 conflict。
- `PUT /endpoints/{endpoint_id}` 更新 Endpoint，不存在返回 404。
- `DELETE /endpoints/{endpoint_id}` 删除 Endpoint；不存在返回 204。
- `endpoint_id` 必须匹配 `[A-Za-z0-9_-]+`。
- `workspace` 是默认 Web IDE 保留 ID。
- 删除 `workspace` 允许；UI 默认 Open 会退回 codespace 详情页。

Endpoint create/update 请求体：

| 字段 | 说明 |
| --- | --- |
| `label` | 展示标签 |
| `upstream_scheme` | upstream 协议 |
| `upstream_host` | upstream host |
| `upstream_port` | upstream port |
| `upstream_path` | upstream path |
| `health` | 健康检查信息（可选） |

Endpoint API 规则：

- `label` 会进入 Gitea Runtime Metadata。
- `upstream_*` 只保存在 Manager/Gateway 内部状态，不上报 Gitea。upstream 是 Manager/Gateway 内部网络细节，可能包含私网地址和本地路径；Gitea 只需要 Endpoint 是否存在、展示 label 和可选 health。
- `health` 可选；若上报 Gitea，只作为 UI 展示，不参与授权。
- 每次 Endpoint create/update/delete 后，Manager 重新生成当前 Runtime Metadata 快照并调用 `ReportRuntimeMetadata`。

## Gateway 设计

Gateway 通过 Manager 身份调用 Gitea [ManagerService RPC](rpc-spec.md) 完成 Open Token 校验和 SSH 认证。

### Endpoint 打开流程

`POST /codespace/{uuid}/open` 打开一个 Runtime Metadata [Endpoint](glossary.md#endpoint)。

输入：

```text
endpoint_id=<endpoint_id>
```

规则：

- `workspace` 是唯一保留 Endpoint ID，表示默认 Web IDE。
- SSH 不是 Endpoint。
- 预览端口、服务入口和 IDE 入口都通过 Endpoint 打开。
- 除 `workspace` 外，Gitea 不定义 Endpoint 协议或产品类型。
- Gitea 不读取 Endpoint 协议、端口、进程或 upstream。
- Gitea 只校验 `endpoint_id` 存在于当前 Runtime Metadata。
- `endpoint_id` 必须匹配 `[A-Za-z0-9_-]+`。
- 不接受 `path`、任意 `redirect`、upstream、URL 或 port 参数。

Endpoint label：

- 仅供 UI 展示。
- 不参与查找、路由、授权、默认选择或日志身份。
- trim 后长度为 1 到 64。
- 禁止控制字符。
- 禁止 `<` 和 `>`。
- UI 仍必须按普通文本 escape 后展示。

默认 open：

- 当前 Runtime Metadata 存在 `endpoint_id=workspace` 时，列表页/repo 页默认 Open 打开 `workspace`。
- 不存在 `workspace` 时，默认 Open 进入 `GET /codespace/{uuid}`，让用户手动选择 Endpoint。

open 成功响应：

```text
302 Location: {manager.gateway_url}/open?open_token={token}
```

- `open_token` 是唯一授权凭据。
- Gitea 可以追加只读路由提示参数，但不凭这些参数授权。
- Gateway 调用 `ValidateOpenToken` 校验。
- `open_token` 只在 Gateway 侧消费，不进入 Runtime Instance。
- Gateway access log 不记录完整 token。

> **TODO**: Gateway Endpoint 反向代理实现细节（HTTP reverse proxy / WebSocket upgrade / TCP tunnel）、TLS 处理、路径重写、header 注入等尚未定义。

### Gateway Session 管理

- Gateway 维护 `codespace_uuid -> live sessions` 的本地索引。
- Gateway 和 Manager 是同一 deployment 内的一体化组件。
- Manager 执行 stop/delete 前，先通知本地 Gateway 关闭该 `codespace_uuid` 的 HTTP/WebSocket/IDE 会话。
- Manager disabled 后，本地 Gateway 拒绝新 open，并关闭该 Manager 负责的 live sessions。
- repo access lost、user access lost 后，新的 open 由 Gitea `ValidateOpenToken` 拒绝。
- 已建立 session 在下一次 Manager operation、Gateway 周期校验或 Runtime 断开时关闭。Gateway 会话管理依赖本地 Manager 事件通知，Gitea 不对 Gateway 下发主动指令。

> **TODO**: Gateway session 超时时间、空闲断开、最大 session 数、健康检查、断线重连策略尚未定义。

## SSH 接入

### SSH 用户

SSH 是 codespace 自身稳定接入面，不是 Endpoint。

Gitea 在创建 codespace 时生成 `ssh_user`。`ssh_user` 在 codespace 生命周期内保持不变，delete 后失效且不复用。

示例：

```text
dragon+12141qwdada@1.2.3.4
```

规则：

- 只有 `running` 允许 SSH。
- `queued|booting|stopping|stopped|resuming|deleting|error` 均拒绝 SSH。
- SSH 不自动唤醒 stopped codespace。
- `ssh_password_auth_allowed` 由 Gitea 创建服务策略写入。
- `ssh_password_auth_allowed=false` 时拒绝密码认证，但不影响公钥认证。

### SSH 中转模型

Manager 确保 Runtime Instance 存在兼容 OpenSSH 的 sshd。

Gateway 中转流程：

1. 用户连接 `ssh_user@gateway_host`。
2. Gateway 解析 `ssh_user`。
3. Gateway 调用 Gitea 完成密码/TOTP 或公钥认证。
4. Gateway 确认 codespace 为 running。
5. Gateway 作为 SSH client 连接 Runtime Instance 内部 sshd。
6. Gateway 在外部 SSH 连接与内部 SSH 连接之间转发 channel。

Gateway 终止外部 SSH 并重建内部 SSH，不采用纯 TCP forwarding，也不自行实现 shell/sftp/pty。

支持的 SSH channel 能力：

- shell
- exec
- subsystem `sftp`
- `pty-req`
- `window-change`
- `signal`
- `env`
- `exit-status`
- `exit-signal`
- `auth-agent-req`
- `x11-req`
- `direct-tcpip`
- `tcpip-forward`
- `cancel-tcpip-forward`

SSH forwarding 属于 SSH 会话能力，不写入 Runtime Metadata `endpoints`。

### SSH 认证

Gateway 每次 SSH 认证尝试都调用 Gitea。不跨连接缓存密码或公钥认证成功结果。

Gitea 校验（详细见 [ManagerService RPC](gitea-server.md#managerservice-rpc) 中的 `VerifySSHPassword` 和 `VerifySSHPublicKey`）：

- `ssh_user` 映射到有效 codespace。
- codespace 为 `running`。
- 认证者是 codespace 创建用户。
- 创建用户当前允许登录。
- 密码认证满足 password 与 TOTP 要求。
- 公钥认证通过 SSH key 归属判定用户身份；若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- WebAuthn-only 用户不能使用 SSH 密码认证。
- repository access precondition 仍通过。
- 绑定 Manager 当前在线且未被 disabled。
- 密码认证被该 codespace 允许。
- 本地密码和 TOTP 使用 Gitea 现有校验逻辑。
- 公钥认证确认 public_key_blob 归属于创建用户（`models/asymkey/ssh_key.go`）。
- `public_key_fingerprint` 和 `public_key_algorithm` 仅用于日志诊断，可以为空，不参与认证判断。

Gateway 按 source IP、`ssh_user`、`codespace_uuid` 做限流和退避。限流和退避由 Gateway 负责。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

SSH session 规则：

- Gateway 维护 `codespace_uuid -> live SSH sessions` 的本地索引。
- Manager 执行 stop/delete 前，先通知本地 Gateway 关闭该 `codespace_uuid` 的 SSH sessions。
- Manager disabled 后，本地 Gateway 拒绝新 SSH，并关闭该 Manager 负责的 live SSH sessions。
- repo access lost、user access lost 后，新的 SSH auth 由 Gitea `VerifySSHPassword` / `VerifySSHPublicKey` 拒绝。
- 已建立 SSH session 在下一次 Manager operation、Gateway 周期校验或 Runtime 断开时关闭。Gateway 会话管理依赖本地 Manager 事件通知，Gitea 不对 Gateway 下发主动指令。

> **TODO**: Gateway SSH 认证限流与退避的具体配置项尚未定义。

### 内部 SSH

每条 Manager 注册记录拥有一对固定内部 Gateway SSH key。

规则：

- Manager 声明 `gateway_internal_ssh_public_key`。
- create/resume 时将该公钥写入 Runtime Instance 内部工作用户 `authorized_keys`。
- Gateway 使用对应 private key 连接内部 sshd。
- 内部 host、port、user、host key fingerprint 通过 `POST /boot` 上报。
- 用户密码、用户公钥、TOTP 不在 Runtime Instance 内部校验。
- 内部 SSH metadata 不在普通 UI/API 输出中暴露。

## 日志与脱敏

### 日志来源

- Gitea 保存一套 codespace operation 上报日志。
- Manager 本地日志只用于 Manager/Gateway 排障，不上报 Gitea。
- `UpdateLog` 是唯一上报入口，始终绑定当前 `operation_uuid`。
- create/resume/stop/delete lifecycle operation 执行期间的 boot、init、git、Endpoint 初始化、stop、resume、delete 阶段日志写入对应 operation log。
- operation 进入 `done|failed` 后，Manager 不再拥有该 operation 的执行上下文，不能继续通过该 `operation_uuid` 写日志。
- running 期间 open token 连接成功、SSH 连接成功、session 正常关闭、Endpoint 后续变化和用户可见运行异常不写入 Gitea operation log。
- running 期间连接成功通过 `last_active_unix` 记录用户活跃时间；详细连接事件写 Manager/Gateway 本地日志。
- open token 校验失败、SSH 密码/TOTP/公钥失败、限流、扫描、爆破、Gateway proxy debug、backend driver debug、heartbeat、空 pull、health poll 明细和内部 retry 细节只写 Manager/Gateway 本地日志。

operation log 是生命周期操作的执行证据，在 operation 完成前封闭，避免终态之后继续改变该 operation 的可见输出。running 期间没有未完成 lifecycle operation；为连接事件引入空 `operation_uuid`、长期 runtime operation 或第二套 Gitea 日志都会扩大状态模型。Gitea 对运行期连接只需要保存授权结果影响到的权威状态（如 `last_active_unix`）；排障细节属于 Manager/Gateway 本地日志。

### 脱敏

- Manager 是精确脱敏第一责任方。
- Manager 在 `UpdateLog` 前脱敏 `GITEA_TOKEN`、`CODESPACE_RUNTIME_TOKEN`、URL userinfo、URL query token、Authorization header、git credential helper 输出和常见 bearer/basic token 形式。
- Manager 维护 operation-local mask set。
- operation-local mask set 包含注入给 `init.sh` 的所有敏感值。
- `::add-mask::value` 消费后，`value` 加入 operation-local mask set，后续日志中出现的 `value` 替换为 `***`。
- `::add-mask::value` 由 Manager 消费，不写入 Gitea 日志。
- Manager 重启后继续处理同一 operation 时，重新加载或重建该 operation 的必要 mask set。
- 如果 Manager 无法确认脱敏安全，停止上传该 operation 的原始日志，并将 operation 标记为 failed 或上传明确错误摘要。
- Gitea 入库前只做防御性清理，例如控制字符过滤、单行长度限制、URL userinfo 和 Authorization header 模式替换。
- Gitea 不持有 Runtime Token 明文，不能精确脱敏 Runtime Token。
- Gitea 通用防御性清理不是 Runtime Token 泄漏的安全兜底。
- 前端隐藏不属于安全边界。
- 下载日志和 UI 日志使用同一份脱敏内容。
- 错误摘要必须在 operation 进入 `done|failed` 前上传。
- operation 进入 `done|failed` 后，不允许继续追加日志。
- stop/resume/delete 创建新 operation 后，后续 operation 日志写入新的 `active_operation_id`。
- 只有持有 `active_operation_id` 时才能追加 Gitea operation 日志。

### 日志命令

```text
::group::title
::endgroup::
##[group]title
##[endgroup]
::error::message
::warning::message
::notice::message
::debug::message
##[command]command
[command]command
```

Codespace 日志 UI 复用 Actions console 解析和渲染能力，不复制一套解析逻辑。

> **TODO**: Gateway access log 格式、脱敏规则、保留策略尚未定义。
