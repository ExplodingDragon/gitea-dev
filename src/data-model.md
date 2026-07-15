# 数据模型

## 数据表

Gitea 数据库保存 Codespace/Manager binding、生命周期结果和当前 Git token；Gitea cache 保存 Runtime Metadata 与 Gateway Open Token；Endpoint port、Runtime Token、backend 状态和实时容量由 Manager 管理。当前设计不增加 Gitea quota 或运行容量计数表。

### codespace

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `uuid` | `CHAR(36)`，主键 | 全局唯一持久 ID；Web 路由、RPC、日志路径和 Manager 本地 Runtime 映射都使用该值 |
| `user_id` | `BIGINT NOT NULL DEFAULT 0` | 创建者 user ID；有效 codespace 创建时必须大于 0，用户删除事务会物理删除关联记录 |
| `repo_id` | `BIGINT NOT NULL DEFAULT 0` | 大于 0 时用于 create 来源展示和 token repo binding；repository 删除 pre-cleanup 时写为 0 |
| `ref_type` | `VARCHAR(16) NOT NULL DEFAULT ''` | 有效记录只允许 `branch` / `tag` / `commit` / `pull` |
| `ref_name` | `TEXT NOT NULL` | branch/tag/commit 标识或规范化 PR ref 路径 |
| `repo_tag` | `VARCHAR(64) NOT NULL DEFAULT 'default'` | create 时确定，后续不随仓库文件变化 |
| `commit_sha` | `VARCHAR(64) NOT NULL DEFAULT ''` | create 前置校验完成后必须为完整锁定 commit SHA |
| `manager_id` | `BIGINT NOT NULL DEFAULT 0` | create 被领取前为 0，领取后固定 |
| `status` | `VARCHAR(16) NOT NULL DEFAULT ''` | 有效记录只允许五个持久主状态 |
| `operation_rversion` | `BIGINT NOT NULL DEFAULT 0` | 创建或替换 Gitea-issued operation 时递增；Manager runtime transition 不递增 |
| `operation_type` | `VARCHAR(16) NOT NULL DEFAULT ''` | 当前 active operation 类型；无 active operation 时为空字符串 |
| `operation_status` | `VARCHAR(16) NOT NULL DEFAULT ''` | `queued` / `running`；无 active operation 时为空字符串 |
| `operation_created_unix` | `BIGINT NOT NULL DEFAULT 0` | 无 active operation 时为 0 |
| `operation_started_unix` | `BIGINT NOT NULL DEFAULT 0` | queued 或无 active operation 时为 0 |
| `operation_deadline_unix` | `BIGINT NOT NULL DEFAULT 0` | running lease 截止时间；其他状态为 0 |
| `runtime_generation` | `BIGINT NOT NULL DEFAULT 0` | Manager 主动运行事实版本，只保存最新值 |
| `gitea_token_id` | `BIGINT NOT NULL DEFAULT 0` | 当前有效 Gitea access token ID；0 表示当前没有有效 token；`creating/running` 可签发，进入 `stopped/failed/deleting` 或物理删除时吊销并写回 0 |
| `gitea_token` | `TEXT NOT NULL` | 当前有效 Gitea access token 明文；迁移默认写入空字符串，只供绑定 Manager 通过 `RequestGiteaToken` 获取；空字符串表示无 token，不进入 Web/API/Minimal Info/日志/Runtime Metadata/Gateway Open Token |
| `last_active_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近成功记录的用户交互；仅用于 UI 排序和清理参考，写入失败不阻断访问 |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 创建时间戳 |
| `updated_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近一次持久生命周期结果变化时间；进入 failed 时作为 retention 起点 |
| `stopped_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近停止时间戳，未停止过时为 0 |
| `log_filename` | `VARCHAR(255) NOT NULL DEFAULT ''` | 日志文件名 |
| `log_line_count` | `BIGINT NOT NULL DEFAULT 0` | 日志物理行数 |
| `log_size` | `BIGINT NOT NULL DEFAULT 0` | 日志规范化字节数 |
| `log_indexes` | `LONGBLOB NOT NULL` | 迁移默认写入空 blob；varint 编码的 `[]int64`，用于按行 seek |

日志元数据字段参考 Actions `ActionTask`（`models/actions/task.go`）。

repository owner 通过 `repository.owner_id` 表示，不在 codespace 表中重复存 `owner_id`。repository 删除后 `repo_id` 写为 0，这是 Gitea ID 字段常用的未绑定表达，也避免依赖各数据库实现不同的 nullable/partial-index 行为。create operation 完成、workspace 已初始化后，codespace 按 `codespace.uuid`、`user_id` 和 `manager_id` 管理生命周期与交互入口，不依赖 repository row；保留悬空 repository ID 不能恢复来源仓库。repo-bound token 在 `repo_id=0` 时拒绝所有 repository 访问。用户或组织删除在任何 owner repository 删除前，通过现有 `user_id`、`repo_id -> repository.owner_id` 和 `manager_id -> codespace_manager.owner_id` 收集关联 Codespace，并在独立前置清理事务中删除 Gitea 资源，因此不需要增加冗余 owner 字段。repository 此前已单独删除时，`repo_id=0` 表示与原 repository owner 的关系已经有意丢弃，后续只按创建者和 Manager owner 关系处理。

`operation_rversion`、`runtime_generation` 和 `inventory_generation` 的 0 值只是尚未产生版本的持久化初始值，首个有效值为 1。服务层和 Manager 递增这些有符号 `BIGINT` 时使用 checked increment，不回绕到 0 或负数。Gitea 在 `operation_rversion` 已到上限时以 `state_unavailable` 拒绝新 operation，不写主状态或 active operation 的部分结果。Manager 本地 generation 已到上限时保留当前值并进入 recovering，不产生新版本；已持久化的相同 generation 幂等重试仍可继续。`runtime_generation` 仅保存当前值；相同 generation 的幂等以 fact 目标主状态是否已成立判定，不需要再增加历史 fact 类型字段。

`updated_unix` 只表示数据库中的生命周期结果发生变化。创建记录时与 `created_unix` 同值；创建或替换 active operation、首次 final/timeout/missing/transition 改变主状态时写为当前时间。claim、lease 续租、日志、Runtime Metadata、token 读取或修复、open、SSH、相同结果的幂等重试，以及 repository 删除时仅把 `repo_id` 写为 0，都不更新该字段。这样 failed retention 有稳定起点，调度和交互活动也不会被误解为生命周期变化；用户活动继续只写 `last_active_unix`。

endpoint、boot、resource usage、internal SSH 和 last_reported 保存在 Gitea cache。

### codespace_manager

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | `BIGINT` 自增主键 | |
| `name` | `VARCHAR(255) NOT NULL DEFAULT ''` | 展示名称，不要求唯一 |
| `owner_id` | `BIGINT NOT NULL DEFAULT 0` | Manager owner scope |
| `admin_state` | `VARCHAR(16) NOT NULL DEFAULT 'enabled'` | `enabled` / `disabled` |
| `secret_hash` | `VARCHAR(64) NOT NULL DEFAULT ''` | SHA-256 hex verifier |
| `secret_salt` | `VARCHAR(32) NOT NULL DEFAULT ''` | 16 随机字节的 hex 编码 |
| `tags_json` | `TEXT NOT NULL` | 规范化、去重后的 tags JSON 数组 |
| `runtime_state` | `VARCHAR(16) NOT NULL DEFAULT 'recovering'` | 只保存 `online` / `recovering`，offline 实时派生 |
| `last_online_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近成功 Declare 时间 |
| `last_recovering_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近一次恢复窗口起点 |
| `last_recovered_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近恢复完成时间 |
| `inventory_generation` | `BIGINT NOT NULL DEFAULT 0` | 最近接受的完整 inventory 版本 |
| `inventory_hash` | `VARCHAR(64) NOT NULL DEFAULT ''` | 最近接受的规范化 inventory SHA-256 |
| `created_by` | `BIGINT NOT NULL DEFAULT 0` | 创建者 user ID，允许后续悬空 |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 创建时间 |
| `meta_json` | `TEXT NOT NULL` | Gitea 生成的规范化 Manager metadata JSON |

