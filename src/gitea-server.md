# Gitea 服务端

## Web 路由与页面

Web 页面只保留三类。

### Repository Codespace 入口

```text
GET  /{owner}/{repo}/codespace
POST /{owner}/{repo}/codespace
```

作用：

- 基于当前 repository/ref 上下文创建 codespace。
- 展示当前用户在该 repository 下创建的 codespace。
- 提供进入用户 codespace 列表页的入口。

Repository 页面可以提供 "Open in Codespace" 入口：

- repository 主页
- branch/tag 下拉菜单
- pull request 页面
- commit 页面

这些入口提交 git 上下文（`ref_type`、`ref_name`、`commit_sha`），由 Manager 自行决定 runtime 参数、image、VM/container 类型、Endpoint、SSH 和 backend。

创建输入：

| 参数 | 说明 |
| --- | --- |
| `repo_id` | 仓库 ID |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | branch → 分支名；tag → 标签名；commit → commit SHA；pull → PR ref 路径（如 `refs/pull/42/head`） |
| `commit_sha` | commit SHA |

### 用户 Codespace 列表页

```text
GET /codespace
```

该页面只展示当前用户创建的 codespace。

展示字段：

- repo
- ref
- status
- last active
- 状态摘要
- open / stop / resume / delete

列表页不读取日志文件。

### 单个 Codespace 页

```text
GET    /codespace/{uuid}
GET    /codespace/{uuid}/logs
POST   /codespace/{uuid}/open
POST   /codespace/{uuid}/resume
POST   /codespace/{uuid}/stop
DELETE /codespace/{uuid}
```

`GET /codespace/{uuid}` 是唯一对象页面。

`GET /codespace/{uuid}/logs` 是日志数据接口，不是独立页面。

路由行为：

