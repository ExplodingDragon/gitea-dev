# 数据模型

## 数据表

Endpoint、port、Runtime Token、Git token、Gateway Open Token、quota、运行容量计数、Manager binding 等运行时数据，在已有表字段或本地 cache 中存储。

### codespace

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | 自增主键 | |
| `uuid` | 全局唯一标识 | |
| `user_id` | 创建者 user ID | 保持初次创建者身份；允许悬空引用，物理删除后不改写 |
| `repo_id` | 代码来源 repository ID | repository 存在时用于权限与展示；repository 删除 pre-cleanup 时置空 |
| `source_repository_state` | `available` / `deleted` / `unavailable` | repository 删除时写入 `deleted`；repository 暂时不可解析但未确认删除时展示为 `unavailable` |
| `ref_type` | `branch` / `tag` / `commit` / `pull` | |
| `ref_name` | ref 标识 | `branch` → 分支名（如 `main`）；`tag` → 标签名（如 `v1.0.0`）；`commit` → 完整 commit SHA；`pull` → Gitea 风格 PR ref 路径（如 `refs/pull/42/head`），PR 编号可从路径解析 |
| `repo_tag` | 从 `.gitea/codespace.yaml` 解析的 tag | create 时确定，后续不随仓库文件变化 |
| `commit_sha` | 锁定 commit SHA | |
| `manager_id` | 绑定 Manager ID | create 被领取前为 0，领取后固定 |
| `status` | 当前主状态 | |
| `operation_type` | `create` / `resume` / `stop` / `delete` | 当前 operation 类型 |
| `operation_status` | `queued` / `running` / `done` / `failed` | `running` 表示有正在执行的操作；stale detection、RPC 匹配和并发保护都以此为准 |
| `operation_deadline_unix` | lease 截止时间戳 | |
| `operation_finished_unix` | 完成时间戳 | |
| `operation_status_message` | 状态消息 | |
| `gitea_token_id` | 当前有效 Gitea access token ID | 为空表示当前没有有效 token |
| `last_active_unix` | 最近用户交互时间戳 | 成功 open Endpoint/SSH auth/resume 进入 running 后更新；`ReportRuntimeMetadata` 成功写入时更新；仅用于 UI 排序和清理参考，不用于权限判断 |
| `created_unix` | 创建时间戳 | |
| `updated_unix` | 更新时间戳 | |
| `stopped_unix` | 最近停止时间戳 | |
| `status_message` | 状态消息 | 最长 1024 字符，超长截断；输入清理控制字符，UI 按普通文本 escape 后展示 |
| `log_filename` | 日志文件名 | |
| `log_line_count` | 日志行数 | |
| `log_size` | 日志大小 | |
| `log_indexes` | 行号到 byte offset 索引 | LONGBLOB，varint 编码的 `[]int64`，用于按行 seek |
| `log_storage` | 日志存储位置 | 第一版固定为 `dbfs`；后续归档到对象存储时再扩展为 `object` |
| `log_expired` | 日志是否过期 | 列表页和非日志详情区只读取 `log_line_count / log_size / log_expired`；只有日志面板需要读取 DBFS 日志内容 |

日志元数据字段参考 Actions `ActionTask`（`models/actions/task.go`）。

repository owner 通过 `repository.owner_id` 表示，不在 codespace 表中重复存 `owner_id`。repository 删除后 `repo_id` 置空，`status_message` 表达 `source repository deleted`。这样设计是因为 codespace 的生命周期清理依赖 `codespace.uuid` 和 `manager_id`，不依赖 repository row；保留悬空 repository ID 不能恢复来源仓库，反而会让权限和展示逻辑多一层不可解析状态。

endpoint、boot、resource usage、internal SSH 和 last_reported 保存在本地 cache。

### codespace_manager

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | 自增主键 | |
| `name` | 名称 | |
| `admin_state` | `enabled` / `disabled` | 管理员控制的管理态：disabled Manager 保留已有任务的 stop/delete 和状态分歧上报能力；在线态由 `last_online_unix` 和 timeout 推导 |
| `secret_hash` | manager secret 哈希 | |
| `secret_salt` | 盐值 | |
| `tags_json` | 支持的 tags JSON | Manager 不按 owner/org/repo 分组 |
| `last_online_unix` | 最近在线时间戳 | |
| `created_by` | 创建者 user ID | |
| `created_unix` | 创建时间戳 | |
| `updated_unix` | 更新时间戳 | |
| `meta_json` | 诊断与扩展信息 JSON | 包含 `gateway_url`、`gateway_ssh_addr`、`last_capacity_total`、`last_capacity_available`、`backend_capabilities` 等 Manager 上报的动态元数据 |

### codespace_manager_token

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | 自增主键 | |
| `token` | 明文 Registration Token（唯一索引） | 注册凭据，创建或重置时展示一次 |
| `owner_id` | 创建者/拥有者 user ID | 0=全局，对齐 `action_runner_token` 的 `OwnerID` |
| `is_active` | 是否 active | 同一时间只能有一个 active token |
| `created` | 创建时间戳 | xorm auto |
| `updated` | 更新时间戳 | xorm auto |
| `deleted` | 软删除时间戳 | xorm auto |

