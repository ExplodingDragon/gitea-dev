# 数据模型

## 数据表

Endpoint、port、Runtime Token、Git token、Gateway Open Token、quota、运行容量计数、Manager binding 等运行时数据，在已有表字段或本地 cache 中存储。

### codespace

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `uuid` | 主键，全局唯一标识 | 作为 codespace 的唯一持久 ID，Web 路由、RPC、日志路径和 Manager 本地 Runtime 映射都使用该值 |
| `user_id` | 创建者 user ID | 保持初次创建者身份；允许悬空引用，物理删除后不改写 |
| `repo_id` | 代码来源 repository ID | repository 存在时用于 create 来源展示和 token repo binding；repository 删除 pre-cleanup 时置空，空值即表示来源 repository 已不可再解析，codespace-bound token 对任何 repository 都不匹配 |
| `ref_type` | `branch` / `tag` / `commit` / `pull` | |
| `ref_name` | ref 标识 | `branch` → 分支名（如 `main`）；`tag` → 标签名（如 `v1.0.0`）；`commit` → 完整 commit SHA；`pull` → Gitea 风格 PR ref 路径（如 `refs/pull/42/head`），PR 编号可从路径解析 |
| `repo_tag` | 从 `.gitea/codespace.yaml` 解析的 tag | create 时确定，后续不随仓库文件变化 |
| `commit_sha` | 锁定 commit SHA | |
| `manager_id` | 绑定 Manager ID | create 被领取前为 0，领取后固定 |
| `status` | `creating` / `running` / `stopped` / `deleting` / `failed` | 当前资源主状态；排队、启动、停止中、恢复中等展示态由主状态和 operation 字段派生 |
| `operation_rversion` | Gitea 下发 operation 版本 | 每次创建或替换 Gitea-issued operation 时递增，用于 Manager 上报归属校验；Manager runtime transition 不递增 |
| `operation_type` | `create` / `resume` / `stop` / `delete` / 空 | 当前 active operation 类型；没有 active operation 时为空 |
| `operation_status` | `queued` / `running` / 空 | 只表达 active operation；完成后清空 |
| `operation_created_unix` | operation 创建时间戳 | 用户 create/resume/stop/delete 动作创建 operation 时写入 |
| `operation_started_unix` | operation 被领取时间戳 | Manager 通过 `FetchOperations` 成功领取时写入 |
| `operation_deadline_unix` | lease 截止时间戳 | Manager 领取和续租时更新；维护恢复窗口由 Manager 运行态推导，不写入 codespace 行 |
| `runtime_generation` | Manager 主动运行事实版本 | 初始为 0；绑定 Manager 每次主动 stop/resume 时递增，用于拒绝乱序 `ReportRuntimeTransition`，只保存最新版本 |
| `gitea_token_id` | 当前有效 Gitea access token ID | 为空表示当前没有有效 token；`creating/running` 可签发，进入 `stopped/failed/deleting` 或物理删除时吊销并清空 |
| `gitea_token` | 当前有效 Gitea access token 明文 | 只供绑定 Manager 通过 `RequestGiteaToken` 获取；不进入 Web/API/Minimal Info/日志/Runtime Metadata/Gateway Open Token |
| `last_active_unix` | 最近用户交互时间戳 | 成功 open Endpoint/SSH auth/resume 进入 running 后更新；仅用于 UI 排序和清理参考，不用于权限判断 |
| `created_unix` | 创建时间戳 | |
| `updated_unix` | 更新时间戳 | |
| `stopped_unix` | 最近停止时间戳 | |
| `log_filename` | 日志文件名 | |
| `log_line_count` | 日志行数 | |
| `log_size` | 日志大小 | |
| `log_indexes` | 行号到 byte offset 索引 | LONGBLOB，varint 编码的 `[]int64`，用于按行 seek |
| `log_storage` | 日志存储位置 | 第一版固定为 `dbfs`；后续归档到对象存储时再扩展为 `object` |

日志元数据字段参考 Actions `ActionTask`（`models/actions/task.go`）。

repository owner 通过 `repository.owner_id` 表示，不在 codespace 表中重复存 `owner_id`。repository 删除后 `repo_id` 置空，空 `repo_id` 即来源 repository 已不可解析的机器状态。create operation 完成、workspace 已初始化后，codespace 按 `codespace.uuid`、`user_id` 和 `manager_id` 管理生命周期与交互入口，不依赖 repository row；保留悬空 repository ID 不能恢复来源仓库，反而会让展示逻辑多一层不可解析状态。repo-bound token 在 `repo_id` 为空时拒绝所有 repository 访问。

endpoint、boot、resource usage、internal SSH 和 last_reported 保存在本地 cache。