- `POST /{owner}/{repo}/codespace` 成功后重定向到 `GET /codespace/{uuid}`。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /codespace/{uuid}`。
- delete 后返回显式 `return_to`；若没有，则 repository 可见时回到 repository codespace 页，否则回到 `/codespace`。

布局：

- `creating`：中心日志布局；根据 `operation_status` 派生展示 queued 或 booting，只允许 delete。
- `running`：左右分栏；无 active operation 时展示 Endpoint、SSH、stop、delete；active stop operation 时派生展示 stopping 并禁用交互。
- `stopped`：左右分栏；无 active operation 时展示 resume/delete；active resume operation 时派生展示 resuming。
- `deleting`：显示清理进度，不允许新的用户动作。
- `failed`：只展示日志和 delete。

## 权限模型

Codespace 权限由服务层统一判定，Web handler、ManagerService、Gateway Open Token 校验和 SSH 公钥校验都调用同一组入口：

```text
CanCreateCodespace(ctx, user, repo, ref) Decision
CanInteractiveAccessCodespace(ctx, user, codespace, action) Decision
CanAdministerCodespace(ctx, user, codespace, action) Decision
```

`Decision` 包含 `allowed`、`failure_category`、`failure_message` 和 `retryable`。

这样设计的原因是 create、open、SSH、resume、stop、delete、logs 都会重复使用用户状态、codespace 状态、Manager 状态和 Runtime Metadata；create 还需要额外校验 repository 状态和 repository 权限。统一入口可以让 Web 页面、RPC 和 Gateway 得到同一结论，避免权限规则在多个 handler 中逐渐分叉。

服务层判定复用 Gitea 现有用户、组织、仓库、unit、visibility、blocking、restricted user、login restriction、2FA 和 repository permission 逻辑。repository permission 只作为 create 来源校验和 Git HTTP(S) 访问时的 Gitea 既有权限检查，不作为既有 codespace 交互入口的生命周期依赖。

用户登录状态至少包含：

- `is_active`
- `prohibit_login`
- `must_change_password`
- 站点强制 2FA

create 阶段 repository 访问边界复用 Gitea 现有结果：

- user blocking
- restricted user
- owner visibility
- internal/private repository visibility
- repository code unit 可读性（`CanRead(unit.Code)`）
- repository 生命周期状态

### Create 要求

| 条件 | 说明 |
| --- | --- |
| 登录 | 当前用户已登录 |
| 登录限制 | 满足 Gitea 登录限制（`is_active`、`prohibit_login`、`must_change_password`、站点强制 2FA） |
| 代码读取 | 拥有 repository code-read 权限（`CanRead(unit.Code)`） |
| 仓库状态 | repository 状态允许 create，目标 ref/commit 可解析 |

Repository 状态只参与 create：

| repository 状态 | create | 设计原因 |
| --- | --- | --- |
| 正常且 code unit 可读 | 允许 | 用户具备代码读取能力时，可以用该 repository 初始化自己的私有开发环境。 |
| `archived` | 返回 repository archived 分类 | archived 表示仓库进入只读/冻结管理状态，create 不再产生新的运行侧 workspace。 |
| `empty` | 返回 empty repository 分类 | 空仓库没有可锁定 commit，无法形成可复现 workspace。 |
| migrating / pending transfer / broken | 返回 repository unavailable 分类 | 这些状态下 repository 权限、路径或 git 数据可能正在变化，create 暂停可以避免 clone/checkout 与权限判定出现不一致。 |
| source repository deleted | 返回 source repository deleted 分类 | repository 已不存在时无法再解析来源、锁定 commit 或签发 repo-bound Git token。 |
| mirror | 允许 | mirror 本身仍是可读取 repository，同步来源属性不改变远程开发入口；实际写入能力继续由用户对 Gitea repository 的权限决定。 |
| create 目标 ref/commit 不可解析 | 返回 ref not found 分类 | create 需要先锁定 commit，已有 codespace 后续按已保存的 `commit_sha` 和运行时数据管理。 |

codespace 创建完成后，repository 的后续状态不再参与 open、SSH、resume、stop、delete 或 logs 判定。这样设计是因为 workspace 已经用 `commit_sha`、Runtime 数据和 Manager binding 初始化完成，repository 后续删除、归档、迁移、ref 移动或访问权限变化只会影响 Runtime 内部 Git HTTP(S) 操作，不应该改变既有 workspace 的生命周期。

### Interactive Access 要求

适用于 `open`、SSH、`resume`：

| 条件 | 说明 |
| --- | --- |
| 身份 | 仅 codespace 创建用户本人 |
| 登录限制 | 创建用户当前仍满足 Gitea 登录限制 |
| codespace 状态 | codespace 与 Manager 状态允许该动作 |
| Endpoint | open 时 [Endpoint](glossary.md#endpoint) metadata 必须存在 |

### Administrative Permission

适用于查看最小信息、日志、stop、delete：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 始终拥有，除非已被物理删除 |
| 站点管理员 | 可管理所有 codespace，用于全站资源治理和故障回收 |

管理权限独立于 repo code-read 权限，创建用户失去 repo 访问后仍可行使管理权限。codespace 是由 `user_id` 标识的用户私有资源，管理权由创建用户本人和站点管理员表达。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | 创建用户被删除后只保留后台清理和日志保留 |
| 组织仓库 | codespace 仍归创建用户管理；站点管理员保留全站管理能力 |

### Minimal Info

只允许返回：

- `uuid`
- `status`
- `created_unix`
- `updated_unix`
- `stopped_unix`
- `user_id`
- `user_display_name`
- `user_deleted`
- `repo_id`（repository 删除后为空；空值表示来源 repository 已不可再解析）
- `ref_type`
- `ref_name`
- `commit_sha`
- `manager_id`
- `manager_display_name`
- `manager_online`
- `log_line_count`
- `log_size`
- `allowed_actions`

以下字段保留在服务端内部或 Manager/Gateway 内部，不进入 Minimal Info：

- `gitea_token_id`
- `gitea_token`
- Manager Secret
- Runtime Token
- Gateway Open Token
- `token hash / salt`
- `internal_ssh`
- Endpoint upstream
- 完整 `meta_json`
- 日志正文
- Runtime Instance 内部 host / port / user

Minimal Info 面向列表页、站点管理员管理视图和 repository 删除后的弱关联展示。它只提供识别对象、判断状态和发起允许动作所需的信息。token、internal SSH、upstream 和日志正文保留在对应的专用接口或内部组件中，可以减少列表接口的敏感数据暴露面，也让站点管理员能够治理资源而不进入其他用户 workspace。

## ManagerService RPC

Gitea 实现：

```text
codespace.v1.ManagerService
```

传输：

- Connect RPC over HTTP（参考 Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口

Manager 认证 header：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，其余 RPC 使用 Manager header。

完整 proto 定义和消息结构见 [RPC 接口定义](rpc-spec.md)。

### RegisterManager

- 将 registration token 兑换为 Manager identity 和 manager secret。
- 校验 `is_active=true`。
- Manager 的 `owner_id` 继承 registration token 的 `owner_id`；`owner_id=0` 表示 global，非 0 表示 Gitea owner 的 `user.id`。
- 数据库保存 manager secret 的 `secret_hash / secret_salt`。
- 只返回一次明文 manager secret。

### DeclareManager

- 更新 Manager 名称、版本、gateway 地址、tags 和 metadata。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Manager 周期调用 `DeclareManager`；心跳间隔小于 `MANAGER_OFFLINE_TIMEOUT / 3`。
- Manager 重启恢复期间通过 `DeclareManager` 上报 `manager_runtime_state=recovering`，恢复完成后上报 `manager_runtime_state=online`。

心跳间隔小于 offline timeout 三分之一，是为了让一次短暂网络抖动或单次 heartbeat 延迟不会直接触发 offline，同时让 Gitea 能在数个心跳周期内发现真实离线。`recovering` 运行态让 Gitea 区分“Manager 正在维护恢复”和“Manager 完全不可达”，从而保留已有 codespace 主状态并暂停新的 create/resume 领取。

Declare 校验：

- `gateway_url` 使用 absolute `http://` 或 `https://` URL，不含 userinfo、query 或 fragment。
- `gateway_url` path 允许为空或作为固定 base path；生成 open URL 时安全 join `/open`。
- `gateway_ssh_addr` 固定格式为 `host:port`，host 非空，port 范围 1-65535。
- `meta.gateway_ssh_host_key_algorithm` 非空，例如 `ssh-ed25519`。
- `meta.gateway_ssh_host_key_fingerprint_sha256` 使用 OpenSSH SHA256 fingerprint 格式，例如 `SHA256:...`。
- `meta.gateway_ssh_host_key_updated_unix` 是 Unix 时间戳。

