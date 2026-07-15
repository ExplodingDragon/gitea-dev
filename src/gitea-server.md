# Gitea 服务端

## Web 路由与页面

Codespace 生命周期只保留下列三类页面；Manager 和 registration token 使用现有站点、用户和组织设置导航中的管理页面，不计入生命周期页面数量。

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
POST   /codespace/{uuid}/open/{endpoint_id}
POST   /codespace/{uuid}/resume
POST   /codespace/{uuid}/stop
POST   /codespace/{uuid}/delete
```

`GET /codespace/{uuid}` 是唯一对象页面。

`GET /codespace/{uuid}/logs` 是日志数据接口，不是独立页面。

路由行为：

- `POST /{owner}/{repo}/codespace` 成功后重定向到 `GET /codespace/{uuid}`。
- `POST /codespace/{uuid}/open` 始终打开默认 `workspace`；`POST /codespace/{uuid}/open/{endpoint_id}` 打开明确选择的普通 Endpoint，并拒绝保留值 `workspace`。默认路由不接收可选 `endpoint_id` 字段，避免缺失值和空值产生两套默认语义。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /codespace/{uuid}`。
- delete 后返回显式 `return_to`；若没有，则 repository 可见时回到 repository codespace 页，否则回到 `/codespace`。
- delete 时 `manager_id=0` 表示没有已绑定运行侧资源，Gitea 同步物理删除记录、token 和日志；`manager_id!=0` 时写入绑定 Manager 的 delete operation，并在进入 `deleting` 的事务中吊销 token。
- 站点管理员可通过同一路由提交 form 字段 `force=true` 和显式确认字段。Web 删除使用受 CSRF 保护的 POST；服务层校验站点管理员权限后直接删除 Gitea 记录、token 和日志，并明确该动作只清理 Gitea，运行侧资源可能保留。

布局：

- `creating`：中心日志布局；根据 `operation_status` 派生展示 queued 或 booting，只允许 delete。
- `running`：左右分栏；无 active operation 时展示 Endpoint、SSH、stop、delete；active stop operation 时派生展示 stopping 并禁用交互。
- `stopped`：左右分栏；无 active operation 时展示 resume/delete；active resume operation 时派生展示 resuming。
- `deleting`：显示清理进度，不允许新的用户动作。
- `failed`：只展示日志和 delete。

实现验收点：

- create、open、resume、stop、delete 均回到唯一 codespace 对象页或明确的 `return_to`。
- `manager_id=0` 的 delete 不创建无法领取的 operation。
- 非站点管理员不能使用 `force=true`；站点管理员 force delete 不检查 Manager 状态，也不等待 Runtime 清理。
- running 且存在 stop/delete operation 时，页面禁用 Endpoint 和 SSH 交互。
- 默认 open 不依赖 Runtime Metadata 中存在 `workspace` 记录；两种 open 都要求 metadata ready，显式 Endpoint 路由还拒绝 `workspace` 并只打开当前 metadata 中存在的普通 Endpoint。

Manager 管理入口：

```text
GET/POST /admin/codespace
GET/POST /admin/codespace/managers
GET/POST /user/settings/codespace
GET/POST /org/{org}/settings/codespace
```

站点管理页列出所有 Codespace 和 Manager，并提供 force delete、Manager disable/直接删除及 global registration token 管理；用户和组织设置页只管理当前 owner scope 的 registration token 与 Manager。Manager 删除确认页展示绑定 Codespace 数量，并说明 Gitea 会同步删除这些 Codespace、token 和日志，但不会联系 Manager 或保证 Runtime 回收。确认后，服务层不检查 Manager admin/runtime state，直接提交本地删除事务；删除与 Manager/Codespace 写入共用 keyed lock，已经通过认证的并发 RPC 也必须在最终写入前重新检查记录和 binding。第一版不增加对应 public API，页面直接调用同一 Codespace 服务层，避免 Web 与后续内部调用形成两套删除或凭据规则。

实现验收点：

- 站点管理员可以查看和管理全部 Codespace、Manager 与 global registration token。
- 用户和组织管理员只能管理各自 owner scope 的 registration token 与 Manager。
- 生命周期对象页与设置管理页复用相同服务层权限和事务逻辑。
- 删除任意状态的 Manager 都只执行 Gitea 本地事务，不创建 operation、不发送 ManagerService 请求。
- 删除完成后，并发旧 RPC 不能重新写入 Manager、Codespace、token 或 cache。

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

`open`、SSH 和 `resume` 都只允许 codespace 创建用户本人发起，并要求创建用户当前满足 Gitea 登录限制。三类动作在身份检查后按各自实际依赖继续判断：

