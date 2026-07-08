# 创建流程与 Manager

## 创建与 Ref 解析

Create 支持：

```text
ref_type=branch|tag|commit|pull
ref_name
commit_sha
pull_id
```

Gitea 必须：

- 校验 repository 可见性和 code-read 权限。
- 校验 repository 状态。
- 打开 git repository 并确认非空。
- 解析并锁定最终 commit SHA。
- 拒绝不存在的 ref 和不可解析的 commit。
- PR 创建记录 `pull_id`。

Pull Request 规则：

- PR 入口属于 base repository 页面。
- `ref_type=pull` 时从 Gitea 数据加载 PR。
- base repository 必须等于路由 repository。
- 创建用户必须能读取 base repository。
- head repository 不同时，创建用户也必须能读取 head repository。
- 锁定 commit 必须能从 head repository 解析。
- 必要时 operation payload 同时包含 base/head clone URL 与 web URL。
- Manager tag matching 和 `.gitea/codespace.yaml` 使用 base repository。

## Repository Codespace 配置

配置文件：

```text
.gitea/codespace.yaml
```

唯一字段：

```yaml
tag: default
```

规则：

- 配置只从 branch tree 读取。
- `ref_type=branch`：读取该 branch。
- `ref_type=pull`：读取 PR base branch。
- `ref_type=tag`：读取 repository default branch。
- `ref_type=commit`：读取 repository default branch。
- 文件不存在等价于 `tag=default`。
- 空仓库在读取配置前已被拒绝。
- YAML 非法时 create 失败。
- 未知字段忽略，create 日志中提示当前只识别 `tag`。
- `tag` 必须匹配 `[A-Za-z0-9_-]+`。
- `tag` 解析后 lower-case。
- `tag` 只影响 create 的 Manager tag matching。
- `tag` 不影响 stop/resume/delete。
- 实际 checkout commit 仍按用户选择的 branch/tag/commit/PR 锁定 SHA。

设计决策：

- `.gitea/codespace.yaml` 只用于选择 Manager tag，不决定实际 checkout 内容。
- tag/commit 场景读取 default branch，避免任意历史 commit 改变 Manager 选择。
- PR 场景使用 base branch，让目标仓库维护者控制运行侧选择；实际代码仍按用户选择的 ref 锁定到具体 commit SHA。

## Boot 与 Init

`booting` 是首次 create 的唯一环境初始化状态。

Codespace Manager 在 Runtime Instance 启动后以 `init.sh` 作为唯一初始化入口。

`init.sh` 负责：

- 通过 `GET /boot` 获取初始化所需信息
- 配置 git 凭据
- 使用 Git HTTP(S) clone URL clone 或复用 workspace 目录
- fetch 目标 ref
- checkout 到锁定 commit SHA
- 校验 HEAD 等于锁定 commit SHA
- 准备 OpenSSH
- 将 `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` 写入内部工作用户 `authorized_keys`
- 启动内部 sshd
- 启动默认 Web IDE 或其他本地服务
- 通过 `POST /boot` 上报初始化结果与 internal SSH metadata
- 通过 `/endpoints/{endpoint_id}` 创建、更新或删除 Endpoints

必需环境变量：

```text
GITEA_REPO_CLONE_URL
GITEA_REPO_WEB_URL
GITEA_BASE_REPO_CLONE_URL
GITEA_BASE_REPO_WEB_URL
GITEA_HEAD_REPO_CLONE_URL
GITEA_HEAD_REPO_WEB_URL
GITEA_REPO_ID
GITEA_REPO_FULL_NAME
GITEA_OWNER_ID
GITEA_OWNER_NAME
GITEA_OWNER_TYPE
GITEA_OWNER_DISPLAY_NAME
GITEA_REF_TYPE
GITEA_REF_NAME
GITEA_COMMIT_SHA
GITEA_PULL_ID
GITEA_TOKEN
CODESPACE_UUID
CODESPACE_NAME
CODESPACE_OWNER_NAME
CODESPACE_REPO_NAME
CODESPACE_WORKSPACE_DIR
CODESPACE_SSH_USER
CODESPACE_MANAGER_BASE_URL
CODESPACE_RUNTIME_TOKEN
CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY
```

环境变量规则：

