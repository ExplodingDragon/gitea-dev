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

这些入口只提交用户选择的 git ref 上下文，由 Gitea 解析并锁定 `commit_sha`；客户端不能指定最终 commit 或覆盖路由 repository。Manager 自行决定 runtime 参数、image、VM/container 类型、Endpoint、SSH 和 backend。

创建输入：

| 参数 | 说明 |
| --- | --- |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | branch → 分支名；tag → 标签名；commit → 完整 commit SHA；pull → 十进制 PR index |

`repo_id` 来自 `/{owner}/{repo}` 路由解析结果。Gitea 对 pull index 生成规范 `refs/pull/{index}/head`，对其他类型解析对应 ref，并把服务端得到的完整 commit SHA 写入 codespace；任何客户端提交的 `repo_id/commit_sha` 字段都作为未知输入拒绝。

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
POST   /codespace/{uuid}/delete
```

`GET /codespace/{uuid}` 是唯一对象页面。

`GET /codespace/{uuid}/logs` 是日志数据接口，不是独立页面。

路由行为：

- `POST /{owner}/{repo}/codespace` 成功后重定向到 `GET /codespace/{uuid}`。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /codespace/{uuid}`。
- delete 后返回显式 `return_to`；若没有，则 repository 可见时回到 repository codespace 页，否则回到 `/codespace`。
- delete 时 `manager_id=0` 表示没有已绑定运行侧资源，Gitea 同步物理删除记录、token 和日志；`manager_id!=0` 时写入绑定 Manager 的 delete operation，并在进入 `deleting` 的事务中吊销 token。
- 站点管理员在 Manager 永久不可恢复时可通过同一路由提交 form 字段 `force=true` 和显式确认字段。Web 删除使用受 CSRF 保护的 POST；服务层校验站点管理员权限后直接删除 Gitea 记录、token 和日志，并在响应中明确运行侧资源尚未确认清理。

布局：

- `creating`：中心日志布局；根据 `operation_status` 派生展示 queued 或 booting，只允许 delete。
- `running`：左右分栏；无 active operation 时展示 Endpoint、SSH、stop、delete；active stop operation 时派生展示 stopping 并禁用交互。
- `stopped`：左右分栏；无 active operation 时展示 resume/delete；active resume operation 时派生展示 resuming。
- `deleting`：显示清理进度，不允许新的用户动作。
- `failed`：只展示日志和 delete。

实现验收点：

- create、open、resume、stop、delete 均回到唯一 codespace 对象页或明确的 `return_to`。
- `manager_id=0` 的 delete 不创建无法领取的 operation。
- 非站点管理员不能使用 `force=true`；正常 delete 仍通过绑定 Manager 清理 Runtime。
- running 且存在 stop/delete operation 时，页面禁用 Endpoint 和 SSH 交互。

## 权限模型

Codespace 权限由服务层统一判定，Web handler、ManagerService、Gateway Open Token 校验和 SSH 公钥校验都调用同一组入口：

```text
CanCreateCodespace(ctx, user, repo, ref) Decision
CanInteractiveAccessCodespace(ctx, user, codespace, action) Decision
CanAdministerCodespace(ctx, user, codespace, action) Decision
```

`Decision` 包含 `allowed`、`failure_category`、`failure_message` 和 `retryable`。

统一入口确保 Web、RPC 和 Gateway 对用户状态、codespace 状态与 Manager 状态得到一致结论，避免权限规则在多个 handler 中逐渐分叉。

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

create operation 完成后，repository 的后续状态不再参与 open、SSH、resume、stop、delete 或 logs 判定。workspace 已经由 Runtime 数据和 Manager binding 初始化完成，repository 后续删除、归档、迁移、ref 移动或访问权限变化只影响 Runtime 内部 Git HTTP(S) 操作。仍处于 creating 的初始化过程可以因 Git HTTP(S) 被拒绝而上报 failed，但 repository 事件本身不直接改写主状态。

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

绑定 Manager 永久不可恢复时，站点管理员可在明确确认后强制删除 Gitea 记录、token 和日志。该动作不声称已经清理运行侧资源；旧 Manager 再次出现并上报对应 Runtime 时，Gitea 将其识别为 extra runtime 并返回 cleanup instruction。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | 创建用户被删除后只保留后台清理和日志保留 |
| 组织仓库 | codespace 仍归创建用户管理；站点管理员保留全站管理能力 |

### Minimal Info

面向列表页、站点管理员管理视图和 repository 删除后的弱关联展示。它只提供识别对象、判断状态和发起允许动作所需的信息，token、internal SSH、upstream 和日志正文保留在对应的专用接口或内部组件中。

用户本人的 codespace 列表页使用完整 `codespace` 行字段（含 `last_active_unix` 等交互活跃信息），不在 Minimal Info 范围内。Minimal Info 仅用于非创建用户的管理视图。

只允许返回：

- `uuid`
- `status`
- `created_unix`
- `updated_unix`
- `stopped_unix`
- `user_id`
- `user_display_name`
- `user_deleted`
- `repo_id`（repository 删除后为 0；0 表示来源 repository 已不可再解析）
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

实现验收点：

- create 使用 repository 权限；既有 codespace 的交互和管理权限不依赖 repository row。
- 创建用户只能交互自己的 codespace，站点管理员可以查看日志、stop、delete 和强制清理全部 codespace。
- Minimal Info 不返回 token、internal SSH、upstream 或日志正文。

## ManagerService RPC

Gitea 实现：

```text
codespace.v1.ManagerService
```

传输：

- Connect RPC over HTTP 或 HTTPS（参考 Actions runner Connect 服务形态）；具体 scheme 由部署地址和 Manager 本地配置决定
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口

HTTP 适合受信私网和本地开发，HTTPS 适合跨主机或不受信网络。协议选择不改变 RPC、认证 header 或状态语义；启用 HTTPS 时由部署配置提供 CA、证书和 server name 校验，使用 HTTP 时运维侧负责把控制面限制在受信网络。

Manager 认证 header：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，其余 RPC 使用 Manager header。

完整 proto 定义和消息结构见 [RPC 接口定义](rpc-spec.md)。

### 统一失败分类

ManagerService 和访问判定使用以下稳定字符串。handler 选择表中最具体的分类，不自行拼接新字符串；日志可以附带内部错误正文，但协议只返回分类和 `retryable`，使 Manager/Gateway 能以固定分支处理重试、清理和用户提示。

| 分类 | Connect code / retryable | 使用场景 |
| --- | --- | --- |
| `invalid_argument` | `InvalidArgument / false` | 字段格式、枚举、数量或 request 大小不合法 |
| `unauthenticated` | `Unauthenticated / false` | registration token、Manager ID 或 secret 无效 |
| `invalid_credentials` | `PermissionDenied / false` | SSH 公钥或一次性 open code 未通过访问判定 |
| `permission_denied`、`user_deleted`、`login_restricted` | `PermissionDenied / false` | 当前身份不再允许该动作 |
| `manager_disabled` | `FailedPrecondition / false` | Manager 管理态不允许新运行或交互 |
| `manager_offline`、`manager_recovering` | `Unavailable / true` | 当前 Manager 可用性暂不满足交互或领取条件 |
| `codespace_not_found` | `NotFound / false` | UUID 不存在；UpdateOperation delete 重试仍使用 `resource_absent` outcome |
| `codespace_not_running`、`endpoint_not_found` | `FailedPrecondition / false` | 当前 codespace 或 Endpoint 不满足交互入口条件 |
| `manager_mismatch`、`stale_operation` | `FailedPrecondition / false` | 请求来自错误 binding 或旧 operation 上下文 |
| `current_operation_conflict`、`generation_conflict`、`offset_conflict`、`offset_gap` | `Aborted / true` | 当前值已变化，caller 应读取响应 detail 后重建请求 |
| `stale_generation` | `FailedPrecondition / true` | generation 过旧，并附 `StaleGenerationDetail` |
| `metadata_required`、`metadata_invalid`、`state_unavailable` | `FailedPrecondition / false` | 请求缺少有效 metadata，或当前生命周期不允许该动作 |
| `runtime_not_ready` | `Unavailable / true` | running 主状态已成立，但 credential/SSH/Endpoint 尚未收敛到 ready |
| `metadata_rebuilding` | `Unavailable / true` | 主状态有效，但当前节点的 Runtime Metadata cache 尚待 Manager 重建 |
| `log_size_exceeded` | `ResourceExhausted / false` | 普通日志已达到固定上限 |
| `internal_error` | `Internal / true` | 服务端无法保证本次命令是否执行 |