SSH 是 Manager 的必备能力。Web Endpoint 和 SSH 都属于 codespace 的交互入口，统一要求 Manager 声明 SSH 地址和 Gateway SSH host key 指纹，可以让 UI、权限判定、用户首次连接核对和 Gateway 部署健康检查有稳定能力基线。

### FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。

`FetchOperations` request：

| 字段 | 说明 |
| --- | --- |
| `capacity_total` | Manager 总容量 |
| `capacity_available` | Manager 可用容量 |
| `accepted_operation_types` | 本次接受的类型：`create|resume|stop|delete` |
| `max_operations` | 本次最多返回 operation 数量 |
| `observed_operations` | Manager 已持有的 `codespace_uuid + operation_rversion` |

领取优先级：

```text
delete -> stop -> resume -> create
```

领取条件：

| operation | 条件 |
| --- | --- |
| `delete` | 已绑定当前 Manager，主状态为 `deleting`，`operation_status=queued` |
| `stop` | 已绑定当前 Manager，主状态为 `running`，`operation_type=stop`，`operation_status=queued` |
| `resume` | 已绑定当前 Manager，主状态为 `stopped`，`operation_type=resume`，`operation_status=queued`，本次声明接受 resume，容量可用 |
| `create` | 未绑定 Manager，主状态为 `creating`，`operation_type=create`，`operation_status=queued`，owner scope 匹配，tag 匹配，本次声明接受 create，容量可用 |

领取成功后返回 `operations[]`：

- `operation_rversion`
- `operation_type`
- `codespace_uuid`
- `lease_deadline_unix`
- create 所需 repository/ref/commit 字段；resume 不包含 repository payload

delete 和 stop 是资源回收动作，优先推进可以释放运行侧资源。resume 和 create 会占用容量，由 Manager 当前容量决定领取时机。resume 基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository。`operation_rversion` 绑定本次 Gitea 下发的 operation 版本，Manager 后续 operation-bound RPC 都用它校验归属。

Manager matching 不在 SQL 中做完整匹配。Gitea 先查询 queued operation 候选，再在 Go 中判断 owner scope、tag、`accepted_operation_types` 和 capacity，最后通过条件 UPDATE 领取。这样与 Actions `runs-on` 的 DB 粗筛加内存 label 匹配保持一致，也避免第一版依赖数据库 JSON 匹配能力。

实现验收点：

- 单次 `FetchOperations` 可返回多个 operation。
- 总返回数量不超过 `max_operations`。
- create/resume 返回数量不超过 `capacity_available`。
- Manager 已上报相同 `observed_operations` 版本的 running operation 不重复下发完整 payload。
- 领取通过数据库条件更新完成；affected rows 为 0 时继续尝试下一个候选。
- 领取同事务写入 `operation_status=running`、`operation_started_unix`、`operation_deadline_unix`；create 领取额外写入 `manager_id`。
- 领取不递增 `operation_rversion`。
- stop/delete 在 Manager 满载时仍可领取。
- 并发领取时只有一个 Manager 成功。

### UpdateOperation

`UpdateOperation` 上报当前 operation 的执行情况：

```text
progress
renew lease
final done
final failed
```

Gitea 校验：

```text
codespace_uuid
operation_rversion
manager_id
operation_status=running
```

状态写入：

| operation | done | failed |
| --- | --- | --- |
| `create` | `status=running, keep token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `resume` | `status=running, clear active operation` | `status=failed, revoke token, clear active operation` |
| `stop` | `status=stopped, stopped_unix=now, revoke token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `delete` | 物理删除 codespace、token、日志和绑定数据 | `status=failed, revoke token, clear active operation` |

Manager 负责报告 Gitea-issued operation 的动作结果，Gitea 负责把结果写成主状态、token 生命周期绑定和日志追加窗口。State Finalization 在同一事务内完成这些写入，保证用户看到一致的生命周期结果。operation 完成后不保留 `done|failed` 状态，失败诊断从 codespace 日志读取。

实现验收点：

- progress 更新 stage 和 lease。
- final result 触发一次 State Finalization。
- 重复 final 返回幂等结果。
- State Finalization 同事务处理主状态、active operation 清空、token 生命周期绑定和日志追加窗口关闭。
- 过期 `operation_rversion` 返回 stale 分类，当前主状态保持稳定。

