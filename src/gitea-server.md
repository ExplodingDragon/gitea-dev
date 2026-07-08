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
- 组织仓库下展示组织管理员可管理的其他成员 codespace。
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

- `queued|booting|error|首次 create 链路中的 deleting`：中心日志布局；除 deleting 外只允许 delete。
- `running|stopping|stopped|resuming|非首次 create 链路中的 deleting`：左右分栏；左侧日志，右侧控制与信息。
- `running`：按条件展示 Endpoint 与 SSH 区域。
- `stopped`：按条件展示 resume/delete。
- `error`：只展示日志和 delete。

## 权限模型

所有权限判断复用 Gitea 现有用户、组织、仓库、unit、visibility、blocking、restricted user、login restriction、2FA 和 repository permission 逻辑。

Gitea 登录限制至少包括：

- `is_active`
- `prohibit_login`
- `must_change_password`
- 站点强制 2FA

repository 边界复用 Gitea 现有结果：

- user blocking
- restricted user
- owner visibility
- internal/private repository visibility
- repository code unit 可读性（`CanRead(unit.Code)`）
- archived、mirror、empty、being migrated、pending transfer、broken 等 repository 状态

### Create 要求

| 条件 | 说明 |
| --- | --- |
| 登录 | 当前用户已登录 |
| 登录限制 | 满足 Gitea 登录限制（`is_active`、`prohibit_login`、`must_change_password`、站点强制 2FA） |
| 代码读取 | 拥有 repository code-read 权限（`CanRead(unit.Code)`） |
| 仓库状态 | 不处于 archived、migrating、pending transfer、broken、empty 或无法解析目标 ref/commit |

### Interactive Access 要求

适用于 `open`、SSH、`resume`：

