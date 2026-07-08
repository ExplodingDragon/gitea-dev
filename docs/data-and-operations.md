# 数据模型与运维

## 数据模型

数据表：

- `codespace_manager_registration_secret`
- `codespace_manager`
- `codespace`
- `codespace_operation`

不为 Endpoint、port、Runtime Token、Git token、Gateway Open Token、quota、运行容量计数或 Manager binding 建独立表。

### codespace_manager_registration_secret

```text
id
secret_hash
secret_salt
is_active
expires_unix
created_by
created_unix
updated_unix
consumed_unix
```

说明：

- registration secret 明文只在创建或重置时展示一次。
- 同一时间只能有一个 active 且未消费 registration secret。
- 重置 registration secret 只会使旧的未消费 registration secret inactive。

### codespace_manager

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

说明：

- Manager 不按 owner、organization 或 repository 分组。
- `tags_json` 存放该 Manager 当前声明支持的 tags。
- `gateway_url` 存放用户 Endpoint 入口地址。
- `gateway_ssh_addr` 存放用户 SSH 入口地址。
- `gateway_internal_ssh_public_key` 是 Gateway 连接 Runtime Instance 内部 sshd 的固定公钥。
- `admin_state` 只表示管理态，不表示在线态。
- `last_capacity_total / last_capacity_available` 是 Manager 最近通过 `DeclareManager` 或 `FetchOperation` 上报的容量快照，用于 UI、诊断和 `FetchOperation` 准入检查；不是 Gitea 运行容量计数，不会因 claim、`done|failed` 或 timeout 自动变化。
- `meta_json` 只存放诊断与扩展信息，例如 `backend_capabilities`。

### codespace

```text
id
uuid
user_id
repo_id
ref_type=branch|tag|commit|pull
ref_name
repo_tag
commit_sha
pull_id
manager_id
ssh_user
ssh_password_auth_allowed
status
active_operation_id
generation
gitea_token_id
last_active_unix
created_unix
updated_unix
stopped_unix
status_message
```

说明：

- `user_id` 表示创建该 codespace 的历史创建者 Gitea user id。
- `user_id` 允许悬空引用；创建者被物理删除后不改写、不重分配。
- `repo_id` 表示代码来源 repository，不表示删除检查归属。
- `repo_id` 允许在 source repository 物理删除后成为历史引用；repository 解析不到时显示 `source repository deleted`。
- repository owner 仍通过 `repository.owner_id` 表示，不在 codespace 表中重复存 `owner_id`。
- `repo_tag` 表示 create 时从 `.gitea/codespace.yaml` 解析出的 tag，后续不随仓库文件变化而改变。
- `ssh_user` 全局唯一，插入唯一索引冲突时重试生成。
- `ssh_user` delete 后不复用。
- `ssh_password_auth_allowed` 表示该 codespace 是否允许 SSH 密码认证，由 Gitea 创建服务层写入，默认值来自站点策略。
- create operation 被领取前 `manager_id=0`。
- create operation 被领取后 `manager_id` 固定，后续 stop、resume、delete 都回到该 Manager。
- `generation` 每次创建新的 active operation 时递增，用于拒绝 Stale Report。
- `active_operation_id` 只表示当前未完成 lifecycle operation；operation 进入 `done|failed` 并完成 State Finalization 后清空。
- `gitea_token_id` 表示当前有效的 Gitea access token 标识，用于精确吊销；为空表示当前没有有效 token。
- `last_active_unix` 只记录用户交互，不记录 Manager heartbeat。
- 成功 open Endpoint、成功 SSH auth/session 建立、resume 成功进入 `running` 后更新 `last_active_unix`。
- Runtime Metadata refresh、DeclareManager、UpdateLog、stop、delete 和 error 不更新 `last_active_unix`。
- `last_active_unix` 只用于 UI 排序和清理参考，不用于权限或状态判断。
- `status_message` 最长 1024 字符，超长截断，禁止控制字符。
- `status_message` UI 按普通文本 escape 后展示。
- endpoint、boot、resource usage、internal SSH 和 last_reported 不持久化到 `codespace`，只保存在本地 cache。