create 的 repository archived/empty/unavailable、ref not found 和 repo permission 等分类继续使用权限模型中定义的稳定名称；它们都属于 create 前置结果，不改变既有 codespace 的生命周期。访问判定 RPC 在 `denied` outcome 中使用同一分类字符串，不把正常拒绝转换成 Connect error。

实现验收点：

- 同一失败条件在不同 handler 中返回同一 category、Connect code 和 retryable。
- generation 与日志 offset 冲突携带对应 detail，Manager 不解析 message 文本恢复。
- 未知内部错误统一为 `internal_error`，不会把数据库或 token 正文暴露给 caller。

### RegisterManager

- 将 registration token 兑换为 Manager identity 和 manager secret。
- 校验 `is_active=true`。
- Manager 的 `owner_id` 继承 registration token 的 `owner_id`；`owner_id=0` 表示 global，非 0 表示 Gitea owner 的 `user.id`。
- 数据库保存 manager secret 的 `secret_hash / secret_salt`。
- 只返回一次明文 manager secret。

### DeclareManager

- 更新 Manager 名称、版本、gateway 地址、tags、SSH host key 信息、容量快照和 backend capabilities；Gitea 从这些明确类型字段生成规范化 `meta_json`，其中版本用于管理页面展示和兼容性诊断。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- 只有成功的 Declare 更新 `last_online_unix`；其他 RPC 认证成功不隐式恢复 online。超过 offline timeout 的 Manager 必须先按恢复流程 Declare recovering/online，才能领取 create/resume。
- response 返回当前 `admin_state=enabled|disabled`，使 Manager/Gateway 在 heartbeat 后立即执行本地管理态。
- Manager 周期调用 `DeclareManager`；心跳间隔小于 `MANAGER_OFFLINE_TIMEOUT / 3`。
- Manager 重启恢复期间通过 `DeclareManager` 上报 `manager_runtime_state=recovering`，恢复完成后上报 `manager_runtime_state=online`。
- `codespace_manager.runtime_state` 只保存 Manager 声明的 `online|recovering`；offline 根据 `last_online_unix + MANAGER_OFFLINE_TIMEOUT` 实时派生，不回写该字段。
- 首次 `recovering` 声明写入 `last_recovering_unix=now`；`recovering` 期间重复 `DeclareManager` 不更新该时间戳。
- `recovering -> online` 过渡时写入 `last_recovered_unix=now`；后续 `online` 期间重复 `DeclareManager` 不更新该时间戳。

心跳间隔小于 offline timeout 三分之一，是为了让一次短暂网络抖动或单次 heartbeat 延迟不会直接触发 offline，同时让 Gitea 能在数个心跳周期内发现真实离线。`recovering` 运行态让 Gitea 区分“Manager 正在维护恢复”和“Manager 完全不可达”，从而保留已有 codespace 主状态并暂停新的 create/resume 领取；`now-last_recovering_unix` 超过 `MANAGER_RESTART_GRACE` 后不再暂停 operation lease 超时，避免 recovering heartbeat 无限冻结 operation。

Declare 校验：

- `gateway_url` 使用 absolute `http://` 或 `https://` URL，不含 userinfo、query 或 fragment。站点可通过 `GATEWAY_REQUIRE_HTTPS` 要求 HTTPS；默认允许 HTTP，便于受信内网和开发环境部署。
- `gateway_url` path 允许为空或作为固定 base path；生成 open 和 Endpoint URL 时以相对 path segment 追加，必须保留 base path。
- `gateway_ssh_addr` 固定格式为 `host:port`，host 非空，port 范围 1-65535。
- `gateway_ssh_host_key_algorithm` 非空，例如 `ssh-ed25519`。
- `gateway_ssh_host_key_fingerprint_sha256` 使用 OpenSSH SHA256 fingerprint 格式，例如 `SHA256:...`。
- `gateway_ssh_host_key_updated_unix` 是 Unix 时间戳。
- tags 最多 64 个，规范化后不得重复；backend capabilities 最多 64 个。
- `capacity_total > 0` 且 `0 <= capacity_available <= capacity_total`。

SSH 是 Manager 的必备能力。Web Endpoint 和 SSH 都属于 codespace 的交互入口，统一要求 Manager 声明 SSH 地址和 Gateway SSH host key 指纹，可以让 UI、权限判定、用户首次连接核对和 Gateway 部署健康检查有稳定能力基线。

### RotateManagerSecret

Manager 在本地把新 secret 保存为 pending 并保留当前 secret，随后使用当前 secret 认证调用该 RPC。Gitea 校验新 secret 格式与熵值，在同一事务内生成新 salt、写入新 hash；成功提交后旧 secret 立即失效，`manager_id`、admin/runtime state 和 codespace binding 均保持不变。响应丢失时，Manager 先用 pending secret 调用 `DeclareManager`：成功则提升 pending；明确 unauthenticated 才表示服务端仍使用旧 secret，并允许重试同一个新值；网络或服务端临时错误只重试 pending 探测。该流程轮换现有身份凭据，不通过注册新 Manager 迁移绑定，也不生成第三个 secret。

实现验收点：

- 调用前后 `manager_id` 和 codespace binding 不变。
- 成功后旧 secret 无法认证，新 secret 可以认证。
- 请求重试不会生成服务端未知的第三个 secret。
- 响应丢失后 Manager 能用 pending/current 认证结果判定服务端是否已经提交轮换。

### FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。

`FetchOperations` request：

| 字段 | 说明 |
| --- | --- |
| `capacity_total` | Manager 总容量（仅用于本次领取判断，不写入数据库） |
| `capacity_available` | Manager 可用容量（仅用于本次领取判断，不写入数据库） |
| `accepted_operation_types` | 本次接受的新建类型：`create|resume`；stop/delete 不依赖该字段 |
| `max_operations` | 本次最多返回 operation 数量 |
| `observed_operations` | Manager 已持有的 `codespace_uuid + operation_rversion` |

Fetch 先处理已绑定当前 Manager 的 running operation：enabled Manager 上报相同 `observed_operations` 版本时只刷新 lease，不下发 payload；未观察到或版本不同则重新下发并刷新 lease。disabled Manager 的 running stop/delete 仍按该规则恢复，running create/resume 则始终返回对应的 `abort_create|abort_resume` 空命令，不重发来源数据、不刷新 lease。然后再按以下优先级领取 queued operation：

```text
delete -> stop -> resume -> create
```

领取条件：

| operation | 条件 |
| --- | --- |
| `delete` | 已绑定当前 Manager，主状态为 `deleting`，`operation_status=queued`（不要求 `accepted_operation_types` 包含 delete） |
| `stop` | 已绑定当前 Manager，主状态为 `running`，`operation_type=stop`，`operation_status=queued`（不要求 `accepted_operation_types` 包含 stop） |
| `resume` | 已绑定当前 Manager，主状态为 `stopped`，`operation_type=resume`，`operation_status=queued`，本次声明接受 resume，容量可用，caller Manager enabled、声明 `runtime_state=online` 且未按 heartbeat timeout 派生为 offline |
| `create` | 未绑定 Manager，主状态为 `creating`，`operation_type=create`，`operation_status=queued`，owner scope 匹配，tag 匹配，本次声明接受 create，容量可用，caller Manager enabled、声明 `runtime_state=online` 且未按 heartbeat timeout 派生为 offline |

领取成功后返回 `operations[]`：

- `operation_rversion`
- `codespace_uuid`
- `lease_deadline_unix`
- `log_offset`
- create 所需 repository/ref/commit 字段；resume 不包含 repository payload
- `repo_id=0` 的 running create 只返回 `recover_create_without_source` 命令，不包含 repository payload
- disabled 后已领取的 running create/resume 只返回对应 abort 命令，用于本地清理和 `final failed`

delete 和 stop 是资源回收动作，优先推进可以释放运行侧资源。resume 和 create 会占用容量，由 Manager 当前容量决定领取时机。resume 基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository。`operation_rversion` 绑定本次 Gitea 下发的 operation 版本，Manager 后续 operation-bound RPC 都用它校验归属。