- `CODESPACE_NAME` 是派生值，不单独持久化。
- `CODESPACE_NAME` 生成规则固定为 `cs-{short_uuid}`，其中 `short_uuid` 取 `codespace.uuid` 前 12 位。
- UI 展示名称使用同一派生规则。
- delete 后 `CODESPACE_NAME` 不复用。
- Manager 不把 `CODESPACE_NAME` 当 Runtime Instance name 的唯一来源。
- Runtime Instance name 仍由 Manager 用 `codespace_uuid + generation` 本地生成。
- `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN` 由 Manager 创建 Runtime 时注入，不来自 Gitea Operation Payload。

可选环境变量：

```text
CODESPACE_BOOT_LOG_PATH
```

Boot 完成条件：

- `init.sh` 成功。
- workspace checkout 到锁定 commit SHA。
- internal SSH 可被 Gateway 连通。
- `internal_ssh.host / port / user / host_key_fingerprint` 已上报。
- 至少一版 Runtime Metadata 被 Gitea 接受。
- 若存在 Web IDE，对应 Endpoint 已上报。

推荐 boot stage：

```text
prepare-runtime
configure-ssh
configure-git
clone-repository
checkout-commit
run-init-script
start-ide
report-endpoints
```

## Manager 注册与匹配

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

Manager 记录字段：

```text
id
uuid
name
gateway_url
gateway_ssh_addr
gateway_internal_ssh_public_key
admin_state=enabled|disabled
last_capacity_total
last_capacity_available
secret_hash
secret_salt
tags_json
last_online_unix
created_by
created_unix
updated_unix
meta_json
```

Manager 规则：

- Manager 不按 owner、organization 或 repository 分组。
- 不支持 repository 级 Manager。
- 不设计单独的 Manager binding 表。
- `admin_state` 只表示管理态，不表示在线态；在线态由 `last_online_unix` 和 timeout 推导。

Declare 声明：

- `gateway_url`
- `gateway_ssh_addr`
- `gateway_internal_ssh_public_key`
- `tags`
- `capacity_total`
- `capacity_available`
- 可选诊断 `meta_json`

Declare 校验：

- `gateway_url` 必须是 absolute `http://` 或 `https://` URL。
- `gateway_url` 不允许 userinfo、query 或 fragment。
- `gateway_url` path 允许为空或作为固定 base path；生成 open URL 时安全 join `/open`。
- `gateway_ssh_addr` 固定格式为 `host:port`。
- `gateway_ssh_addr` host 不允许为空。
- `gateway_ssh_addr` port 必须是 1 到 65535。
- `gateway_ssh_addr` 不接受 URL 格式。

SSH 是必选能力。不满足完整 SSH 要求的 Manager 无效。

Manager tag matching：

- create 记录固定 `repo_tag`。
- disabled Manager 不参与 tag 匹配。
- 没有 enabled Manager 支持 `repo_tag` 时，create 直接失败。
- create 创建时不绑定具体 Manager。
- 具体 `manager_id` 只在某个 Manager 通过 `FetchOperation` 成功领取 create operation 时写入。
- 有匹配 Manager 但全部离线、满载、不调用 `FetchOperation`，或调用 `FetchOperation` 但声明不可接收 create 时，create 保持 `queued`。

设计决策：

- 使用统一 Manager 池，repository 只需要通过 tag 描述运行侧能力需求。
- Manager 不按 owner/org/repo scope 分组，避免 repository、owner/org 删除流程与 Manager 生命周期互相耦合。
- 具体 Manager 由 pull 成功的一方确定，符合 Manager 主动拉取 operation 的模型。

Create operation claim：

- claim 前：`codespace.manager_id=0`，`operation.manager_id=0`。
- `FetchOperation` 原子 claim operation。
- claim 同时写入 `codespace.manager_id`、`operation.manager_id`，并将 codespace 从 `queued` 推进到 `booting`。
- claim 条件包含 caller Manager enabled、caller Manager 支持 `repo_tag`、本次 `FetchOperation` 声明可接收 create、`manager_id=0`、当前 status、active operation 和 generation。
- 本次 `FetchOperation` 的 `capacity_available` 必须大于 0。
- Gitea 不在 claim、`done|failed` 或 timeout 时修改 `last_capacity_total / last_capacity_available`。
- claim 成功后，operation 归属不可被后续 `DeclareManager` 覆盖。
- 并发 claim 失败不是系统错误。

Manager Capacity：