### codespace_manager

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | 自增主键 | |
| `name` | 名称 | |
| `owner_id` | Manager owner scope | `0` 表示 global；非 0 表示 Gitea owner 的 `user.id`，owner 可以是个人用户或组织 |
| `admin_state` | `enabled` / `disabled` | 管理员控制的管理态：disabled Manager 保留已有任务的 stop/delete 和状态分歧上报能力；在线态由 `last_online_unix` 和 timeout 推导 |
| `secret_hash` | manager secret 哈希 | |
| `secret_salt` | 盐值 | |
| `tags_json` | 支持的 tags JSON | Manager owner scope 由 `owner_id` 表达，运行能力由 tags 表达 |
| `runtime_state` | `online` / `recovering` / `offline` | Manager 维护恢复运行态（Manager 只能上报 `online` 或 `recovering`；`offline` 由 Gitea 根据 `last_online_unix` + timeout 推导）。proto `DeclareManagerRequest` 中对应字段名为 `manager_runtime_state` |
| `last_online_unix` | 最近在线时间戳 | |
| `last_recovering_unix` | 最近进入 recovering 时间戳 | Manager 启动恢复、Runtime scan 或 metadata rebuild 开始时更新 |
| `last_recovered_unix` | 最近恢复完成时间戳 | Manager 完成本地 Runtime scan 和 Runtime Metadata 重建后更新 |
| `inventory_generation` | 最近接受的完整 Runtime inventory 版本 | 初始为 0；更高版本驱动差异计算，相同版本幂等忽略，更低版本拒绝，避免延迟旧快照触发错误的 missing 判定 |
| `created_by` | 创建者 user ID | |
| `created_unix` | 创建时间戳 | |
| `updated_unix` | 更新时间戳 | |
| `meta_json` | Manager metadata JSON | 包含 Gateway 地址、SSH 安全展示信息、容量快照和 backend 能力 |

### codespace_manager_token

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | 自增主键 | |
| `token` | 明文 Registration Token（唯一索引） | 注册入口凭据，设置页展示给管理员 |
| `owner_id` | Registration Token owner scope | `0` 表示 global；非 0 表示 Gitea owner 的 `user.id`，owner 可以是个人用户或组织 |
| `is_active` | 是否 active | 同一时间只能有一个 active token |
| `created` | 创建时间戳 | xorm auto（与 `action_runner_token` 一致，不使用 `_unix` 后缀） |
| `updated` | 更新时间戳 | xorm auto |
| `deleted` | 软删除时间戳 | xorm auto |

设计与 `action_runner_token` 一致：明文存储，唯一索引。token 可复用，支持多个 Manager 用同一 token 注册。`owner_id` 与 Gitea repository owner 语义一致，组织是 `user` 表中 `type=organization` 的 owner 记录。

实现验收点：

- 数据迁移创建文中列出的真实字段、非空默认值和枚举约束。
- active operation 完成后 operation 字段清空，`operation_rversion` 和最新事实 generation 保留当前值。
- token ID 与明文字段在生命周期事务中同时写入或同时清空。

## Manager Metadata 结构

`codespace_manager.meta_json` 保存 Manager 上报的展示和诊断信息。固定结构：

```json
{
  "gateway_url": "https://codespace.example.com",
  "gateway_ssh_addr": "ssh.codespace.example.com:22",
  "gateway_ssh_host_key_algorithm": "ssh-ed25519",
  "gateway_ssh_host_key_fingerprint_sha256": "SHA256:...",
  "gateway_ssh_host_key_updated_unix": 0,
  "last_capacity_total": 10,
  "last_capacity_available": 3,
  "backend_capabilities": "incus,docker"
}
```

规则：

- `gateway_ssh_host_key_fingerprint_sha256` 是用户首次 SSH 连接前可展示和核对的 Gateway SSH host key 指纹。
- `gateway_ssh_host_key_algorithm` 与 fingerprint 一起展示，避免用户只看到裸 hash。
- `gateway_ssh_host_key_updated_unix` 用于提示 host key 轮换时间。
- Manager 每次 `DeclareManager` 覆盖写入当前 metadata。
- Gitea 不在普通 codespace 列表接口返回完整 `meta_json`；需要展示 SSH 连接信息的页面按权限读取必要字段。

实现验收点：

- Declare metadata 经过固定 key 校验后覆盖写入规范化 JSON。
- 管理页面可展示 Gateway SSH algorithm、SHA256 fingerprint 和更新时间。
- 容量快照只用于展示与诊断，不参与后续 Fetch 领取判断。

## 索引

| 表 | 索引列 |
| --- | --- |
| codespace | `uuid`（主键） |
| codespace | `(user_id, status)` |
| codespace | `(repo_id, status)`，仅覆盖 repository 存在的记录 |
| codespace | `(status, operation_type, operation_status, manager_id, repo_tag)`，用于 create 批量领取 |
| codespace | `(manager_id, operation_type, operation_status, status)`，用于 stop/resume/delete 领取和 active operation 扫描 |
| codespace_manager | `(owner_id, admin_state)` |
| codespace_manager | `(owner_id, runtime_state)` |
| codespace_manager_token | `token`（唯一） |
| codespace_manager_token | `(owner_id, is_active)` |

实现验收点：

- queued create 和已绑定 operation 查询使用对应复合索引，不依赖 JSON SQL 匹配。
- token、UUID 的唯一索引阻止重复记录。

## 本地 Cache