Manager matching 不在 SQL 中做完整匹配。Gitea 先查询 queued operation 候选，再在 Go 中判断 owner scope、tag、`accepted_operation_types` 和 capacity，最后通过条件 UPDATE 领取。这样与 Actions `runs-on` 的 DB 粗筛加内存 label 匹配保持一致，也避免第一版依赖数据库 JSON 匹配能力。

`max_operations` 范围为 `1..256`；`observed_operations` 最多 10000 条且 UUID 不得重复。每种优先级按 `operation_created_unix ASC, uuid ASC`，单次 Fetch 在所有优先级合计最多粗筛 1024 个 queued 候选，防止每增加一种 operation 类型都线性放大数据库读取。Manager 调用 Fetch 或续租的周期不超过 `OPERATION_LEASE_TIMEOUT / 3`。disabled Manager 不领取 queued create/resume；queued 和 running stop/delete 继续正常处理。abort create/resume 不续租，lease 先超时时 Gitea 已写入的 failed 与 Manager 随后提交的 `final failed` 幂等收敛到同一结果。

单次 Fetch 在一个数据库事务内完成 running lease 刷新、queued claim 和 claim 释放。条件 UPDATE 成功后如果 create repository/user 数据加载或 payload 构造失败，服务按当前 `codespace_uuid + operation_rversion + manager_id + operation_status=running` 条件释放尚未返回给 Manager 的 claim：恢复 queued 和 operation 时间字段，create 同时恢复 `manager_id=0`。该候选失败会写服务端日志并继续处理同批后续候选；数据库连接、事务提交等系统错误回滚本次全部新 claim 和 lease 刷新，不返回部分 response。响应丢失发生在事务提交后时，Manager 通过 running payload 重发恢复。

实现验收点：

- 单次 `FetchOperations` 可返回多个 operation。
- 总返回数量不超过 `max_operations`。
- 本次新领取的 queued create/resume 数量不超过 `capacity_available`；running 恢复和 abort 不占新容量。
- running operation 重发不占 create/resume capacity，但计入 `max_operations`。
- enabled Manager 和 disabled stop/delete 已上报相同 `observed_operations` 版本时不重复下发完整 payload。
- 上述已观察 operation 由 Fetch 刷新 lease，且不计入 response 的 `max_operations`；disabled create/resume 始终返回 abort 并计入 response。
- 领取通过数据库条件更新完成；affected rows 为 0 时继续尝试下一个候选。
- 领取同事务写入 `operation_status=running`、`operation_started_unix`、`operation_deadline_unix`；create 领取额外写入 `manager_id`。
- 领取不递增 `operation_rversion`。
- 普通 running operation 重发不执行 claim、不递增版本，但刷新 `operation_deadline_unix`；abort 不刷新。
- disabled 后已领取的 create/resume 返回 abort 命令且不刷新 lease，不会重新启动初始化或恢复。
- stop/delete 在 Manager 满载时仍可领取。
- 并发领取时只有一个 Manager 成功。
- 已领取但未加入 response 的 operation 会被条件释放，且不会覆盖已经被替换的 operation。
- 单条候选构造失败不会丢弃同批其他成功 operation；系统性事务错误不会返回部分未知结果。
- 系统性错误回滚本次全部 claim；事务提交后响应丢失可由下一次 Fetch 重发 running payload。
- 同类型 FIFO、request 上限、10000 条 observed 上限和单次合计候选扫描上限得到校验。

### UpdateOperation

`UpdateOperation` 续租或上报当前 operation 的最终结果：

```text
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

renew 和首次 final 在写入前直接检查 `operation_deadline_unix`。online Manager 在 `now >= deadline` 后不能恢复该 operation；处于有效 restart grace 的绑定 Manager 可用当前版本的首次 Fetch、renew 或 final 原子恢复 lease。该判断与 Cron 使用相同条件更新，先成功的 final、续租或超时收敛结果生效，后到请求按最新状态返回幂等或 stale outcome。

Manager 为 enabled 时按正常规则接受续租和 final。Manager 在 operation 领取后被 disabled 时，stop/delete 仍按正常规则完成；create/resume 只允许追加清理日志和提交 `final failed`，拒绝 done 和续租。该规则让已开始的新建工作立即回收并收敛为 failed，同时不阻塞已有资源的 stop/delete。

final 必须携带原始 `operation_type`。active operation 仍存在时该类型必须与数据库一致；active operation 已清空的重复请求用请求类型和当前主状态推导幂等结果，因此不需要保存 operation 历史。abort create/resume 仍分别携带原始 create/resume 类型。

状态写入：

| operation | done | failed |
| --- | --- | --- |
| `create` | `status=running, keep token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `resume` | `status=running, last_active_unix=now, clear active operation`（`stopped_unix` 不清零） | `status=failed, revoke token, clear active operation` |
| `stop` | `status=stopped, stopped_unix=now, revoke token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `delete` | 物理删除 codespace、token、日志和绑定数据 | `status=failed, revoke token, clear active operation` |

Manager 负责报告 Gitea-issued operation 的动作结果，Gitea 负责把结果写成主状态、token 生命周期绑定和日志追加窗口。State Finalization 在同一事务内完成这些写入，保证用户看到一致的生命周期结果。operation 完成后不保留 `done|failed` 状态，失败诊断从 codespace 日志读取。

实现验收点：

- renew lease 只刷新 deadline；boot stage 由 Runtime Metadata 和日志表达。
- final result 触发一次 State Finalization。
- 首次 final 返回 `outcome.final_accepted`。
- final operation 类型与当前 active operation 不一致时被拒绝；active 已清空时可按原类型稳定返回幂等或 stale outcome。
- 重复 final 同一 `operation_rversion` 且主状态已匹配目标结果，返回 `outcome.idempotent_done`。
- 过期 `operation_rversion` 或主状态不匹配，返回 `outcome.stale_operation`，当前主状态保持稳定。
- State Finalization 同事务处理主状态、active operation 清空、token 生命周期绑定和日志追加窗口关闭。
- deadline 到期后的 online renew/final 被拒绝；restart grace 内当前版本可恢复，且与 Cron 并发时只有一个条件更新生效。
- codespace 已物理删除时返回 `outcome.resource_absent`；delete worker 幂等结束，create/resume/stop worker 停止并清理本地 Runtime。UUID 不复用，不保存 operation 历史或 tombstone。
- disabled 后已领取的 create/resume 只能 final failed，已领取或新领取的 stop/delete 可以正常完成。

### UpdateLog

- 写入 DBFS 路径 `codespace_log/{codespace_uuid}.log`。
- Gitea 服务层可为完整 failed 对象和 operation 最终状态通过内部入口写入失败或 warning 摘要；Manager operation payload 携带当前 `log_offset`。
- request 使用结构化 `LogLine(timestamp_unix_nano, message)`；Gitea 脱敏后统一编码为 UTF-8 `[RFC3339Nano] message\n`，offset 按编码后的完整字节计算。
- 校验 `codespace_uuid + operation_rversion + manager_id` 匹配当前 running operation。
- offset 等于当前日志大小时追加。
- offset 小于当前日志大小时，幂等重放同一段内容；内容不一致返回 offset conflict 分类。
- offset 大于当前日志大小时返回 offset gap 分类，保持日志文件连续。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许当前 `operation_rversion` 对应的 running operation 追加日志。
- active operation 清空后，日志进入封闭状态。
- 单行最大长度由 `LOG_MAX_LINE_SIZE` 控制。
- 日志总大小由 `LOG_MAX_SIZE` 控制。普通日志可用上限为 `LOG_MAX_SIZE-LOG_FINAL_SUMMARY_RESERVE`，超过后返回 log size exceeded 分类并写入明确截断摘要。
- 服务端固定预留 `LOG_FINAL_SUMMARY_RESERVE`；达到普通日志上限后拒绝原始行，但内部最终摘要仍可写入预留空间。
- keyed lock 内发现普通 batch 将使当前文件首次跨过普通日志上限时，只写一条截断摘要；文件已经达到上限后的普通行直接返回 `log_size_exceeded`，不再写摘要。截断摘要和最终摘要共同受 `LOG_MAX_SIZE` 硬上限约束。
- 成功追加和内容一致的幂等重放都返回服务端当前 `next_offset`；该值是脱敏和规范化编码后的真实文件末尾。
- offset conflict/gap 返回 `CodespaceFailureDetail` 和 `LogOffsetDetail(current_offset)`；Manager 从服务端位置恢复，不根据本地原始 message 估算 offset。

日志使用 byte offset 而不是行号作为写入幂等键，是因为 DBFS 提供 seek/write 能力，Manager 重试时可以精确重放同一段内容。offset gap 分类可以保证 UI tail、下载和后续清理都面对连续文件，不需要处理缺失片段。

实现验收点：

- 成功追加和相同内容幂等重放都返回真实 `next_offset`。
- 服务端脱敏改变字节数时，Manager 下一次追加仍使用 response offset 并成功连续写入。
- offset conflict/gap 携带 `LogOffsetDetail.current_offset`，且不产生不连续文件。
- 达到普通日志上限后只写一条截断摘要，重复请求不消耗最终摘要预留空间。

### ReportRuntimeMetadata

- 只写 [Runtime Metadata](glossary.md#runtime-metadata) 到本地 cache。
- Gitea 接受请求时写入 `last_reported_unix=now`；该字段不由 Manager 提交，也不参与内容 hash。
- request 携带 `metadata_generation`；高于 cache 当前版本时覆盖，相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回 generation conflict，更低版本返回 stale 和当前版本。cache miss 接受 Manager 重建的正 generation 快照。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`，不匹配时返回 stale 分类。
- 只接受 `creating|running|stopped` 状态写入。
- Manager 必须为 enabled；disabled 优先于 recovering，返回 manager disabled 分类。
- `deleting|failed` 状态返回 stale 分类。
- stale 上报不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- Manager 周期刷新间隔不超过 cache TTL 三分之一；相同 generation、相同内容的刷新同样延长 TTL。
- `stopped` 状态下 Runtime Metadata 只用于展示保留资源信息，不提供 open 或 SSH。
- metadata 顶层和 `boot` 使用固定字段；未知字段被拒绝。`endpoints` 始终存在，没有声明时为空数组；`internal_ssh` 在 `boot.stage=ready` 时必须完整。
- create operation 只有在当前 metadata 为 `boot.stage=ready` 时可 final done。resume final done 和主动 running transition 可提交 `credential-refresh`，但新的 open/SSH 在后续 `ready` 快照到达前返回 `runtime_not_ready`。
- Manager 启动后为所有仍由自己持有且处于 `creating|running|stopped` 的 codespace 重建 Runtime Metadata cache。
- Manager 运行期间周期刷新 active codespace 的 Runtime Metadata cache，避免 Gitea 重启或本地 cache 丢失后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 Endpoint existence check 和 UI 展示。主状态校验基于数据库 `codespace.status`，与 cache 信任无关。
- 成功写入 Runtime Metadata 时，可刷新维护恢复证据时间。