索引：

- `uuid`
- `(user_id, status)`
- `(repo_id, status)`
- `(manager_id, status)`
- `(manager_id, status, repo_tag)`
- `(ssh_user)`

### codespace_operation

```text
id
uuid
codespace_id
manager_id
generation
type=create|resume|stop|delete
status=queued|running|done|failed
deadline_unix
created_unix
updated_unix
finished_unix
status_message
log_filename
log_line_count
log_size
last_log_unix
log_expired
```

说明：

- create operation 被领取前 `manager_id=0`。
- create operation 被领取时与 `codespace.manager_id` 在同一事务中写入。
- resume、stop、delete operation 从创建时就绑定既有 `codespace.manager_id`。
- `log_size` 是按 offset 增量读取日志的必要元数据。
- 列表页和非日志详情区只读取 `log_line_count / log_size / last_log_unix / log_expired`。
- 只有日志面板需要读取 DBFS 日志内容。

索引：

- `uuid`
- `(manager_id, status, type)`
- `(codespace_id, generation)`

## 本地 Cache

Gitea 本地 cache 只保存短期易失数据：

- `codespace:open-token:{token_hash}`
- `codespace:runtime-meta:{codespace_uuid}:{generation}`

规则：

- cache 只影响交互能力和页面展示，不影响主状态权威。
- 主状态推进、权限闭环、删除闭环和 operation 超时闭环只依赖数据库。
- 一次性 token 校验通过本机锁串行化，不依赖 cache 原生原子操作。
- cache 内容都是短期、可失效或可由 Manager 重建的数据；丢失不影响 codespace 生命周期、权限、删除闭环或 operation 超时判断。
- 数据库仍是主状态和权限闭环的唯一持久权威。

## 日志

Codespace operation 日志存储在 DBFS（`models/dbfs/`，32KB 分块 + 乐观锁）。

路径：

```text
codespace_log/
  {manager_id}/
    {codespace_uuid}/
      {operation_uuid}.log
```

规则：

- append-only
- 每条存储日志都是已脱敏单行
- 每行包含 timestamp 和 message
- message 内部不允许真实换行
- 按 cursor/offset 读取
- delete 成功后删除 codespace 日志
- `error` 日志保留到用户 delete 或 failed cleanup

日志文件以 `operation_uuid` 命名，因为 Gitea 只保存 lifecycle operation 执行期日志。日志元数据归属 `codespace_operation`，running 期间没有未完成 operation 时不追加 Gitea operation log。

日志命令：

- `::group::title`
- `::endgroup::`
- `##[group]title`
- `##[endgroup]`
- `::error::message`
- `::warning::message`
- `::notice::message`
- `::debug::message`
- `##[command]command`
- `[command]command`

Codespace 日志 UI 复用 Actions console 解析和渲染能力，不复制一套解析逻辑。

日志来源：

- Gitea 只保存一套 codespace operation 上报日志，不引入 runtime log、connection log 或 audit log 等多套日志。
- Manager 本地日志只用于 Manager/Gateway 排障，不上报 Gitea。
- `UpdateLog` 是唯一上报入口，始终绑定当前 `operation_uuid`。
- create/resume/stop/delete lifecycle operation 执行期间的 boot、init、git、Endpoint 初始化、stop、resume、delete 阶段日志写入对应 operation log。
- operation 进入 `done|failed` 后，Manager 不再拥有该 operation 的执行上下文，不能继续通过该 `operation_uuid` 写日志。
- running 期间 open token 连接成功、SSH 连接成功、session 正常关闭、Endpoint 后续变化和用户可见运行异常不写入 Gitea operation log。
- running 期间连接成功通过 `last_active_unix` 记录用户活跃时间；详细连接事件写 Manager/Gateway 本地日志。
- open token 校验失败、SSH 密码/TOTP/公钥失败、限流、扫描、爆破、Gateway proxy debug、backend driver debug、heartbeat、空 pull、health poll 明细和内部 retry 细节只写 Manager/Gateway 本地日志。