Manager secret 固定为 32 个随机字节的 64 位小写十六进制字符串，salt 为 16 个随机字节的 32 位小写十六进制字符串；`secret_hash` 固定保存 `hex(SHA-256(salt_bytes || secret_bytes))`。明确按解码后的字节计算，可以让注册、认证和轮换使用同一算法，避免实现分别拼接文本得到不同 verifier。

Manager 删除由服务层先按 `codespace.manager_id` 收集并删除绑定 Codespace，再删除 Manager row；不保留 Manager tombstone、删除中字段或远端回收状态。这样数据库只表达 Gitea 当前仍管理的对象，运行侧残留不会反向成为 Gitea 数据模型的一部分。

### codespace_manager_token

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | `BIGINT` 自增主键 | |
| `token` | `VARCHAR(64) NOT NULL`，唯一索引 | 32 随机字节的 hex 编码明文 |
| `owner_id` | `BIGINT NOT NULL DEFAULT 0` | Registration Token owner scope |
| `is_active` | `BOOLEAN NOT NULL DEFAULT true` | 同一 `owner_id` 同一时间只能有一个 active token |
| `created` | 创建时间戳 | xorm auto（与 `action_runner_token` 一致，不使用 `_unix` 后缀） |
| `updated` | 更新时间戳 | xorm auto |
| `deleted` | 软删除时间戳 | xorm auto |