- `capacity_total > 0`
- `0 <= capacity_available <= capacity_total`
- create/resume 需要 Manager 在本次 `FetchOperation` 中声明可接收，且 `capacity_available > 0`。
- stop/delete 不需要可用 capacity。
- capacity 是 Manager 最近上报的本地可接收能力快照，不是 Gitea quota。
- Manager 是实际运行容量权威，自行确保不拉取超过本地真实容量的 create/resume operation。
- Gitea 只保证 operation 不被重复领取，不保护 Manager 的本地运行并发。
- `DeclareManager` 和 `FetchOperation` 使用 request 中的 `capacity_total / capacity_available` 覆盖数据库中的 `last_capacity_total / last_capacity_available`。

设计决策：

- Manager 主动 pull operation；满载时不拉取 create/resume，queued operation 自然等待。
- Gitea 看不到 Manager 本地 Runtime 队列、资源占用和启动中任务，不是真实容量权威，只保存最近容量快照用于 UI、诊断和本次 `FetchOperation` 准入检查。

Manager 禁用/删除：

- 常规操作支持禁用，不提供普通物理删除。
- disabled Manager 只能执行清理和状态分歧上报，不能服务新建、恢复、open 或 SSH。
- disabled Manager 可调用 `DeclareManager`。
- disabled Manager 可调用 `FetchOperation`，但只能领取已绑定给自己的 `stop|delete`。
- disabled Manager 可调用 `UpdateOperation` 和 `UpdateLog`，但仅限自己已领取的 `stop|delete`。
- disabled Manager 可调用 `ReportInstances`。
- disabled Manager 拒绝 `FetchOperation(create|resume)`、`ReportRuntimeMetadata`、`RequestGiteaToken`、`ValidateOpenToken`、`VerifySSHPassword` 和 `VerifySSHPublicKey`。
- 仍有未删除 codespace 引用时，不允许物理删除 Manager 记录。
- 完整移除 Manager 前先删除或清理其所有 codespace。

## ManagerService RPC

Gitea 实现：

```text
codespace.v1.ManagerService
```

传输：

- Connect RPC over HTTP（参考 Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 不提供 REST 控制面旁路

Manager 认证 header：

```text
x-codespace-manager-uuid: <manager uuid>
x-codespace-manager-secret: <manager secret>
```

只有 `RegisterManager` 不使用 Manager header。它使用一次性 registration secret 认证。

RPC：

```text
RegisterManager
DeclareManager
FetchOperation
UpdateOperation
UpdateLog
ReportRuntimeMetadata
RequestGiteaToken
ValidateOpenToken
VerifySSHPassword
VerifySSHPublicKey
ReportInstances
```

`RegisterManager`：

- 将一次性 registration secret 兑换为 Manager identity 和 manager secret。
- 消费 registration secret。
- 只返回一次明文 manager secret。

`DeclareManager`：

- 更新 Manager 版本、gateway 地址、tags、capacity、内部 SSH 公钥和诊断 metadata。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Manager 周期调用 `DeclareManager`；心跳间隔严格小于 `MANAGER_OFFLINE_TIMEOUT`，建议不超过其三分之一。

`FetchOperation`：

- Manager 主动拉取可领取的 operation。
- request 包含 `capacity_total`、`capacity_available` 和 `accepted_operation_types`。
- 更新 `last_online_unix`。
- 使用 request 中的 `capacity_total / capacity_available` 更新 `last_capacity_total / last_capacity_available`。
- 优先返回已绑定给当前 Manager 的 `stop|delete`。
- `create` 只返回给支持 `repo_tag`、本次声明接受 `create` 且 `capacity_available > 0` 的 enabled Manager。
- `resume` 只返回给已绑定该 codespace、本次声明接受 `resume` 且 `capacity_available > 0` 的 enabled Manager。
- `capacity_available=0` 时不返回 `create|resume`。
- 对返回的 operation 执行原子 claim。

`FetchOperation` request：

```text
capacity_total
capacity_available
accepted_operation_types=create|resume|stop|delete
```

规则：

- `accepted_operation_types` 表示 Manager 本次 pull 愿意接收的 operation 类型。
- Manager 满载时可以只声明 `stop|delete`，或不调用 `FetchOperation`。
- Manager 有 create/resume 空闲容量时才声明 `create|resume`。
- Gitea 不把 operation 推送给 Manager；没有 Manager 主动领取时，operation 保持 `queued`。

`UpdateOperation`：