Gitea 本地 cache 只保存短期易失数据：

- `codespace:open-code:{code_hash}`（一次性的 authorization code 校验缓存，参见 [Gateway Open Token](glossary.md#gateway-open-token)）
- `codespace:runtime-meta:{codespace_uuid}`（当前 Endpoint、internal SSH 和 boot 动态快照，参见 [Runtime Metadata](glossary.md#runtime-metadata)）

规则：

- cache 只影响交互能力和页面展示，不影响主状态。
- 主状态推进、权限判断、删除处理和 operation 超时处理只依赖数据库。
- 一次性 token 校验通过本机锁串行化，使用 get → validate → delete 模式，cache 原生原子操作不是必需依赖。
- cache 内容都是短期、可失效或可由 Manager 重建的数据；丢失不影响 codespace 生命周期、权限、删除处理或 operation 超时判断。
- 主状态和权限相关的持久数据都以数据库为准。

实现验收点：

- 清空本地 cache 后 codespace 主状态、active operation、token binding 和日志仍可从数据库恢复。
- open code cache 丢失只使未消费 code 失效，Runtime Metadata cache 丢失只暂时影响交互和展示。

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
    "started_unix": 0,
    "last_update_unix": 0
  },
  "last_reported_unix": 0
}
```

规则：

- `endpoints` 以 JSON 数组存储在 Runtime Metadata cache 中。
- `internal_ssh` 不在普通 UI/API 输出中暴露。
- `endpoint_id` 由 Manager 上报，并在同一 `codespace_uuid` 内保持唯一。
- 不同 codespace 可以使用相同 `endpoint_id`。
- `label` 只用于 UI 展示，可以重复，不是路由键。
- Runtime Metadata 保存在 Gitea 本地 cache。
- key：`codespace:runtime-meta:{codespace_uuid}`
- value：当前 `endpoints + internal_ssh + boot + last_reported_unix`，以及 request envelope 中的 `metadata_generation`
- ttl：`MANAGER_OFFLINE_TIMEOUT * 2`
- 只要所属 Manager 在线，Gitea 即信任当前 cache 中的 Runtime Metadata。
- Gitea 信任 Runtime Metadata cache 仅表示 Endpoint existence check 和 UI 展示信任当前 cache 内容。
- Gitea 重启或本地 cache 丢失后，Runtime Metadata 由 Manager 重建。
- Manager 离线时，新的 open 和 SSH 需要 Manager online 才能执行授权校验。
- Runtime Metadata 仅记录当前最新快照，cache miss 只影响交互与展示。
- `metadata_generation` 由 Manager 按 codespace 单调递增；相同版本幂等返回且不覆盖 cache，更低版本拒绝。
- Runtime Metadata 是动态运行信息，用于展示和交互入口。主状态由 operation 状态写入和 reconciliation 处理，推进依据来自数据库状态。

实现验收点：

- metadata generation 相同的重试幂等，更低 generation 不覆盖 cache。
- endpoint ID 在单个 codespace 内唯一，internal SSH 不进入普通 UI/API。
- cache TTL 刷新不改写 `last_active_unix` 或主状态。

## 日志存储

Codespace [Operation](glossary.md#operation) 日志存储在 DBFS（`models/dbfs/`，32KB 分块 + 乐观锁）。

路径：

```text
codespace_log/{codespace_uuid}.log
```

规则：

- Manager 通过 byte offset 追加，单文件连续写入。
- Gitea 服务层可以在 create 前置校验和最终状态收敛时通过内部入口追加摘要；该入口与 Manager 写入使用同一 offset 事务和日志元数据。
- offset 等于当前大小时追加。
- offset 小于当前大小时，只允许幂等重放同一段内容。
- offset 大于当前大小时返回 offset gap 分类，保持日志文件连续。
- 每条存储日志都是已脱敏单行。
- 每行包含 timestamp 和 message。
- message 内部需要换行时，由日志渲染器按行号还原，存储层只接受单行字符串。
- 按 `log_indexes` 提供的行号到 byte offset 映射进行 seek 读取。
- `GET /codespace/{uuid}/logs` 使用 byte offset 分页读取，返回 `offset / next_offset / eof / lines / truncated`。
- delete 成功后删除 codespace 日志。
- `failed` 日志保留到用户 delete 或 `FAILED_RETENTION_DAYS` 清理。
- 第一版不归档对象存储，`log_storage` 固定为 `dbfs`。

日志存储在 DBFS 单文件中，`codespace` 行保存当前日志元数据。只有当前 `operation_status=running` 且 `operation_rversion` 匹配时允许追加日志。第一版不引入对象存储归档，避免日志 transfer 状态影响生命周期状态机。

实现验收点：

- `runtime_generation` 和 `inventory_generation` 均为非空、初始值为 0 的当前版本字段，不保存历史记录。
- repository 删除后 `repo_id` 置空，其他持久字段与主状态保持不变。
- Runtime Metadata cache 只接受不低于当前 `metadata_generation` 的快照。
- codespace 日志按单文件连续 offset 追加，并随 codespace 物理删除或 failed retention 清理。