设计与 `action_runner_token` 一致：明文存储，唯一索引。token 可复用，支持多个 Manager 用同一 token 注册。`owner_id` 与 Gitea repository owner 语义一致，组织是 `user` 表中 `type=organization` 的 owner 记录。

实现验收点：

- 数据迁移创建文中列出的真实字段和非空默认值；模型校验只允许文中列出的状态、operation 类型和运行态值。
- active operation 完成后 operation 字段清空，`operation_rversion` 和最新事实 generation 保留当前值。
- operation 与 generation 的 0 值只用于未初始化，有效版本从 1 开始，递增不会溢出回绕。
- operation 版本耗尽时不产生部分写入，Manager generation 耗尽时不产生新版本，两者都保留当前值。
- token ID 与明文字段在生命周期事务中同时写入或同时清空。
- `gitea_token_id=0` 时 `gitea_token` 必须为空字符串；非零 token ID 只能被一个 codespace 绑定。
- `inventory_generation/inventory_hash` 同事务更新；相同 generation 只有 hash 相同时才作为幂等重试。
- inventory 规范化按 `codespace_uuid` 排序，hash 包含 UUID、runtime state 和 observed operation version。
- Manager secret 的长度、hex 格式和 `SHA-256(salt_bytes || secret_bytes)` 计算在注册、认证和轮换路径一致。
- 用户或组织删除在 repository 删除前通过现有关系完成前置清理；已经为 0 的 `repo_id` 不保留原 owner 历史，也不需要新增冗余 owner 字段。
- Manager 删除物理清理绑定 Codespace 和 Manager row，不新增删除状态、墓碑或远端确认字段。

## Manager Metadata 结构

`codespace_manager.meta_json` 保存 Gitea 根据 `DeclareManager` 明确类型字段生成的展示和诊断信息。固定结构：

```json
{
  "version": "1.0.0",
  "gateway_url": "https://codespace.example.com",
  "gateway_ssh_addr": "ssh.codespace.example.com:22",
  "gateway_ssh_host_key_algorithm": "ssh-ed25519",
  "gateway_ssh_host_key_fingerprint_sha256": "SHA256:...",
  "gateway_ssh_host_key_updated_unix": 0,
  "last_capacity_total": 10,
  "last_capacity_available": 3,
  "backend_capabilities": ["incus", "docker"]
}
```

规则：

- `version` 是 Manager 当前软件版本，用于管理页面展示和兼容性诊断，不参与 operation 领取。
- `gateway_url` 保存 Gateway 的 scheme、DNS base domain 和可选 port，例如 `https://codespace.example.com`；它不保存业务 path。Gitea 用它派生单层 wildcard 下的 workspace 与普通 Endpoint host。
- `gateway_url` 规范化后在 Manager 间唯一。该值已经位于 `meta_json`，首次 Declare 或变更时由服务层取得 `codespace_manager_addresses` global lock 后检查，不为此增加重复数据库字段；唯一 origin 保证派生 host 只路由到持有对应 Runtime 映射的 Manager deployment。
- `gateway_ssh_addr` 由 Manager 当前配置声明，规范化 `host:port` 后在 Manager 间唯一；当前架构没有共享 SSH 路由层，因此相同地址不能映射到两份独立 Runtime 本地映射。
- `gateway_ssh_host_key_fingerprint_sha256` 是用户首次 SSH 连接前可展示和核对的 Gateway SSH host key 指纹。
- `gateway_ssh_host_key_algorithm` 与 fingerprint 一起展示，避免用户只看到裸 hash。
- `gateway_ssh_host_key_updated_unix` 用于提示 host key 轮换时间。
- Gitea 每次接受 `DeclareManager` 后校验并覆盖写入规范化 metadata；Manager 不提交自由 JSON/map。
- Manager 可以修改声明字段；每次成功 Declare 整体覆盖当前 `name/tags_json/runtime_state/meta_json`，失败请求不产生部分更新。只保存最新快照，不增加声明历史或版本字段。
- Gitea 不在普通 codespace 列表接口返回完整 `meta_json`；需要展示 SSH 连接信息的页面按权限读取必要字段。

实现验收点：