- 续租 lease。
- 更新 progress/stage。
- 写入终态结果 `done|failed`。
- 触发 Gitea 服务层同步执行 State Finalization。
- 匹配 `operation.uuid`、`operation.manager_id`、`codespace.active_operation_id` 和 `codespace.generation`。
- operation 已进入 `done|failed` 后终态不可再改变。
- 重复提交相同终态可以幂等返回当前结果，但不重复执行 State Finalization。
- lease 过期后拒绝 progress 和 lease update。
- 终态 `done|failed` 不因 `deadline_unix` 已经过期自动拒绝。
- lease 过期但 reconciliation 尚未标记 failed 前，Manager 上报 `done|failed` 可以由 State Finalization 接受。
- reconciliation 已将 operation 置为 failed 后，late `done` 视为 stale，不改变主状态。
- operation 进入 `done|failed` 后，不允许继续 `UpdateOperation` 改变终态。
- operation 进入 `done|failed` 后，Runtime Metadata 不能继续作为该 operation 的输出写入。

`UpdateLog`：

- 按 offset 追加已脱敏日志。
- 拒绝日志空洞。
- 要求匹配 `operation_uuid / codespace_uuid / generation`。
- `operation_uuid` 始终存在，不允许为空。
- 匹配 `operation.uuid`、`operation.manager_id`、`codespace.active_operation_id` 和 `codespace.generation`。
- 只允许 `operation.status=queued|running` 时追加日志。
- operation 进入 `done|failed` 后不允许继续追加日志。

`ReportRuntimeMetadata`：

- 只写 Runtime Metadata 到本地 cache。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`。
- 校验 `generation == codespace.generation`。
- 只接受 `booting|running|resuming|stopping` 状态写入。
- `queued|stopped|deleting|error` 拒绝写入 Runtime Metadata。
- stale generation 返回 stale，不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- `stopping` 写入只用于展示 stop 过程中的运行信息，不允许 open/SSH。
- Manager 启动后为所有仍由自己持有且处于 `booting|running|stopping|resuming` 的 codespace 重建 Runtime Metadata cache。
- Manager 运行期间周期刷新 active codespace 的 Runtime Metadata cache，避免 Gitea 重启或本地 cache 丢失后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅表示展示和 Endpoint existence check 信任 cache，不表示绕过 codespace 主状态校验。

`RequestGiteaToken`：

- 只允许 active create/resume operation 申请。
- 返回一次性明文 Gitea access token。

`ValidateOpenToken`：

- 校验并消费 Gateway Open Token。
- 返回校验后的 open binding。

`VerifySSHPassword` 与 `VerifySSHPublicKey`：

- 做 Gitea 侧认证和授权判定。
- 不返回长期凭据。

`ReportInstances`：

- Manager 重启后上报本地 Runtime Instance 集合。
- Gitea 检测状态分歧，并可返回 `manager_instruction=cleanup_local_runtime`。

所有 operation-bound RPC 都携带：

```text
operation_uuid
codespace_uuid
generation
```

Stale report 不改变当前状态。

### Operation Payload

`FetchOperation` 返回给 Manager 的 operation payload 基础字段：

```text
operation_uuid
operation_type
codespace_uuid
generation
ssh_user
lease_deadline_unix
```

`create|resume` payload 额外包含：

```text
repo_clone_url
repo_web_url
repo_tag
base_repo_clone_url
base_repo_web_url
head_repo_clone_url
head_repo_web_url
start_ref
ref_type
ref_name
commit_sha
pull_id
```

规则：

- `operation_type` 只允许 `create|resume|stop|delete`。
- `start_ref` 是 Manager 用于 fetch/checkout 的输入提示，最终 checkout 以 `commit_sha` 为准。
- 非 PR 场景下 `base_*` 与 `head_*` 可以为空。
- PR 场景下 `create|resume` payload 同时包含 base/head clone URL 与 web URL。
- `stop|delete` payload 不包含 repository clone/web URL、base/head URL、ref、commit 或 pull 字段。
- `delete` payload 不依赖 repository row 生成；repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Manager 删除 Runtime 只依赖 `codespace_uuid + generation` 的本地确定性映射。
- Gitea 不下发 `workspace_dir` 或 `manager_base_url`。
- Gitea 不下发 Runtime Instance ID、Runtime Instance name、镜像、资源、backend、mount、network 或 Endpoint upstream。
- Manager 使用 `codespace_uuid` 和 `generation` 在本地生成或查找 Runtime Instance 的确定性映射。
- Manager 创建 Runtime 时自己决定并注入 `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN`。
- `lease_deadline_unix` 是本次 claim/续租的截止时间，Manager 在截止前通过 `UpdateOperation` 续租或上报终态。