设计与 `action_runner_token` 一致：明文存储，唯一索引。token 可复用，支持多个 Manager 用同一 token 注册。重置时旧 token `is_active=false`，不影响已注册 Manager 的 `manager_secret`。

## 索引

| 表 | 索引列 |
| --- | --- |
| codespace | `uuid`（唯一） |
| codespace | `(user_id, status)` |
| codespace | `(repo_id, status)`，仅覆盖 repository 存在的记录 |
| codespace | `(manager_id, status)` |
| codespace | `(manager_id, status, repo_tag)` |

## 本地 Cache

Gitea 本地 cache 只保存短期易失数据：

- `codespace:open-token:{token_hash}`（参见 [Gateway Open Token](glossary.md#gateway-open-token)）
- `codespace:runtime-meta:{codespace_id}`（参见 [Runtime Metadata](glossary.md#runtime-metadata)）

规则：

- cache 只影响交互能力和页面展示，不影响主状态权威。
- 主状态推进、权限闭环、删除闭环和 operation 超时闭环只依赖数据库。
- 一次性 token 校验通过本机锁串行化，使用 get → validate → delete 模式，cache 原生原子操作不是必需依赖。
- cache 内容都是短期、可失效或可由 Manager 重建的数据；丢失不影响 codespace 生命周期、权限、删除闭环或 operation 超时判断。
- 数据库仍是主状态和权限闭环的唯一持久权威。

## Runtime Metadata 结构

`ReportRuntimeMetadata` 只写当前 Runtime Metadata 快照。允许的结构：

```json
{
  "runtime": {
    "internal_ssh": {
      "host": "10.0.0.12",
      "port": 2222,
      "user": "coder",
      "auth_mode": "publickey",
      "host_key_fingerprint": "SHA256:..."
    }
  },
  "endpoints": [
    {
      "endpoint_id": "workspace",
      "label": "Workspace"
    },
    {
      "endpoint_id": "app-3000",
      "label": "App 3000"
    }
  ],
  "boot": {
    "stage": "run-init-script",
    "message": "running init script",
    "started_unix": 0,
    "last_update_unix": 0
  },
  "resource_usage": {
    "cpu": "unavailable",
    "memory": "unavailable",
    "disk": "unavailable",
    "network": "unavailable"
  },
  "last_reported_unix": 0
}
```

规则：

- `endpoints` 以 JSON 数组存储在 Runtime Metadata cache 中。
- `internal_ssh` 不在普通 UI/API 输出中暴露。
- `endpoint_id` 由 Manager 上报并确保在同一 `codespace_id` 内唯一。
- 不同 codespace 可以使用相同 `endpoint_id`。
- `label` 只用于 UI 展示，可以重复，不是路由键。
- `health` 作为 Endpoint 可选展示字段，仅用于 UI 展示。
- Runtime Metadata 保存在 Gitea 本地 cache。
- key：`codespace:runtime-meta:{codespace_id}`
- value：当前 `endpoints + internal_ssh + boot + resource_usage + last_reported_unix`
- ttl：`MANAGER_OFFLINE_TIMEOUT * 2`
- 只要所属 Manager 在线，Gitea 即信任当前 cache 中的 Runtime Metadata。
- Gitea 信任 Runtime Metadata cache 仅表示 Endpoint existence check 和 UI 展示信任当前 cache 内容。
- Gitea 重启或本地 cache 丢失后，Runtime Metadata 由 Manager 重建。
- Manager 离线时，新的 open 和 SSH 需要 Manager online 才能执行授权校验。
- resource usage 是可选展示信息。
- 缺失 resource usage 时显示 `unavailable`。
- Runtime Metadata 仅记录当前最新快照，cache miss 只影响交互与展示。
- Runtime Metadata 是动态观测数据，用于展示和交互入口。主状态由 operation finalization 和 reconciliation 写入，基于数据库状态推进。

## 日志存储

Codespace [Operation](glossary.md#operation) 日志存储在 DBFS（`models/dbfs/`，32KB 分块 + 乐观锁）。

路径：

```text
codespace_log/{codespace_uuid}.log
```

规则：

- Manager 通过 byte offset 追加，单文件连续写入。
- offset 等于当前大小时追加。
- offset 小于当前大小时，只允许幂等重放同一段内容。
- offset 大于当前大小时返回 offset gap 分类，保持日志文件连续。
- 每条存储日志都是已脱敏单行。
- 每行包含 timestamp 和 message。
- message 内部需要换行时，由日志渲染器按行号还原，存储层只接受单行字符串。
- 按 `log_indexes` 提供的行号到 byte offset 映射进行 seek 读取。
- `GET /codespace/{uuid}/logs` 使用 byte offset 分页读取，返回 `offset / next_offset / eof / lines / truncated`。
- delete 成功后删除 codespace 日志。
- `error` 日志保留到用户 delete 或 `FAILED_RETENTION_DAYS` 清理。
- 第一版不归档对象存储，`log_storage` 固定为 `dbfs`。

日志存储在 DBFS 单文件中，`codespace` 行保存当前日志元数据。`operation_status == running` 时允许追加日志。DBFS 支持 seek/read/write，适合运行中日志追加和页面轮询；第一版不引入对象存储归档，可以避免日志 transfer 状态影响生命周期状态机。