Runtime Metadata 是运行时信息，变化频繁，也可以由 Manager 重建，因此放在 cache 中。主状态和权限判断继续使用数据库字段。

实现验收点：

- Runtime Metadata 成功写入 cache。
- `running` 交互入口同时依据主状态、Manager 在线态和 Runtime Metadata。
- Gitea cache 丢失后由 Manager 重建 Runtime Metadata。
- 相同 generation、不同内容被拒绝，相同内容的重试和周期刷新幂等延长 TTL。
- ready 快照缺失完整 internal SSH、固定 boot 字段或包含未知字段时被拒绝，且 create 不能提前 final done。

### ReportRuntimeTransition

`ReportRuntimeTransition` 用于 Manager 在没有 Gitea-issued active operation 时上报本地主动 stop/resume 事实。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | Runtime 对应 codespace UUID |
| `runtime_generation` | Manager 对该 codespace 主动运行事实的单调版本 |
| `observed_operation_rversion` | Manager 产生该事实时观察到的最新 Gitea operation 版本 |
| `fact.running` | running 事实以及完整 `metadata_json + metadata_generation` |
| `fact.stopped` | stopped 事实，不携带 Runtime Metadata |

接受规则：

| 当前状态 | Manager fact | 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped`、写 `stopped_unix=now`、吊销 token |
| `stopped` 且无 active operation | `running` | 写 `status=running`，同事务写入 Runtime Metadata |
| `running/stopped` 且有 active operation | 任意 | 返回 `current_operation_conflict` |
| `creating/deleting/failed` | 任意 | 返回 `stale_operation` |
| Manager disabled 且无 active operation | `stopped` | 允许 |
| Manager disabled | `running` | 返回 `manager_disabled` |

校验顺序固定为：读取 codespace 并检查 `manager_id` binding；检查 active operation conflict；检查 Manager admin/runtime state；检查 `observed_operation_rversion`；检查 `runtime_generation`；检查主状态与 fact 是否兼容；running fact 最后校验并规范化 metadata。任何一步失败都不写主状态、generation 或 cache。固定顺序让同一请求即使同时存在多个问题也返回稳定分类。全部通过后，同事务更新主状态、Runtime Metadata 和 `runtime_generation`。`ReportRuntimeTransition` 不递增 `operation_rversion`，因为它不是 Gitea 下发的 operation。

Manager 主动 transition 不更新 `last_active_unix`；该字段只记录用户 resume final、成功消费 open code 和成功 SSH 认证。

实现验收点：

- transition 请求不携带不参与判定的观察时间和原因字段。
- disabled Manager 只可提交 stopped fact，running fact 返回 manager disabled。
- operation 上下文、runtime generation 和 running metadata 任一不满足时均不改主状态。
- 多个条件同时不满足时仍按固定校验顺序返回同一失败分类。

### RequestGiteaToken

- 允许绑定 Manager 在 `status=creating|running` 工作状态申请当前 Git 凭据。
- 调用方 Manager 必须与 `codespace.manager_id` 匹配、enabled 且 online。
- `codespace.user_id` 必须仍能解析到创建用户；用户已删除时返回 `user_deleted`，不得重新签发 token。
- `creating` 要求 create operation 已被该 Manager 领取，用于首次 clone/checkout。
- `running` 要求没有 active stop/delete operation。
- `status=stopped|failed|deleting` 返回状态不可用。
- `repo_id=0` 时仍可签发 token；后续 Git HTTP(S) 访问因 repo binding 不匹配而拒绝所有 repository。
- `gitea_token_id>0` 时直接返回保存的 `gitea_token` 明文。
- `gitea_token_id=0` 时签发新 token，写入非零 `gitea_token_id` 和 `gitea_token`，再返回明文。
- token ID/明文不成对，或 access token row 已不存在时，生命周期服务锁定 codespace 行：非零 token ID 对应的 row 仍存在时先通过生命周期专用入口删除，再原子写回 `0 + 空字符串`；仅在当前为工作状态且创建用户仍存在时重新签发。该顺序避免旧 token 在失去 codespace binding 后变成普通 PAT。
- 同一 `codespace_uuid` 的请求、生命周期吊销和 reconciliation 使用同一个 keyed lock；锁内重新读取 codespace，并在一个数据库事务中完成旧 token 清理、access token 创建和 token pair 写入。并发请求因此只会创建并返回同一个有效 token，stop/delete 也不会在签发提交后遗漏吊销。

实现验收点：

- creating/running 且创建用户存在时返回当前 token 或在空 binding 上签发一个新 token。
- 用户已删除时返回 `user_deleted`，不创建 access token row。
- 损坏 pair 修复后旧 token row 不存在，codespace 最多绑定一个新 token。
- 并发 Request、stop/delete 和 reconciliation 后，数据库中至多存在一个被该 codespace 引用的有效 token，字段 pair 不出现半写入。

### ValidateOpenToken

- Gateway 提交 authorization code，Gitea 校验并消费该 code 后返回 open binding。
- response 使用互斥 outcome：成功返回 `allowed(user_id, codespace_uuid, endpoint_id, manager_id)`，访问拒绝返回 `denied(category, retryable)`，不同时返回无意义的零值 binding 和失败字段。
- 校验过程遵循 OAuth2 Authorization Code Grant 模式：Gitea 作为 Authorization Server，Gateway 作为 Client（以 Manager 身份认证，代替 OAuth2 标准的 client_id/client_secret）。
- 验证时执行运行时检查（codespace 状态、用户权限、Endpoint 存在性），而非仅检查 code 是否有效。
- 成功消费 code 并建立 open binding 时更新 `last_active_unix=now`。

### VerifySSHPublicKey

- Gateway 调用，Gitea 校验用户身份和访问权限后返回本次认证结果。
- 认证成功时更新 `last_active_unix=now`。

`VerifySSHPublicKeyRequest`：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | codespace UUID（Gateway 从 SSH 连接串 `cs-{id}` 解析） |
| `public_key` | SSH 客户端认证请求中的 wire-format 公钥 bytes |

`VerifySSHPublicKeyResponse` 使用互斥 outcome：

| 字段 | 说明 |
| --- | --- |
| `allowed` | 成功 binding，包含 `user_id + codespace_uuid` |
| `denied` | 拒绝详情，包含 `category + retryable` |

Gitea 校验：

- `codespace_uuid` 映射到有效 codespace。
- codespace 为 `running`。
- codespace 当前没有 active stop/delete operation。
- 公钥认证使用 `ssh.ParsePublicKey` 解析 `public_key`，计算 OpenSSH SHA256 fingerprint，以 `OwnerID=codespace.user_id + Fingerprint + KeyTypeUser` 查询 Gitea SSH key，并再次比较数据库 key 规范化后的 wire bytes。二次比较保证认证依据是同一把 key，而不是仅依赖 fingerprint 文本。部署密钥（`KeyTypeDeploy`）和授权主体（`KeyTypePrincipal`）不接受。若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- 创建用户当前允许登录。
- 绑定 Manager 当前在线且未被 disabled。
- `public_key` 解析失败、未匹配用户 key 或 wire bytes 不一致均返回 `invalid_credentials`。
- `public_key` 是认证的唯一依据，Gateway 仅在 `VerifySSHPublicKey` 中传递客户端提交的完整公钥 bytes。

SSH 接入的完整流程（Gateway 中转模型、channel 能力、限流退避配置）参见 [Manager 与 Gateway - SSH 接入](manager-gateway.md#ssh-接入)。

Gateway 按 source IP、`codespace_uuid` 做限流和退避。限流和退避由 Gateway 负责。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

失败分类：

| 分类 | 含义 |
| --- | --- |
| `invalid_credentials` | 公钥认证信息未通过 |
| `login_restricted` | 用户登录受限 |
| `codespace_not_found` | codespace 不存在 |
| `codespace_not_running` | codespace 未运行 |
| `manager_mismatch` | Manager 不匹配 |
| `permission_denied` | 权限判定未通过 |
| `internal_error` | 内部错误 |

### RevalidateGatewaySession

Gateway 对已建立的 Endpoint 和 SSH session 周期调用该接口。request 使用 `oneof session`：Endpoint session 携带 `user_id / codespace_uuid / endpoint_id`，SSH session 只携带 `user_id / codespace_uuid`；调用方 Manager 必须与 codespace binding 匹配。

Gitea 重新检查：

- 创建用户仍允许登录，且 request `user_id` 等于 `codespace.user_id`。
- codespace 为 running 且没有 active stop/delete operation。
- 绑定 Manager enabled 且 online。
- request 选择 `endpoint` binding 时，Runtime Metadata 中仍存在 `endpoint_id`。
- request 选择 `ssh` binding 时，internal SSH metadata 仍完整可用。

该接口通过互斥 outcome 返回空的 `allowed` 或带 `category + retryable` 的 `denied`，只表达当前访问判定，不消费 Gateway Open Token、不写主状态、不记录访问历史。拒绝时 Gateway 关闭本地 session；成功 revalidate 不更新 `last_active_unix`，用户实际发起 open 或 SSH 认证时已经记录活跃时间。

实现验收点：

- Endpoint 和 SSH session 都能在配置的 revalidate interval 内感知登录状态、codespace 状态和 Manager 状态变化。
- request user、codespace、endpoint 和 Manager binding 任一不匹配时返回拒绝。
- revalidate 不延长一次性 open code，也不改变 codespace 生命周期。

### ReportInstances

Manager 通过 `ReportInstances` 上报本地 Runtime inventory 快照。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `inventory_generation` | Manager 单调递增的 inventory 版本 |
| `instances[].codespace_uuid` | 本地 Runtime 对应 codespace UUID |
| `instances[].runtime_state` | `creating|running|stopped` |
| `instances[].observed_operation_rversion` | Manager 看到的本地 operation 版本 |

`ReportInstances` 始终上报 Manager 持有的完整 Runtime 集合，包括 stopped 的可恢复 workspace、volume 或实例。第一版不提供增量或 incomplete 模式；单次最多 10000 个实例且 UUID 唯一。

`inventory_generation` 高于当前版本时执行差异写入并更新版本；相同 generation、相同规范化快照时不重复已经完成的条件状态写入，但必须根据请求中的完整快照和当前数据库状态重新计算 instruction，保证首次响应丢失后可以恢复；相同 generation、不同快照返回 generation conflict；更低版本返回 stale 和当前版本。`instances[].runtime_state` 用于发现运行状态分歧，主状态变更仍通过 `ReportRuntimeTransition` 完成。

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
runtime_state_mismatch
```