- Declare metadata 经过固定 key 校验后覆盖写入规范化 JSON。
- `gateway_url` 规范化后只保留 scheme、DNS base domain 和可选 port，不保存业务 path。
- 不同 Manager 不能写入相同的规范化 `gateway_url`，冲突声明不覆盖原 metadata。
- 不同 Manager 不能写入相同的规范化 `gateway_ssh_addr`。
- 修改后的完整声明要么整体覆盖旧快照，要么全部保持旧值。
- 管理页面可展示 Manager 当前版本，但版本不参与生命周期状态推进。
- 管理页面可展示 Gateway SSH algorithm、SHA256 fingerprint 和更新时间。
- 容量快照只用于展示与诊断，不参与后续 Fetch 领取判断。

## 索引

| 表 | 索引列 |
| --- | --- |
| codespace | `uuid`（主键） |
| codespace | `(user_id, status)` |
| codespace | `(repo_id, status)`，查询 repository 关联记录时使用 `repo_id > 0` |
| codespace | `(gitea_token_id)`，用于 token binding 反查；查询时使用 `gitea_token_id > 0` |
| codespace | `(status, operation_type, operation_status, manager_id, repo_tag)`，用于 create 批量领取 |
| codespace | `(manager_id, operation_type, operation_status, status)`，用于 stop/resume/delete 领取和 active operation 扫描 |
| codespace | `(operation_status, operation_created_unix)`，用于 queued operation 超时扫描 |
| codespace | `(operation_status, operation_deadline_unix)`，用于 running lease 超时扫描 |
| codespace | `(status, updated_unix)`，用于 failed retention 清理；`updated_unix` 在进入 failed 时写入且 token reconciliation 不刷新 |
| codespace_manager | `(owner_id, admin_state)` |
| codespace_manager | `(owner_id, runtime_state)` |
| codespace_manager | `(admin_state, last_online_unix)`，用于派生 offline 和 reconciliation 扫描 |
| codespace_manager_token | `token`（唯一） |
| codespace_manager_token | `(owner_id, is_active)` |
| codespace_manager_token | `(is_active, updated)`，用于 inactive token retention 清理；`updated` 在停用时成为保留期起点 |

实现验收点：

- queued create 和已绑定 operation 查询使用对应复合索引，不依赖 JSON SQL 匹配。
- operation 超时和 failed/inactive retention 扫描使用时间字段复合索引，不做全表逐行判断。
- token、UUID 的唯一索引阻止重复记录。

## Gitea Cache 与 Keyed Lock

Codespace 通过 Gitea `modules/cache.GetCache()` 使用站点已经配置的 cache adapter，只保存短期易失数据：