| 条件 | 说明 |
| --- | --- |
| 身份 | 仅 codespace 创建用户本人 |
| 登录限制 | 创建用户当前仍满足 Gitea 登录限制 |
| 代码读取 | 创建用户当前仍有 repository code-read 权限 |
| 仓库状态 | 仓库当前状态允许交互访问 |
| codespace 状态 | codespace 与 Manager 状态允许该动作 |
| Endpoint | open 时 [Endpoint](glossary.md#endpoint) metadata 必须存在 |

### Administrative Permission

适用于查看最小信息、日志、stop、delete：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 始终拥有，除非已被物理删除 |
| 组织管理员 | 组织仓库下额外拥有（`IsOrganizationAdmin(ctx, orgID, userID)`）。无法进入其他用户 workspace |

管理权限独立于 repo code-read 权限，创建用户失去 repo 访问后仍可行使管理权限。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | 创建用户被删除后只保留后台清理和日志保留 |
| 组织仓库 | 创建用户失去 repo 访问、被禁用或被删除后，组织管理员仍可 stop/delete 和查看日志/最小信息 |

### Minimal Info

只允许返回：

- `uuid`
- `status`
- `status_message`
- `created_unix`
- `updated_unix`
- `stopped_unix`
- `user_id`
- `user_display_name`
- `user_deleted`
- `repo_id`
- `repo_display_name`
- `repo_deleted`
- `ref_type`
- `ref_name`
- `commit_sha`
- `manager_id`
- `manager_display_name`
- `manager_online`
- `log_line_count`
- `log_size`
- `log_expired`
- `allowed_actions`

禁止返回：

- `gitea_token_id`
- Manager Secret
- Runtime Token
- Gateway Open Token
- `token hash / salt`
- `internal_ssh`
- Endpoint upstream
- 完整 `meta_json`
- 日志正文
- Runtime Instance 内部 host / port / user

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
- 只返回一次明文 manager secret。

### DeclareManager

- 更新 Manager 版本、gateway 地址、tags 和诊断 metadata。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Manager 周期调用 `DeclareManager`；心跳间隔严格小于 `MANAGER_OFFLINE_TIMEOUT`，建议不超过其三分之一。

Declare 校验：

- `gateway_url` 必须是 absolute `http://` 或 `https://` URL，不含 userinfo、query 或 fragment。
- `gateway_url` path 允许为空或作为固定 base path；生成 open URL 时安全 join `/open`。
- `gateway_ssh_addr` 固定格式为 `host:port`，host 非空，port 范围 1-65535。

SSH 是必选能力。不满足完整 SSH 要求的 Manager 无效。

### FetchOperation

- Manager 主动拉取可领取的 operation。
- request 包含 `capacity_total`、`capacity_available` 和 `accepted_operation_types`。
- 更新 `last_online_unix`。
- 使用 request 中的 `capacity_total / capacity_available` 更新 `last_capacity_total / last_capacity_available`。
- 优先返回已绑定给当前 Manager 的 `stop|delete`。
- `create` 只返回给支持 `repo_tag`、本次声明接受 `create` 且 `capacity_available > 0` 的 enabled Manager。
- `resume` 只返回给已绑定该 codespace、本次声明接受 `resume` 且 `capacity_available > 0` 的 enabled Manager。
- `capacity_available > 0` 时返回 `create|resume`。
- 对返回的 operation 执行原子 claim。

`FetchOperation` request：

| 字段 | 说明 |
| --- | --- |
| `capacity_total` | Manager 总容量 |
| `capacity_available` | Manager 可用容量 |
| `accepted_operation_types` | 本次接受的类型：`create|resume|stop|delete` |

规则：

- `accepted_operation_types` 表示 Manager 本次 pull 愿意接收的 operation 类型。
- Manager 满载时可以只声明 `stop|delete`，或不调用 `FetchOperation`。
- Manager 有 create/resume 空闲容量时才声明 `create|resume`。
- Manager 主动 pull operation；没有 Manager 主动领取时，operation 保持 `queued`。

### UpdateOperation

- 续租 lease。
- 更新 progress/stage。
- 写入终态结果 `done|failed`。
- 触发 Gitea 服务层同步执行 [State Finalization](glossary.md#state-finalization)。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- operation 已进入 `done|failed` 后终态不可再改变。
- 重复提交相同终态返回幂等结果，State Finalization 仅执行一次。
- lease 过期后拒绝 progress 和 lease update。
- 终态 `done|failed` 不因 `deadline_unix` 已经过期自动拒绝。
- lease 过期但 reconciliation 尚未标记 failed 前，Manager 上报 `done|failed` 可以由 State Finalization 接受。
- reconciliation 已将 operation 置为 failed 后，later `done` 视为 stale，operation_status 保持 failed。
- operation 进入 `done|failed` 后，`UpdateOperation` 和 Runtime Metadata 写入均已封闭。

### UpdateLog

- 按 offset 追加已脱敏日志。
- 拒绝日志空洞。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许 `codespace.operation_status in (queued,running)` 时追加日志。
- operation 进入 `done|failed` 后不允许继续追加日志。

### ReportRuntimeMetadata

- 只写 [Runtime Metadata](glossary.md#runtime-metadata) 到本地 cache。
- 成功写入时更新 `last_active_unix`。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`。
- 校验 `codespace.status in (booting,running,stopping,resuming) && codespace.manager_id == caller`，不匹配则拒绝为 stale。
- 只接受 `booting|running|resuming|stopping` 状态写入。
- `queued|stopped|deleting|error` 拒绝写入 Runtime Metadata。
- stale 上报返回 stale，不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- `stopping` 状态下 Runtime Metadata 写入用于展示 stop 过程运行信息。open 和 SSH 仅在 `running` 状态可用。
- Manager 启动后为所有仍由自己持有且处于 `booting|running|stopping|resuming` 的 codespace 重建 Runtime Metadata cache。
- Manager 运行期间周期刷新 active codespace 的 Runtime Metadata cache，避免 Gitea 重启或本地 cache 丢失后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 Endpoint existence check 和 UI 展示。主状态校验基于数据库 `codespace.status`，与 cache 信任无关。

### RequestGiteaToken

- 只允许 active create/resume operation 申请。
- 返回一次性明文 Gitea access token。

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
| `public_key_fingerprint` | 公钥 fingerprint（仅日志诊断，可为空） |
| `public_key_algorithm` | 公钥算法（仅日志诊断，可为空） |
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
- repository access precondition 仍通过。
- 绑定 Manager 当前在线且未被 disabled。
- 请求中的 `public_key_fingerprint` 和 `public_key_algorithm` 仅用于日志诊断和审计，授权判定依据为 `public_key_blob` 归属验证。
- `public_key_blob` 解析失败返回 `invalid_credentials`。
- `public_key_blob` 是认证的唯一依据，Gateway 仅在 `VerifySSHPublicKey` 中传递完整公钥。

Gateway 按 source IP、`codespace_uuid` 做限流和退避。限流和退避由 Gateway 负责。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

失败分类：

| 分类 | 含义 |
| --- | --- |
| `invalid_credentials` | 公钥无效 |
| `login_restricted` | 用户登录受限 |
| `codespace_not_found` | codespace 不存在 |
| `codespace_not_running` | codespace 未运行 |
| `ssh_disabled` | SSH 已禁用 |
| `repo_access_lost` | 仓库访问权限丢失 |
| `manager_mismatch` | Manager 不匹配 |
| `permission_denied` | 权限拒绝 |
| `internal_error` | 内部错误 |

### ReportInstances

- Manager 重启后上报本地 Runtime Instance 集合。
- Gitea 检测 [State Divergence](glossary.md#state-divergence)，并可返回 [Manager Instruction](glossary.md#manager-instruction) `cleanup_local_runtime`。

所有 operation-bound RPC 都携带 `codespace_uuid`，Gitea 通过 `codespace.operation_status` 和 `codespace.manager_id` 完成校验。

[Stale Report](glossary.md#stale-report) 被识别后直接拒绝，codespace 主状态保持当前值。

### Operation Payload

`FetchOperation` 返回给 Manager 的 operation payload 字段：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `operation_type` | 全部 | `create`/`resume`/`stop`/`delete` |
| `codespace_uuid` | 全部 | Codespace UUID |
| `lease_deadline_unix` | 全部 | Lease 截止时间 |
| `repo_clone_url` | create/resume | 仓库 clone URL |
| `repo_web_url` | create/resume | 仓库 Web URL |
| `repo_tag` | create/resume | 从 `.gitea/codespace.yaml` 解析的 tag |
| `base_repo_clone_url` | create/resume | PR base 仓库 clone URL |
| `base_repo_web_url` | create/resume | PR base 仓库 Web URL |
| `head_repo_clone_url` | create/resume | PR head 仓库 clone URL |
| `head_repo_web_url` | create/resume | PR head 仓库 Web URL |
| `start_ref` | create/resume | Manager fetch/checkout 的 ref 提示 |
| `ref_type` | create/resume | `branch`/`tag`/`commit`/`pull` |
| `ref_name` | create/resume | `branch` → 分支名；`tag` → 标签名；`commit` → commit SHA；`pull` → PR ref 路径 |
| `commit_sha` | create/resume | 锁定 commit SHA |

规则：

- `operation_type` 只允许 `create|resume|stop|delete`。
- `start_ref` 是 Manager 用于 fetch/checkout 的输入提示，最终 checkout 以 `commit_sha` 为准。
- 非 PR 场景下 `base_*` 与 `head_*` 可以为空。
- PR 场景下 `create|resume` payload 同时包含 base/head clone URL 与 web URL。
- `stop|delete` payload 不包含 repository clone/web URL、base/head URL、ref、commit 或 pull 字段。
- `delete` payload 使用 `codespace_uuid` 生成，不依赖 repository row。repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Manager 删除 Runtime 只依赖 `codespace_uuid` 的本地确定性映射。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- Runtime Instance ID、Runtime Instance name、镜像、资源、backend、mount、network 和 Endpoint upstream 均由 Manager 独立决定。
- Manager 使用 `codespace_uuid` 在本地生成或查找 Runtime Instance 的确定性映射。
- Manager 创建 Runtime 时自己决定并注入 `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN`。
- `lease_deadline_unix` 是本次 claim/续租的截止时间，Manager 在截止前通过 `UpdateOperation` 续租或上报终态。

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
- token scope 限定为 `write:repository`，访问范围以创建用户已有 repository 权限为上限。
- `codespace.gitea_token_id` 指向当前 active access token。
- `codespace.repo_id` 是唯一 repository binding。
- Runtime clone、fetch 和 push 使用 Git HTTP(S) clone URL。
- Git HTTP 认证链路识别 codespace-bound token。
- repository 访问只在现有支持 token/basic auth 的入口做 repo binding 校验。
- API v1 repository routes 在 `APIContext.TokenCanAccessRepo(repo)` 或同等公共入口追加 codespace-bound token 校验。
- Web/git HTTP 在 `CheckRepoScopedToken(ctx, repo, level)` 或同等公共入口追加 codespace-bound token 校验。
- 显式启用 `AllowBasic` 或 `AllowOAuth2` 的 repository HTTP 路径复用上述公共校验入口。
- 上述入口在 scope 校验外，额外校验 `target_repo_id == codespace.repo_id`。
- codespace-bound token 只能访问 `codespace.repo_id`；访问其他 repository 时即使 token scope 正常允许，也拒绝。
- codespace token scope 限定为 `write:repository`。需要 `read:user` 或 `read:organization` 的信息由 Gitea 在 create/resume 时通过只读环境变量注入。
- Runtime 需要的 owner/org 展示信息由 Gitea 在 create/resume 时作为只读环境变量注入，不通过 codespace token 调用通用 user/org API。
- 每次 create/resume 都替换 token。
- stop/delete/error/source repo 删除/user 删除时吊销 token。
- 同一 codespace 的 active token 对应 `booting`、`running`、`resuming` 状态。`stopped`、`deleting`、`error` 状态下 token 已吊销且不可申请。
- 同一 codespace 只允许保留一个 active token。
- 重复 `RequestGiteaToken` 时，Gitea 先吊销旧 token，再签发新 token，并更新 `codespace.gitea_token_id`。

删除保护：

- 被 `codespace.gitea_token_id` 引用的 access token 通过专用生命周期服务 `DeleteAccessTokenByIDForCodespaceLifecycle` 吊销。Web 和 API 手动删除返回 `409 Conflict` 并提示先 stop/delete 对应 codespace。
- codespace 生命周期服务使用专用内部入口 `DeleteAccessTokenByIDForCodespaceLifecycle(ctx, tokenID, codespaceID)` 删除。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 必须校验 `codespace.gitea_token_id == tokenID`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 在同一事务内清空或更新 `codespace.gitea_token_id`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 为 codespace 生命周期服务内部入口，不与 Web/API handler 共享调用路径。
- reconciliation 负责清理 codespace 已不存在但 token 仍标记占用的异常状态。

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

> **TODO**: Gitea 多副本部署时，Open Token 一次性单机锁的行为、Runtime Metadata cache 多副本重建触发机制尚未分析。

## Cron 任务

| 任务 | 默认调度 | 职责 |
| --- | --- | --- |
| `reconcile_codespace_states` | `@every 1m` | 检查中间态（booting/stopping/resuming/deleting）的 `operation_deadline_unix` 超时、Manager offline timeout、stale runtime metadata，推进到 error 或吊销 token |
| `cleanup_failed_codespaces` | `@daily` | 清理超过保留期的 `error` 状态 codespace 记录和日志；清理超过保留期的 inactive registration token |
| `cleanup_codespace_logs` | `@daily` | 清理超过 `LOG_RETENTION_DAYS` 的已完成 operation 日志文件 |

`reconcile_codespace_states` 定时扫描中间态 codespace，处理 `operation_deadline_unix` 超时和 Manager 离线导致的停滞，防止 codespace 永久卡死在中间态。`cleanup_failed_codespaces` 和 `cleanup_codespace_logs` 分别处理数据生命周期，避免无效记录和日志长期堆积。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
CONTROL_PLANE_TIMEOUT = 30s
MANAGER_OFFLINE_TIMEOUT = 120s
OPERATION_LEASE_TIMEOUT = 300s
QUEUE_TIMEOUT = 5m
BOOT_TIMEOUT = 30m
RESUME_TIMEOUT = 15m
STOP_TIMEOUT = 10m
DELETE_TIMEOUT = 15m
OPEN_TOKEN_EXPIRE = 60s
LOG_MAX_LINE_SIZE = 64KiB
LOG_RETENTION_DAYS = 365
FAILED_RETENTION_DAYS = 365

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
- `OPERATION_LEASE_TIMEOUT` 是 Manager claim/续租 [Operation](glossary.md#operation) 的 lease 时长。

Manager 本地配置由 Manager 自己管理，例如：

```text
/etc/gitea-codespace/manager.yaml
/etc/gitea-codespace/manager.json
```

Manager 本地配置保存 tag 到 backend 的映射，以及 Incus/Docker 配置、镜像、资源、网络、挂载、bootstrap、DinD 策略。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。