设计决策：

- operation log 是生命周期操作的执行证据，在 operation 完成前封闭，避免终态之后继续改变该 operation 的可见输出。
- running 期间没有未完成 lifecycle operation；为连接事件引入空 `operation_uuid`、长期 runtime operation 或第二套 Gitea 日志都会扩大状态模型。
- Gitea 对运行期连接只需要保存授权结果影响到的权威状态（如 `last_active_unix`）；排障细节属于 Manager/Gateway 本地日志。

脱敏：

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
- 没有 `active_operation_id` 时，不存在 Gitea operation 日志追加入口。

operation 日志元数据：

```text
log_filename
log_line_count
log_size
last_log_unix
log_expired
```

## Cron Jobs

```text
reconcile_codespace_operations
cleanup_failed_codespaces
cleanup_codespace_logs
```

`reconcile_codespace_operations`：

- 默认每分钟运行。
- 处理中间态超时、Manager offline timeout、stale operation、token 吊销和状态分歧。

`cleanup_failed_codespaces`：

- 默认每天运行。
- 清理长期保留的 `error` 记录和日志。
- 清理过期或已消费且超过保留期的 registration secret。

`cleanup_codespace_logs`：

- 默认每天运行。
- 清理已完成 operation 的过期日志。

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
SSH_PASSWORD_AUTH_ALLOWED = true
LOG_MAX_LINE_SIZE = 64KiB
LOG_RETENTION_DAYS = 365
FAILED_RETENTION_DAYS = 365
REGISTRATION_SECRET_EXPIRE = 24h

[cron.reconcile_codespace_operations]
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

- `OPEN_TOKEN_EXPIRE` 是 Gateway Open Token 的有效期和 Gitea cache TTL。
- `SSH_PASSWORD_AUTH_ALLOWED` 是新建 codespace 的默认内部策略值，可由 Gitea 服务层按站点策略进一步收紧。
- SSH 认证限流与退避属于 Gateway 配置，不属于 Gitea 配置。
- `OPERATION_LEASE_TIMEOUT` 是 Manager claim/续租 operation 的 lease 时长。
- `REGISTRATION_SECRET_EXPIRE` 是 registration secret 的有效期。
- registration secret 清理不新增独立 cron，由 `cleanup_failed_codespaces` 处理。

不存在 `[codespace.quota]` 配置。

Manager 本地配置由 Manager 自己管理，例如：

```text
/etc/gitea-codespace/manager.yaml
/etc/gitea-codespace/manager.json
```

Manager 本地配置保存 tag 到 backend 的映射，以及 Incus/Docker 配置、镜像、资源、网络、挂载、bootstrap、DinD 策略。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。

## 代码组织

Gitea 侧代码按以下方向拆分：

```text
routers/api/codespace/manager.go
routers/web/codespace/repo.go
routers/web/codespace/user.go
services/codespace/
models/codespace/
modules/codespace/
```

Web handler 与 ManagerService RPC handler 不应混在同一个文件。

Runtime HTTP API 属于 Manager，不属于 Gitea route。

## 实现约束

本文档是最终设计基线。

- 不兼容旧 codespace prototype route、proto name、table 或 runtime option form。
- 删除旧 codespace port table 行为。
- 删除前端 runtime 选型输入。
- 删除 `/codespace/{uuid}/create`、`retry`、`cancel`。
- 删除旧 `initializing` 状态。
- 删除旧 task 术语。
- 删除所有 quota 设计和实现。
- 复用 Gitea 现有 permission、token、SSH key、TOTP、setting、cron、routing、DBFS 和测试组织方式。

实现完成后的最低验证：

```bash
cd gitea
go test ./...
make fmt
make lint-backend
```