| 动作 | 状态与运行信息要求 |
| --- | --- |
| `resume` | codespace 为 `stopped`、没有 active operation，绑定 Manager enabled 且 online；不读取 Runtime Metadata 或 Endpoint，因为恢复动作只依赖已经初始化的 workspace |
| 打开默认 `workspace` | codespace 为 `running`、没有 active stop/delete operation，绑定 Manager enabled 且 online，Runtime Metadata 存在且 `boot.stage=ready` |
| 打开普通 [Endpoint](glossary.md#endpoint) | 满足默认 `workspace` 的 ready 条件，并且当前 metadata 中存在目标 `endpoint_id` |
| SSH 新认证 | codespace 与 Manager 满足运行条件，Runtime Metadata 存在且 ready、`internal_ssh` 完整，提交的 SSH key 归创建用户所有 |

每个入口只检查完成该动作所需的数据。特别是 resume 不依赖可能在 stopped 期间过期或丢失的 cache；open 和 SSH 则需要 ready 快照，避免用户进入 credential、SSH 或 Endpoint 尚未收敛的 Runtime。判定顺序固定为数据库身份与主状态、Manager 状态、metadata 是否存在、ready、目标 Endpoint 或 internal SSH；cache miss 返回 `metadata_rebuilding`，快照存在但尚未 ready 返回 `runtime_not_ready`。

### Administrative Permission

适用于查看最小信息、日志、stop、delete：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 始终拥有，除非已被物理删除 |
| 站点管理员 | 可管理所有 codespace，用于全站资源治理和故障回收 |

管理权限独立于 repo code-read 权限，创建用户失去 repo 访问后仍可行使管理权限。codespace 是由 `user_id` 标识的用户私有资源，管理权由创建用户本人和站点管理员表达。

站点管理员可在明确确认后强制删除 Gitea 记录、token 和日志，不以 Manager 失联或特定状态为前提。该动作的完成条件就是 Gitea 本地事务提交；Gitea 不声明运行侧资源已经清理，也不保存墓碑。之后收到该 UUID 的 inventory 项时忽略，不向 Manager 下发破坏性指令。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | codespace 归创建用户管理；创建用户删除时由账户删除事务物理清理 |
| 组织仓库 | codespace 仍归创建用户管理；站点管理员保留全站管理能力 |

### Minimal Info

面向列表页、站点管理员管理视图和 repository 删除后的弱关联展示。它只提供识别对象、判断状态和发起允许动作所需的信息，token、internal SSH、upstream 和日志正文保留在对应的专用接口或内部组件中。

用户本人列表和管理视图都返回明确的响应 DTO，不直接序列化 `codespace` 数据库行。`CodespaceOwnerListItem` 在下列 Minimal Info 字段基础上增加 `last_active_unix`；该时间用于创建用户查看最近交互，不扩大敏感字段范围。

只允许返回：

- `uuid`
- `status`
- `created_unix`
- `updated_unix`
- `stopped_unix`
- `user_id`
- `user_display_name`
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
- stopped 状态的 resume 在 Runtime Metadata cache 为空时仍可提交；workspace、普通 Endpoint 和 SSH 在 cache miss 时返回 `metadata_rebuilding`，在非 ready 时返回 `runtime_not_ready`。
- 普通 Endpoint 只有在 metadata ready 且目标存在时可打开；SSH 只有在 ready、internal SSH 完整且公钥归创建用户时可认证。
- Minimal Info 和 `CodespaceOwnerListItem` 都不返回 token、internal SSH、upstream、完整 Manager metadata 或日志正文。

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
| `unauthenticated` | `Unauthenticated / false` | registration token 或现有 Manager secret 无效 |
| `invalid_credentials` | `PermissionDenied / false` | SSH 公钥或一次性 open code 未通过访问判定 |
| `permission_denied`、`login_restricted` | `PermissionDenied / false` | 当前身份不再允许该动作 |
| `repo_permission_denied`、`repo_binding_mismatch`、`unsupported_resource` | `PermissionDenied / false` | repository 原有权限、Codespace 单仓库绑定或资源类型不允许访问 |
| `repository_archived`、`repository_empty`、`repository_unavailable`、`source_repository_deleted` | `FailedPrecondition / false` | create 来源 repository 当前不能形成 workspace |
| `ref_not_found` | `NotFound / false` | create 目标 ref/commit 无法解析 |
| `manager_disabled` | `FailedPrecondition / false` | Manager 管理态不允许新运行或交互 |
| `manager_unregistered` | `Unauthenticated / false` | request 中的 Manager ID 已注销、随 owner 删除或从未注册 |
| `gateway_url_conflict` | `FailedPrecondition / false` | 规范化 Gateway URL 已由另一个 Manager 使用 |
| `gateway_ssh_addr_conflict` | `FailedPrecondition / false` | 规范化 Gateway SSH 地址已由另一个 Manager 使用 |
| `manager_offline`、`manager_recovering` | `Unavailable / true` | 当前 Manager 可用性暂不满足交互或领取条件 |
| `codespace_not_found` | `NotFound / false` | UUID 不存在；`UpdateOperation` 对任意 operation 类型改用 `resource_absent` outcome |
| `codespace_not_running`、`endpoint_not_found` | `FailedPrecondition / false` | 当前 codespace 或 Endpoint 不满足交互入口条件 |
| `manager_mismatch`、`stale_operation` | `FailedPrecondition / false` | 请求来自错误 binding 或旧 operation 上下文 |
| `current_operation_conflict` | `Aborted / true` | 当前 active operation 已变化，caller 应重新 Fetch 权威 payload |
| `generation_conflict` | `Aborted / true` | 相同 generation 对应不同当前事实；caller 从自己已知的冲突 generation 做 checked increment 后重读并重报当前事实 |
| `offset_conflict`、`offset_gap` | `Aborted / true` | 日志 offset 已变化，并附 `LogOffsetDetail` |
| `stale_generation` | `FailedPrecondition / true` | generation 过旧，并附 `StaleGenerationDetail` |
| `metadata_required`、`metadata_invalid`、`state_unavailable` | `FailedPrecondition / false` | 请求缺少有效 metadata，或当前生命周期不允许该动作 |
| `runtime_not_ready` | `Unavailable / true` | running 主状态已成立，但 credential/SSH/Endpoint 尚未收敛到 ready |
| `metadata_rebuilding` | `Unavailable / true` | 主状态有效，但当前节点的 Runtime Metadata cache 尚待 Manager 重建 |
| `log_size_exceeded` | `ResourceExhausted / false` | 普通日志已达到固定上限 |
| `internal_error` | `Internal / true` | 服务端无法保证本次命令是否执行 |

create 的 repository archived/empty/unavailable、ref not found 和 repo permission 等分类继续使用权限模型中定义的稳定名称；它们都属于 create 前置结果，不改变既有 codespace 的生命周期。访问判定 RPC 在 `denied` outcome 中使用同一分类字符串，不把正常拒绝转换成 Connect error。`UpdateOperation` 也使用自身 response oneof 表达 `stale_operation` 和 `resource_absent`；表中的 Connect `stale_operation` 只用于 `UpdateLog`、`ReportRuntimeTransition` 等其他 command RPC，避免同一 handler 在正常 outcome 与 Connect error 之间随机选择。

实现验收点：

- 同一失败条件在不同 handler 中返回同一 category、Connect code 和 retryable。
- UpdateOperation 的 lease/final/idempotent/stale/resource-absent 都通过 response outcome 返回；其他 command rejection 才使用 Connect error detail。
- `stale_generation` 携带当前 generation，`generation_conflict` 不携带 stale detail；日志 offset 冲突携带当前 offset，Manager 不解析 message 文本恢复。
- 未知内部错误统一为 `internal_error`，不会把数据库或 token 正文暴露给 caller。

### RegisterManager

- 将 registration token 兑换为 Manager identity 和 manager secret。
- 校验 `is_active=true`。
- Manager 的 `owner_id` 继承 registration token 的 `owner_id`；`owner_id=0` 表示 global，非 0 表示 Gitea owner 的 `user.id`。
- 数据库保存 manager secret 的 `secret_hash / secret_salt`。
- 只返回一次明文 manager secret。
- registration token 可复用，因此请求超时不能判断 Gitea 是否已创建 Manager。CLI 对 `RegisterManager` 的不确定超时不自动重试，而是提示管理员先在对应设置页检查 `last_online_unix=0`、即从未成功 Declare 的注册记录；确认后删除该记录，再重新执行注册。这样不增加 registration nonce 或幂等表，也不会因盲目重试产生多个身份。

实现验收点：

- 明确失败的注册不创建 Manager；成功注册只在响应中返回一次明文 secret。
- 注册响应超时后 CLI 不自动重试，管理页可以识别并删除从未 Declare 的注册记录。

### DeclareManager

- `DeclareManager` 提交 Manager 客户端当前配置和运行能力的完整快照，不是注册后不可修改的配置。客户端可修改并重新声明名称、版本、Gateway/SSH 地址、tags、SSH host key 信息、容量快照、backend capabilities 和 `manager_runtime_state`。
- 每次请求都携带完整字段；Gitea 校验成功后整体覆盖 `name`、`tags_json`、`runtime_state` 和规范化 `meta_json`。字段缺失或空值只按该字段自身规则校验，不表示“保持旧值”，因此不需要 PATCH、字段掩码或 declaration version。
- `manager_id`、`owner_id`、`created_by`、`admin_state`、secret verifier、inventory generation 和已有 Codespace binding 不由 Declare 修改。Manager secret 只通过 `RotateManagerSecret` 轮换，`admin_state` 只通过 Gitea 管理入口修改。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Declare 要么完整接受，要么完整拒绝；任一字段格式或地址唯一性校验失败时，不更新任何声明字段或 `last_online_unix`。其他 RPC 认证成功也不隐式恢复 online。超过 offline timeout 的 Manager 必须先按恢复流程 Declare recovering/online，才能领取 create/resume。
- response 返回当前 `admin_state=enabled|disabled`，使 Manager/Gateway 在 heartbeat 后立即执行本地管理态。
- Manager 周期调用 `DeclareManager`；心跳间隔小于 `MANAGER_OFFLINE_TIMEOUT / 3`。
- Manager 重启恢复期间通过 `DeclareManager` 上报 `manager_runtime_state=recovering`，恢复完成后上报 `manager_runtime_state=online`。
- `codespace_manager.runtime_state` 只保存 Manager 声明的 `online|recovering`；offline 根据 `last_online_unix + MANAGER_OFFLINE_TIMEOUT` 实时派生，不回写该字段。
- 首次 `recovering` 声明写入 `last_recovering_unix=now`；`recovering` 期间重复 `DeclareManager` 不更新该时间戳。
- `recovering -> online` 过渡时写入 `last_recovered_unix=now`；后续 `online` 期间重复 `DeclareManager` 不更新该时间戳。

心跳间隔小于 offline timeout 三分之一，是为了让一次短暂网络抖动或单次 heartbeat 延迟不会直接触发 offline，同时让 Gitea 能在数个心跳周期内发现真实离线。`recovering` 运行态让 Gitea 区分“Manager 正在维护恢复”和“Manager 完全不可达”，从而保留已有 codespace 主状态并暂停新的 create/resume 领取；`now-last_recovering_unix` 超过 `MANAGER_RESTART_GRACE` 后不再暂停 operation lease 超时，避免 recovering heartbeat 无限冻结 operation。

Declare 校验：

- `gateway_url` 使用 absolute `http://` 或 `https://` URL，只包含 DNS base domain 和可选 port，不接受 IP literal、userinfo、query、fragment 或非根 path。根 path `/` 在规范化后移除。站点可通过 `GATEWAY_REQUIRE_HTTPS` 要求 HTTPS；默认允许 HTTP，便于受信内网和开发环境部署。
- 规范化 `gateway_url` 在全部已注册 Manager 中唯一。首次声明或 URL 变化时，Gitea 取得 `codespace_manager_addresses` global lock 后按 `scheme + lower-case host + effective port` 检查冲突；相同 Manager 的未变化 heartbeat 直接复用现值。Endpoint host 不包含 `manager_id`，唯一 origin 保证 DNS 请求只到达持有对应 Runtime 映射的 Manager deployment。
- Gitea 从该 base domain 派生 `{uuid32}.{domain}` 和 `{endpoint_id}-{uuid32}.{domain}`，因此部署需要把 base domain 与单层 wildcard DNS 都指向 Gateway；HTTPS 证书需要同时覆盖 base domain 和单层 wildcard。
- `gateway_ssh_addr` 来自 Manager 当前配置，固定格式为 `host:port`；DNS host 转为小写，port 规范化为十进制且范围为 1-65535。规范化 `host:port` 在 Manager 间唯一，同 host 不同 port 可以分别使用。当前架构没有共享 SSH 路由层，唯一地址保证用户连接进入持有该 Codespace Runtime 映射的 Manager deployment。
- `gateway_ssh_host_key_algorithm` 非空，例如 `ssh-ed25519`。
- `gateway_ssh_host_key_fingerprint_sha256` 使用 OpenSSH SHA256 fingerprint 格式，例如 `SHA256:...`。
- `gateway_ssh_host_key_updated_unix` 是 Unix 时间戳。
- `name` trim 后长度为 1-255，`version` trim 后长度为 1-64；二者用于展示和诊断，不参与生命周期推进。
- tags 和 backend capabilities 都最多 64 个，每项 lower-case 后使用 `[a-z0-9_-]+`、长度为 1-64，并在规范化后去重。
- `0 < capacity_total <= 10000` 且 `0 <= capacity_available <= capacity_total`。10000 与完整 inventory/observed operation 的协议上限一致。

SSH 是 Manager 的必备能力。Web Endpoint 和 SSH 都属于 codespace 的交互入口，统一要求 Manager 声明 SSH 地址和 Gateway SSH host key 指纹，可以让 UI、权限判定、用户首次连接核对和 Gateway 部署健康检查有稳定能力基线。

实现验收点：

- Manager 修改可声明字段后，下一次成功 Declare 用完整新快照覆盖旧值；Gitea 不保存声明历史。
- tags 修改只影响之后尚未领取的 create；已有 binding、已领取 operation 和 stop/resume/delete 不重新匹配。
- 相同 Manager 的地址未变化 heartbeat 正常更新在线时间；地址冲突分别返回 `gateway_url_conflict` 或 `gateway_ssh_addr_conflict`，且不更新声明字段或在线时间。
- 首次或变更 Gateway/SSH 地址的 Declare 按全局地址 lock、Manager lock 的顺序整体校验，与 Manager 删除并发时只产生完整声明或记录不存在两种结果。
- 容量或 Runtime 总数超过 10000 时不进入 online 可领取状态。

### RotateManagerSecret

Manager 在本地把新 secret 保存为 pending 并保留当前 secret，随后使用当前 secret 认证调用该 RPC。Gitea 要求新 secret 是 32 个随机字节编码成的 64 位小写十六进制字符串，在同一事务内生成 16 字节 salt，并写入 `hex(SHA-256(salt_bytes || secret_bytes))`；成功提交后旧 secret 立即失效，`manager_id`、admin/runtime state 和 codespace binding 均保持不变。响应丢失时，Manager 先用 pending secret 调用 `DeclareManager`：成功则提升 pending；明确 unauthenticated 才表示服务端仍使用旧 secret，并允许重试同一个新值；网络或服务端临时错误只重试 pending 探测。该流程轮换现有身份凭据，不通过注册新 Manager 迁移绑定，也不生成第三个 secret。

实现验收点：

- 调用前后 `manager_id` 和 codespace binding 不变。
- 成功后旧 secret 无法认证，新 secret 可以认证。
- 请求重试不会生成服务端未知的第三个 secret。
- 响应丢失后 Manager 能用 pending/current 认证结果判定服务端是否已经提交轮换。

### FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。认证完成后，handler 取得调用方 `codespace_manager_{manager_id}` lock，并在整个请求期间持有；随后在锁内重新读取 Manager 的 admin/runtime state、heartbeat、tags 和 owner scope，再处理 running operation、queued claim 与 payload 构造。这样 Manager 删除和 owner 删除可以用同一 Manager lock 得到稳定的 binding 集合，同时仍保留每条 operation 的短事务边界。

`FetchOperations` request：

| 字段 | 说明 |
| --- | --- |
| `capacity_total` | Manager 总容量（仅用于本次领取判断，不写入数据库） |
| `capacity_available` | Manager 可用容量（仅用于本次领取判断，不写入数据库） |
| `accepted_operation_types` | 本次接受的新建类型：`create|resume`；stop/delete 不依赖该字段 |
| `max_operations` | 本次最多返回 operation 数量 |
| `observed_operations` | Manager 已持有的 `codespace_uuid + operation_rversion` |

Fetch 先处理已绑定当前 Manager 的 running operation，并先按下文规则检查 deadline 与 restart grace。允许继续处理时，enabled Manager 上报相同 `observed_operations` 版本只刷新 lease，并通过 `renewed_leases` 返回新 deadline，不下发 payload；未观察到或版本不同则重新下发并刷新 lease。disabled Manager 的 running stop/delete 仍按该规则恢复，running create/resume 只返回对应的 `abort_create|abort_resume` 空命令，不重发来源数据、不刷新 lease。然后再按以下优先级领取 queued operation：

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
- disabled 后已领取且未超过可恢复边界的 running create/resume 只返回对应 abort 命令，用于本地清理和 `final failed`

observed-only 续租返回 `renewed_leases[]`，每项只包含 `codespace_uuid + operation_rversion + lease_deadline_unix`。同一 UUID 在一次响应中只能进入 `operations` 或 `renewed_leases` 之一；abort 不续租，因此只进入 `operations`。

delete 和 stop 是资源回收动作，优先推进可以释放运行侧资源。resume 和 create 会占用容量，由 Manager 当前容量决定领取时机。resume 基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository。`operation_rversion` 绑定本次 Gitea 下发的 operation 版本，Manager 后续 operation-bound RPC 都用它校验归属。

Manager matching 沿用 Actions `runs-on` 的分层方式。Gitea 从认证后的当前 `codespace_manager.tags_json` 解析规范化标量列表，Fetch request 不重复提交 tags；create 候选查询按 operation 字段、`repo_tag IN manager.tags` 和 repository 当前 owner scope 筛选，global Manager 不加 owner 限制。`accepted_operation_types`、capacity 和最终状态在 Go 中判断。

最终 create claim 使用单条条件更新重新确认未绑定 queued create、当前 Manager enabled/online、`repo_tag` 仍属于最新 tags，并要求 `repo_id>0` 且 repository 记录仍存在；owner-scoped Manager 还要求该 repository 当前 `owner_id` 等于 Manager owner，global Manager 不限制 owner。并发 repository transfer 与 claim 以该语句看到的数据库顺序为准：claim 先成立时 binding 固定，transfer 先成立时旧 owner Manager affected rows 为 0。Fetch 已持有调用方 Manager lock，但 claim 本身不取得 repository 或 Codespace lock；`CreateCodespace` 记录插入事务、repository 删除和实际变更 owner 的 transfer 按外部变化章节使用 owner/repository lock。

`max_operations` 范围为 `1..256`，只限制 `operations`；`renewed_leases` 最多与 request 的 observed 数量相同，不占 payload 名额。`observed_operations` 最多 10000 条且 UUID 不得重复。每种优先级使用 `operation_created_unix, uuid` keyset 分页，按升序处理；单次 Fetch 在稳定 scope/tag 筛选后合计最多检查 1024 个 queued 候选，防止每增加一种 operation 类型都线性放大数据库读取。Manager 调用 Fetch 或续租的周期不超过 `OPERATION_LEASE_TIMEOUT / 3`。disabled Manager 不领取 queued create/resume；queued 和 running stop/delete 继续正常处理。abort create/resume 不续租，lease 先超时时 Gitea 已写入的 failed 与 Manager 随后提交的 `final failed` 幂等收敛到同一结果。

Fetch 在处理每条 running operation 时，于 Codespace lock 内先检查 `operation_deadline_unix` 和 Manager restart grace，再决定 observed 续租或 payload 重发。deadline 未到期时按普通规则处理；deadline 已到期但仍在有效 grace 时先条件写入新 deadline；Manager online 或 hard grace 已结束时执行 timeout State Finalization，不返回 payload 也不计入 `max_operations`。disabled create/resume 在 deadline 未到期或到期后仍处于有效 grace 时可返回一次性 abort 命令，但不写新 deadline；超过可恢复边界后同样直接 timeout。这与 UpdateOperation 和 Cron 使用同一条件更新边界，observed 批量续租不能恢复本应超时的 operation。

Fetch 对每个 queued 候选在 claim 前检查 `operation_created_unix + QUEUE_TIMEOUT`。已到硬截止时间的候选不得领取；handler 在 Codespace lock 内按 `codespace_uuid + operation_rversion + operation_status=queued` 条件执行 timeout State Finalization，然后继续本批其他候选。该项不计入 `max_operations`，未被 Fetch 遇到的过期记录仍由 reconciliation Cron 处理。

单次 Fetch 不持有覆盖整批操作的事务。running lease 刷新和每条 queued claim 都在各自短事务中条件更新；claim 提交后再构造 payload。只有 create repository/user 数据加载或 payload 构造失败会释放刚完成的 claim：服务在仍持有 Manager lock 时，以单独短事务按当前 `codespace_uuid + operation_rversion + manager_id + operation_status=running` 条件恢复 queued 和 operation 时间字段，create 同时恢复 `manager_id=0`。该候选失败会写服务端日志并继续处理同批后续候选。数据库连接等系统性错误、RPC 响应失败或响应丢失不释放已经提交的 claim；它保持 running，并由下一次 Fetch 重发 payload。每条 claim 独立提交与 Actions 领取任务的事务边界一致，也让响应丢失和中途故障使用同一种恢复路径。

实现验收点：

- 单次 `FetchOperations` 可返回多个 operation。
- 总返回数量不超过 `max_operations`。
- 本次新领取的 queued create/resume 数量不超过 `capacity_available`；running 恢复和 abort 不占新容量。
- running operation 重发不占 create/resume capacity，但计入 `max_operations`。
- enabled Manager 和 disabled stop/delete 已上报相同 `observed_operations` 版本时不重复下发完整 payload，而是返回 `renewed_leases` 回执。
- 上述仍在有效执行边界内的已观察 operation 由 Fetch 刷新 lease，续租回执不计入 `max_operations`；disabled create/resume 在 deadline 未到期或到期后仍处于有效 grace 时返回 abort 并计入 `operations`，超过可恢复边界时直接 timeout。
- timeout、payload 重发和 abort 都不进入 `renewed_leases`；Manager 不能把缺少续租回执解释为 operation 已清除。
- running operation 在 observed 续租或 payload 重发前检查 deadline；非 grace 的过期项直接 timeout，不进入 response。
- 领取通过数据库条件更新完成；affected rows 为 0 时继续尝试下一个候选。
- 遇到过期 queued 候选时条件写入 timeout 结果，不领取、不计入 `max_operations`，且不阻断同批其他候选。
- Fetch tags 只来自认证 Manager 最新 `tags_json`；客户端修改 tags 并成功 Declare 后，下一次候选查询和 claim 使用新值。
- create claim 条件更新重新确认 repository 存在和当前 owner；与 transfer 并发时只产生 transfer 前成功绑定或 transfer 后旧 scope 领取失败两种结果。
- 每条领取在自己的短事务中写入 `operation_status=running`、`operation_started_unix`、`operation_deadline_unix`；create 领取额外写入 `manager_id`。
- 领取不递增 `operation_rversion`。
- 普通 running operation 重发不执行 claim、不递增版本，但刷新 `operation_deadline_unix`；abort 不刷新。
- disabled 后已领取且未超过可恢复边界的 create/resume 返回 abort 命令且不刷新 lease，不会重新启动初始化或恢复；超过边界时不再返回命令。
- stop/delete 在 Manager 满载时仍可领取。
- 并发领取时只有一个 Manager 成功。
- Fetch 从重新读取 Manager 到完成 claim、payload 构造或条件释放始终持有调用方 Manager lock；Manager/owner 删除取得同一 lock 后重新查询，因此删除提交后不会遗留指向已删除 Manager 的 binding。
- payload 构造失败的 operation 会被条件释放，且不会覆盖已经被替换的 operation；系统故障留下的 running claim 由下一次 Fetch 重发。
- 单条候选构造失败不会丢弃同批其他成功 operation；系统性事务错误不会返回部分未知结果。
- 系统性错误不返回 response；已提交 claim 和事务提交后响应丢失都由下一次 Fetch 重发 running payload。
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

renew 和首次 final 在写入前直接检查 `operation_deadline_unix`。处于有效 restart grace 的绑定 Manager 可用当前版本的首次 Fetch、renew 或 final 原子恢复 lease，再继续本次请求。online 或已超过 hard grace 时，handler 发现当前版本 `now >= deadline` 且 Cron 尚未处理，就在 Codespace lock 内立即按 timeout 写 failed、吊销 token 并清空 operation；随后 `final failed` 返回 `idempotent_done`，renew 或 `final done` 返回 `stale_operation`。该判断与 Cron 使用相同条件更新，先成功的 final、续租或 timeout 生效，后到请求按最新状态返回幂等或 stale outcome。

Manager 为 enabled 时按正常规则接受续租和 final。Manager 在 operation 领取后被 disabled 时，stop/delete 仍按正常规则完成；create/resume 只允许追加清理日志和提交 `final failed`，拒绝 done 和续租。该规则让已开始的新建工作立即回收并收敛为 failed，同时不阻塞已有资源的 stop/delete。

final 必须携带 Manager 本地保存的原始 `operation_type`。active operation 仍存在时该类型必须与数据库一致；当前版本匹配但有效类型不同时返回 `outcome.stale_operation`，Manager 清除错误 worker 并在下次 Fetch 省略 observed 声明以重取权威 payload。`UNSPECIFIED` 和未知枚举返回 `invalid_argument`。active operation 已清空后，Gitea 只能按相同版本和请求映射出的目标主状态判断幂等，不能再证明原类型。create/resume done 都映射 running，stop done 映射 stopped，任意 failed 映射 failed；该目标状态幂等语义使设计不需要保存 operation 历史。abort create/resume 仍分别携带本地原始类型。

resume final done 后，Gitea 不保留 operation；Manager 继续持有当前 `credential-refresh` boot 上下文，直至 token、Runtime credential 和 `ready` metadata 完成。该后置步骤可跨 Manager 重启恢复，最新 boot 终态结果继续保留用于 Runtime API 幂等重试。确认无法写入 credential 时，Manager 停止 Runtime 并通过 `ReportRuntimeTransition(stopped)` 把 running 收敛回 stopped。

状态写入：

| operation | done | failed |
| --- | --- | --- |
| `create` | `status=running, keep token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `resume` | `status=running, last_active_unix=now, clear active operation`（`stopped_unix` 不清零） | `status=failed, revoke token, clear active operation` |
| `stop` | `status=stopped, stopped_unix=now, revoke token, clear active operation` | `status=failed, revoke token, clear active operation` |
| `delete` | 物理删除 codespace、token、日志和绑定数据 | `status=failed, revoke token, clear active operation` |

Manager 负责报告 Gitea-issued operation 的动作结果，Gitea 负责把结果写成主状态、token 生命周期绑定和日志追加窗口。State Finalization 在同一事务内完成这些写入，保证用户看到一致的生命周期结果。operation 完成后不保留 `done|failed` 状态，失败诊断从 codespace 日志读取。

State Finalization 首次改变生命周期结果时写 `updated_unix=now`；创建或替换 active operation 也更新该字段。claim、lease 续租、日志、Runtime Metadata、token 读取或修复、open、SSH 和相同结果的幂等重试不更新它，repository 删除仅把 `repo_id` 写为 0 时也不更新。这样 `updated_unix` 可以稳定表达生命周期变化，并作为 failed retention 起点，而不会被调度或交互活动延后。

State Finalization 主事务提交后，仍保留 Codespace 记录的结果在释放该 Codespace keyed lock 前尽力追加内部状态摘要。摘要由独立的 DBFS 追加事务保证内容与日志元数据共同提交；摘要失败只记录服务端日志，不回滚主状态。delete done 已经物理删除记录和日志，直接跳过摘要；force/account/Manager delete 与 retention 清理同样不能重新创建日志。

实现验收点：

- renew lease 只刷新 deadline；boot stage 由 Runtime Metadata 和日志表达。
- final result 触发一次 State Finalization。
- 首次 final 返回 `outcome.final_accepted`。
- final 的有效 operation 类型与当前同版本 active operation 不一致时返回 stale outcome，非法枚举返回 invalid argument；active 已清空时按相同版本和请求目标主状态稳定返回幂等或 stale outcome，不声称恢复原类型。
- 重复 final 同一 `operation_rversion` 且主状态已匹配目标结果，返回 `outcome.idempotent_done`。
- 过期 `operation_rversion` 或主状态不匹配，返回 `outcome.stale_operation`，当前主状态保持稳定。
- State Finalization 同事务处理主状态、active operation 清空和 token 生命周期绑定；active operation 清空后日志追加窗口关闭。
- `updated_unix` 只在创建记录、创建或替换 active operation 和首次状态结果变化时更新；claim、续租、交互、metadata、日志、token 修复、幂等结果和 `repo_id` 置 0 不刷新该字段。
- 保留 Codespace 记录的结果在主事务提交后、释放 Codespace lock 前单独追加内部摘要；物理删除跳过摘要，摘要失败不回滚已经接受的 final。
- deadline 到期后的 online renew/final 在请求路径立即触发 timeout；final failed 返回幂等，renew/final done 返回 stale。restart grace 内当前版本可恢复，且与 Cron 并发时只有一个条件更新生效。
- codespace 已物理删除时返回 `outcome.resource_absent`；worker 清除本地 operation 上下文并停止上报，delete worker 幂等结束。Gitea 不借此要求 Manager 删除 Runtime；UUID 不复用，也不保存 operation 历史或 tombstone。
- disabled 后已领取的 create/resume 只能 final failed，已领取或新领取的 stop/delete 可以正常完成。

### UpdateLog

- 写入 DBFS 路径 `codespace_log/{codespace_uuid}.log`。
- Gitea 服务层可为完整 failed 对象和 operation 最终状态通过内部入口写入失败或 warning 摘要；Manager operation payload 携带当前 `log_offset`。
- request 使用结构化 `LogLine(timestamp_unix_nano, message)`；Gitea 脱敏后统一编码为 UTF-8 `[RFC3339Nano] message\n`，offset 按编码后的完整字节计算。
- 校验 `codespace_uuid + operation_rversion + manager_id` 匹配当前 running operation。
- offset 等于当前日志大小时追加。
- offset 小于当前日志大小时，只有规范化后的完整请求段已经全部存在且逐字节相同时才是幂等重放；请求段只与文件尾部分重叠时返回 offset conflict 和当前文件末尾，不追加剩余部分。
- offset 大于当前日志大小时返回 offset gap 分类，保持日志文件连续。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许当前 `operation_rversion` 对应的 running operation 追加日志。
- active operation 清空后，日志进入封闭状态。
- 单行最大长度由 `LOG_MAX_LINE_SIZE` 控制。
- 日志总大小由 `LOG_MAX_SIZE` 控制。普通日志可用上限为 `LOG_MAX_SIZE-LOG_FINAL_SUMMARY_RESERVE`，超过后返回 log size exceeded 分类并写入明确截断摘要。
- 服务端固定预留 `LOG_FINAL_SUMMARY_RESERVE`；达到普通日志上限后拒绝原始行，但内部最终摘要仍可写入预留空间。
- keyed lock 内发现普通 batch 将使当前文件首次跨过普通日志上限时，只写一条截断摘要；文件已经达到上限后的普通行直接返回 `log_size_exceeded`，不再写摘要。截断摘要和最终摘要共同受 `LOG_MAX_SIZE` 硬上限约束。
- Manager 在 final 前先上传 operation 最终摘要。对于仍保留 Codespace 记录的结果，Gitea 在 State Finalization 主事务提交后、释放 Codespace keyed lock 前使用剩余预留空间尽力追加内部状态摘要；该 DBFS 追加事务失败或预留耗尽时只记录服务端日志，不回滚生命周期状态。物理删除路径跳过摘要并删除整份日志。
- 成功追加和内容一致的幂等重放都返回服务端当前 `next_offset`；该值是脱敏和规范化编码后的真实文件末尾。
- offset conflict/gap 返回 `CodespaceFailureDetail` 和 `LogOffsetDetail(current_offset)`；Manager 从服务端位置恢复，不根据本地原始 message 估算 offset。

日志使用 byte offset 而不是行号作为写入幂等键，是因为 DBFS 提供 seek/write 能力，Manager 重试时可以精确重放同一段内容。offset gap 分类可以保证 UI tail、下载和后续清理都面对连续文件，不需要处理缺失片段。

实现验收点：

- 成功追加和相同内容幂等重放都返回真实 `next_offset`。
- 服务端脱敏改变字节数时，Manager 下一次追加仍使用 response offset 并成功连续写入。
- offset conflict/gap 携带 `LogOffsetDetail.current_offset`，且不产生不连续文件。
- 达到普通日志上限后只写一条截断摘要，重复请求不消耗最终摘要预留空间。
- 部分重叠的重放不会补写尾部；内部状态摘要写入失败不回滚已经提交的 State Finalization，物理删除不会重新创建日志。

### ReportRuntimeMetadata

- 只写 [Runtime Metadata](glossary.md#runtime-metadata) 到 Gitea cache。
- Gitea 接受请求时写入 `last_reported_unix=now`；该字段不由 Manager 提交，也不参与内容 hash。
- request 携带 `metadata_generation`；高于 cache 当前版本时覆盖，相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回 generation conflict 且不附 stale detail，更低版本返回 stale 和当前版本。cache miss 接受 Manager 重建的正 generation 快照。Manager 对 stale 使用服务端当前值加一，对 generation conflict 使用请求中的已知值加一；两者都重新读取本地当前快照并持久化新 generation 后上报。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`，不匹配时返回 `manager_mismatch`。
- 只接受 `creating|running|stopped` 状态写入。
- Manager 必须为 enabled；disabled 优先于 recovering，返回 manager disabled 分类。
- Manager 必须声明为 online 或处于有效 recovering 窗口；heartbeat 已派生 offline 时返回 `manager_offline`。
- `deleting|failed` 状态或旧 boot operation 版本返回 `stale_operation`。
- stale 上报不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- Manager 周期刷新间隔不超过 cache TTL 三分之一；相同 generation、相同内容的刷新同样延长 TTL。
- `stopped` 状态下 Runtime Metadata 只用于展示保留资源信息，不提供 open 或 SSH。
- metadata 顶层和 `boot` 使用固定字段；`boot.operation_rversion` 必填。active create/resume 要求该值等于当前 operation；没有 active operation 时不能大于 codespace 当前版本。未知字段被拒绝。`endpoints` 始终存在，没有声明时为空数组；`internal_ssh` 在 `boot.stage=ready` 时必须完整。
- create operation 只有在当前 metadata 的 boot 版本等于当前 create 且 `stage=ready` 时可 final done。resume final done 要求 boot 版本等于当前 resume、stage 为 `credential-refresh` 且 generation 高于此前 cache 快照；主动 running transition 要求 boot 版本等于 `observed_operation_rversion`。旧 `ready` 快照不能完成恢复；新的 open/SSH 在后续相同 boot 版本、更高 generation 的 `ready` 快照到达前返回 `runtime_not_ready`。
- Manager 启动后为所有仍由自己持有且处于 `creating|running|stopped` 的 codespace 重建 Runtime Metadata cache。
- Manager 运行期间周期刷新 active codespace 的 Runtime Metadata cache，避免 cache miss 后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 open/SSH 的 ready、普通 Endpoint existence、internal SSH 和 UI 展示。resume 不读取该 cache；主状态校验基于数据库 `codespace.status`，与 cache 信任无关。

Runtime Metadata 是运行时信息，变化频繁，也可以由 Manager 重建，因此放在 cache 中。主状态和权限判断继续使用数据库字段。

实现验收点：

- Runtime Metadata 成功写入 cache。
- `running` 交互入口同时依据主状态、Manager 在线态和 Runtime Metadata。
- Gitea cache 丢失后由 Manager 重建 Runtime Metadata。
- 相同 generation、不同内容被拒绝，相同内容的重试和周期刷新幂等延长 TTL。
- metadata generation stale 与 conflict 分别按服务端当前值和请求已知值升代，并重读当前完整快照；版本耗尽时进入 recovering。
- 错误 Manager、旧 operation、disabled、offline、低 generation 和同 generation 不同内容分别稳定返回 `manager_mismatch`、`stale_operation`、`manager_disabled`、`manager_offline`、`stale_generation` 和 `generation_conflict`。
- ready 快照缺失完整 internal SSH、固定 boot 字段或包含未知字段时被拒绝，且 create 不能提前 final done。
- resume 必须先接受绑定当前 operation 版本的新 `credential-refresh` generation，进入 running 后再接受同 boot 版本、更高 generation 的 `ready`。
- resume final 清空 active operation 后，`credential-refresh` boot session 仍可上报同版本的更高 generation ready 快照；ready 接受前 open/SSH 返回 `runtime_not_ready`。

### ReportRuntimeTransition

`ReportRuntimeTransition` 用于 Manager 在没有 Gitea-issued active operation 时上报本地主动 running、stopped 或不可恢复的 failed 事实。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | Runtime 对应 codespace UUID |
| `runtime_generation` | Manager 对该 codespace 主动运行事实的单调版本 |
| `observed_operation_rversion` | Manager 产生该事实时观察到的最新 Gitea operation 版本 |
| `fact.running` | running 事实以及完整 `metadata_json + metadata_generation` |
| `fact.stopped` | stopped 事实，不携带 Runtime Metadata |
| `fact.failed` | 单 Codespace 已确认不可恢复的事实，不携带原因或时间 |

接受规则：

| 当前状态 | Manager fact | 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped`、写 `stopped_unix=now`、吊销 token |
| `stopped` 且无 active operation | `running` | 先写入 `credential-refresh` Runtime Metadata，再写 `status=running` |
| `running/stopped` 且无 active operation | `failed` | 写 `status=failed` 并吊销 token，提交后尽力清除交互 cache；不伪造停止时间 |
| `running/stopped` 且有 active operation | 任意 | 返回 `current_operation_conflict` |
| `failed` 且相同 generation 的 `failed` 重试 | `failed` | 目标状态已收敛，幂等成功，不刷新 `updated_unix` |
| `creating/deleting`，或 `failed` 收到 running/stopped | 任意 | 返回 `stale_operation` |
| Manager disabled 且无 active operation | `stopped` | 允许 |
| Manager disabled 且无 active operation | `failed` | 允许 |
| Manager disabled | `running` | 返回 `manager_disabled` |

校验顺序固定为：读取 codespace 并检查 `manager_id` binding；检查 active operation conflict；检查 Manager admin/runtime state；检查 `observed_operation_rversion`；检查 `runtime_generation`；检查主状态与 fact 是否兼容；running fact 最后校验并规范化 metadata。enabled Manager 在 online 或有效 recovering 期间可以提交三种 fact；disabled Manager 在这两种运行态下只允许 stopped/failed；已派生 offline 的 Manager 先 `DeclareManager(recovering)` 再上报。主动 running fact 必须携带 `stage=credential-refresh`、`boot.operation_rversion=observed_operation_rversion` 的新 metadata generation。`ReportRuntimeTransition` 不递增 `operation_rversion`，因为它不是 Gitea 下发的 operation。

runtime generation 只保存当前值，因此幂等以 running/stopped/failed fact 映射的目标主状态为准：低于当前值返回 `stale_generation`；等于当前值且目标状态已成立时幂等成功；等于当前值但目标不同时返回 `generation_conflict`；高于当前值时只在状态转换合法时写入。已处于 failed/creating/deleting 等不兼容状态时，更高 generation 返回 `stale_operation`，不改写当前 generation。

running fact 在 Codespace lock 内先幂等写入或验证 metadata cache，再提交 `status/runtime_generation` 数据库事务；cache 写入失败时不提交数据库，数据库失败时 stopped 主状态继续阻止交互。相同 generation 的 running 重试必须补写或验证 metadata，不能只因数据库主状态已经 running 而跳过。stopped/failed fact 先提交主状态、runtime generation 和 token 事务，随后尽力清除 Runtime Metadata 与未消费 Open Token；清理失败只写服务端日志，不能回滚已提交结果或恢复交互权限。响应丢失后的相同 fact 按数据库目标状态幂等成功，并可再次尝试清理。failed fact 首次提交时写 `updated_unix=now`，幂等重试不刷新该字段，并通过内部日志入口追加固定摘要；详细原因只写 Manager 本地日志。

主动 running 被接受后，绑定 Manager 才可通过 `RequestGiteaToken` 取得 stopped 阶段已经吊销的新 token，刷新 Runtime credential，再用同一 boot 版本和更高 metadata generation 上报 `ready`。ready 前交互返回 `runtime_not_ready`；credential 确认失败时停止 Runtime，并以更高 runtime generation 上报 stopped。该过程不创建 operation，也不更新 `last_active_unix`。

Manager 主动 transition 不更新 `last_active_unix`；该字段只记录用户 resume final、成功消费 open code 和成功 SSH 认证。failed fact 不表示 Runtime 已停止，因此从 running 进入 failed 时不写 `stopped_unix`。

Manager 在 failed fact 前关闭 session，取消 pending metadata/Endpoint mutation 和后置 worker。请求被首次接受或按目标状态幂等成功后，Manager 可立即停止并删除本地 Runtime；清理失败时继续在 inventory 中上报 failed，由 failed 主状态返回 `cleanup_local_runtime`。未知 UUID 和 `resource_absent` 仍不构成本地删除授权。

Manager 处理 transition Connect error 时不重试无法成立的原请求：`current_operation_conflict` 转为 Fetch 当前 operation；`stale_operation` 转为完整 inventory 调和；`stale_generation` 按 detail 的当前值加一并重新读取 backend 事实；`generation_conflict` 在已知的相同 generation 上加一，仅重报仍为当前值的事实；`manager_disabled` 拒绝 running fact 时停止 Runtime 并改报 stopped；`manager_offline` 先 Declare recovering 后重建当前事实；`codespace_not_found` 停止该 Codespace 的后续上报，`manager_unregistered` 停止全部 Gitea 通信，两者都不清理 Runtime。这些分支只使用现有 error category、Fetch、Declare 和 inventory，不增加响应字段。

实现验收点：

- transition 请求不携带不参与判定的观察时间和原因字段。
- 主动 running 只接受 `credential-refresh` metadata，随后 token/credential/ready 收敛完成前不提供交互。
- disabled Manager 可提交 stopped/failed fact，running fact 返回 manager disabled。
- enabled Manager 在 online/recovering 可提交三种 fact，offline Manager 必须先 Declare recovering。
- 相同 generation 以目标主状态幂等收敛，目标不同时返回 generation conflict，不需要保存 fact 历史。
- operation 上下文、runtime generation 和 running metadata 任一不满足时均不改主状态。
- running fact 重试可修复丢失的 metadata cache；stopped/failed 的数据库结果不依赖 cache 清理成功，残留 cache 也不能绕过数据库状态复检。
- failed fact 只从无 active operation 的 running/stopped 生效，吊销 token 且相同请求重试不刷新 failed retention 起点。
- failed fact 成功后本地 Runtime 可立即清理，未完成清理由 failed inventory instruction 继续收敛。
- transition 被 operation conflict、stale operation、generation stale/conflict、Manager disabled/offline 或 Codespace/Manager 记录缺失拒绝时，Manager 按固定分支转入 Fetch、inventory、Declare、新 generation、stopped 或停止上报。
- 多个条件同时不满足时仍按固定校验顺序返回同一失败分类。

### RequestGiteaToken

- 允许绑定 Manager 在 `status=creating|running` 工作状态申请当前 Git 凭据。
- 调用方 Manager 必须与 `codespace.manager_id` 匹配、enabled，且已声明为 online 或处于有效 recovering 窗口。recovering 允许恢复已绑定 Codespace 的当前凭据，既包括 active create，也包括 resume final 或主动 running fact 后已无 active operation 的 `credential-refresh`；它不允许领取新 create/resume。
- `codespace.user_id` 必须解析到创建用户；正常账户删除事务会先物理删除关联 codespace，若发现悬空引用则按数据库一致性错误拒绝并交由服务端日志排查，不签发 token。
- `creating` 要求 create operation 已被该 Manager 领取，用于首次 clone/checkout。
- `running` 在没有 active operation 或当前是绑定 Manager 已领取的 stop operation 时允许；stop worker 只可重新取得已经存在的 token 明文以恢复日志 mask set，token binding 为空时返回 `state_unavailable` 而不在停止过程中签发新 token。delete 已把主状态改为 `deleting` 并吊销 token，因此不会通过该分支取回凭据。
- `credential-refresh` worker 收到 `manager_disabled` 时把它视为确定性不可继续：取消后置工作、停止 Runtime，递增 runtime generation 并上报 stopped；停止确认失败时改报 failed。`manager_offline` 要求先 Declare recovering 再重试；`codespace_not_found|manager_unregistered` 终止后置通信但不删除 Runtime；更高 stop/delete operation 已存在时由 active operation 接管。
- `status=stopped|failed|deleting` 返回状态不可用。
- `repo_id=0` 时仍可签发 token；后续 Git HTTP(S) 访问因 repo binding 不匹配而拒绝所有 repository。
- `gitea_token_id>0` 时直接返回保存的 `gitea_token` 明文。
- `gitea_token_id=0` 时以固定名称 `codespace-{完整 codespace_uuid}` 和 `write:repository` scope 签发新 access token，写入非零 `gitea_token_id` 和 `gitea_token`，再返回明文。固定 UUID 名称不会因 repository 或展示名称变化而改变，也便于现有 PAT 列表识别来源。
- token ID/明文不成对，或 access token row 已不存在时，生命周期服务锁定 codespace 行：非零 token ID 对应的 row 仍存在时先通过生命周期专用入口删除，再原子写回 `0 + 空字符串`；仅在当前为工作状态且创建用户仍存在时重新签发。该顺序避免旧 token 在失去 codespace binding 后变成普通 PAT。
- 同一 `codespace_uuid` 的请求、生命周期吊销和 reconciliation 使用同一个 keyed lock；锁内重新读取 codespace，并在一个数据库事务中完成旧 token 清理、access token 创建和 token pair 写入。并发请求因此只会创建并返回同一个有效 token，stop/delete 也不会在签发提交后遗漏吊销。
- `[codespace] ENABLED=false` 时不签发或修复 token。create、普通 running 和 `credential-refresh` 请求返回 `state_unavailable`；仅当前已领取 stop operation 的 running Codespace 可以取回数据库中已经成对存在的 token，用于 Manager 重建日志脱敏集合。该分支在 binding 为空或损坏时同样返回 `state_unavailable`，不会生成新凭据。

实现验收点：

- 功能启用时，creating/running 且创建用户存在的有效请求返回当前 token 或在空 binding 上签发一个新 token；running stop 只可读取现有 token，不会签发或轮换。
- recovering Manager 可为已绑定 Codespace 的 active create 或无 active operation `credential-refresh` 恢复凭据，不因 resume operation 已清空而拒绝。
- credential-refresh 的 disabled、offline、记录缺失和更高 operation 分别收敛到 stopped/failed、Declare recovering、停止通信或 active operation 接管。
- 悬空 `user_id` 不创建 access token row；账户删除正常路径不会留下可调用该 RPC 的 codespace。
- 损坏 pair 修复后旧 token row 不存在，codespace 最多绑定一个新 token。
- 并发 Request、stop/delete 和 reconciliation 后，数据库中至多存在一个被该 codespace 引用的有效 token，字段 pair 不出现半写入。
- 新 token 的名称固定为 `codespace-{完整 codespace_uuid}`，scope 固定为 `write:repository`。
- 排空模式下 create、credential-refresh 和普通 running 请求不会签发或返回 token；running stop 只能读取已经存在且完整的 token pair，用于日志脱敏。

### ValidateOpenToken

- Gateway 提交 authorization code，Gitea 校验并消费该 code 后返回 open binding。
- response 使用互斥 outcome：成功返回 `allowed(user_id, codespace_uuid, endpoint_id, manager_id)`，访问拒绝返回 `denied(category, retryable)`，不同时返回无意义的零值 binding 和失败字段。
- 校验过程遵循 OAuth2 Authorization Code Grant 模式：Gitea 作为 Authorization Server，Gateway 作为 Client（以 Manager 身份认证，代替 OAuth2 标准的 client_id/client_secret）。
- 验证时执行运行时检查（codespace 状态、用户权限、有效 Endpoint），而非仅检查 code 是否有效。Runtime Metadata 必须 ready；普通 Endpoint 还必须仍在当前 metadata 中，`workspace` 不要求 endpoints 数组存在同名项，实际连接 Runtime 同名 Endpoint 还是默认 Web SSH 由 Manager 决定。
- 成功消费 code 并建立 open binding 后尽力更新 `last_active_unix=now`。该字段只用于展示和清理参考，更新失败记录服务端日志但不把已经通过的访问改成 denied。

### VerifySSHPublicKey

- Gateway 调用，Gitea 校验用户身份和访问权限后返回本次认证结果。
- 认证成功后尽力更新 `last_active_unix=now`；更新失败记录服务端日志并仍返回 allowed。

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
- Runtime Metadata 存在且 `boot.stage=ready`，`internal_ssh` 完整。
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
- Runtime Metadata 仍存在且 `boot.stage=ready`。
- request 选择普通 `endpoint` binding 时，metadata 中仍存在 `endpoint_id`；`endpoint_id=workspace` 时不要求 endpoints 数组存在同名项。
- request 选择 `ssh` binding 时，internal SSH metadata 仍完整可用。

该接口通过互斥 outcome 返回空的 `allowed` 或带 `category + retryable` 的 `denied`，只表达当前访问判定，不消费 Gateway Open Token、不写主状态、不记录访问历史。Gateway 仅在收到明确 `allowed` 时保留 session；`denied`、超时、Connect `Unavailable|Internal`、响应解析失败和连接错误都立即关闭本地 session。revalidate 是持续授权边界，失败关闭比在无法确认权限时继续开放更符合当前状态模型。成功 revalidate 不更新 `last_active_unix`；用户实际发起 open 或 SSH 认证时已经完成访问判定，并单独尽力记录活跃时间。

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
| `instances[].runtime_state` | `creating|running|stopped|failed` |
| `instances[].observed_operation_rversion` | Manager 看到的本地 operation 版本 |

`ReportInstances` 始终上报 Manager 持有的完整 Runtime 集合，包括 creating 资源和 stopped 的可恢复 workspace、volume 或实例。Manager 只在 backend 全量枚举和所有状态读取均成功后提交；任一分页、连接或状态读取失败时不发送本轮快照，也不递增 generation。第一版不提供增量或 incomplete 模式；单个 Manager 最多管理 10000 个带其 label 的 Runtime，单次最多 10000 个实例且 UUID 唯一。超限时 Manager 保持 recovering、声明可用容量 0，不发送截断快照。`observed_operation_rversion=0` 明确表示本地没有 active operation 上下文。

`inventory_generation` 高于当前版本时执行差异写入并更新版本；相同 generation、相同规范化快照时不重复已经完成的条件状态写入，但必须根据请求中的完整快照和当前数据库状态重新计算 instruction，保证首次响应丢失后可以恢复；相同 generation、不同快照返回 generation conflict 且不附 stale detail；更低版本返回 stale 和当前版本。stale 时 Manager 使用服务端当前值加一，同代冲突时使用请求中的已知值加一；两种情况都重新完整扫描 backend、持久化新 generation 后提交当前快照。`runtime_state=creating` 只证明已有稳定 Runtime identity，`runtime_state=failed` 只证明 identity 仍存在但 Manager 已确认不可恢复，两者都不直接驱动主状态变化。running/stopped 分歧和无 active operation 的 failed inventory 通过 `ReportRuntimeTransition` 完成；有 active operation 的 failed inventory 先 refetch，再由 `UpdateOperation(final failed)` 收敛。

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
| Gitea 中无记录的 reported runtime | 不返回 instruction；Gitea 不保存删除墓碑，不能据未知 UUID 发出破坏性动作 |
| Gitea 中有记录且 binding 指向其他 Manager，或主状态为 failed | 返回 `cleanup_local_runtime` instruction，主状态保持稳定 |
| Gitea 为未绑定 creating，Manager 已有同 UUID Runtime | 不返回 cleanup；等待当前 create 被领取或 queue timeout |
| reported `observed_operation_rversion` 与 Gitea 当前 active operation 版本不同 | 返回 `refetch_operation(current_operation_rversion)`，该实例本轮不驱动主状态写入；Manager 在下一次 Fetch 省略该 observed 项以取得当前 payload |
| Manager 以非零 observed version 报告了 operation 上下文但 Gitea 当前没有 active operation | 返回 `clear_operation_context(current_operation_rversion)`；Manager 仅在本地 worker 版本不高于该值时清除上下文并保留 Runtime |
| enabled Manager 上报的 running/stopped 与无 active operation 的 `running/stopped` 主状态不一致 | 返回 `report_runtime_transition(current_operation_rversion)`，由 Manager 使用该版本携带新 generation 上报事实；reported creating 只作为存在证据 |
| 已绑定当前 Manager 的 Runtime 上报 failed，Gitea 为 running/stopped 且无 active operation | 返回 `report_runtime_transition(current_operation_rversion)`；Manager 用该版本提交新 generation 的 failed fact |
| 已绑定当前 Manager 的 Runtime 上报 failed，Gitea 仍有 active operation | 无论 observed 版本是否相同，都返回 `refetch_operation(current_operation_rversion)`；Manager 恢复权威 payload 后使用 `UpdateOperation(final failed)` |
| disabled Manager：Gitea running、Runtime stopped | 返回 `report_runtime_transition(current_operation_rversion)`，只允许上报 stopped |
| disabled Manager：Gitea stopped、Runtime running | 返回 `stop_local_runtime(current_operation_rversion)`；Manager 仅在本地版本不高于该值时停止 Runtime，Gitea 主状态保持 stopped |
| missing `creating` runtime | active create deadline 未到期，或绑定 Manager 仍在有效 restart grace 时保持 creating；active operation 缺失或 hard grace 结束时进入 `failed` |
| missing `running` runtime | 记录 divergence，进入 `failed` |
| missing `stopped` runtime | 进入 `failed`，因为已经无法 resume |
| missing `deleting` runtime | 接受 cleanup 完成，物理删除 codespace |

数量差异来自 Gitea 记录和 Manager 本地 Runtime 列表不同。Gitea 用数据库主状态判断哪些 Runtime 应该存在，Manager 用快照报告本地实际列表，最后由 Gitea 返回处理指令。Gitea 对同一 Manager 使用 keyed lock 串行接受 generation：先用短事务校验并写入 `inventory_generation/inventory_hash`，再按 UUID 分别执行条件状态事务。单个 UUID 失败不回滚其他已提交项；请求返回可重试错误，Manager 使用同一 generation 和规范化快照重试，Gitea 从当前数据库状态继续计算。每个 UUID 最多返回一个 action，优先级为 `cleanup > refetch > clear > stop > report transition`。

实现验收点：

- Gitea 按 `manager_id` 查询 expected。
- Manager 上报完整快照后计算 extra/missing。
- backend 枚举或状态读取不完整时 Manager 不递增 generation，也不调用 `ReportInstances`。
- Manager 超过 10000 个 Runtime 时不提交截断快照，并保持 recovering、容量为 0。
- 相同 generation 的相同快照可以重获 instruction，不重复执行状态写入；不同快照被拒绝。
- operation 版本不一致或 failed inventory 遇到 active operation 时只返回 refetch instruction，不使用 Runtime inventory 直接改写主状态。
- `refetch_operation` 只用于当前存在 active operation 的记录；无 active operation 时明确返回 `clear_operation_context`，Manager 不从空 Fetch 响应推断清理。
- running/stopped 分歧和 failed inventory 的 `report_runtime_transition` 始终返回当前 operation 版本，本地版本基线丢失后仍可安全上报 fact。
- 延迟到达的 clear instruction 可清除该版本及更早的旧上下文，但不能清除本地已经替换为更高版本的 operation。
- disabled Manager 不会收到要求上报 running fact 的 instruction。
- 无记录 UUID 和未绑定 creating 不返回 instruction；只有当前 binding 冲突或 failed 状态才返回 cleanup。
- failed inventory 只对已绑定当前 Manager 的记录返回 refetch 或 transition，不向未绑定 creating 下发 payload 或版本。
- missing runtime 按当前主状态处理；有效 restart grace 内的 active create 不因启动恢复时的空 inventory 提前失败。
- 旧 inventory generation 不触发 extra/missing 或主状态写入。
- 同一 Manager 的并发 inventory 被串行化；相同 generation 重试能继续处理未完成项，且每个 UUID 只返回一个最高优先级 action。

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
| `command.abort_create/abort_resume` | Manager disabled 后已领取且未超过可恢复边界的 running create/resume | 不重发执行数据；Manager 清理本轮 Runtime 工作并 final failed |
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
- Codespace delete operation 清理 Runtime 时只依赖 `codespace_uuid` 的本地确定性映射；这与直接删除 Manager 记录是两条独立流程。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- Runtime Instance ID、Runtime Instance name、镜像、资源、backend、mount、network 和 Endpoint port 均由 Manager 独立决定；Endpoint host 固定从所属 Runtime identity 解析，公开 path/query 原样转发到 upstream 根路径。
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
- 普通 Gitea PAT 通过 Basic password、Bearer header 或 `access_token` query 认证成功后，认证分支除写入现有 `IsApiToken/ApiTokenScope` 外，还把实际 token ID 作为 `AccessTokenID int64` 写入 request context。OAuth2 access token、Actions token/JWT、登录 session、reverse proxy 身份和 SSH 身份不写该字段；它们没有使用普通 PAT，不能误触 Codespace PAT binding。
- 认证层按 `AccessTokenID` 反查当前 binding。命中 Codespace binding 后，请求态 `repo_bound_access_mode` 初始化为 `deny`；请求不能因为 PAT 已经转换为用户身份而按普通用户路径继续。
- API 和 Web 在路由 middleware 完成后、handler 执行前运行公共 final guard。单 repository API/Web adapter 与 Git HTTP/LFS adapter 先解析唯一目标 repository，再调用服务层 `CheckRepoBoundAccessToken(ctx, tokenID, targetRepoID) Decision`；判定通过后把请求态改为 `repository_checked`，随后继续执行 Gitea 现有 scope、用户、repository、unit、可见性和权限检查。
- raw、archive、download 和 repository feed 复用所属 repository 路由已经解析的目标，不增加第二套目标识别。fork、migrate、transfer、创建 repository、跨 repository compare 和其他涉及零个、多个或新 repository 的请求保持 `deny`，由 final guard 在读取结果和写入副作用前返回 `unsupported_resource`。
- 只有 `DELETE /api/v1/token` 把请求态改为 `current_token_delete`，使请求可以到达受保护的 access-token 删除服务；handler 直接读取认证阶段写入 request context 的 `AccessTokenID`，不再次只按 Bearer header 解析 token，因此 Basic、Bearer 和 query PAT 使用同一删除语义。绑定 Codespace 的当前 token 由该服务返回 409。`GET /api/v1/token` 和其他非 repository 请求保持 `deny` 并返回 403；没有 `AccessTokenID` 的 OAuth2、Actions 或 session 身份沿用现有无效 token 响应。

`repo_bound_access_mode` 是请求内枚举，不写入数据库、session 或 cache：

```text
deny
repository_checked
current_token_delete
```

使用单一枚举可以让 final guard 对每个请求只有一个明确结果，避免多个布尔标记组合出“看似已经检查、实际没有目标 repository”的状态。普通 PAT 没有 Codespace binding 时继续使用 Gitea 现有路径；该请求态只约束命中 binding 的 PAT。

- repo-bound token 判定只额外校验 `target_repo_id == codespace.repo_id`。
- codespace-bound token 的 repository 访问范围固定为 `codespace.repo_id`；访问其他 repository 时返回 repo binding mismatch 分类，访问绑定 repository 时继续交给 Gitea 现有权限链路判断。`repo_id=0` 时，任何 repository 都返回 repo binding mismatch。
- codespace token scope 限定为 `write:repository`。需要 `read:user` 或 `read:organization` 的信息由 Gitea 在 create 时通过只读环境变量注入；resume 使用已初始化 workspace 中的既有信息。
- Runtime 需要的 owner/org 展示信息由 Gitea 在 create 时作为只读环境变量注入，不通过 codespace token 调用通用 user/org API。
- `creating/running` 是工作状态，允许持有 token；`creating -> running` 不吊销 token，直接复用 create 阶段 token。
- 创建用户记录必须仍存在；账户删除事务物理删除关联 codespace 及 token，不保留等待补签的工作状态记录。
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
- access token 被 codespace 绑定时，`codespace.status` 必须为 `creating|running`；其他状态返回 `codespace_not_running`。
- `[codespace] ENABLED=false` 时，现有 binding 判定仍然加载；repository 请求返回 `state_unavailable`，不能回退到普通 PAT 逻辑。`current_token_delete` 仍进入删除服务并返回 409，使功能关闭不会解除 token 生命周期所有权。`RequestGiteaToken` 只允许 active running stop 读取已经存在的完整 token pair 用于日志脱敏，其他请求均不签发或返回 token。
- `target_repo_id` 与 `codespace.repo_id` 匹配。
- `codespace.repo_id=0` 时，对所有 target repository 返回 repo binding mismatch。
- repo binding 匹配后继续执行 Gitea 现有 scope、用户、repository、unit、可见性和权限检查。
- 请求态为 `repository_checked` 时目标 repository 已通过公共判定；`current_token_delete` 只允许进入当前 token 删除服务；其余非 repository、零个或多个目标、跨 repository 和未显式完成公共判定的请求返回 unsupported resource 分类。Runtime 需要的非 repository 信息由 create 环境变量注入。

repo-bound token 判定只补足单仓库边界——Gitea access token scope 是 category 级，`write:repository` 表达“可以做 repository 类动作”但不表达“只能访问哪个 repository”。用户权限、repository 存在性、unit 可读写性继续由 Gitea 现有检查负责，避免 Runtime token 变成通用 PAT。

token 生命周期以每个新 Git HTTP/LFS 请求的认证时刻为边界。stop、failed、deleting 或功能关闭成立后，后续请求重新读取当前 binding 并拒绝；已经完成认证并进入 Gitea Git 处理链的请求按现有 Gitea 行为结束，不增加进行中请求表，也不从生命周期事务取消 git subprocess。LFS 后续对象传输是新请求，会重新认证。

有效 codespace-bound token 的 `repo_binding_mismatch`、`unsupported_resource` 和功能关闭统一由 API、Web、Git HTTP 与 LFS adapter 返回 HTTP 403；`current_token_delete` 的 binding 冲突由删除服务返回 409。token 本身不存在或校验失败继续使用 Gitea 现有 401。repo binding 通过后的用户、repository、unit 和可见性拒绝保持 Gitea 现有 403/404 行为，不用 Codespace 分类覆盖原权限语义。

Codespace access token 继续显示在现有 PAT 列表和 API 中，只展示固定名称、创建时间、使用时间等现有非明文字段；现有接口不会返回 token 明文。删除操作命中 binding 时返回 409，因此用户可以识别该系统凭据，但必须通过 stop 或 delete 结束其生命周期，不增加另一套隐藏 token 列表。

删除保护：

- 不扩展 `access_token` 表。`services/auth/access_token.go` 提供外部入口 `DeleteAccessToken(ctx, tokenID, userID)` 和生命周期入口 `DeleteAccessTokenForCodespaceLifecycle(ctx, tokenID, codespaceID)`，让普通 PAT 删除与 Codespace 状态事务分别拥有明确的事务边界。
- `DeleteAccessToken` 自己开启短事务，先按 `codespace.gitea_token_id` 反查 binding。命中时返回 typed error `ErrAccessTokenUsedByCodespace`；Web/API 统一映射为 `409 Conflict` 并提示先 stop 或 delete 对应 Codespace。未命中时仍按 `tokenID + userID` 删除普通 PAT，保持现有所有权检查。
- 用户设置页、用户 token API 和“删除当前认证 token”API 都调用 `DeleteAccessToken`，router 不再直接调用 access-token model。这样 PAT 列表删除和当前凭据删除不会绕过同一 binding 保护。
- Codespace 生命周期服务在 stop final、failed final、进入 deleting、物理删除和 failed 记录清理时调用 `DeleteAccessTokenForCodespaceLifecycle`。该入口使用调用者已有的事务 context，不开启嵌套事务；它校验 Codespace ID 与 `gitea_token_id`，并在同一事务删除 token row、把 `gitea_token_id` 写为 0、把 `gitea_token` 写为空字符串。
- `DeleteAccessTokenForCodespaceLifecycle` 只供生命周期服务调用，不与 Web/API handler 共享调用路径。复用调用者事务可以保证主状态与 token pair 一起提交或一起回滚，不产生已经 stopped 但 token 仍有效的中间结果。
- 用户删除中的 access token 批量删除是内部例外：owner 前置清理必须先通过生命周期入口删除所有关联 Codespace token，随后现有用户删除事务才可批量删除剩余普通 PAT。批量入口不能用于仍有 Codespace binding 的普通用户删除路径。
- reconciliation 负责清理 codespace 行仍存在但 token ID、明文或 access token row 不一致的状态；物理删除必须在同一事务删除 token row，因此不依赖无 codespace 记录的反查。
- token pair 损坏时先删除仍存在的旧 token row，再清空 binding；不能先解除 binding 而留下可按普通 PAT 认证的旧 token。

通过反查 `codespace.gitea_token_id` 做删除保护，因为 token 生命周期所有权已由 codespace 行表达。这样不需要给通用 PAT 模型增加新的 token 类型，也能让用户在通用 token UI/API 删除时得到明确的 409 冲突原因。

实现验收点：

- codespace-bound token 只有在 `creating/running` 状态且 token ID、repo binding、Gitea 原有权限均通过时才能访问 repository。
- 普通 PAT 的 Basic、Bearer 和 query 认证都写入实际 `AccessTokenID`；OAuth2、Actions、session、reverse proxy 和 SSH 身份不会被误标为 PAT。
- codespace-bound 请求以 `repo_bound_access_mode=deny` 开始；只有唯一 repository 判定成功或当前 token 删除两个明确分支可以通过 final guard，零个、多个或跨 repository 操作均拒绝。
- API/Web repository adapter 与 Git HTTP/LFS adapter 在 handler 前调用同一公共判定；raw、archive、download 和 feed 复用已解析 repository，未接入的路由无法仅凭已认证用户身份继续执行。
- `repo_id=0` 时仍可签发 token，但任何 repository 访问都返回 repo binding mismatch。
- 功能关闭时 binding 与删除保护继续生效，现有 token 不会退化为普通 PAT；吊销只阻止之后的新请求，不承诺中断已经进入 Git 处理链的请求。
- `creating -> running` 复用同一 token；stop/failed/deleting 清空字段，后续 running 请求生成新 token。
- 用户无法从通用 PAT 页面删除仍由 codespace 持有的 token。
- 用户设置页、用户 token API 和删除当前认证 token API 都经过 `DeleteAccessToken`；绑定 token 的删除稳定返回 409，`GET /api/v1/token` 和其他非 repository 请求稳定返回 403。
- 删除当前认证 token 的 handler 使用 request context 中的 `AccessTokenID`，Basic、Bearer 和 query PAT 得到相同的普通 token 204 或绑定 token 409 结果。
- 生命周期吊销通过调用者事务中的 `DeleteAccessTokenForCodespaceLifecycle` 同时删除 token row 和清空 token pair，不开启嵌套事务。
- PAT 列表可见 `codespace-{完整 codespace_uuid}` 的非明文元数据，删除该项稳定返回 409。
- owner 前置清理事务完成后，当时仍由创建者、repository owner 或 Manager owner 关联的 access token、codespace token binding 和 codespace 记录同时不存在。

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

`POST /codespace/{uuid}/open` 在签发前固定选择 `endpoint_id=workspace`；显式 Endpoint 路由使用 path 中经过 DNS-safe 格式校验的 ID。两种入口都要求当前 metadata ready，普通 Endpoint 还需要存在于 metadata，`workspace` 不要求同名 Endpoint。两种入口都生成完整 binding，Gitea 不签发空 `endpoint_id`，Manager 也不需要为 Web SSH 增加特殊 token 类型。

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
value = required JSON fields: user_id, codespace_uuid, endpoint_id, manager_id, issued_unix, expires_unix
ttl = OPEN_TOKEN_EXPIRE

index key = codespace:open-code-index:{codespace_uuid}
index value = 去重并按 code_hash 升序的 JSON 字符串数组
index ttl = OPEN_TOKEN_EXPIRE
```

Codespace 通过 `modules/cache.GetCache()` 使用站点现有 cache adapter，不增加专用 cache 实现。memory/twoqueue 重启后可以丢失这些 key，Redis/memcache 可在 TTL 内保留；保留的 Open Code 仍必须执行下面的全部实时校验。

规则：

- code 明文只出现在 `302 Location` 的 query string 中，不落数据库和日志。
- code 签发、消费和 Codespace 物理删除直接使用 `globallock.Lock(ctx, "codespace_" + canonicalUUID)` 串行化。签发在 code 与 index 都写入后才返回重定向；index 写入失败时尽力删除刚写入的 code 并返回失败。index 是主动清理辅助，adapter 后续可单独淘汰它；物理删除后的残留 code 仍会被数据库复检拒绝。
- code 使用 `CryptoRandomBytes(32)` 生成，256 位熵值使得 hash 冲突概率可忽略，不需要冲突重试逻辑。

校验步骤（code 交换，映射 OAuth2 Token Endpoint）：

1. 计算 `code_hash = sha256(submitted_code)`。
2. 以 `code_hash` 查询并解析 cache，读取 binding 中的 `codespace_uuid`；Gitea cache API 会把后端读取错误表现为 miss，因此 miss 直接按无效凭据拒绝，无法解析时记录服务端日志、尽力删除后拒绝。
3. 取得 `codespace_{uuid}` global lock，并在锁内重新读取同一 code；等待锁期间 code 已消失或 binding 变化时返回失败。
4. 显式校验 `now < expires_unix`；已经过期时尽力删除 code 和 index 引用后拒绝（防御 TTL 淘汰延迟）。
5. 校验调用方 Manager 身份等于 `manager_id`（代替 OAuth2 标准的 client 认证）。
6. 重新读取 codespace，校验当前为 `running`。
7. 校验用户仍具备 Interactive Access。
8. 校验 Runtime Metadata 仍为 ready；普通 ID 还必须存在于当前 metadata，`workspace` 不要求 endpoints 数组存在同名项。
9. 校验 Manager 仍在线且未被 disabled。
10. 全部校验通过后删除 code；删除失败时返回内部错误，不返回 binding。
11. 从 index 移除 `code_hash`；index miss 或损坏按空集合处理，更新失败时记录服务端日志并仍返回成功，因为 code 已经不可再次消费。
12. 尽力更新 `last_active_unix=now`；更新失败记录日志并仍返回 binding。

步骤 3-9 是运行时安全检查，在 code 签发到验证之间的时间窗口内状态可能已变化。校验完成后才消费 code，使暂时不满足条件的请求不会无故销毁凭据；返回 binding 前必须成功删除 code，保证一次性语义。

成功返回：

```text
user_id
codespace_uuid
endpoint_id
manager_id
```

Cache miss 时 code 失效，用户重新从 Gitea 发起 open；Redis/memcache 在 TTL 内保留的 code 可以继续交换，但仍执行全部实时校验。codespace 生命周期状态不受 cache 影响。

Gateway 成功交换 code 后要求请求 Host 与返回 binding 派生的 host 一致，再创建服务端 session，并用 host-only、`Path=/`、`HttpOnly/SameSite=Lax` 的 cookie 和 `303 Location: /` 跳转到无 code URL；`Secure` 按 Gateway 外部 scheme 和本地配置决定。带 code 的请求不代理到目标，响应设置 `Referrer-Policy: no-referrer`。Gateway 重启后本地 session 失效，用户重新从 Gitea open。

实现验收点：

- access token、Gateway open code 和 Manager 凭据使用各自独立的生命周期与校验入口。
- open code 单次消费、60 秒过期，并在消费时重新检查当前访问条件。
- code 和 index 全部写入后才签发成功；校验失败保留 code 到原 TTL，code 删除失败不返回 binding，index 清理失败不允许 code 再次消费。
- index 被 adapter 单独淘汰后只降低物理删除的主动清理覆盖率，不参与 code 授权、过期或一次性消费。
- code 成功消费后的 `last_active_unix` 更新失败不恢复 code，也不拒绝已经成立的 binding。
- 默认 open 始终签发 `endpoint_id=workspace`；没有 Runtime 同名 Endpoint 时，Gitea 校验仍可通过并由 Manager 使用默认 Web SSH。
- Codespace 物理删除提交后先释放 Codespace lock，再尽力清理 Runtime Metadata 和仍可索引的未消费 open code；即使清理失败或 index 已丢失，后续消费也因 Codespace 不存在而拒绝。
- code 交换后浏览器地址和后续 Referer 不再包含 code，host-only session cookie 不向其他 Endpoint host 暴露。
- token 或 code 明文不进入日志和普通 API 输出。

## Cron 任务

| 任务 | 默认调度 | 职责 |
| --- | --- | --- |
| `reconcile_codespace_states` | `@every 1m` | 检查 queued operation timeout、running operation lease、Manager offline/recovering 和 token 生命周期绑定 |
| `cleanup_failed_codespaces` | `@daily` | 清理超过保留期的 `failed` 状态 codespace 记录、token 绑定和日志；清理超过保留期的 inactive registration token |

`reconcile_codespace_states` 定时扫描 active operation、Manager 可用性和 token binding。Runtime inventory 不持久化，差异只在 `ReportInstances` 请求内处理。queued operation 使用 `operation_created_unix + QUEUE_TIMEOUT` 判定等待超时，running operation 使用 `operation_deadline_unix` 判定 lease 超时。failed retention 从进入 failed 时写入的 `updated_unix` 起算，token reconciliation 不刷新该值；inactive registration token retention 从 `is_active` 变为 false 时的 `updated` 起算。codespace 只有一份连续日志且不保存 operation 历史，因此日志随 delete 或 `cleanup_failed_codespaces` 一起删除，不按“已完成 operation”单独清理。

两个任务沿用 Gitea 单实例 Cron，不增加调度器。扫描统一使用 100 条固定批次和稳定 keyset：queued 按 `operation_created_unix, uuid`，running 按 `operation_deadline_unix, uuid`，failed 按 `updated_unix, uuid`，inactive registration token 按 `updated, id`。每个 Codespace 候选单独取得 Codespace lock 并在短事务中处理；registration token 候选按 ID 使用独立短事务。单条业务或数据错误记录服务端日志后继续当前批次，keyset 仍越过该项并在下一轮任务重试。候选查询、数据库连接或事务基础设施错误会终止本轮，避免在无法确认扫描基线时继续。任务响应进程关闭 context，处理完当前短事务后停止。

`cleanup_failed_codespaces` 对到期记录直接执行 Gitea 本地物理删除：取得 Codespace lock 后在本地事务中清理 access token、明文 token binding、单文件日志和数据库记录，提交并释放 lock 后尽力清理对应 cache；cache 清理失败只记录服务端日志，不改变删除结果。该任务不创建 delete operation，不联系 Manager，也不检查 Manager 的 enabled/online/recovering 状态。failed 已经是不可恢复终态，保留期只用于给用户读取日志和手动 delete；到期后继续等待运行侧确认不会增加 Gitea 数据安全性，反而会让终态记录无限保留。Manager 以后上报该 UUID 时按无数据库记录处理，不返回 `cleanup_local_runtime`。

实现验收点：

- reconciliation 不读取已失效的 inventory 快照，只处理数据库可判断的 timeout、Manager 可用性和 token 残留。
- failed retention 在本地事务中清理 codespace 记录、token 和对应单文件日志，提交后先释放 Codespace lock 再清理 cache；cache 清理失败不恢复记录或权限。
- failed retention 仅提交 Gitea 本地清理，不创建 operation、Manager instruction 或远端确认；之后的未知 UUID inventory 被忽略。
- token reconciliation 不延后 failed 清理时间，registration token 停用时间是其 retention 起点。
- 系统不存在按 operation 历史清理日志的 cron 任务。
- Cron 使用 100 条 keyset 批次和单 Codespace 短事务；单条失败不阻塞同批后续记录，数据库级错误终止本轮。

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

- Codespace 功能只支持一个活动 Gitea 进程；cache 直接复用 `[cache]` adapter，需要 keyed serialization 的明确写路径直接调用 `[global_lock]` backend 提供的 `globallock.Lock`，Cron 沿用 Gitea 单实例调度。Redis 配置不改变 Codespace 的单进程支持边界。
- `ENABLED=false` 使用排空模式，不删除现有 Codespace/Manager 数据。Web 禁止新 create、resume、open 和 SSH，但详情、日志、stop、普通 delete、站点管理员 force delete 与现有管理页继续可用；访问判定返回 `state_unavailable`，已有 Gateway session 在下一次 revalidate 时关闭。
- 排空模式拒绝 `RegisterManager`、新的 Gitea token 签发与普通 token 读取、Runtime Metadata 写入和 running transition。active running stop 可读取已经存在的完整 token pair 以重建日志脱敏集合，但空或损坏 binding 不修复；已有 Manager 仍可 Declare、轮换自身 secret、ReportInstances、上报 stopped/failed transition，并通过 Fetch 领取 stop/delete 或取得已领取 create/resume 的 abort；对应 UpdateLog 和 final 继续可用。queued create/resume 不再领取，按现有 queue timeout 收敛。
- 排空模式继续运行 `reconcile_codespace_states`、`cleanup_failed_codespaces` 和 registration token retention。repo-bound token 识别、repo binding 判定、通用 PAT 删除保护及站点管理员本地删除不受 `ENABLED` 开关影响。重新启用后，未进入 stopped/failed/deleting 的现有对象继续按当前状态工作。
- `OPEN_TOKEN_EXPIRE` 也是 [Gateway Open Token](glossary.md#gateway-open-token) 的 Gitea cache TTL。
- Codespace 不使用 `[session]` 保存 Runtime Metadata 或 Open Code，也不增加专用 cache、lock 或 Redis 配置。Open Code、index 和 Runtime Metadata 使用各自明确 TTL；即使通用 `[cache] ITEM_TTL=-1`，这些协议所需条目仍直接写入已配置 adapter。
- `CONTROL_PLANE_MAX_REQUEST_SIZE` 是 ManagerService 单个解码后 request 的硬上限，inventory、metadata 和日志批次都受其约束。
- `GATEWAY_REQUIRE_HTTPS=false` 时接受 `http://` 和 `https://` 的 `gateway_url`；设为 true 时只接受 HTTPS。该选项用于部署策略，不改变扁平子域路由或 session 语义。
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

- `ENABLED=false` 禁止新增运行与交互，但保留 stop/delete/abort/final、管理清理和 Cron；现有 codespace-bound token 始终按 binding 识别并拒绝使用。
- `ENABLED=false` 下只有 active running stop 能读取已存在的完整 token pair 用于日志脱敏，任何路径都不能新签发或修复 token。
- 启用 Codespace 时只有一个活动 Gitea 进程；memory、twoqueue、Redis、memcache cache adapter 和 memory、Redis global lock backend 均沿用 Gitea 现有配置，不据此提供多实例能力。
- 重新启用不迁移或重建数据库状态，现有对象按当前持久状态继续。
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
name: manager-01
tags: [linux, amd64]
capacity_total: 100
gitea_url: http://gitea.internal:3000
control_plane_require_https: false
control_plane_tls_ca_file: ""
control_plane_tls_server_name: ""
control_plane_tls_insecure_skip_verify: false
fetch_poll_interval: 2s
fetch_poll_jitter: 20%
fetch_error_backoff_max: 30s
inventory_report_interval: 1m
runtime_api_listen: 0.0.0.0:8080
runtime_api_url: http://manager.internal:8080
runtime_api_require_https: false
runtime_api_tls_cert_file: ""
runtime_api_tls_key_file: ""
gateway_listen: 0.0.0.0:8081
gateway_url: http://codespace.example.com
gateway_cookie_secure: auto
gateway_tls_cert_file: ""
gateway_tls_key_file: ""
gateway_session_ttl: 8h
gateway_session_idle_timeout: 30m
gateway_session_revalidate_interval: 5m
gateway_max_sessions_per_codespace: 32
gateway_max_sessions_per_user: 128
gateway_ssh_listen: 0.0.0.0:2222
gateway_ssh_addr: ssh.codespace.example.com:22
ssh_auth_max_attempts_per_ip_per_minute: 30
ssh_auth_max_attempts_per_codespace_per_minute: 20
ssh_auth_max_attempts_per_ip_codespace_per_minute: 10
ssh_auth_max_attempts_per_public_key_per_minute: 30
ssh_auth_backoff_base: 1s
ssh_auth_backoff_max: 30s
ssh_auth_failure_window: 10m
upstream_tls_ca_file: ""
upstream_tls_server_name: ""
upstream_tls_insecure_skip_verify: false
```

Manager 当前配置是 `name`、`tags`、`capacity_total`、`gateway_url` 和 `gateway_ssh_addr` 的唯一声明来源，修改配置后通过完整 Declare 快照覆盖 Gitea 中的当前值。`capacity_available` 由本地 worker 槽位计算，backend capabilities 由当前实际能力生成。`capacity_total` 范围为 1..10000，且单个 Manager 管理的全部 Runtime 总数同样不能超过 10000。Manager ID、manager secret、轮换中的 pending secret、inventory generation、operation worker 与 SSH host private key 都保存在 `state_dir`，不写入 YAML；同一目录由进程锁保证只能被一个 Manager 进程使用。

`runtime_api_listen`、`gateway_listen` 和 `gateway_ssh_listen` 是本地 listener 地址；`runtime_api_url`、`gateway_url` 和 `gateway_ssh_addr` 是向 Runtime、Gitea 或用户声明的可达地址，两者可以因反向代理或端口映射而不同。`gitea_url`、`runtime_api_url` 和 `gateway_url` 都允许 HTTP/HTTPS；各 `require_https` 选项用于需要强制 HTTPS 的部署。CA 和 server name 只在对应 HTTPS 连接中使用，`insecure_skip_verify` 默认 false。`gateway_url` 必须是 DNS base domain，不能带业务 path，并且规范化后不能与其他 Manager 重复；部署为该 domain 和 `*.domain` 配置 DNS。Gateway URL 为 HTTPS 时，listener 证书或受信反向代理证书同时覆盖 base domain 与单层 wildcard；cookie Secure 默认按外部 URL 自动决定。Endpoint HTTPS upstream 使用 upstream TLS 配置，Endpoint 请求不能修改信任策略。

`inventory_report_interval` 默认 1 分钟，必须大于 0；Fetch 默认 2 秒并带 20% 正抖动，临时错误最多退避 30 秒。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。

实现验收点：

- 控制面、Runtime API 和 Gateway 在 HTTP 配置下可正常工作，启用对应 HTTPS 配置后使用证书和 CA 校验。
- `gateway_cookie_secure=auto` 与浏览器实际访问 scheme 一致，HTTP 不因固定 Secure cookie 无法建立 session。
- `gateway_url` 的非根 path 和 IP literal 被拒绝；base domain 与单层 wildcard DNS/TLS 可以覆盖所有派生 Endpoint host。
- 两个 Manager 声明相同的规范化 `gateway_url` 时，后声明者收到 `gateway_url_conflict`；已有 Manager 的未变化 heartbeat 不受全表扫描影响。
- `gateway_ssh_addr` 完全来自 Manager 配置；两个 Manager 声明相同规范化 `host:port` 时，后声明者收到 `gateway_ssh_addr_conflict`。
- 修改 name、tags、capacity、Gateway/SSH 地址或 capability 后，成功 Declare 整体覆盖旧快照；失败 Declare 不产生部分更新。
- listener 与对外地址可以不同；Manager 声明值、容量和 SSH 限流均能由上述配置或本地运行事实唯一确定。
- 同一 `state_dir` 的第二个进程启动失败，同一 Manager 身份不支持从其他状态目录或主机并发运行。
- Endpoint 请求只能选择 `http|https` scheme，不能关闭 HTTPS 证书校验或指定任意 host。