### UpdateLog

- 写入 DBFS 路径 `codespace_log/{codespace_uuid}.log`。
- 按 byte offset 追加已脱敏日志。
- 校验 `codespace_uuid + operation_rversion + manager_id` 匹配当前 running operation。
- offset 等于当前日志大小时追加。
- offset 小于当前日志大小时，幂等重放同一段内容；内容不一致返回 offset conflict 分类。
- offset 大于当前日志大小时返回 offset gap 分类，保持日志文件连续。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许当前 `operation_rversion` 对应的 running operation 追加日志。
- active operation 清空后，日志进入封闭状态。
- 单行最大长度由 `LOG_MAX_LINE_SIZE` 控制。
- 日志总大小由 `LOG_MAX_SIZE` 控制。超过限制后返回 log size exceeded 分类，并写入明确状态摘要。

日志使用 byte offset 而不是行号作为写入幂等键，是因为 DBFS 提供 seek/write 能力，Manager 重试时可以精确重放同一段内容。offset gap 分类可以保证 UI tail、下载和后续清理都面对连续文件，不需要处理缺失片段。

### ReadLog

`GET /codespace/{uuid}/logs` 使用 byte offset 分页读取：

```text
GET /codespace/{uuid}/logs?offset=<byte_offset>&limit=<max_bytes>
```

返回：

```text
offset
next_offset
eof
lines
truncated
```

规则：

- 默认 `offset=0`。
- 单次读取最大 `LOG_READ_MAX_BYTES`，默认 512 KiB。
- `lines` 来自同一份已脱敏 DBFS 日志。
- `next_offset` 是下一次轮询起点。
- `eof=false` 表示仍可继续读取。
- `truncated=true` 表示本次响应达到读取上限，客户端继续使用 `next_offset` 拉取。
- delete done 后删除 DBFS 日志。
- `failed` 状态日志保留到用户 delete 或 `FAILED_RETENTION_DAYS` 清理。

第一版日志完成后仍保留在 DBFS，不迁移到对象存储。DBFS 已满足运行中追加和页面读取；先不引入归档状态，可以减少状态机和清理任务的耦合。后续若需要对象存储归档，再增加 `log_storage=dbfs|object` 和独立 transfer job。

### ReportRuntimeMetadata