- `codespace:open-code:{code_hash}`（一次性的 authorization code 校验缓存，参见 [Gateway Open Token](glossary.md#gateway-open-token)）
- `codespace:open-code-index:{codespace_uuid}`（签发成功时尚未消费的 `code_hash` 去重升序 JSON 数组，仅用于物理删除时尽力定向清理）
- `codespace:runtime-meta:{codespace_uuid}`（当前 Endpoint、internal SSH 和 boot 动态快照，参见 [Runtime Metadata](glossary.md#runtime-metadata)）

memory/twoqueue adapter 的内容随进程退出而丢失；Redis/memcache 可在各项 TTL 内跨 Gitea 重启保留。两种结果都符合 cache 语义：Open Code 交换始终重新校验数据库、用户、Manager 和 Endpoint，Runtime Metadata 也不能替代数据库主状态与 Manager 在线判定。Codespace 的明确 TTL 不使用通用 `[cache] ITEM_TTL`：Open Code 和 index 使用 `OPEN_TOKEN_EXPIRE`，Runtime Metadata 使用 `MANAGER_OFFLINE_TIMEOUT * 2`。`ITEM_TTL=-1` 只关闭使用通用 TTL 的查询缓存，不关闭这些具有协议生命周期的 Codespace 项。

Codespace 不实现 Locker、mutex pool 或 lock backend。需要 keyed serialization 的路径直接调用 Gitea `modules/globallock.Lock(ctx, key)`；默认 `[global_lock] SERVICE_TYPE=memory` 时锁位于当前进程，站点配置 Redis 时沿用同一个 Gitea lock backend。两种配置都只服务当前单活动 Gitea 进程模型，不表示支持多实例。Codespace 不读取 Session Provider，也不增加专用 cache、lock 或 Redis 配置。

锁 key 只由纯格式化 helper 构造：全局 Manager Gateway/SSH 地址唯一性使用 `codespace_manager_addresses`，owner 使用 `codespace_owner_{owner_id}`，Manager 使用 `codespace_manager_{manager_id}`，Codespace 使用完整规范化小写 UUID 构造 `codespace_{uuid}`。现有 repository transfer 的 `repo_working_{repo_id}` helper 移到 `modules/repository/lock.go` 并导出为 `WorkingLockKey(repoID)`；transfer、repository delete 和 `CreateCodespace` 记录插入事务都直接把该 key 传给 `globallock.Lock`，不增加 repository lock wrapper。

明确取得 keyed lock 的路径：地址首次声明或变更取得地址 lock；registration token 创建/轮换、owner-scoped Manager 注册/删除、用户/组织删除和 `CreateCodespace` 记录插入事务取得相关 owner lock；repository 删除和 `CreateCodespace` 记录插入事务取得 repository lock；创建、取消或拒绝 pending repository transfer 只取得 repository lock，接受 transfer 或其他实际修改 `owner_id` 的路径取得原/新 owner lock 后再取得 repository lock；Declare 写入、Manager secret 轮换、inventory generation 接受、Manager 删除和完整 `FetchOperations` 请求取得 Manager lock；Fetch/UpdateOperation 对 running operation 的续租、重发和收敛、State Finalization、timeout、主动 transition、Gitea token 签发/修复/吊销、Runtime Metadata 写入、operation 日志追加、Open Code 签发/消费、单 Codespace 物理删除和 reconciliation 取得 Codespace lock。Fetch 的 queued 条件 claim 已受调用方 Manager lock 保护，但不额外取得 repository 或 Codespace lock；纯读取和未修改地址的 heartbeat 不增加 lock；repository 数据库删除已经由 repository lock 串行，不额外取得 Codespace lock；Fetch 遇到过期 queued 项并执行 timeout 时按 timeout 路径取得 Codespace lock。

同一操作需要多个 lock 时，代码按地址、owner、repository、Manager、Codespace 直接多次调用 `globallock.Lock`；同层多个 ID 去重并升序取得，完整 UUID 按字符串升序，后一个取得失败或操作完成时逆序释放。所有 lock 在数据库事务前取得，已持锁内部函数不重复取得相同 key，锁内不调用 Manager、Gateway 或其他网络服务。

owner lock 只串行化参与 Codespace 关系集合的明确写路径：Codespace 记录创建、owner-scoped Manager 注册/删除、registration token 变更、repository 实际 owner 变更或删除，以及用户/组织删除。普通 repository、package、membership 等 Gitea 写入继续沿用各自现有事务和前置检查，不因 Codespace 增加 owner lock。这个边界让 Codespace 删除能稳定收集自身关系，同时不把 owner lock 扩展成所有 Gitea 业务写入的总锁。

规则：

- cache 只保存交互所需的动态数据和页面展示快照；数据库主状态始终是授权与生命周期结果的权威来源。
- Runtime Metadata 写入失败时，不提交依赖该快照的 running 状态变化；数据库提交失败时，已有 stopped 等主状态继续阻止交互，Manager 可用相同事实重试。
- stopped/failed 或物理删除先提交数据库和 token 结果，再尽力清除 Runtime Metadata 与未消费 open code。物理删除提交后先释放所持 `globallock`，再在锁外清理 cache；清理失败只记录服务端日志，不回滚或改写已经提交的生命周期结果。后续请求取得 lock 后仍重新读取数据库，因此残留 cache 不会恢复权限或记录。
- open code 签发只有在 code 和 index 都写入后才成功；index 写入失败时尽力删除刚写入的 code 并返回失败。index 只是主动清理辅助，adapter 后续可以独立淘汰它；code 仍按 TTL 和数据库复检保证安全。消费先按 `code_hash` 读取 binding 中的 `codespace_uuid`，取得该 Codespace lock 后必须重新读取同一 code，再完成数据库、权限和 Endpoint 校验并删除 code；code 删除失败时不返回 binding，code 已删除但 index 更新失败时记录日志并返回成功，因为该 code 已不能再次消费。
- cache 原生跨 key 原子操作不是正确性的前提；keyed lock、数据库复检、短 TTL 和失败后的确定返回共同保证安全边界。
- cache 内容都是短期、可失效或可由 Manager 重建的数据；丢失不影响 codespace 生命周期、权限、删除处理或 operation 超时判断。
- 主状态和权限相关的持久数据都以数据库为准。
- Gitea cache 读取接口不能区分后端读取错误和 key miss，因此 Open Code 读取失败按无效凭据 fail closed，Runtime Metadata 读取失败按 `metadata_rebuilding`，index 读取失败按空集合；无法解析的值记录日志并尽力删除，分别按相同 miss 语义处理。必须成功的 cache Put/Delete 和 `globallock.Lock` 错误返回 `internal_error / retryable=true`，不回退到另一份内存 cache 或 lock backend。数据库结果提交后的 cache 清理失败只记录日志。

实现验收点：

- 清空 Codespace cache 后，codespace 主状态、active operation、token binding 和日志仍可从数据库恢复。
- open code cache 丢失只使未消费 code 失效，Runtime Metadata cache 丢失只暂时影响交互和展示。
- memory/twoqueue 重启后可以丢失 cache，Redis/memcache 可在 TTL 内保留；两种情况下 Open Code 都重新执行完整访问校验，Runtime Metadata 都不替代数据库主状态。
- open code 只在 code 和 index 都写入后签发成功；index 后续被独立淘汰只降低主动清理覆盖率，不参与授权和一次性消费。校验失败不消费 code，消费删除失败不返回 binding。
- Codespace 物理删除提交后尽力通过 open-code index 删除尚未消费的 code 并删除 Runtime Metadata cache；清理失败不改变删除结果，残留项也不能通过数据库复检。
- `updated_unix` 只按生命周期结果矩阵变化，claim、续租、交互、metadata、日志、token 修复和 `repo_id` 置 0 不刷新 failed retention 起点。
- 文档明确列出的 keyed serialization 路径直接调用 Gitea `globallock.Lock`；代码中没有 Codespace Locker、mutex pool、lock wrapper、专用 cache/lock 配置或失败后的后端回退。
- repository transfer/delete 与 `CreateCodespace` 记录插入事务通过 `modules/repository.WorkingLockKey` 使用同一个 `repo_working_{repo_id}`；实际修改 owner 的 transfer 对原/新 owner ID 去重升序加锁，pending transfer 的创建、取消和拒绝只使用 repository lock。多对象路径按地址、owner、repository、Manager、Codespace 和各层稳定升序取得，事务前完成加锁，内部已持锁实现不重复取得同一 key。
- `FetchOperations` 在调用方 Manager lock 内重新读取 Manager 并完成 running 处理、queued claim、payload 构造或条件释放；Manager/owner 删除取得相同 Manager lock 后重新查询 binding 集合。
- owner lock 的保证范围只覆盖文中列出的 Codespace 关系写路径；普通 Gitea repository/package/membership 写入仍按现有服务事务收敛。

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
    "operation_rversion": 1,
    "stage": "run-init-script",
    "started_unix": 0,
    "last_update_unix": 0
  }
}
```

规则：

- 顶层固定且必填为 `runtime`、`endpoints`、`boot`；`boot` 固定且必填为 `operation_rversion`、`stage`、`started_unix`、`last_update_unix`。规范之外的字段被拒绝，使 Manager、Gitea 和 Gateway 对同一快照得到一致解释。
- `endpoints` 始终以 JSON 数组存储；没有 Endpoint 时使用空数组，不省略字段。
- `internal_ssh` 不在普通 UI/API 输出中暴露。
- `internal_ssh` 在 SSH 尚未就绪的 boot 阶段可以不出现；一旦出现以及 `boot.stage=ready` 时，`host/user/auth_mode/host_key_fingerprint` 必须为非空字符串，`port` 必须在 1-65535，`auth_mode` 第一版固定为 `publickey`。该条件字段表达真实的启动阶段，不使用空 host/port 伪装未就绪。
- `boot.stage` 只允许 `prepare-runtime`、`configure-ssh`、`configure-git`、`clone-repository`、`checkout-commit`、`run-init-script`、`start-ide`、`report-endpoints`、`credential-refresh`、`ready`。create 按初始化阶段推进并在 token、SSH 和服务均可用后进入 `ready`；resume 可从 `credential-refresh` 进入 `ready`。
- `started_unix > 0`，`last_update_unix >= started_unix`；同一 boot session 的 `started_unix` 保持不变，阶段推进或状态刷新更新 `last_update_unix`。
- active create/resume 上报的 `boot.operation_rversion` 必须等于当前 operation；没有 active operation 时保留最近 boot 上下文的版本，不能大于 `codespace.operation_rversion`。主动 running transition 的 boot 版本必须等于请求的 `observed_operation_rversion`，stage 必须为 `credential-refresh`。
- create `final done` 要求当前快照的 boot 版本等于当前 create 且 `stage=ready`；resume `final done` 要求 boot 版本等于当前 resume、`stage=credential-refresh`，并且 metadata generation 高于此前 cache 快照。旧 `ready` 不能直接完成恢复；cache miss 时正 generation 的当前 operation credential-refresh 可以重建。resume final 后 Manager 继续保留该 boot 后置上下文，直到同 boot 版本、更高 generation 的 `ready` 被接受；active operation 已清空不阻止该后置快照。后置 worker 结束后，Manager 仍保留最新 boot 版本的终态结果，直到更高 create/resume 版本替换或 Runtime 删除，用于 `/boot` 幂等重试。open/SSH 在 ready 前不可用。
- `endpoint_id` 由 Manager 上报，使用 1 到 30 位 DNS-safe 小写字母、数字或连字符，并在同一 `codespace_uuid` 内保持唯一。
- Endpoint 数量不超过协议固定上限 64，规范化 JSON 不超过 `RUNTIME_METADATA_MAX_SIZE`。
- 不同 codespace 可以使用相同 `endpoint_id`。
- `label` 只用于 UI 展示，可以重复，不是路由键。
- `endpoints` 保存 Runtime 实际声明，不为默认 Web SSH 伪造记录。`workspace` 是 Gitea 与 Manager 约定的有效逻辑入口：同名记录存在时 Manager 使用其 Runtime upstream，不存在时 Manager 使用默认 Web SSH；两种情况的 Open Token binding 都是 `endpoint_id=workspace`。
- Runtime Metadata 保存在 Gitea cache。
- key：`codespace:runtime-meta:{codespace_uuid}`
- value：当前 `endpoints + internal_ssh + boot`、Gitea 接受请求时写入的 `last_reported_unix`，以及 request envelope 中的 `metadata_generation` 和规范化内容 hash
- ttl：`MANAGER_OFFLINE_TIMEOUT * 2`
- 只要所属 Manager 在线，Gitea 即信任当前 cache 中的 Runtime Metadata。
- Gitea 信任 Runtime Metadata cache 仅表示 open/SSH 的 ready、普通 Endpoint existence、internal SSH 和 UI 展示信任当前 cache 内容；resume 不读取该 cache。
- Gitea cache miss 后，Runtime Metadata 由 Manager 重建；外部 adapter 在 TTL 内保留的合法快照可以继续使用。
- Manager 离线时，新的 open 和 SSH 需要 Manager online 才能执行授权校验。
- Runtime Metadata 仅记录当前最新快照，cache miss 只影响交互与展示。
- `metadata_generation` 由 Manager 按 codespace 单调递增；更高版本覆盖内容并刷新 TTL，相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回 generation conflict 且不附 stale detail，更低版本拒绝并返回当前版本。Manager 对 stale 使用服务端当前值加一，对 conflict 使用请求中的已知值加一，再重读并提交本地当前完整快照。
- `last_reported_unix` 由 Gitea 在接受请求时写入，不参与 Manager 快照内容或 generation 比较。
- Runtime Metadata 规范化使用固定 JSON 字段、对象 key 排序和按 `endpoint_id` 排序的 endpoints；内容 hash 不受 Manager 原始 JSON 空白或对象 key 顺序影响。
- Runtime Metadata 是动态运行信息，用于展示和交互入口。主状态由 operation 状态写入和 reconciliation 处理，推进依据来自数据库状态。

实现验收点：

- metadata generation 相同的重试幂等，更低 generation 不覆盖 cache。
- 相同 generation、不同规范化内容被拒绝；相同内容的周期刷新可以延长 TTL。
- metadata generation stale 和同代冲突分别以服务端当前值和请求已知值为基线升代；checked increment 耗尽时进入 recovering。
- endpoint ID 在单个 codespace 内唯一，internal SSH 不进入普通 UI/API。
- metadata ready 且没有 `workspace` 记录时，默认 workspace open 仍有效，UI 不要求生成一条虚假的 Web SSH Endpoint metadata。
- resume final 后的 credential-refresh 与 ready 使用同一 boot operation 版本，ready 接受前 Manager 重启不会丢失后置凭据刷新上下文；ready 后仍保留最新 boot 结果供相同 POST 幂等重试。
- 未知字段、缺失固定字段、非法 boot stage、错误 boot operation 版本和不完整 internal SSH 被拒绝；create 在当前 operation 的 ready 快照前不能 final done。
- cache TTL 刷新不改写 `last_active_unix` 或主状态。

## 日志存储

Codespace [Operation](glossary.md#operation) 日志存储在 DBFS（`models/dbfs/`，32KB 分块存储）。同一 codespace 的并发写入由 codespace 日志服务串行化，不能把 DBFS revision 字段当作乐观锁。

路径：

```text
codespace_log/{codespace_uuid}.log
```

规则：

- Manager 通过 byte offset 追加，单文件连续写入。
- Gitea 服务层可以为完整 failed 对象和最终状态收敛通过内部入口追加摘要；每次内部追加与其日志元数据在同一个 DBFS 事务中提交。
- offset 等于当前大小时追加。
- offset 小于当前大小时，只允许规范化后的完整请求段已存在且逐字节相同的幂等重放；部分重叠返回 offset conflict 和当前文件末尾，不补写尾部。
- offset 大于当前大小时返回 offset gap 分类，保持日志文件连续。
- 每条存储日志都是已脱敏单行。
- Manager 上报结构化 `timestamp_unix_nano + message`；Gitea 统一编码为 UTF-8 `[RFC3339Nano] message\n`。
- `UpdateLog` 成功响应返回规范化、脱敏并写入后的 `next_offset`；Manager 以该服务端值推进下一次追加。
- message 包含换行时，Manager 在提交前按换行拆成多条物理日志行；存储层每个 `lines[]` 元素只接受一行，渲染器按物理行顺序展示。
- 按 `log_indexes` 提供的行号到 byte offset 映射进行 seek 读取。
- `GET /codespace/{uuid}/logs` 使用 byte offset 分页读取，返回 `offset / next_offset / eof / lines / truncated`。
- 读取 offset 必须为 0、文件末尾或 `log_indexes` 中的物理行起点；落在 UTF-8 字符或物理行中间时返回 offset conflict 和该物理行起点。
- 第一条完整物理行超过请求 `limit` 时仍单独返回该行并推进 `next_offset`，避免客户端因过小 limit 永远无法前进；单次响应始终不超过 `LOG_READ_MAX_BYTES`，配置要求 `LOG_MAX_LINE_SIZE <= LOG_READ_MAX_BYTES`。
- delete 成功后删除 codespace 日志。
- `failed` 日志保留到用户 delete 或 `FAILED_RETENTION_DAYS` 清理。
- 第一版只使用 DBFS，不在表中保存固定值的 storage 类型；真正增加对象存储归档时再通过迁移增加 storage 字段和 transfer job。
- Gitea 单实例内使用按 `codespace_uuid` 分片的 keyed lock 串行化日志追加；锁内开启数据库事务，并使用该事务 context 打开和写入 DBFS，校验 operation 和 offset，让 DBFS 写入与 `log_size/log_line_count/log_indexes` 更新共同提交。DBFS 的 revision 字段本身不提供 compare-and-swap，不能代替该串行化边界。
- 在 keyed lock 内，普通 batch 会让当前文件从普通日志上限以下跨过 `LOG_MAX_SIZE-LOG_FINAL_SUMMARY_RESERVE` 时，拒绝该 batch 并只写一条固定截断摘要；文件已经达到该上限后的普通 batch 直接拒绝，不再写摘要，因此不需要增加数据库字段。截断摘要和最终状态摘要合计不得突破 `LOG_MAX_SIZE`，最终摘要优先使用剩余预留空间。
- Manager 在 final 前写 operation 最终摘要。对于仍保留 Codespace 记录的 final、timeout、missing 和 failed fact，Gitea 在主事务提交后、释放 Codespace keyed lock 前使用剩余预留空间尽力追加内部状态摘要；该独立 DBFS 事务失败或空间耗尽时只记录服务端日志，不回滚生命周期结果。delete done、Gitea 直接删除和 retention 清理跳过摘要，避免删除后重新创建日志。

日志存储在 DBFS 单文件中，`codespace` 行保存当前日志元数据。只有当前 `operation_status=running` 且 `operation_rversion` 匹配时允许追加日志。第一版不引入对象存储归档，避免日志 transfer 状态影响生命周期状态机。

实现验收点：

- 同一 codespace 的并发日志追加被串行化，两个相同 offset、不同内容的请求只有一个可以写入。
- DBFS 内容与 `log_size/log_line_count/log_indexes` 在同一数据库事务中提交或回滚。
- message 中的换行被拆成多条物理日志行，行数、索引和分页结果一致。
- offset 按服务端规范化编码后的完整字节计算，读取不拆分 UTF-8 字符或物理日志行。
- 超过请求 limit 的物理行可以单独分页返回，非法行中 offset 返回该物理行的服务端起点，响应仍遵守服务端读取硬上限。
- 达到普通日志上限后只出现一条截断摘要，最终文件大小不超过 `LOG_MAX_SIZE`。
- 内部状态摘要只为仍保留 Codespace 记录的结果在主事务提交后尝试；摘要事务失败时主状态和 active operation 结果保持已提交，物理删除后日志保持不存在。
- codespace 日志按单文件连续 offset 追加，并随 codespace 物理删除或 failed retention 清理。
- offset conflict/gap 返回服务端当前 offset，Manager 不通过本地编码结果猜测恢复位置。