处理方式：

| 差异 | Gitea 行为 |
| --- | --- |
| extra runtime | 返回 `cleanup_local_runtime` instruction，主状态保持稳定 |
| reported `observed_operation_rversion` 与 Gitea 当前 active operation 版本不同 | 返回 `refetch_operation(current_operation_rversion)`，该实例本轮不驱动主状态写入；Manager 在下一次 Fetch 省略该 observed 项以取得当前 payload |
| Manager 以非零 observed version 报告了 operation 上下文但 Gitea 当前没有 active operation | 返回 `clear_operation_context(current_operation_rversion)`；Manager 仅在本地 worker 版本不高于该值时清除上下文并保留 Runtime |
| enabled Manager 上报的 runtime_state 与无 active operation 的 `running/stopped` 主状态不一致 | 返回 `report_runtime_transition`，由 Manager 携带新 generation 上报事实 |
| disabled Manager：Gitea running、Runtime stopped | 返回 `report_runtime_transition`，只允许上报 stopped |
| disabled Manager：Gitea stopped、Runtime running | 返回 `stop_local_runtime`，Manager 本地停止 Runtime，Gitea 主状态保持 stopped |
| missing `creating` runtime | active create lease 有效时保持 creating；lease 失效或 active operation 缺失时进入 `failed` |
| missing `running` runtime | 记录 divergence，进入 `failed` |
| missing `stopped` runtime | 进入 `failed`，因为已经无法 resume |
| missing `deleting` runtime | 接受 cleanup 完成，物理删除 codespace |

数量差异来自 Gitea 记录和 Manager 本地 Runtime 列表不同。Gitea 用数据库主状态判断哪些 Runtime 应该存在，Manager 用快照报告本地实际列表，最后由 Gitea 返回处理指令。

实现验收点：

- Gitea 按 `manager_id` 查询 expected。
- Manager 上报完整快照后计算 extra/missing。
- 相同 generation 的相同快照可以重获 instruction，不重复执行状态写入；不同快照被拒绝。
- operation 版本不一致只返回 refetch instruction，不使用旧 Runtime 事实改写主状态。
- `refetch_operation` 只用于当前存在 active operation 的记录；无 active operation 时明确返回 `clear_operation_context`，Manager 不从空 Fetch 响应推断清理。
- 延迟到达的 clear instruction 可清除该版本及更早的旧上下文，但不能清除本地已经替换为更高版本的 operation。
- disabled Manager 不会收到要求上报 running fact 的 instruction。
- extra runtime 返回 cleanup instruction。
- missing runtime 按当前主状态处理。
- 旧 inventory generation 不触发 extra/missing 或主状态写入。

所有 operation-bound RPC 都携带 `codespace_uuid` 和 `operation_rversion`，Gitea 通过 `codespace.operation_rversion`、`codespace.operation_status` 和 `codespace.manager_id` 完成校验。