- 只写 [Runtime Metadata](glossary.md#runtime-metadata) 到本地 cache。
- 成功写入时只更新 Runtime Metadata 内的 `last_reported_unix`。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`。
- 校验 `codespace.manager_id == caller`，不匹配时返回 stale 分类。
- 只接受 `creating|running|stopped` 状态写入。
- `deleting|failed` 状态返回 stale 分类。
- stale 上报不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- `stopped` 状态下 Runtime Metadata 只用于展示保留资源信息，不提供 open 或 SSH。
- Manager 启动后为所有仍由自己持有且处于 `creating|running|stopped` 的 codespace 重建 Runtime Metadata cache。
- Manager 运行期间周期刷新 active codespace 的 Runtime Metadata cache，避免 Gitea 重启或本地 cache 丢失后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 Endpoint existence check 和 UI 展示。主状态校验基于数据库 `codespace.status`，与 cache 信任无关。
- 成功写入 Runtime Metadata 时，可刷新维护恢复证据时间。

Runtime Metadata 是运行时信息，变化频繁，也可以由 Manager 重建，因此放在 cache 中。主状态和权限判断继续使用数据库字段。

实现验收点：

- Runtime Metadata 成功写入 cache。
- `running` 交互入口同时依据主状态、Manager 在线态和 Runtime Metadata。
- Gitea cache 丢失后由 Manager 重建 Runtime Metadata。

### ReportRuntimeTransition

`ReportRuntimeTransition` 用于 Manager 在没有 Gitea-issued active operation 时上报本地主动 stop/resume 事实。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | Runtime 对应 codespace UUID |
| `runtime_state` | `running` 或 `stopped` |
| `transition_reason` | 本地触发原因 |
| `observed_unix` | Manager 观察时间 |
| `metadata_json` | transition 后观察到的 Runtime Metadata |

接受规则：

| 当前状态 | Manager fact | 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped`、写 `stopped_unix` |
| `stopped` 且无 active operation | `running` | 写 `status=running`，同事务写入 Runtime Metadata |
| `running/stopped` 且有 active operation | 任意 | 返回 `current_operation_conflict` |
| `creating/deleting/failed` | 任意 | 返回 `stale_operation` |
| Manager disabled | `stopped` | 允许 |
| Manager disabled | `running` | 返回 `manager_disabled` |

`ReportRuntimeTransition` 不递增 `operation_rversion`，因为它不是 Gitea 下发的 operation。

### RequestGiteaToken

- 允许绑定 Manager 在 `status=creating|running` 工作状态申请当前 Git 凭据。
- `creating` 要求 create operation 已被该 Manager 领取，用于首次 clone/checkout。
- `running` 要求没有 active stop/delete operation。
- `status=stopped|failed|deleting` 返回状态不可用。
- `repo_id` 为空时仍可签发 token；后续 Git HTTP(S) 访问因 repo binding 不匹配而拒绝所有 repository。
- `gitea_token_id` 非空时直接返回保存的 `gitea_token` 明文。
- `gitea_token_id` 为空时签发新 token，写入 `gitea_token_id` 和 `gitea_token`，再返回明文。

### ValidateOpenToken

- 校验并消费 [Gateway Open Token](glossary.md#gateway-open-token)。
- 返回校验后的 open binding。

### VerifySSHPublicKey

- Gateway 调用，Gitea 校验用户身份和访问权限后返回本次认证结果。

`VerifySSHPublicKeyRequest`：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | codespace UUID（Gateway 从 SSH 连接串 `cs-{id}` 解析） |
| `public_key_blob` | 公钥 blob |
| `source_ip` | 来源 IP |
| `user_agent_or_client_version` | 客户端版本 |
| `gateway_session_id` | Gateway session ID |

`VerifySSHPublicKeyResponse`：

| 字段 | 说明 |
| --- | --- |
| `allowed` | 是否允许 |
| `user_id` | 用户 ID |
| `codespace_uuid` | codespace UUID |
| `failure_category` | 失败分类 |
| `failure_retryable` | 是否可重试 |

Gitea 校验：

- `codespace_uuid` 映射到有效 codespace。
- codespace 为 `running`。
- 公钥认证解析 `public_key_blob`，并确认其通过 Gitea 现有 SSH key 模型归属于 codespace 创建用户（`models/asymkey/ssh_key.go`）；若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- 创建用户当前允许登录。
- 绑定 Manager 当前在线且未被 disabled。
- `public_key_blob` 解析失败返回 `invalid_credentials`。
- `public_key_blob` 是认证的唯一依据，Gateway 仅在 `VerifySSHPublicKey` 中传递完整公钥。

Gateway 按 source IP、`codespace_uuid` 做限流和退避。限流和退避由 Gateway 负责。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

失败分类：

| 分类 | 含义 |
| --- | --- |
| `invalid_credentials` | 公钥认证信息未通过 |
| `login_restricted` | 用户登录受限 |
| `codespace_not_found` | codespace 不存在 |
| `codespace_not_running` | codespace 未运行 |
| `ssh_disabled` | SSH 已禁用 |
| `manager_mismatch` | Manager 不匹配 |
| `permission_denied` | 权限判定未通过 |
| `internal_error` | 内部错误 |

### ReportInstances

Manager 通过 `ReportInstances` 上报本地 Runtime inventory 快照。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `snapshot_id` | 本次 inventory 快照标识 |
| `snapshot_complete` | 本次上报是否为完整快照 |
| `instances[].codespace_uuid` | 本地 Runtime 对应 codespace UUID |
| `instances[].runtime_state` | Manager 看到的 Runtime 状态 |
| `instances[].observed_operation_rversion` | Manager 看到的本地 operation 版本 |
| `instances[].observed_unix` | 本次检查时间 |

`ReportInstances` 上报 Manager 持有的所有 Runtime 资源，包括 stopped 的可恢复 workspace、volume 或实例；`snapshot_complete=false` 不驱动 missing 判定。

Gitea 计算：

```text
expected = Gitea 中绑定该 Manager 且按主状态应存在 Runtime 资源的 codespace
reported = Manager 上报的本地 Runtime 资源
extra = reported - expected
missing = expected - reported
```

差异分类：

```text
extra_runtime
missing_runtime
manager_mismatch
stale_operation
metadata_missing
snapshot_incomplete
```

处理方式：

| 差异 | Gitea 行为 |
| --- | --- |
| extra runtime | 返回 `cleanup_local_runtime` instruction，主状态保持稳定 |
| missing `creating` runtime | Manager online 且 snapshot complete 后进入 `failed` |
| missing `running` runtime | 记录 divergence，进入 `failed` |
| missing `stopped` runtime | 进入 `failed`，因为已经无法 resume |
| missing `deleting` runtime | 接受 cleanup 完成，物理删除 codespace |

数量差异来自 Gitea 记录和 Manager 本地 Runtime 列表不同。Gitea 用数据库主状态判断哪些 Runtime 应该存在，Manager 用快照报告本地实际列表，最后由 Gitea 返回处理指令。

实现验收点：

- Gitea 按 `manager_id` 查询 expected。
- Manager 上报完整快照后计算 extra/missing。
- extra runtime 返回 cleanup instruction。
- missing runtime 按当前主状态处理。

所有 operation-bound RPC 都携带 `codespace_uuid` 和 `operation_rversion`，Gitea 通过 `codespace.operation_rversion`、`codespace.operation_status` 和 `codespace.manager_id` 完成校验。

[Stale Report](glossary.md#stale-report) 被识别后返回 stale 分类，codespace 主状态保持当前值。

stale report 使用分类响应而不是改写主状态，是因为 Manager 上报可能来自旧 lease、重启后的残留任务或已经被 Gitea reconciliation 接管的 operation。保持主状态不变，可以让 Gitea 数据库状态继续作为判断依据，同时给 Manager 明确 cleanup 或停止上报的信号。

### Operation 返回数据

`FetchOperations` 返回给 Manager 的 operation 字段：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `operation_rversion` | 全部 | Gitea 下发 operation 版本 |
| `operation_type` | 全部 | `create`/`resume`/`stop`/`delete` |
| `codespace_uuid` | 全部 | Codespace UUID |
| `lease_deadline_unix` | 全部 | Lease 截止时间 |
| `repo_clone_url` | create | 仓库 clone URL |
| `repo_web_url` | create | 仓库 Web URL |
| `repo_tag` | create | 从 `.gitea/codespace.yaml` 解析的 tag |
| `base_repo_clone_url` | create | PR base 仓库 clone URL |
| `base_repo_web_url` | create | PR base 仓库 Web URL |
| `head_repo_clone_url` | create | PR head 仓库 clone URL |
| `head_repo_web_url` | create | PR head 仓库 Web URL |
| `start_ref` | create | Manager fetch/checkout 的 ref 提示 |
| `ref_type` | create | `branch`/`tag`/`commit`/`pull` |
| `ref_name` | create | `branch` → 分支名；`tag` → 标签名；`commit` → commit SHA；`pull` → PR ref 路径 |
| `commit_sha` | create | 锁定 commit SHA |

规则：

- `operation_type` 只允许 `create|resume|stop|delete`。
- `start_ref` 是 Manager 用于 fetch/checkout 的输入提示，最终 checkout 以 `commit_sha` 为准。
- 非 PR 场景下 `base_*` 与 `head_*` 可以为空。
- PR 场景下 `create` 返回数据同时包含 base/head clone URL 与 web URL。
- `resume|stop|delete` 返回数据不包含 repository clone/web URL、base/head URL、ref、commit 或 pull 字段。
- `resume` 完全基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository，不依赖 repository payload。
- `delete` 返回数据使用 `codespace_uuid` 生成，不依赖 repository row。repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Manager 删除 Runtime 只依赖 `codespace_uuid` 的本地确定性映射。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- Runtime Instance ID、Runtime Instance name、镜像、资源、backend、mount、network 和 Endpoint upstream 均由 Manager 独立决定。
- Manager 使用 `codespace_uuid` 在本地生成或查找 Runtime Instance 的确定性映射。
- Manager 创建 Runtime 时自己决定并注入 `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN`。
- `lease_deadline_unix` 是本次领取/续租的截止时间，Manager 在截止前通过 `UpdateOperation` 续租或上报终态。

## Token 管理

### Gitea Token

[Gitea Token](glossary.md#gitea-token) 复用 Gitea 现有 `access_token` 模型（`models/auth/access_token.go`）。

设计依据：

- 参考 Gitea Actions 的 token 认证与 repository 绑定模型。
- Actions 现有实现先把 task token 识别为内部 actor，再在 repository 权限判定阶段按 `task.RepoID` 校验目标 repository；同 repo 允许正常权限，跨 repo 再按额外限制收紧。
- Codespace 采用同类设计：继续复用现有 `access_token` 与 `write:repository` scope，再增加 `codespace.repo_id` 绑定校验。
- Gitea 现有 access token scope 只有 category 级（位图实现，如 `write:repository`），没有单仓库 scope。把"能做 repository 类操作"和"只能访问哪个 repository"拆开，才能在不扩展通用 token 系统的前提下得到可执行且可追踪的边界。

规则：

- token 归属于 codespace 创建用户。
- 所有 codespace token 统一签发 `write:repository`。
- token scope 限定为 `write:repository`，实际能否访问由 Gitea 现有 token、用户、repository、unit 和权限检查决定。
- `codespace.gitea_token_id` 指向当前 active access token。
- `codespace.gitea_token` 保存当前 token 明文，只允许通过 `RequestGiteaToken` 返回给绑定 Manager。
- `codespace.repo_id` 是唯一 repository binding；为空时不匹配任何 repository。
- Runtime clone、fetch 和 push 使用 Git HTTP(S) clone URL。
- Git HTTP 认证流程识别 codespace-bound token。
- repository 访问在公共 token 判定入口追加 repo binding 校验，并在通过后继续执行 Gitea 现有检查。
- 新增公共判定入口 `CheckRepoBoundAccessToken(ctx, tokenID, targetRepoID) Decision`。
- API v1 repository routes 通过 `APIContext.TokenCanAccessRepo(repo)` 调用 repo-bound token 判定。
- Web、Git HTTP、LFS、raw、archive、download、feed 等支持 token/basic auth 的 repository 路径通过 `CheckRepoScopedToken(ctx, repo, level)` 调用 repo-bound token 判定。
- package、user、org 等非 repository token 路径按非 repository 资源处理，codespace-bound token 不通过这些路径取得额外能力。
- repo-bound token 判定只额外校验 `target_repo_id == codespace.repo_id`。
- codespace-bound token 的 repository 访问范围固定为 `codespace.repo_id`；访问其他 repository 时返回 repo binding mismatch 分类，访问绑定 repository 时继续交给 Gitea 现有权限链路判断。`repo_id` 为空时，任何 repository 都返回 repo binding mismatch。
- codespace token scope 限定为 `write:repository`。需要 `read:user` 或 `read:organization` 的信息由 Gitea 在 create 时通过只读环境变量注入；resume 使用已初始化 workspace 中的既有信息。
- Runtime 需要的 owner/org 展示信息由 Gitea 在 create 时作为只读环境变量注入，不通过 codespace token 调用通用 user/org API。
- `creating/running` 是工作状态，允许持有 token；`creating -> running` 不吊销 token，直接复用 create 阶段 token。
- `gitea_token_id` 为空时才签发新 token；非空时返回保存的 `gitea_token` 明文，不做轮换。
- 进入 `stopped`、`failed`、`deleting` 或物理删除时吊销 token 并清空 `gitea_token_id/gitea_token`。
- source repo 删除或创建用户失去 repo 访问权限只影响 Git HTTP(S) 访问；已有 codespace 的 open、SSH、resume、stop、delete 和 logs 继续按 codespace 自身权限与状态判定。
- repository 删除不单独吊销 token；`repo_id` 置空后，现有 token 对任何 repository 都拒绝。
- 同一 codespace 只允许保留一个绑定的 Gitea token。
- 轮换只由 token 字段被清空后再次请求触发；例如 `stopped -> running` 后重新请求会生成新 token。

`CheckRepoBoundAccessToken` 规则：

- 当前请求没有 access token 时，不处理。
- access token 未被 codespace 绑定时，按 Gitea 现有 token 逻辑处理。
- access token 被 codespace 绑定时，`token_id` 与 `codespace.gitea_token_id` 匹配。
- `target_repo_id` 与 `codespace.repo_id` 匹配。
- `codespace.repo_id` 为空时，对所有 target repository 返回 repo binding mismatch。
- repo binding 匹配后继续执行 Gitea 现有 scope、用户、repository、unit、可见性和权限检查。
- 非 repository 资源返回 unsupported resource 分类；需要 Runtime 使用的非 repository 信息由 create 环境变量注入。

这样设计的原因是 Gitea access token scope 是 category 级，`write:repository` 只能表达“可以做 repository 类动作”，不能表达“只能访问哪个 repository”。repo-bound token 判定只补足单仓库边界，用户是否仍有权限、repository 是否存在、unit 是否可读写等继续由 Gitea 现有检查负责，避免 Runtime token 变成通用 PAT。

删除保护：

- 不扩展 `access_token` 表，手动删除时通过 `codespace.gitea_token_id` 反查是否被 codespace 占用。
- 被 `codespace.gitea_token_id` 引用的 access token 只能由 codespace 生命周期服务通过专用入口吊销。Web 和 API 手动删除返回 `409 Conflict` 并提示先 stop 或 delete 对应 codespace。
- codespace 生命周期服务在 stop final、failed final、delete final 和 failed 记录物理清理时使用专用内部入口 `DeleteAccessTokenByIDForCodespaceLifecycle(ctx, tokenID, codespaceID)` 删除。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 校验 `codespace.gitea_token_id == tokenID`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 在同一事务内清空 `codespace.gitea_token_id` 和 `codespace.gitea_token`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 为 codespace 生命周期服务内部入口，不与 Web/API handler 共享调用路径。
- reconciliation 负责清理 codespace 已不存在但 token 仍标记占用的异常状态。

通过反查 `codespace.gitea_token_id` 做删除保护，是因为 token 的生命周期所有权已经由 codespace 行表达。这样不需要给通用 PAT 模型增加新的 token 类型，也能让用户在通用 token UI/API 删除时得到明确的 409 冲突原因。

### Gateway Open Token

[Gateway Open Token](glossary.md#gateway-open-token) 是：

- 短期有效
- 一次性使用
- opaque bearer token
- 非 JWT
- 以 token hash 写入 Gitea 本地 cache
- 绑定 `user_id / codespace_uuid / endpoint_id / manager_id`

签发算法（与现有 access_token 风格一致，使用纯随机 + sha256）：

```text
token = hex(crypto random 32 bytes)
salt = crypto random string
token_hash = sha256(salt + token)
```

Gateway Open Token 写入 Gitea 本地 cache，使用纯随机 + sha256 方案满足一次性校验需求。

规则：

- token 明文只出现在 `302 Location` 中，不落数据库和日志。
- cache 写入时若 `token_hash` 冲突，重新生成。
- hash 比较使用常量时间比较（`subtle.ConstantTimeCompare`）。
- token 校验通过本机锁串行化（get → validate → delete）。

Cache 结构：

```text
key = codespace:open-token:{token_hash}
value = user_id + codespace_uuid + endpoint_id + manager_id + issued_unix + expires_unix
ttl = OPEN_TOKEN_EXPIRE
```

校验步骤：

1. 计算提交 token 的 hash。
2. 在本机锁保护下读取并删除 cache 记录。
3. 校验过期时间。
4. 校验调用方 Manager 身份等于 `manager_id`。
5. 重新读取 codespace。
6. 校验 codespace 当前为 `running`。
7. 校验用户仍具备 Interactive Access。
8. 校验 Endpoint 仍存在于当前 Runtime Metadata。
9. 校验 Manager 仍在线。
10. 校验 Manager 未被 disabled。

成功返回：

```text
user_id
codespace_uuid
endpoint_id
manager_id
```

Cache 丢失即 token 失效，用户重新从 Gitea 发起 open。

Token 是一次性跳转凭据，写入 Gitea 本地 cache；cache 丢失时本次 open 失效，用户重新从 Gitea 发起 open。codespace 生命周期状态不受 cache 影响。

## Cron 任务

| 任务 | 默认调度 | 职责 |
| --- | --- | --- |
| `reconcile_codespace_states` | `@every 1m` | 检查 queued operation timeout、running operation lease、Manager offline/recovering、Runtime inventory 差异和 token 生命周期绑定 |
| `cleanup_failed_codespaces` | `@daily` | 清理超过保留期的 `failed` 状态 codespace 记录、token 绑定和日志；清理超过保留期的 inactive registration token |
| `cleanup_codespace_logs` | `@daily` | 清理超过 `LOG_RETENTION_DAYS` 的已完成 operation 日志文件 |

`reconcile_codespace_states` 定时扫描 active operation、Manager 离线和 Runtime inventory 差异，让 codespace 按状态机进入明确结果。queued operation 使用 `operation_created_unix + QUEUE_TIMEOUT` 判定等待超时，running operation 使用 `operation_deadline_unix` 判定 lease 超时。`cleanup_failed_codespaces` 和 `cleanup_codespace_logs` 分别处理数据生命周期，控制过期记录和日志的长期堆积。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
CONTROL_PLANE_TIMEOUT = 30s
MANAGER_OFFLINE_TIMEOUT = 120s
MANAGER_RESTART_GRACE = 10m
OPERATION_LEASE_TIMEOUT = 300s
QUEUE_TIMEOUT = 5m
OPEN_TOKEN_EXPIRE = 60s
LOG_MAX_LINE_SIZE = 64KiB
LOG_READ_MAX_BYTES = 512KiB
LOG_MAX_SIZE = 64MiB
LOG_RETENTION_DAYS = 365
FAILED_RETENTION_DAYS = 365
CODESPACE_REPO_CONFIG_MAX_SIZE = 64KiB

[cron.reconcile_codespace_states]
ENABLED = true
RUN_AT_START = true
SCHEDULE = @every 1m

[cron.cleanup_failed_codespaces]
ENABLED = true
RUN_AT_START = false
SCHEDULE = @daily

[cron.cleanup_codespace_logs]
ENABLED = true
RUN_AT_START = false
SCHEDULE = @daily
```

说明：

- `OPEN_TOKEN_EXPIRE` 也是 [Gateway Open Token](glossary.md#gateway-open-token) 的 Gitea cache TTL。
- SSH 认证限流与退避由 Gateway 配置和管理。
- `OPERATION_LEASE_TIMEOUT` 是 Manager 领取/续租 [Operation](glossary.md#operation) 的 lease 时长。
- `QUEUE_TIMEOUT` 是 queued operation 等待 Manager 领取的最长时间。
- `MANAGER_RESTART_GRACE` 用于 Manager 从 offline/recovering 回到 online 的维护恢复窗口。这个窗口内 Gitea 保持 codespace 主状态，由 Manager 重新发现本地 Runtime。
- `CODESPACE_REPO_CONFIG_MAX_SIZE` 限制 `.gitea/codespace.yaml` 读取大小，避免配置读取变成大 blob 解析路径。
- `LOG_READ_MAX_BYTES` 限制单次日志读取响应大小，便于页面轮询和 API 客户端稳定分页。
- `LOG_MAX_SIZE` 限制单个 codespace 日志总量，避免异常 init 或脚本持续输出导致 DBFS 无限增长。

Manager 本地配置由 Manager 自己管理，例如：

```text
/etc/gitea-codespace/manager.yaml
/etc/gitea-codespace/manager.json
```

Manager 本地配置保存 tag 到 backend 的映射，以及 Incus/Docker 配置、镜像、资源、网络、挂载、bootstrap、DinD 策略。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。