[Stale Report](glossary.md#stale-report) 被识别后返回 stale 分类，codespace 主状态保持当前值。

stale report 使用分类响应而不是改写主状态，是因为 Manager 上报可能来自旧 lease、重启后的残留任务或已经被 Gitea reconciliation 接管的 operation。保持主状态不变，可以让 Gitea 数据库状态继续作为判断依据，同时给 Manager 明确 cleanup 或停止上报的信号。

### Operation 返回数据

`FetchOperations` 返回 operation envelope，并通过 `oneof command` 表达命令类型：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `operation_rversion` | 全部 | Gitea 下发 operation 版本 |
| `codespace_uuid` | 全部 | Codespace UUID |
| `lease_deadline_unix` | 全部 | Lease 截止时间 |
| `log_offset` | 全部 | 当前 codespace 单文件日志大小，Manager 从该 byte offset 继续追加 |
| `command.create` | create | create 专属结构 |
| `command.resume/stop/delete` | 对应类型 | 不携带 repository 数据的明确命令分支 |
| `command.recover_create_without_source` | `repo_id=0` 的 running create 恢复 | 不重发 repository payload，Manager 检查本地 workspace、boot 结果和 `ready` metadata 后 final done 或 failed |
| `command.abort_create/abort_resume` | Manager disabled 后已领取的 running create/resume | 不重发执行数据；Manager 清理本轮 Runtime 工作并 final failed |
| `create.repo_id` | create | base/route repository ID |
| `create.repo_full_name` | create | repository 完整名称 |
| `create.repo_name` | create | repository 名称 |
| `repo_clone_url` | create | 仓库 clone URL |
| `repo_web_url` | create | 仓库 Web URL |
| `repo_tag` | create | 从 `.gitea/codespace.yaml` 解析的 tag |
| `create.owner_id/name/type/display_name` | create | repository owner 信息 |
| `create.codespace_owner_name` | create | codespace 创建用户名称 |
| `start_ref` | create | Manager fetch/checkout 的 ref 提示 |
| `ref_type` | create | `branch`/`tag`/`commit`/`pull` |
| `ref_name` | create | `branch` → 分支名；`tag` → 标签名；`commit` → commit SHA；`pull` → PR ref 路径 |
| `commit_sha` | create | 锁定 commit SHA |

规则：

- command `oneof` 必须且只能设置一个分支，Manager 使用生成类型做穷尽处理。
- operation 类型由 command 分支唯一表达，envelope 不重复返回独立 `operation_type`。
- `start_ref` 是 Manager 用于 fetch/checkout 的输入提示，最终 checkout 以 `commit_sha` 为准。
- PR 场景使用 base repository clone URL 和 `refs/pull/{index}/head`，不下发 head repository clone URL。
- `resume|stop|delete` 返回数据不包含 create 专属的 repository、owner、ref 或 commit 字段。
- `resume` 完全基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository，不依赖 repository payload。
- `recover_create_without_source` 不阻止已初始化 workspace 完成 create；它只表示 Gitea 已无法重发来源数据。
- `delete` 返回数据使用 `codespace_uuid` 生成，不依赖 repository row。repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Manager 删除 Runtime 只依赖 `codespace_uuid` 的本地确定性映射。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- Runtime Instance ID、Runtime Instance name、镜像、资源、backend、mount、network 和 Endpoint port/path 均由 Manager 独立决定；Endpoint host 固定从所属 Runtime identity 解析。
- Manager 使用 `codespace_uuid` 在本地生成或查找 Runtime Instance 的确定性映射。
- Manager 创建 Runtime 时自己决定并注入 `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN`。
- `lease_deadline_unix` 是本次领取/续租的截止时间，Manager 在截止前通过 `UpdateOperation` 续租或上报终态。

实现验收点：

- ManagerService 所有命令通过统一认证、binding 和版本校验。
- Fetch、final、日志、metadata、transition、inventory 和 session revalidate 的请求响应与 RPC 文档一致。
- command rejection 携带统一 Connect failure detail，访问判定返回 decision response。

## 日志读取

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
- 服务端只返回完整 UTF-8 物理日志行；`limit` 是软字节上限，加入下一完整行会超过上限时在该行之前停止。
- `offset` 必须是 0、文件末尾或 `log_indexes` 中的物理行起点；落在字符或行中间时返回 offset conflict 和该物理行起点。
- 如果第一条完整物理行本身超过请求 `limit`，服务端仍单独返回该行并推进 offset，避免客户端无法分页前进；该例外一次只返回这一行，且仍受 `LOG_READ_MAX_BYTES` 约束。
- `next_offset` 是下一次轮询起点。
- `eof=false` 表示仍可继续读取。
- `truncated=true` 表示本次响应达到读取上限，客户端继续使用 `next_offset` 拉取。
- delete done 后删除 DBFS 日志。
- `failed` 状态日志保留到用户 delete 或 `FAILED_RETENTION_DAYS` 清理。

第一版日志完成后仍保留在 DBFS，不迁移到对象存储。DBFS 已满足运行中追加和页面读取；先不引入归档状态，可以减少状态机和清理任务的耦合。后续若需要对象存储归档，再增加 `log_storage=dbfs|object` 和独立 transfer job。

实现验收点：

- 日志读取按 byte offset 稳定分页，`next_offset` 可直接用于下一次请求。
- 非行起点 offset 返回所在行起点，超过请求 limit 的单行可单独返回且不会造成无限重试。
- delete 和 failed retention 删除整份单文件日志，不按 operation 历史截断。
- UI 和下载读取同一份已脱敏内容。

## Token 管理

### Gitea Token

[Gitea Token](glossary.md#gitea-token) 复用 Gitea 现有 `access_token` 模型（`models/auth/access_token.go`）。

设计依据：

- 参考 Gitea Actions 的 token 认证与 repository 绑定模型：Actions 先把 task token 识别为内部 actor，再按 `task.RepoID` 校验目标 repository。
- Gitea 现有 access token scope 是 category 级（位图实现，如 `write:repository`），没有单仓库 scope。Codespace 复用现有 `access_token` 与 `write:repository` scope，再追加 `codespace.repo_id` 绑定校验，把"能做 repository 类操作"和"只能访问哪个 repository"拆开，在不扩展通用 token 系统的前提下得到可执行的单仓库边界。

规则：

- token 归属于 codespace 创建用户。
- 所有 codespace token 统一签发 `write:repository`。
- token scope 限定为 `write:repository`，实际能否访问由 Gitea 现有 token、用户、repository、unit 和权限检查决定。
- `codespace.gitea_token_id` 使用 0 表示无 token，非零值指向当前 active access token，并通过普通索引支持反查。
- `codespace.gitea_token` 使用空字符串表示无 token；非空明文只允许通过 `RequestGiteaToken` 返回给绑定 Manager。
- access token `Name` 固定为 `codespace-{uuid}`，用于用户识别；安全判断只使用 token ID，不依赖名称唯一性。
- `codespace.repo_id` 是唯一 repository binding；为 0 时不匹配任何 repository。
- Runtime clone、fetch 和 push 使用 Git HTTP(S) clone URL。
- Basic 和 OAuth2 PAT 认证成功后，除现有 `IsApiToken/ApiTokenScope` 外，还把实际 `access_token_id` 写入 request context；后续判定不能只依赖已经转换出的用户身份和 category scope。
- 新增服务层公共判定入口 `CheckRepoBoundAccessToken(ctx, tokenID, targetRepoID) Decision`。它根据 token ID 反查当前 codespace binding，并在通过后继续执行 Gitea 现有检查。
- API v1 在 repository context 已解析 target repository 后调用公共判定；`APIContext.TokenCanAccessRepo` 作为 API 适配入口，读取 request context 中的 token ID 后调用该服务，而不是只执行现有 public-only 判断。
- Web repository 路径扩展 `CheckRepoScopedToken`，在现有 scope 检查之外调用公共判定。
- Git HTTP、LFS、raw、archive、download、feed 等不保证经过 Web/API scope helper 的入口，在认证完成且 target repository 已解析后显式调用同一公共判定。
- package、user、org 等非 repository 路径在识别到 codespace-bound token 后返回 unsupported resource；不能因为 PAT 已被转换为用户身份而继续按普通用户处理。
- repo-bound token 判定只额外校验 `target_repo_id == codespace.repo_id`。
- codespace-bound token 的 repository 访问范围固定为 `codespace.repo_id`；访问其他 repository 时返回 repo binding mismatch 分类，访问绑定 repository 时继续交给 Gitea 现有权限链路判断。`repo_id=0` 时，任何 repository 都返回 repo binding mismatch。
- codespace token scope 限定为 `write:repository`。需要 `read:user` 或 `read:organization` 的信息由 Gitea 在 create 时通过只读环境变量注入；resume 使用已初始化 workspace 中的既有信息。
- Runtime 需要的 owner/org 展示信息由 Gitea 在 create 时作为只读环境变量注入，不通过 codespace token 调用通用 user/org API。
- `creating/running` 是工作状态，允许持有 token；`creating -> running` 不吊销 token，直接复用 create 阶段 token。
- 创建用户记录必须仍存在；用户删除事务清理 token row 和 binding 后，工作状态也不重新签发 token。
- `gitea_token_id=0` 时才签发新 token；非零时返回保存的 `gitea_token` 明文，不做轮换。
- stop final、failed final 或 delete 请求进入 `deleting` 时吊销 token 并把 binding 写回 `0 + 空字符串`；物理删除再次执行幂等兜底清理。
- source repo 删除或创建用户失去 repo 访问权限只影响 Git HTTP(S) 访问；已有 codespace 的 open、SSH、resume、stop、delete 和 logs 继续按 codespace 自身权限与状态判定。
- repository 删除不单独吊销 token；`repo_id=0` 后，现有 token 对任何 repository 都拒绝。
- 同一 codespace 只允许保留一个绑定的 Gitea token。
- 轮换只由 token 字段被清空后再次请求触发；例如 `stopped -> running` 后重新请求会生成新 token。
- Runtime 的持久 Git credential 使用 Manager 可刷新的文件或 helper；resume 进入 running 后申请新 token 并替换旧 credential。

`CheckRepoBoundAccessToken` 规则：

- 当前请求没有 access token 时，不处理。
- access token 未被 codespace 绑定时，按 Gitea 现有 token 逻辑处理。
- access token 被 codespace 绑定时，`token_id` 与 `codespace.gitea_token_id` 匹配。
- access token 被 codespace 绑定时，`codespace.status` 必须为 `creating|running`；其他状态返回 codespace state mismatch。
- `target_repo_id` 与 `codespace.repo_id` 匹配。
- `codespace.repo_id=0` 时，对所有 target repository 返回 repo binding mismatch。
- repo binding 匹配后继续执行 Gitea 现有 scope、用户、repository、unit、可见性和权限检查。
- 非 repository 资源返回 unsupported resource 分类；需要 Runtime 使用的非 repository 信息由 create 环境变量注入。

repo-bound token 判定只补足单仓库边界——Gitea access token scope 是 category 级，`write:repository` 表达“可以做 repository 类动作”但不表达“只能访问哪个 repository”。用户权限、repository 存在性、unit 可读写性继续由 Gitea 现有检查负责，避免 Runtime token 变成通用 PAT。

删除保护：

- 不扩展 `access_token` 表，外部删除统一通过 access-token service，先按 `codespace.gitea_token_id` 反查是否被 codespace 占用。
- 被 `codespace.gitea_token_id` 引用的 access token 只能由 codespace 生命周期服务通过专用入口吊销。用户设置页删除、用户 API 删除和“删除当前认证 token”API 都调用该外部 service；命中 binding 时返回 `409 Conflict` 并提示先 stop 或 delete 对应 codespace。
- codespace 生命周期服务在 stop final、failed final、进入 deleting、物理删除和 failed 记录清理时使用专用内部入口 `DeleteAccessTokenByIDForCodespaceLifecycle(ctx, tokenID, codespaceID)` 删除。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 校验 `codespace.gitea_token_id == tokenID`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 在同一事务内清空 `codespace.gitea_token_id` 和 `codespace.gitea_token`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 为 codespace 生命周期服务内部入口，不与 Web/API handler 共享调用路径。
- reconciliation 负责清理 codespace 行仍存在但 token ID、明文或 access token row 不一致的状态；物理删除必须在同一事务删除 token row，因此不依赖无 codespace 记录的反查。
- token pair 损坏时先删除仍存在的旧 token row，再清空 binding；不能先解除 binding 而留下可按普通 PAT 认证的旧 token。

通过反查 `codespace.gitea_token_id` 做删除保护，因为 token 生命周期所有权已由 codespace 行表达。这样不需要给通用 PAT 模型增加新的 token 类型，也能让用户在通用 token UI/API 删除时得到明确的 409 冲突原因。

实现验收点：

- codespace-bound token 只有在 `creating/running` 状态且 token ID、repo binding、Gitea 原有权限均通过时才能访问 repository。
- `repo_id=0` 时仍可签发 token，但任何 repository 访问都返回 repo binding mismatch。
- `creating -> running` 复用同一 token；stop/failed/deleting 清空字段，后续 running 请求生成新 token。
- 用户无法从通用 PAT 页面删除仍由 codespace 持有的 token。
- 用户设置页、用户 token API 和删除当前认证 token API 都经过同一 binding 删除保护。
- 创建用户删除后 `RequestGiteaToken` 返回 `user_deleted`，reconciliation 只清理残留 binding。

### Gateway Open Token

[Gateway Open Token](glossary.md#gateway-open-token) 采用 OAuth2 Authorization Code Grant 模式实现：

- Gitea 作为 Authorization Server，在用户请求 open 时签发 authorization code。
- Gateway 作为 Client，以 Manager 身份认证后提交 code 换取 open binding。
- 与 Gitea 现有 `OAuth2AuthorizationCode` 模型（`models/auth/oauth2.go`，`gta_` 前缀，10 分钟有效期）模式一致：code 为 opaque 随机值，单次使用，短期有效。差异仅在于编码方式（hex vs base32）、有效期（60s vs 10min）和存储介质（cache vs DB）。

Authorization code 属性：

- 短期有效（默认 60s）
- 一次性使用（消费后从 cache 删除）
- opaque，非 JWT
- 绑定 `user_id / codespace_uuid / endpoint_id / manager_id`

签发算法：

```text
code = hex(CryptoRandomBytes(32))
code_hash = sha256(code)
```

设计原因：

- `CryptoRandomBytes(32)` 生成 256 位随机值，hex 编码为 64 字符字符串。
- `sha256(code)` 直接作为 cache lookup key，不需要 salt。code 自身 256 位熵值足够高，且单次使用、60s TTL，彩虹表攻击不可行。加 salt 后验证时需要 salt 才能重建 hash，在 cache key 查找模式下 salt 不可恢复，反而引入设计缺陷。
- 不使用 PBKDF2：code 是随机值而非用户记忆的密码，高计算成本无安全收益。

过期机制（两层保障）：

| 层级 | 机制 | 触发条件 | 作用 |
| --- | --- | --- | --- |
| Cache TTL | `OPEN_TOKEN_EXPIRE`（60s） | cache 自动淘汰 | 主力过期，自动清理 |
| 显式校验 | `expires_unix` 比对 | `ValidateOpenToken` 中显式判断 | 防御纵深，消除 TTL 淘汰延迟窗口 |

两层机制确保即使在 cache TTL 淘汰延迟（秒级）的时间窗口内，`expires_unix` 显式比对也能拒绝已过期的 code。

Cache 结构：

```text
key = codespace:open-code:{code_hash}
value = user_id + codespace_uuid + endpoint_id + manager_id + issued_unix + expires_unix
ttl = OPEN_TOKEN_EXPIRE
```

规则：

- code 明文只出现在 `302 Location` 的 query string 中，不落数据库和日志。
- code 校验通过本机锁串行化（get → validate → delete），确保原子消费。
- code 使用 `CryptoRandomBytes(32)` 生成，256 位熵值使得 hash 冲突概率可忽略，不需要冲突重试逻辑。

校验步骤（code 交换，映射 OAuth2 Token Endpoint）：

1. 计算 `code_hash = sha256(submitted_code)`。
2. 在本机锁保护下以 `code_hash` 查询 cache，命中后立即删除记录。
3. 若 cache miss，code 已过期或已被消费，返回失败。
4. 显式校验 `now < expires_unix`（防御 TTL 淘汰延迟）。
5. 校验调用方 Manager 身份等于 `manager_id`（代替 OAuth2 标准的 client 认证）。
6. 重新读取 codespace，校验当前为 `running`。
7. 校验用户仍具备 Interactive Access。
8. 校验 Endpoint 仍存在于当前 Runtime Metadata。
9. 校验 Manager 仍在线。
10. 校验 Manager 未被 disabled。

步骤 6-10 是运行时安全检查，在 code 签发到验证之间的时间窗口内状态可能已变化。这是 callback 模式的核心价值——不能提前编码进 JWT 签发时跳过。

成功返回：

```text
user_id
codespace_uuid
endpoint_id
manager_id
```

Cache 丢失即 code 失效，用户重新从 Gitea 发起 open。codespace 生命周期状态不受 cache 影响。

Gateway 成功交换 code 后创建服务端 session，并用带 `HttpOnly/SameSite=Lax` 的 cookie 和 `303` 跳转到无 code Endpoint URL；`Secure` 按 Gateway 外部 scheme 和本地配置决定。带 code 的请求不代理到 Runtime，响应设置 `Referrer-Policy: no-referrer`。Gateway 重启后本地 session 失效，用户重新从 Gitea open。

实现验收点：

- access token、Gateway open code 和 Manager 凭据使用各自独立的生命周期与校验入口。
- open code 单次消费、60 秒过期，并在消费时重新检查当前访问条件。
- code 交换后浏览器地址和后续 Referer 不再包含 code，session cookie 不向脚本或其他 Endpoint path 暴露。
- token 或 code 明文不进入日志和普通 API 输出。

## Cron 任务

| 任务 | 默认调度 | 职责 |
| --- | --- | --- |
| `reconcile_codespace_states` | `@every 1m` | 检查 queued operation timeout、running operation lease、Manager offline/recovering 和 token 生命周期绑定 |
| `cleanup_failed_codespaces` | `@daily` | 清理超过保留期的 `failed` 状态 codespace 记录、token 绑定和日志；清理超过保留期的 inactive registration token |

`reconcile_codespace_states` 定时扫描 active operation、Manager 可用性和 token binding。Runtime inventory 不持久化，差异只在 `ReportInstances` 请求内处理。queued operation 使用 `operation_created_unix + QUEUE_TIMEOUT` 判定等待超时，running operation 使用 `operation_deadline_unix` 判定 lease 超时。failed retention 从进入 failed 时写入的 `updated_unix` 起算，token reconciliation 不刷新该值；inactive registration token retention 从 `is_active` 变为 false 时的 `updated` 起算。codespace 只有一份连续日志且不保存 operation 历史，因此日志随 delete 或 `cleanup_failed_codespaces` 一起删除，不按“已完成 operation”单独清理。

实现验收点：

- reconciliation 不读取已失效的 inventory 快照，只处理数据库可判断的 timeout、Manager 可用性和 token 残留。
- failed retention 清理 codespace 记录、token 和对应单文件日志。
- token reconciliation 不延后 failed 清理时间，registration token 停用时间是其 retention 起点。
- 系统不存在按 operation 历史清理日志的 cron 任务。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
CONTROL_PLANE_TIMEOUT = 30s
CONTROL_PLANE_MAX_REQUEST_SIZE = 8MiB
GATEWAY_REQUIRE_HTTPS = false
MANAGER_OFFLINE_TIMEOUT = 120s
MANAGER_RESTART_GRACE = 10m
OPERATION_LEASE_TIMEOUT = 300s
QUEUE_TIMEOUT = 5m
OPEN_TOKEN_EXPIRE = 60s
LOG_MAX_LINE_SIZE = 64KiB
LOG_READ_MAX_BYTES = 512KiB
LOG_MAX_SIZE = 64MiB
LOG_FINAL_SUMMARY_RESERVE = 64KiB
RUNTIME_METADATA_MAX_SIZE = 256KiB
FAILED_RETENTION_DAYS = 365
REGISTRATION_TOKEN_RETENTION_DAYS = 30
CODESPACE_REPO_CONFIG_MAX_SIZE = 64KiB

[cron.reconcile_codespace_states]
ENABLED = true
RUN_AT_START = true
SCHEDULE = @every 1m

[cron.cleanup_failed_codespaces]
ENABLED = true
RUN_AT_START = false
SCHEDULE = @daily

```

说明：

- `OPEN_TOKEN_EXPIRE` 也是 [Gateway Open Token](glossary.md#gateway-open-token) 的 Gitea cache TTL。
- `CONTROL_PLANE_MAX_REQUEST_SIZE` 是 ManagerService 单个解码后 request 的硬上限，inventory、metadata 和日志批次都受其约束。
- `GATEWAY_REQUIRE_HTTPS=false` 时接受 `http://` 和 `https://` 的 `gateway_url`；设为 true 时只接受 HTTPS。该选项用于部署策略，不改变 Gateway 路由或 session 语义。
- SSH 认证限流与退避由 Gateway 配置和管理。
- `OPERATION_LEASE_TIMEOUT` 是 Manager 领取/续租 [Operation](glossary.md#operation) 的 lease 时长。
- `QUEUE_TIMEOUT` 是 queued operation 等待 Manager 领取的最长时间。
- `MANAGER_RESTART_GRACE` 是 offline/recovering 的维护恢复硬上限。offline 从 `last_online_unix+MANAGER_OFFLINE_TIMEOUT` 成立的时刻起算，recovering 从首次 `last_recovering_unix` 起算；超过对应 deadline 后不再暂停 operation lease 超时。
- `CODESPACE_REPO_CONFIG_MAX_SIZE` 限制 `.gitea/codespace.yaml` 读取大小，避免配置读取变成大 blob 解析路径。
- `LOG_READ_MAX_BYTES` 限制单次日志读取响应大小，便于页面轮询和 API 客户端稳定分页。
- `LOG_MAX_LINE_SIZE` 必须小于或等于 `LOG_READ_MAX_BYTES`，保证任何已存物理行都能在服务端硬上限内返回。
- `LOG_MAX_SIZE` 限制单个 codespace 日志总量，避免异常 init 或脚本持续输出导致 DBFS 无限增长。
- `LOG_FINAL_SUMMARY_RESERVE` 从 `LOG_MAX_SIZE` 中预留给截断和最终状态摘要。
- `RUNTIME_METADATA_MAX_SIZE` 限制规范化 Runtime Metadata JSON，避免 Endpoint 声明无限放大 cache 和 RPC。
- `REGISTRATION_TOKEN_RETENTION_DAYS` 是 inactive registration token 的清理保留期。

实现验收点：

- 配置项与实际 cron、lease、queue、open code、日志限制一一对应。
- 容量快照不作为 Gitea 配置或 quota；领取只使用本次 Fetch request。

Manager 本地配置由 Manager 自己管理，例如：

```text
/etc/gitea-codespace/manager.yaml
/etc/gitea-codespace/manager.json
```

Manager 本地配置包含：

```yaml
state_dir: /var/lib/gitea-codespace
gitea_url: http://gitea.internal:3000
control_plane_require_https: false
control_plane_tls_ca_file: ""
control_plane_tls_server_name: ""
control_plane_tls_insecure_skip_verify: false
fetch_poll_interval: 2s
fetch_poll_jitter: 20%
fetch_error_backoff_max: 30s
inventory_report_interval: 1m
runtime_api_url: http://manager.internal:8080
runtime_api_require_https: false
runtime_api_tls_cert_file: ""
runtime_api_tls_key_file: ""
gateway_url: http://codespace.example.com
gateway_cookie_secure: auto
gateway_tls_cert_file: ""
gateway_tls_key_file: ""
gateway_session_ttl: 8h
gateway_session_idle_timeout: 30m
gateway_session_revalidate_interval: 5m
gateway_max_sessions_per_codespace: 32
gateway_max_sessions_per_user: 128
upstream_tls_ca_file: ""
upstream_tls_server_name: ""
upstream_tls_insecure_skip_verify: false
```

`gitea_url`、`runtime_api_url` 和 `gateway_url` 都允许 HTTP/HTTPS；各 `require_https` 选项用于需要强制 HTTPS 的部署。CA 和 server name 只在对应 HTTPS 连接中使用，`insecure_skip_verify` 默认 false。Gateway URL 为 HTTPS 时需要 listener 证书，或由受信反向代理终止 HTTPS；cookie Secure 默认按外部 URL 自动决定。Endpoint HTTPS upstream 使用 upstream TLS 配置，Endpoint 请求不能修改信任策略。

配置同时保存 tag 到 backend 的映射，以及 Incus/Docker 配置、镜像、资源、网络、挂载、bootstrap、DinD 策略。`inventory_report_interval` 默认 1 分钟，必须大于 0；Fetch 默认 2 秒并带 20% 正抖动，临时错误最多退避 30 秒。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。

实现验收点：

- 控制面、Runtime API 和 Gateway 在 HTTP 配置下可正常工作，启用对应 HTTPS 配置后使用证书和 CA 校验。
- `gateway_cookie_secure=auto` 与浏览器实际访问 scheme 一致，HTTP 不因固定 Secure cookie 无法建立 session。
- Endpoint 请求只能选择 `http|https` scheme，不能关闭 HTTPS 证书校验或指定任意 host。
