# 数据模型

## 数据表

Gitea 数据库保存 Codespace 与 Manager 的绑定、生命周期结果、Manager 地址、当前 Codespace Gitea Token，以及使用 Git SSH 的 Codespace 公钥绑定；Gitea 缓存保存 Runtime Metadata 与 Gateway Open Token；Git SSH 私钥、Endpoint port、Runtime Token、Incus 状态和实时容量由 Runtime 或 Manager 管理。容量由 Manager 在每次 Fetch 时声明，Gitea 据此领取 operation，因此数据库无需维护另一份运行容量计数。

### codespace

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `uuid` | `CHAR(36)`，主键 | Gitea 生成的规范小写 RFC 4122 UUID v4；Web 路由、RPC、日志路径和 Manager 本地 Runtime 映射都使用该值 |
| `user_id` | `BIGINT NOT NULL DEFAULT 0` | 创建者 user ID；有效 codespace 创建时必须大于 0，用户删除流程会物理删除关联记录 |
| `repo_id` | `BIGINT NOT NULL DEFAULT 0` | 大于 0 时用于 create 来源展示和 token repo binding；repository 删除 pre-cleanup 时写为 0 |
| `ref_type` | `VARCHAR(16) NOT NULL DEFAULT ''` | 有效记录只允许 `branch` / `tag` / `commit` / `pull` |
| `ref_name` | `TEXT NOT NULL` | branch/tag/commit 标识或规范化 PR ref 路径 |
| `repo_tag` | `VARCHAR(64) NOT NULL DEFAULT 'default'` | create 时确定，后续不随仓库文件变化 |
| `git_protocol` | `VARCHAR(8) NOT NULL DEFAULT 'http'` | 只允许 `http` / `ssh`；create 时按站点默认值固化，决定首次 clone 的尝试顺序 |
| `commit_sha` | `VARCHAR(64) NOT NULL DEFAULT ''` | create 前置校验完成后必须为完整锁定 commit SHA |
| `manager_id` | `BIGINT NOT NULL DEFAULT 0` | create 被领取前为 0，领取后固定 |
| `status` | `VARCHAR(16) NOT NULL DEFAULT ''` | 有效记录只允许五个持久主状态 |
| `operation_rversion` | `BIGINT NOT NULL DEFAULT 0` | 创建或替换 Gitea-issued operation 时递增；Manager runtime transition 不递增 |
| `operation_type` | `VARCHAR(16) NOT NULL DEFAULT ''` | 当前 active operation 类型；无 active operation 时为空字符串 |
| `operation_status` | `VARCHAR(16) NOT NULL DEFAULT ''` | `queued` / `running`；无 active operation 时为空字符串 |
| `operation_trigger` | `VARCHAR(16) NOT NULL DEFAULT ''` | `user` / `idle`；表示当前 operation 的创建来源，无 active operation 时为空字符串 |
| `operation_created_unix` | `BIGINT NOT NULL DEFAULT 0` | 无 active operation 时为 0 |
| `operation_started_unix` | `BIGINT NOT NULL DEFAULT 0` | running operation 的首次领取时间，也是总执行期限的固定计算基线；queued 或无 active operation 时为 0 |
| `operation_deadline_unix` | `BIGINT NOT NULL DEFAULT 0` | 当前 running lease 与总执行期限中较早的 Gitea 侧 Unix 秒截止边界；其他状态为 0 |
| `runtime_generation` | `BIGINT NOT NULL DEFAULT 0` | Manager 主动运行状态报告版本，只保存最新值 |
| `last_active_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近成功记录的用户交互；仅用于 UI 排序与展示，写入失败不阻断访问 |
| `auto_stop_mode` | `VARCHAR(16) NOT NULL DEFAULT 'default'` | `default` / `custom` / `never`；分别使用站点默认超时、对象自定义超时或关闭该对象的空闲自动暂停 |
| `auto_stop_timeout_seconds` | `BIGINT NOT NULL DEFAULT 0` | 仅 `auto_stop_mode=custom` 时保存大于 0 的自定义秒数；其他模式为 0 |
| `interaction_generation` | `BIGINT NOT NULL DEFAULT 0` | Gitea 接受用户交互时递增；Manager 请求空闲停止时必须提交已观察到的当前值 |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 创建时间戳 |
| `updated_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近一次持久生命周期结果变化时间；进入 failed 时作为 retention 起点 |
| `stopped_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近停止时间戳，未停止过时为 0 |
| `log_filename` | `VARCHAR(255) NOT NULL DEFAULT ''` | 日志文件名 |
| `log_line_count` | `BIGINT NOT NULL DEFAULT 0` | 日志物理行数 |
| `log_size` | `BIGINT NOT NULL DEFAULT 0` | 日志规范化字节数 |
| `log_indexes` | `LONGBLOB NOT NULL` | 迁移默认写入空 blob；varint 编码的 `[]int64`，用于按行 seek |

日志元数据字段参考 Actions `ActionTask`（`models/actions/task.go`）。

repository owner 通过 `repository.owner_id` 表示，不在 codespace 表中重复存 `owner_id`。repository 删除后 `repo_id` 写为 0，这是 Gitea ID 字段常用的未绑定表达，也避免依赖各数据库实现不同的 nullable/partial-index 行为。create operation 完成、workspace 已初始化后，codespace 按 `codespace.uuid`、`user_id` 和 `manager_id` 管理生命周期与交互入口，不依赖 repository row；保留悬空 repository ID 不能恢复来源仓库。Codespace Gitea Token 在 `repo_id=0` 时没有绑定仓库能力，但公开只读目标仍按 Gitea 现有公开访问规则处理；Git SSH Key 不能匹配任何仓库。用户或组织删除在任何 owner repository 删除前，通过现有 `user_id`、`repo_id -> repository.owner_id` 和 `manager_id -> codespace_manager.owner_id` 收集关联 Codespace，并按 keyset 分批、逐项短事务删除 Gitea 资源，因此不需要增加冗余 owner 字段。repository 此前已单独删除时，`repo_id=0` 表示与原 repository owner 的关系已经有意丢弃，后续只按创建者和 Manager owner 关系处理。

Codespace UUID 在创建记录前由 Gitea 使用加密安全随机源生成 UUID v4，数据库、Web 路径、RPC 和 Manager 持久状态统一使用 36 字符小写带连字符形式。外部输入先做严格格式校验，大小写不同、无连字符或其他非规范形式返回 `invalid_argument`，不能在规范化前参与查询或构造 lock key。`uuid32` 只表示从规范 UUID 删除四个连字符后的 32 字符结果；需要 UUID 的 helper 参数统一命名为 `codespaceUUID`，避免与数字数据库 ID 混淆。单一表达保证同一对象只对应一个数据库键、一个 `codespace_{uuid}` lock key 和一组 Gateway host。

`operation_rversion`、`runtime_generation`、`inventory_generation` 和 `interaction_generation` 的 0 值只是尚未产生版本的持久化初始值，首个有效值为 1。服务层和 Manager 递增这些有符号 `BIGINT` 时使用 checked increment，不回绕到 0 或负数。任一版本无法递增时返回不可重试的 `version_exhausted`，不写主状态、active operation、交互结果或本地快照的部分结果。Codespace 的 operation 或交互版本耗尽后由管理员 force delete；单 Codespace 的 runtime/metadata 版本耗尽由 Manager 按 Incus 归属字段清理该对象；Manager inventory 版本耗尽后删除 Manager、清理部署侧资源并重新注册。该情况需要超过 `int64` 可表达次数，继续为计数设计自动恢复没有实际收益，因此按影响范围使用现有删除路径收敛。`runtime_generation` 仅保存当前值；相同 generation 的幂等以状态报告的目标主状态是否已成立判定，不需要再增加历史状态报告类型字段。

**设计如此：数据库版本与 Manager 观察值是两个独立字段。**数据库 `codespace.operation_rversion=0` 只表示 Gitea 从未为该 Codespace 创建 operation；无匹配 Manager 而直接创建的 failed 记录只是这一初始值的一个实例。inventory 中的 `RuntimeInstance.observed_operation_rversion=0` 表示 Manager 当前没有可继续的完整 active operation 上下文，即使数据库已经保留正数版本也可以上报 0；该观察值只参与本次对账，数据库版本继续由 Gitea 生命周期事务维护。Manager 持有完整上下文时上报对应的正数版本，operation-bound RPC 和状态报告始终使用正数版本。

`git_protocol` 保存 Codespace 创建时选定的首次 clone 首选方式，而不是每次启动读取站点当前默认值。Gitea 同时下发 HTTP(S) 和 SSH URL，所选 create 脚本决定实际 remote；内置脚本在带当前 UUID 标记的临时 workspace 中使用首选 URL，`clone/fetch` 非零退出时清理该受控临时目录并用另一 URL 重试一次。Manager 只在 HEAD 等于锁定 SHA、最终 workspace 与实际 remote 的本地凭据配置有效时接受结果。resume 读取实际 remote，站点默认值变化只影响之后创建的 Codespace。已经初始化的绝对 workspace 路径和实际 remote 都属于 Manager 本地运行快照，不在 Gitea 数据库重复保存；repository 删除后，resume 仍使用该快照恢复原 workspace。

`auto_stop_mode` 保存用户选择而不是保存解析后的布尔结果。`default` 在每次下发和空闲停止授权时读取站点当前默认值，`custom` 使用对象保存的秒数，`never` 明确表示该对象不因空闲而自动暂停。Gitea 解析 `auto_stop_enabled + idle_timeout_seconds` 后直接下发实际运行值；default 与 custom 当前得到相同有效超时时使用相同运行侧基线，模式仍保留在数据库中决定未来站点默认值变化是否影响该对象。Manager 收到延迟快照最多暂时提前或延后本地计时，`RequestIdleStop` 会直接比较当前有效值和交互版本，过期快照不能创建 stop。`last_active_unix` 只用于页面展示，自动暂停使用 Manager/Gateway 的实时连接索引和本地单调计时，不从数据库时间戳推导空闲时长。

`updated_unix` 只表示数据库中的生命周期结果发生变化。创建记录时与 `created_unix` 同值；创建或替换 active operation、首次 final/timeout/missing/transition 写入结果时更新为当前时间。queued resume/stop timeout 或 queued idle stop 取消即使保持原稳定主状态，也因 active operation 首次结束而更新时间；相同结果的幂等重试不刷新。claim、lease 续租、日志、Runtime Metadata、开发凭据读取、登记或修复、未取消 operation 的 open/SSH/继续运行/设置变更，以及 repository 删除时仅把 `repo_id` 写为 0，都不更新该字段。这样 failed retention 有稳定起点，调度和普通交互活动不会被误解为生命周期变化；用户活动分别更新 `interaction_generation`，并尽力写入仅供展示的 `last_active_unix`。

Codespace 主表的更新采用字段级 SQL：每条写路径都用明确的 `SET` 列表更新本节属于该动作的列，并用必要列组成更新条件。`repo_id` 在创建记录时写入，repository 删除时可以把它改为 0；状态流转、operation claim/续租/final、日志元数据、自动暂停设置和 `last_active_unix` 更新的 `SET` 列表都排除 `repo_id`。这一字段归属使 repository 删除的批量 `repo_id=0` 与只取得 Codespace lock 的生命周期写入无论按哪种顺序提交，最终都保留 `repo_id=0`。字段级写入同时缩小并发更新范围，因此 repository 删除无需逐个取得 Codespace lock。

endpoint、boot、resource usage、internal SSH 和 last_reported 保存在 Gitea cache。

### codespace_manager

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | `BIGINT` 自增主键 | |
| `name` | `VARCHAR(255) NOT NULL DEFAULT ''` | 展示名称，不要求唯一 |
| `owner_id` | `BIGINT NOT NULL DEFAULT 0` | Manager owner scope |
| `secret_hash` | `VARCHAR(64) NOT NULL DEFAULT ''` | SHA-256 hex verifier |
| `secret_salt` | `VARCHAR(32) NOT NULL DEFAULT ''` | 16 随机字节的 hex 编码 |
| `tags_json` | `TEXT NOT NULL` | 规范化、去重后的 tags JSON 数组 |
| `runtime_state` | `VARCHAR(16) NOT NULL DEFAULT 'recovering'` | 只保存 `online` / `recovering`，offline 实时派生 |
| `last_online_unix` | `BIGINT NOT NULL DEFAULT 0` | 最近成功 Declare 时间 |
| `inventory_generation` | `BIGINT NOT NULL DEFAULT 0` | 最近接受的完整 inventory 请求版本；只接受更高值 |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 创建时间 |
| `meta_json` | `TEXT NOT NULL` | Gitea 生成的规范化 Manager metadata JSON |

Manager secret 固定为 32 个随机字节的 64 位小写十六进制字符串，salt 为 16 个随机字节的 32 位小写十六进制字符串；`secret_hash` 固定保存 `hex(SHA-256(salt_bytes || secret_bytes))`。明确按解码后的字节计算，可以让注册签发与后续认证使用同一算法，避免实现分别拼接文本得到不同 verifier。

**设计理由：Manager 的身份、可用性和调度意愿分别由现有字段表达。** Manager row 存在表示注册身份有效，`runtime_state + heartbeat` 表示当前可用性，Declare 的容量快照用于展示，Fetch 的 `capacity_available + accepted_operation_types` 表示本次是否接收 create/resume，`cleanup_capacity_available` 表示本次是否接收 stop/delete，删除 row 表示永久撤销身份。两个 Fetch 可用容量都是单次请求的瞬时值，`cleanup_capacity_available` 不写入 Manager 表或 metadata。计划排空由 Manager 上报零启动容量，维护中断由 recovering/offline 表达。各信号职责单一，因此 operation、Token、Gateway session 和 Runtime transition 可按明确来源判定，无需额外管理状态字段。

Manager 删除由服务层先按 `codespace.manager_id` 收集并删除绑定 Codespace，再删除 Manager row。提交完成后，数据库只包含 Gitea 当前仍管理的对象；运行侧残留由部署运维处理，不参与 Gitea 删除结果，因此数据表只需保存当前 Manager 记录。

### codespace_manager_address

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | `BIGINT` 自增主键 | 地址记录 ID |
| `manager_id` | `BIGINT NOT NULL DEFAULT 0` | Manager ID |
| `kind` | `VARCHAR(16) NOT NULL DEFAULT ''` | 只允许 `gateway` / `ssh` |
| `address` | `VARCHAR(512) NOT NULL DEFAULT ''` | 对应类型的规范化地址 |

同一 Manager、同一类型最多一行，同一类型的规范化地址在全部 Manager 中唯一。Manager 注册后、首次成功 Declare 前没有地址行；Declare 在 Manager lock 内校验完整声明，并在同一事务中插入或替换 `gateway` 和 `ssh` 两行。Manager 删除在最终事务中删除其地址行。

独立地址表保存实际参与路由和认证的当前值，`meta_json` 不再重复保存地址。这样数据库唯一约束就是冲突判定的权威来源，首次 Declare 前也不需要用空字符串或可空唯一列表达“尚未声明”。

### codespace_manager_token

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `id` | `BIGINT` 自增主键 | |
| `token` | `VARCHAR(64) NOT NULL`，唯一索引 | 32 随机字节的 hex 编码明文 |
| `owner_id` | `BIGINT NOT NULL DEFAULT 0`，唯一索引 | Registration Token owner scope；每个 scope 最多一行 |
| `created` | 创建时间戳 | xorm auto（与 `action_runner_token` 一致，不使用 `_unix` 后缀） |
| `updated` | 更新时间戳 | xorm auto |

Registration Token 明文存储并可复用，支持同一 owner 用当前 token 注册多个 Manager。`owner_id` 与 Gitea repository owner 语义一致，组织是 `user` 表中 `type=organization` 的 owner 记录。settings 页面进入时通过 GetOrCreate 确保当前行存在；重置原地替换随机 token；owner 删除物理删除该行。

**设计理由：Registration Token 表示 owner 当前有效的注册入口。**每个 owner 最多保存一行；重置原地替换。认证只需按记录是否存在判断当前入口，失败诊断写入服务端日志，因此数据表无需保存 inactive、软删除或轮换历史。

### codespace_gitea_token

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `codespace_uuid` | `CHAR(36)`，主键 | 当前 Token 所属 Codespace；每个 Codespace 最多一行 |
| `token_hash` | `VARCHAR(100) NOT NULL`，唯一索引 | 使用 Gitea 现有 `auth_model.HashToken` 计算的 verifier |
| `token_salt` | `VARCHAR(10) NOT NULL` | Gitea 安全随机字符串 |
| `token_last_eight` | `VARCHAR(8) NOT NULL`，普通索引 | 限定 verifier 候选，不单独参与认证 |
| `token_encrypted` | `TEXT NOT NULL` | 使用 Gitea `secret.EncryptSecret(setting.SecretKey, token)` 保存的可恢复密文 |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 当前 Token 创建时间 |

Token 固定为 `gcs_` 加 32 个安全随机字节的小写十六进制编码。`token_hash` 对包含前缀的完整 Token 调用 Gitea 现有带盐 hash helper；认证按末八位查询候选并以常量时间比较 verifier。`token_encrypted` 只在 `RequestGiteaToken` 重新交付当前凭据时解密，API、Git HTTP 和 LFS 认证不解密。

本表只保存无法从 Codespace 关系推导的凭据材料。用户、仓库和工作状态从当前 Codespace 记录读取；固定 category scope `write:issue,write:repository,read:user` 和 API 入口策略由 Codespace Token 类型派生；物理删除 Token 行表示吊销。因此 `user_id`、`repo_id`、scope、Codespace 状态、revoked、expired 和 updated 都由现有关系或生命周期动作给出，无需在 Token 表重复保存。单一来源可以避免状态、仓库或权限在多张表之间不同步。

**设计理由：`codespace_gitea_token` 使用 `codespace_uuid` 作为主键。**本表与 Codespace 是严格一对一关系，认证 resolver 的一次查询直接生成当前请求所需数据，也没有其他关系按 Token 行 ID 引用该记录。该主键同时表达所属 Codespace 和当前凭据唯一性，减少一个不参与查询或关联的代理键。

**设计选择：Codespace Gitea Token 使用独立凭据类型和独立表。**Codespace Token 和 PAT 都代表真实用户，但 Codespace Token 还受 Codespace 工作状态、单仓库绑定和固定 API 入口策略约束。认证入口按 `gcs_` 前缀进入专用分支，凭据记录或绑定异常时直接返回认证失败。普通 PAT 继续由 `access_token` 表、PAT 页面和 PAT API 管理，两类凭据的生命周期互不影响。

### codespace_ssh_key

| 字段 | 类型说明 | 备注 |
| --- | --- | --- |
| `codespace_uuid` | `CHAR(36)`，主键 | 当前 Git SSH 公钥所属 Codespace；每个 Codespace 最多一行 |
| `key_id` | `BIGINT NOT NULL`，唯一索引 | 对应 Gitea `public_key` 表中的 Codespace 专用公钥 ID |
| `created_unix` | `BIGINT NOT NULL DEFAULT 0` | 当前公钥登记时间 |

Gitea 的 `PublicKey` 类型增加 `KeyTypeCodespace`。对应行使用 `codespace.user_id` 作为 `OwnerID`，`Name` 固定为 `codespace-{uuid}`，`Content` 保存去掉 comment 的规范 OpenSSH 公钥，`Fingerprint` 使用 Gitea 现有 SHA256 计算，`Mode=perm.AccessModeWrite`、`LoginSourceID=0`、`Verified=false`。写模式允许后续命令在创建用户实际具有写权限时执行 push；专用鉴权仍会针对每条命令重新判断读取、写入与保护分支权限。`Verified=false` 表示该运行环境公钥没有进入用户主动验证流程，也不会作为签名 Key 使用。`codespace_ssh_key` 再把该 key ID 绑定到唯一 Codespace。SSH 强制命令入口由 key ID 找到 Codespace 后，使用当前 `repo_id`、创建用户和状态执行专用鉴权。关系表不重复保存 `user_id`、`repo_id`、访问模式或状态，因为这些值都必须以当前 Codespace 和 Gitea 权限结果为准。

Codespace Git SSH Key 是运行环境凭据，不是用户主动维护的账户 Key，也不是 Deploy Key。新增类型后，所有读取和修改入口都按下表正向选择类型，不能继续用“排除 Principal”表示普通用户 Key：

| 使用入口 | 接受的 `PublicKey.Type` |
| --- | --- |
| 普通用户 Key 页面、API、公开导出、数量限制、编辑、验证、删除和 SSH 签名查询 | `KeyTypeUser` |
| Deploy Key 服务 | `KeyTypeDeploy` |
| Principal 服务 | `KeyTypePrincipal` |
| Codespace Key 服务 | `KeyTypeCodespace` |
| `authorized_keys` 生成 | `KeyTypeUser`、`KeyTypeDeploy`、`KeyTypeCodespace` |
| `serv` Git 命令 | 对 User、Deploy、Codespace 分别执行显式分支；未知类型硬错误 |

`KeyTypeCodespace` 追加在已有枚举值之后，不改变 User、Deploy 和 Principal 的数据库数值。普通列表和签名服务使用 `KeyTypes` 正向条件；外部授权文件生成则明确包含三个能够进入强制命令的类型。这样公钥仍能复用 Gitea 现有 SSH key ID、内置 SSH 和 `authorized_keys` 入口，同时不会扩大到创建者的其他仓库，也不会进入 Deploy Key 的仓库所有者身份与保护分支规则。

**设计如此：新增 Key 类型必须把未知类型从默认用户分支改为硬错误。**Gitea 当前部分查询和 `serv` 分支建立在“非 Deploy 即用户”或“排除 Principal 即普通 Key”的旧枚举集合上；新增类型后继续沿用这些默认分支会把运行环境凭据展示为账户 Key，甚至按账户 Key 执行仓库鉴权。正向类型矩阵把每个入口的用途变成可审阅行为，也让以后再增加类型时默认保持不可用。

公钥确保请求在关系不存在时创建绑定，关系已指向相同规范化公钥时返回当前结果，已有不同公钥时返回 `key_conflict`。公钥指纹与任何普通用户 Key、Deploy Key 或其他 Codespace Key 冲突时返回相同错误。公钥属于 Codespace 整体生命周期，不记录 operation 版本，也不在 resume 时轮换；因此来自旧初始化过程的相同公钥请求天然幂等，不同公钥请求始终不能覆盖现有绑定。Manager 将 `key_conflict` 记为不可恢复启动终态：create 进入 failed，resume 在 final failed 后继续通过 failed 状态报告清理原 Runtime。

普通用户 Key、Deploy Key 和 Codespace Key 的创建入口在解析公钥并计算 Gitea 规范 SHA256 指纹后，对该指纹字符串计算 SHA-256 十六进制摘要，以 `public_key_fingerprint_{摘要}` 作为同一个 `globallock` 的 key，再开启各自的数据库事务并重新查询 `public_key.fingerprint`。User Key 遇到任意已有指纹时返回现有冲突；Codespace Key 返回 `key_conflict`；Deploy Key 只在已有行也是 `KeyTypeDeploy` 时复用该 PublicKey，其他类型返回冲突。查询发现历史数据中同一指纹对应多条 PublicKey 时返回数据完整性硬错误，不选择其中一条，也不自动合并。

`EnsureCodespaceGitSSHKey` 固定先取得 Codespace lock，再取得 PublicKey 指纹锁；普通用户和 Deploy 创建只取得 PublicKey 指纹锁。数据库事务提交后释放指纹锁，再调用现有授权文件同步入口。**设计如此：指纹锁覆盖会创建或复用 PublicKey 的三个入口，数据库仍保留现有索引和 Deploy Key 共享语义。**当前单活动 Gitea 进程下，这个提交顺序足以阻止并发查询后分别插入相同指纹；新增唯一索引会同时引入历史重复数据迁移和跨数据库合并问题，却不改善当前设计的运行结果。

登记事务先提交 `public_key` 与 `codespace_ssh_key` 的一致结果，再调用 Gitea 现有公钥授权同步入口。内置 SSH 或外部 `AuthorizedKeysCommand` 直接使用数据库；配置使用外部 `authorized_keys` 文件时重写文件，同步失败则 RPC 返回错误并由相同公钥重试。已经从数据库删除的旧 key ID 即使暂时残留在文件中，也无法通过 Gitea 强制命令鉴权。

私钥和专用 `known_hosts` 只保存在 Incus 实例的 Runtime 用户目录。Gitea 和 Manager 都不持久化私钥；Manager 只在当前 Runtime API 请求中转发公钥。stop、stopped、resume 失败/超时/abort 都保留关系行与对应 `PublicKey`，仓库命令是否可用由当前初始化或运行状态实时判定。进入 failed/deleting、物理删除和 failed retention 才在现有 Codespace 事务中删除公钥。repository 删除只把 `repo_id` 写为 0，现有公钥随 Codespace 保留但无法匹配任何仓库，保证 repository 生命周期不反向破坏 Codespace 的 resume、stop 和 delete。

**设计理由：专用 Key 类型保留创建者语义。**普通用户 Key 会认证为该用户对全部仓库的账户凭据，Deploy Key 会认证为仓库部署凭据；两者都不能表达“只代表创建者访问当前 Codespace 绑定仓库”。一对一关系和每次 SSH 命令的当前权限检查提供了所需范围，不需要引入 SSH 证书、证书续期或新的密钥服务。

实现验收点：

- [x] 新 UUID 由 Gitea 生成且始终为规范小写 UUID v4；非规范外部 UUID 在查询和加锁前拒绝，同一 UUID 只有一个 lock key 和 `uuid32`。
- [x] 数据迁移创建文中列出的真实字段和非空默认值；模型校验只允许文中列出的状态、operation 类型和运行态值。
- [x] active operation 完成后 operation 字段清空，`operation_rversion` 和最新状态报告 generation 保留当前值。
- [x] 每个 active operation 都保存 `user` 或 `idle` 来源，完成、超时、取消或物理删除时与其他 active operation 字段一同清空。
- [x] 数据库 operation 与 generation 的 0 值只用于尚未产生版本，有效版本从 1 开始，递增不会溢出回绕；inventory 的 observed operation 为 0 时只表达 Manager 缺少完整 active operation 上下文，数据库版本继续采用当前持久值。
- [x] running operation 的总执行期限固定为 `operation_started_unix + OPERATION_MAX_DURATION`。`operation_deadline_unix` 保存本次 lease 截止时间与总执行期限中的较早值；未接近总期限时相对有效时长等于配置的精确 lease 毫秒数，最后一次授权返回到总期限为止、向下取整的正整数毫秒数。
- [x] `auto_stop_mode` 明确区分站点默认、自定义和永不自动暂停；自定义值通过站点范围校验，`never` 不通过超时 0 隐式表达。
- [x] 站点默认自动暂停时间变化后，`default` 对象无需批量更新数据库即可在下一次设置下发中得到新的有效超时。
- [x] `last_active_unix` 不参与自动暂停；Manager/Gateway 仅按实时连接和本地单调空闲计时发起请求，Gitea 用当前启用状态、超时和 `interaction_generation` 重新授权。
- [x] Codespace 的更新只写该动作负责的字段；除记录创建和 repository 删除置 0 外，其他更新均不写 `repo_id`。
- [x] 任一版本耗尽时返回 `version_exhausted` 且不产生部分写入；不依赖新 operation 版本的 force delete 仍可清理 Codespace。
- [x] Codespace 主表不包含 Token ID 或 Token 明文；普通 `access_token` 表不创建 Codespace Token。
- [x] `codespace_gitea_token` 的主键为 `codespace_uuid`，且模型中只有表格列出的字段。
- [x] 正式迁移只接受本文定义的 Codespace 表和字段。发现同名但结构不匹配的既有表时返回包含表名、缺失字段和处理方式的迁移硬错误，由管理员备份并清理后重试。这样迁移结果始终对应当前目标 schema，避免用猜测规则生成生命周期状态。
- [x] 新记录在 create 时固化站点当前首选 `git_protocol`，后续配置变化不改写已有记录。
- [x] 每个 Codespace 最多存在一行 `codespace_gitea_token`；数据库只保存 Gitea Secret 密文，认证只读取 salt/hash，不读取或解密密文。
- [x] 每个 Codespace 最多存在一行 `codespace_ssh_key`，其 `key_id` 唯一关联一个 `KeyTypeCodespace` 公钥；create 实际尝试 SSH remote 时可以创建该关系，HTTP(S) remote 且未尝试 SSH 时可以没有该关系。关系表不重复保存用户、仓库、状态或权限。
- [x] `KeyTypeCodespace` PublicKey 的名称、owner、内容、指纹、写模式、登录源与验证状态使用文中固定值；实际读写能力仍由每次 Git SSH 命令的创建用户权限决定。
- [x] 缺失公钥绑定时可以创建，相同公钥确保请求幂等；已有不同公钥或跨对象指纹冲突时返回 `key_conflict`，任何初始化请求都不能替换现有公钥。
- [x] User、Deploy 和 Codespace 公钥创建按同一规范指纹锁串行，并在各自事务内复查；交叉并发只允许一个创建结果，Deploy 仅复用既有 Deploy PublicKey，历史重复指纹返回数据完整性硬错误。
- [x] Codespace Key 不出现在普通用户 Key、Deploy Key、公开用户 Key 导出或签名 Key 查询中；这些查询使用正向类型条件，不依赖 `NotKeytype`。SSH 强制命令只能由 key ID 解析到绑定 Codespace。
- [x] `serv`、普通 Key 转换和全部按 ID 修改入口使用穷尽类型分支；未知类型在启动 Git 子进程或修改数据库前返回硬错误，不能落入用户或 Deploy 默认分支。
- [x] stop final、stopped、resume 失败或超时保留 Codespace Key；failed、deleting 和全部物理删除路径在状态事务中删除 Key。repository 删除后 Key 可保留但不能访问任何仓库。
- [x] Gitea 与 Manager 的持久状态中不存在 Git SSH 私钥；外部 `authorized_keys` 残留的已删除 key ID 仍会被数据库鉴权拒绝。
- [x] `gcs_` Token 使用现有 Gitea 带盐 hash helper 和常量时间比较；密文解密结果必须重新通过同一 verifier 才能返回。
- [x] `inventory_generation` 通过条件事务只接受高于当前值的新请求。等于或低于当前值返回 stale；正数 observed operation 高于 Gitea 当前版本时返回 Manager 级 `state_history_conflict`，且不更新 generation 或处理 inventory 差异。
- [x] Fetch 的 observed operation 都是正数；Gitea 在任何租约、超时或领取写入前批量预检仍存在且绑定当前 Manager 的记录，observed 版本高于当前 `operation_rversion` 时整次返回 `state_history_conflict`。无记录或 binding 不匹配由完整 inventory 处理，因此数据模型不需要保存 operation 历史或删除墓碑。
- [x] Manager secret 的长度、hex 格式和 `SHA-256(salt_bytes || secret_bytes)` 计算在注册签发和后续认证路径一致；Manager 记录删除后，对应摘要随记录一并删除。
- [x] Manager 归属只由 `owner_id` 表达，不保存无法从 registration token 推导且不参与权限判定的创建者字段。
- [x] 每个 Manager 成功 Declare 后恰有一条 `gateway` 和一条 `ssh` 地址记录；同类型地址不能被两个 Manager 使用。
- [x] Manager 表字段与上表一致；身份有效性、运行可用性、领取意愿和永久撤销分别由记录存在性、runtime state、Fetch 容量声明和直接删除表达。
- [x] 每个 owner 最多存在一行 registration token；重置更新该行，owner 删除后该行物理不存在。
- [x] 用户或组织删除在 repository 删除前通过现有关系完成前置清理；已经为 0 的 `repo_id` 不保留原 owner 历史，也不需要新增冗余 owner 字段。
- [x] Manager 删除物理清理绑定 Codespace、Token、Git SSH Key、日志、Manager 地址行和 Manager row，不新增删除状态、墓碑或远端确认字段。

## Manager Metadata 结构

`codespace_manager.meta_json` 保存 Gitea 根据 `DeclareManager` 明确类型字段生成的展示和诊断信息。固定结构：

```json
{
  "version": "1.0.0",
  "gateway_ssh_host_key_algorithm": "ssh-ed25519",
  "gateway_ssh_host_key_fingerprint_sha256": "SHA256:...",
  "gateway_ssh_host_key_updated_unix": 0,
  "last_capacity_total": 10,
  "last_capacity_available": 3
}
```

规则：

- `version` 是 Manager 当前软件版本，用于管理页面展示和兼容性诊断，不参与 operation 领取。
- `gateway_url` 和 `gateway_ssh_addr` 仍由 Declare 的明确类型字段提交，但规范化结果保存在 `codespace_manager_address`，不重复写入 metadata JSON。Gitea 读取地址表派生 Endpoint URL、展示 SSH 地址，数据库唯一约束负责判定地址冲突。
- `gateway_ssh_host_key_fingerprint_sha256` 是用户首次 SSH 连接前可展示和核对的 Gateway SSH host key 指纹。
- `last_capacity_total` 和 `last_capacity_available` 来自最近成功 Declare，仅用于展示与校验后续启动容量；清理可用容量只存在于单次 Fetch request，不保存到 metadata。
- `gateway_ssh_host_key_algorithm` 与 fingerprint 一起展示，避免用户只看到裸 hash。
- `gateway_ssh_host_key_updated_unix` 用于提示 host key 轮换时间。
- Gitea 每次接受 `DeclareManager` 后校验并覆盖写入规范化 metadata；Manager 不提交自由 JSON/map。
- Manager 可以修改声明字段；每次成功 Declare 整体覆盖当前 `name/tags_json/runtime_state/meta_json`，失败请求不产生部分更新。只保存最新快照，不增加声明历史或版本字段。
- Gitea 不在普通 Codespace 列表页面数据中返回完整 `meta_json`；需要展示 SSH 连接信息的页面按权限读取必要字段。

实现验收点：

- [x] Declare metadata 经过固定 key 校验后覆盖写入规范化 JSON。
- [x] `gateway` 地址规范化后只保留 scheme、DNS base domain 和可选 port，不保存业务 path。
- [x] 不同 Manager 不能写入相同类型的规范化地址，冲突声明不覆盖原地址或 metadata。
- [x] 两类规范化地址均不超过 512 bytes，服务层在写入前拒绝超限值，数据库不发生静默截断。
- [x] 修改后的完整声明要么整体覆盖旧快照，要么全部保持旧值。
- [x] 管理页面可展示 Manager 当前版本，但版本不参与生命周期状态推进。
- [x] 管理页面可展示 Gateway SSH algorithm、SHA256 fingerprint 和更新时间。
- [x] 容量快照只用于展示与诊断，不参与后续 Fetch 领取判断；`cleanup_capacity_available` 只属于单次 Fetch 请求，不写入数据库或 `meta_json`。

## 索引

| 表 | 索引列 |
| --- | --- |
| codespace | `uuid`（主键） |
| codespace | `(user_id, status)` |
| codespace | `(repo_id, status)`，查询 repository 关联记录时使用 `repo_id > 0` |
| codespace | `(status, operation_type, operation_status, manager_id, repo_tag, operation_created_unix, uuid)`，用于 create 批量领取和稳定排序 |
| codespace | `(manager_id, operation_type, operation_status, status, operation_created_unix, uuid)`，用于 stop/resume/delete 领取和 active operation 扫描 |
| codespace | `(operation_status, operation_created_unix, uuid)`，用于 queued operation 超时 keyset 扫描 |
| codespace | `(operation_status, operation_deadline_unix, uuid)`，用于 running operation 当前 deadline 超时 keyset 扫描 |
| codespace | `(status, updated_unix, uuid)`，用于 failed retention keyset 清理；`updated_unix` 在进入 failed 时写入 |
| codespace_manager | `(owner_id, runtime_state)` |
| codespace_manager | `(runtime_state, last_online_unix)`，用于按声明状态筛选并实时派生 offline |
| codespace_manager_address | `(manager_id, kind)`（唯一） |
| codespace_manager_address | `(kind, address)`（唯一） |
| codespace_manager_token | `token`（唯一） |
| codespace_manager_token | `owner_id`（唯一） |
| codespace_gitea_token | `codespace_uuid`（主键） |
| codespace_gitea_token | `token_hash`（唯一） |
| codespace_gitea_token | `token_last_eight` |
| codespace_ssh_key | `codespace_uuid`（主键） |
| codespace_ssh_key | `key_id`（唯一） |

`codespace_gitea_token.codespace_uuid` 主键是单一当前凭据的最终保证。签发在 Codespace lock 内完成；并发插入仍必须正确处理主键冲突并重新读取当前行，不能依赖进程锁代替数据库约束。`token_hash` 唯一索引保证 verifier 值不重复，专用 `gcs_` 前缀负责选择 Codespace 认证路径。

实现验收点：

- queued create 和已绑定 operation 查询使用对应复合索引，不依赖 JSON SQL 匹配。
- Fetch、operation 超时和 failed retention 的过滤、排序与索引列顺序一致；相同时间戳记录使用 UUID 稳定翻页，不重复、不遗漏。
- [x] `codespace_manager_token.token` 唯一索引和 Codespace UUID 主键阻止对应重复记录。
- [x] Manager 地址唯一性由数据库约束保证；并发冲突不会产生两个持有同一 Gateway 或 SSH 地址的 Manager。
- [x] 每个 Codespace 最多存在一个 Gitea Token，Token hash 不重复，末八位只用于缩小候选范围。
- 每个 Codespace 最多存在一个 Git SSH Key binding，每个 key ID 最多属于一个 Codespace。

## Gitea 缓存与对象锁

Codespace 通过 Gitea `modules/cache.GetCache()` 使用站点已经配置的缓存实现，只保存短期易失数据：

- `codespace:open-code:{code_hash}`（一次性的 authorization code 校验缓存，参见 [Gateway Open Token](glossary.md#gateway-open-token)）
- `codespace:runtime-meta:{codespace_uuid}`（当前 Endpoint、internal SSH 和 boot 动态快照，参见 [Runtime Metadata](glossary.md#runtime-metadata)）

memory/twoqueue 的内容随进程退出而丢失；Redis/memcache 可在各项 TTL 内跨 Gitea 重启保留。两种结果都符合缓存语义：Open Code 交换始终重新校验数据库、用户、Manager 和 Endpoint，因此对象停止或删除后即使缓存项暂时存在也不能通过校验；Runtime Metadata 也必须结合数据库主状态与 Manager 在线状态判定。Manager/Gateway 重启时还会关闭全部本地 Codespace session 准入，逐项恢复凭据、SSH、路由并重报 ready 后才开放，因此外部 cache 保留的旧 ready 只用于 Gitea 当前判断，不能单独建立本地连接。Open Code 使用 `OPEN_TOKEN_EXPIRE`，Runtime Metadata 使用 `MANAGER_OFFLINE_TIMEOUT * 2`；这些协议 TTL 直接传给缓存接口，与通用 `[cache] ITEM_TTL` 分开配置。

需要按对象串行执行的 Codespace 写路径直接调用 Gitea `modules/globallock.Lock(ctx, key)`。默认 `[global_lock] SERVICE_TYPE=memory` 时锁位于当前进程，站点配置 Redis 时沿用同一个 Gitea 全局锁后端；两者均服务于单活动 Gitea 进程部署。短期数据直接使用站点 `[cache]`，Session Provider 不参与 Codespace 缓存或锁。

锁 key 由格式化 helper 构造：Codespace owner relation lock 使用 `codespace_owner_{owner_id}`，Manager 使用 `codespace_manager_{manager_id}`，Codespace 使用完整规范化小写 UUID 构造 `codespace_{uuid}`。repository 使用的 `repo_working_{repo_id}` helper 位于 `modules/repository/lock.go` 并导出为 `WorkingLockKey(repoID)`；repository 删除、`CreateCodespace` 记录插入、重命名和 transfer start/accept/reject/cancel 使用同一 repository key。PublicKey 创建使用 `public_key_fingerprint_{SHA-256(规范指纹) 的十六进制摘要}`。Manager 地址冲突由数据库唯一约束判定，因此该对象没有锁 key。

Codespace owner relation lock 只保护 CreateCodespace、Manager 和 registration token 等本设计新增的 owner 关系。`owner_id=0` 使用 `codespace_owner_0`，用于串行化 global registration token 与 Manager 注册；它不对应可删除账户。普通 repository 创建、package、组织成员和 team 成员继续使用 Gitea 现有服务、purge 复扫和最终事务检查。

**设计如此：Codespace 不建立覆盖 Gitea 全部所有者关系的通用锁。**账户删除成功需要额外保证 Codespace 新关系为空，但 repository、package 和成员已有自己的创建与删除流程。只让新关系和账户清理共享专用锁，可以证明 Codespace 结果，又不会为了本功能重写无关子系统的并发边界。

下表完整列出本设计使用全局锁的写路径和锁层级：

| 写路径 | 取得的 lock |
| --- | --- |
| registration token GetOrCreate、重置；全部 Manager 注册（包括 `owner_id=0`） | Codespace owner relation |
| Declare 完整快照与 Gateway/SSH 地址写入 | Manager |
| 完整 `FetchOperations` 请求 | Manager；处理 running operation 或 queued timeout 时再取得对应 Codespace |
| `ReportInstances` | 接受 inventory generation 使用数据库条件写入；逐项需要写 Codespace 时取得对应 Codespace |
| `FinalizeOperation`、`UpdateLog`、`ReportRuntimeMetadata`、`ReportRuntimeTransition`、`RequestGiteaToken`、`EnsureCodespaceGitSSHKey`、`RequestIdleStop` | Codespace |
| State Finalization、用户对单个 Codespace 的生命周期动作和自动暂停设置、Open Code 签发/消费、Gateway SSH 成功认证、开发凭据签发/登记/吊销、单 Codespace 物理删除、reconciliation | Codespace |
| Manager 删除 | 全程持有 Codespace owner relation、Manager；按 UUID keyset 每次取得一个绑定 Codespace |
| 用户或组织删除 | 在 Codespace 前置清理、复扫和最终删除阶段持有目标 Codespace owner relation；删除该 owner 自有 Manager 时再取得一个 Manager，删除其余关联 Codespace 时每次只取得一个 Codespace |
| `CreateCodespace` 记录插入 | 创建者和 repository owner 的 Codespace owner relation、repository |
| repository 删除 | repository |
| pending transfer 创建、取消或拒绝 | repository |
| 接受 transfer 或其他实际修改 repository owner | repository |

Fetch 的 queued 条件 claim 已受调用方 Manager lock 保护，不额外取得 repository 或 Codespace lock；最终更新同时匹配 UUID、`status=creating`、`manager_id=0`、当前 `operation_rversion`、`operation_type=create`、`operation_status=queued` 和 `operation_trigger=user`，只有 affected rows 为 1 才表示领取成功。普通未绑定同步删除在 Codespace lock 内先读取记录，再以同一 UUID、`manager_id=0`、主状态和预读到的 `operation_rversion`、`operation_type`、`operation_status`、`operation_trigger`、`operation_created_unix`、`operation_started_unix`、`operation_deadline_unix` 物理删除 Codespace 主记录；queued create 的删除条件具体匹配 `status=creating + operation_type=create + operation_status=queued + operation_trigger=user`，没有 active operation 的 failed 记录则匹配空类型、空状态、空来源和三个 0 时间字段。主记录 affected rows 为 1 后，在同一事务中删除 Codespace Token、Git SSH Key 关系及其 `PublicKey` 和 DBFS 日志元数据。任一子项删除失败会回滚整笔事务，使主记录继续存在。claim 和 queued create 删除因此由数据库提交顺序裁决：claim 先提交时删除条件影响 0 行，删除方重新读取后按已绑定 Codespace 创建 delete operation；删除先提交时 claim 影响 0 行。claim 提交后构造 payload 时还要重新确认同一 UUID、版本、来源和 running operation，记录已删除或 operation 已替换时不返回旧 payload。只有遇到过期 queued 项并执行 timeout 时，Fetch 才按 timeout 路径取得 Codespace lock。

repository 数据库删除已经由 repository lock 串行，并通过字段级 SQL 只把匹配记录的 `repo_id` 写为 0，因此不需要逐个取得 Codespace lock。其他 Codespace 更新只写各自负责的字段，不会覆盖 `repo_id`。只取得 Codespace lock 的 Manager RPC 在锁内事务中重新读取 Manager 是否仍存在、`manager_id` binding 和 operation/version；它可以先完成并由随后取得 Codespace lock 的删除事务清理，或者在删除提交后复检失败。账户清理同样只在逐条删除关联 Codespace 时取得 Codespace lock；记录绑定到 `owner_id=0` 或其他 owner 的 Manager 时也使用相同顺序。删除事务提交后，旧 RPC 会在 Codespace lock 内复检失败；先完成的 RPC 结果则由删除事务一并清理。这样账户删除不会反向取得 Manager lock，也不会阻塞全局 Manager 的其他工作。

同一短事务确实需要多个锁时，代码按 Codespace owner relation、repository、Manager、Codespace 直接多次调用 `globallock.Lock`；同层多个 ID 去重并升序取得，完整 UUID 按字符串升序，后一个取得失败或操作完成时逆序释放。锁在受保护的数据库事务前取得，事务内重新读取关系双方，已持锁内部函数复用调用方持有的锁。Manager 删除持续持有 Codespace owner relation 和 Manager 父级锁；用户或组织删除只在 Codespace 前置清理、最终复扫及删除 owner 的阶段持有目标关系锁，子对象按 keyset 顺序逐个取得、提交和释放。锁内不调用 Manager、Gateway 或其他网络服务。这样既避免一次持有全部 Codespace lock 或开启覆盖全部子对象的长事务，也使已经只持有 Codespace lock 的清理路径无需反向取得 Manager 或 owner relation lock。

`ReportInstances` 不在逐项处理完整 inventory 时持有 Manager lock。处理函数先批量预读 request 中已存在且绑定当前 Manager 的 operation 版本；正数 observed operation 高于 Gitea 当前值时返回不可重试的 Manager 级 `state_history_conflict`。预检通过后，更高 generation 由条件事务接受，等于或低于当前值返回 stale。之后每项处理复检 Manager 当前 generation 等于请求值；Manager 或 generation 复检失败会结束整个请求。Codespace 无记录、binding 不匹配和 failed 进入该 UUID 的 cleanup 动作判定。新 generation 被接受后，旧请求停止处理；请求结束时再次检查 generation，已经过期的请求不返回结果。generation 表达完整扫描请求的替代顺序，避免最多 10000 项的长请求阻塞 Fetch、Declare 或删除。

Codespace Token 的 Git/LFS/API 认证、Gateway session 复检、页面读取和 `last_active_unix` 的尽力展示更新直接读取数据库，不取得 Codespace lock。Open Code 签发/消费、SSH 成功认证、继续运行、resume、自动暂停设置和 `RequestIdleStop` 会推进交互版本、取消 queued idle stop 或创建 operation，因此使用 Codespace lock 并在锁内复检状态。普通读取结果用于判定当前请求；之后发生的状态变化由下一次认证或 session revalidate 读取。这样的边界只串行化会影响空闲停止竞态的写入，不把每个 Git/LFS/API 请求变成生命周期锁热点。

CreateCodespace、Manager 注册/删除和 registration token 变更在 Codespace owner relation lock 内重新读取涉及的用户或组织；记录不存在或类型不符合入口要求时返回明确业务错误，不继续使用锁前读取的旧 `*User`。账户删除在同一锁内完成 Codespace 最终复扫和空集合确认。issue、comment、commit 等历史署名以及 repository、package、成员关系继续使用 Gitea 现有删除映射和检查，因为它们不属于 Codespace 新增关系。

规则：

- cache 只保存交互所需的动态数据和页面展示快照；数据库主状态始终是授权与生命周期结果的权威来源。
- Runtime Metadata 写入失败时，create/resume final done 保持 active operation 并重试；数据库 final 提交失败时，已有 creating/stopped 主状态继续阻止交互。
- stopped/failed 或物理删除先提交数据库和开发凭据结果，再尽力清除 Runtime Metadata。物理删除提交后先释放所持 `globallock`，再在锁外清理 cache 和按配置同步 SSH 授权文件；清理失败只记录服务端日志，不回滚或改写已经提交的生命周期结果。尚未消费的 open code 会在短 TTL 后失效，期间也会因数据库主状态或记录复检失败而拒绝。
- open code 签发只有在 code 写入和交互事务都成功后才返回。消费先按 `code_hash` 读取 binding 中的 `codespace_uuid`，取得该 Codespace lock 后重新读取同一 code，再完成数据库、权限和 Endpoint 校验。无法解析或显式过期的 code 尽力删除；实时访问条件不满足时拒绝并保留到原 TTL；全部校验通过后必须成功删除 code 才返回 binding。
- cache 原生跨 key 原子操作不是正确性的前提；keyed lock、数据库复检、短 TTL 和失败后的确定返回共同保证安全边界。
- cache 内容都是短期、可失效或可由 Manager 重建的数据；丢失不影响 codespace 生命周期、权限、删除处理或 operation 超时判断。
- 主状态和权限相关的持久数据都以数据库为准。
- Gitea 缓存读取接口把后端读取错误和 key miss 都返回为未命中。Open Code 未命中按无效凭据拒绝，Runtime Metadata 未命中返回 `metadata_rebuilding`；无法解析的值记录日志并尽力删除，再使用对应的未命中结果。需要成功完成的缓存 Put/Delete 或 `globallock.Lock` 失败时返回 `internal_error`，调用方按统一失败分类处理。数据库结果提交后的缓存清理失败记录日志，数据库结果保持有效。

实现验收点：

- 清空 Codespace cache 后，codespace 主状态、active operation、当前 Gitea Token、Git SSH 公钥绑定和日志仍可从数据库恢复。
- open code cache 丢失只使未消费 code 失效，Runtime Metadata cache 丢失只暂时影响交互和展示。
- memory/twoqueue 重启后可以丢失 cache，Redis/memcache 可在 TTL 内保留；两种情况下 Open Code 都重新执行完整访问校验，Runtime Metadata 都不替代数据库主状态。
- open code 只在 code 写入和交互事务都成功后签发；无法解析或显式过期时尽力删除，运行时访问条件不满足时保留到原 TTL，成功校验后的删除失败不返回 binding。
- Codespace 物理删除提交后尽力删除 Runtime Metadata cache；清理失败不改变删除结果。尚未消费的 Open Code 在 TTL 内可能保留，交换时的数据库复检会因记录不存在而拒绝，并让 code 按原 TTL 失效。
- `updated_unix` 只按生命周期结果矩阵变化；queued idle stop 取消因 active operation 结束而更新，未改变 operation 的交互或设置、claim、续租、metadata、日志、token 修复和 `repo_id` 置 0 不刷新 failed retention 起点。
- repository 删除与状态流转、续租、日志元数据、设置或 `last_active_unix` 更新并发时，无论提交顺序如何，最终 `repo_id` 都保持为 0；测试同时断言另一动作负责的字段，证明两次字段级更新都已生效。
- 文档明确列出的串行写路径直接调用 Gitea `globallock.Lock`，cache 与 lock 后端都使用站点现有配置；取得 lock 失败时返回可重试内部错误。
- repository 删除、`CreateCodespace` 记录插入、重命名和 transfer start/accept/reject/cancel 通过 `modules/repository.WorkingLockKey` 使用同一个 `repo_working_{repo_id}`；普通 repository 创建、push、设置修改和文件初始化不增加该锁。需要多个锁的路径按 Codespace owner relation、repository、Manager、Codespace、PublicKey fingerprint 的适用层级取得，内部已持锁实现复用同一 key；用户、组织或 Manager 删除一次只持有一个 Codespace 子锁。
- `FetchOperations` 在调用方 Manager lock 内重新读取 Manager 并完成 running 处理和 queued claim；普通未绑定 delete 与 claim 通过带 UUID、版本、binding 和 operation 条件的数据库写入确定唯一胜者，不为 claim 增加 Codespace lock。claim 后构造 payload 必须复检当前记录和 operation，已删除或已替换时不返回旧 payload。
- `FetchOperations` 在所有业务写入前预检 observed operation；高于已存在且绑定当前 Manager 的当前版本时整次请求没有租约、超时、领取、Token 或 cache 写入，无记录或 binding 不匹配等待完整 inventory 收敛。
- 用户或组织删除逐条清理关联 Codespace 时只取得 Codespace lock 并在事务中复检三条 owner 关系；绑定到其他 owner 或 `owner_id=0` Manager 的记录也按此处理，不取得外部 Manager lock。owner 自有 Manager 的身份删除仍使用 Codespace owner relation、Manager、Codespace 层级。
- `ReportInstances` 在写入前预检 reported UUID 的 operation 版本；历史冲突不推进 generation。预检通过后只接受更高 generation，逐 UUID 取得 Codespace lock 并复检 Manager 和当前 generation。无记录、binding 不匹配和 failed 是单项 cleanup 判定，不结束仍有效的请求。数据库或 RPC 错误不生成清理 action；新 generation 接受后旧请求停止写入且不返回结果。
- Token、SSH 和 Gateway session 的认证读取不调用 `globallock.Lock`；Open Code 单次消费、Token 生命周期写入、日志和跨数据库/cache 的状态变更仍使用 Codespace lock。
- CreateCodespace、Manager 和 registration token 写入口先取得涉及 owner 的 `codespace_owner_{owner_id}`，并在事务中复读关系双方；账户最终删除持有同一 key 时，这些入口不能提交新的 Codespace 关系。
- repository、package、组织与 team 成员入口不调用 `codespace_owner` 锁；账户删除对这些关系继续使用 Gitea 当前 purge 复扫和最终事务检查，Codespace 文档不改变其并发语义。
- 用户或组织删除成功后，不存在 repository、package、组织成员、team 成员、Codespace、Manager 或 registration token 继续以目标 ID 作为有效 owner 关系；issue、comment、commit 等历史署名按 Gitea 现有删除映射处理。

## Runtime Metadata 结构

`ReportRuntimeMetadata` 只写当前 Runtime Metadata 快照。允许的结构：

```json
{
  "runtime": {
    "internal_ssh": {
      "host": "10.0.0.12",
      "port": 2222,
      "user": "codespace",
      "auth_mode": "publickey",
      "host_key_fingerprint": "SHA256:..."
    }
  },
  "endpoints": [
    {
      "endpoint_id": "workspace",
      "label": "Workspace",
      "public": false
    },
    {
      "endpoint_id": "app-3000",
      "label": "App 3000",
      "public": true
    }
  ],
  "boot": {
    "operation_rversion": 1,
    "stage": "start-environment",
    "started_unix": 0,
    "last_update_unix": 0
  }
}
```

规则：

- 顶层固定且必填为 `runtime`、`endpoints`、`boot`；`boot` 固定且必填为 `operation_rversion`、`stage`、`started_unix`、`last_update_unix`。规范之外的字段被拒绝，使 Manager、Gitea 和 Gateway 对同一快照得到一致解释。
- `endpoints` 始终以 JSON 数组存储；没有 Endpoint 时使用空数组，不省略字段。
- `internal_ssh` 不进入 Gitea 面向用户的页面数据或响应。
- `internal_ssh` 在 SSH 尚未就绪的 boot 阶段可以不出现；一旦出现以及 `boot.stage=ready` 时，`host/user/auth_mode/host_key_fingerprint` 必须为非空字符串，`port` 必须在 1-65535，`auth_mode` 为 `publickey`。字段是否存在直接表达 SSH 就绪状态，避免用空 host/port 表示未就绪。
- `boot.stage` 只允许 `prepare-runtime`、`initialize-system`、`prepare-workspace`、`start-environment`、`publish-runtime`、`ready`。create 与 resume 都由 Manager 按通用 init/prepare/activate 顺序推进；脚本内部的包管理器、Git 和运行环境子步骤只写日志，不增加状态枚举。同一 `boot.operation_rversion` 只前进，已经接受 `ready` 后保持 `ready`。
- `started_unix > 0`，`last_update_unix >= started_unix`；同一 operation 启动上下文的 `started_unix` 保持不变，阶段推进或状态刷新更新 `last_update_unix`。
- active create/resume 上报的 `boot.operation_rversion` 等于当前 operation。running 快照固定为 `ready`，boot 版本不大于当前 `codespace.operation_rversion`；stopped 且无 active operation 时不发布 Runtime Metadata。resume failed、timeout 或 abort 后，Manager 清除本轮 boot 发布上下文，迟到的本次 resume 版本上报因 active operation 已结束而被拒绝；下一次 resume 使用更高 operation 版本从保留的 Incus 实例重建完整快照。
- create 和 resume 的 `final done` 都要求当前快照的 boot 版本等于当前 operation 且 `stage=ready`。resume 在 active operation 内申请 Token、写入 Runtime credential 并上报 ready；Gitea 还要求当前 Token 行完整，才把主状态从 stopped 改为 running。Manager 在 ready 前根据本地实际 remote 验证 HTTP helper 或 SSH 密钥、公钥绑定与 known_hosts；该结果不进入 Runtime Metadata，Gitea final 不重复判断实际协议。旧版本的 ready 不能完成当前恢复；cache miss 时 Manager 用正 generation 重建当前 operation 快照。Manager 保留最新 boot 终态的 `operation_type + operation_rversion + outcome`，其中 outcome 为 `done|recoverable_failed|unrecoverable_failed`，用于重启恢复和不可恢复 resume 在 final failed 后继续上报 failed。`done` 和 `recoverable_failed` 可由下一次合法初始化替换；`unrecoverable_failed` 保留到 failed 状态报告或 delete 完成。stopped 主状态存在已领取且租约未到期的 active resume 时，初始化所需的 Gitea Token 与已有 Git SSH Key 可用于恢复本地凭据配置；面向用户的 open 和 Gateway SSH 仍等待 `final done` 原子写入 running。**设计如此：ready 证明已初始化 workspace 的本地凭据配置和交互入口完整，不证明 repository 仍然存在或可访问；`repo_id=0` 时仍可恢复 running，Git HTTP(S)、LFS 和 repository API 没有绑定仓库能力但保留公开只读访问，写入、管理、私有或不可见目标由 Gitea 拒绝。Git SSH Key 不能匹配任何仓库。**
- `endpoint_id` 由 Manager 上报，固定匹配 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`，并在同一 `codespace_uuid` 内保持唯一。该规则明确排除首尾连字符，最长 ID 与分隔符、32 位 UUID 组成恰好 63 字节的普通 Endpoint DNS label。
- Endpoint 数量不超过协议固定上限 64，规范化 JSON 不超过 `RUNTIME_METADATA_MAX_SIZE`。
- 不同 codespace 可以使用相同 `endpoint_id`。
- `label` 只用于 UI 展示，可以重复，不是路由键。它必须是合法 UTF-8，使用 Go `strings.TrimSpace` 去除首尾 Unicode 空白后保存，经 `utf8.RuneCountInString` 计算的长度为 1 到 64，并且不包含 `unicode.IsControl` 判定的控制字符、`<` 或 `>`。Manager 与 Gitea 执行相同校验，不做 Unicode 归一化、字符替换或自动清洗；规范化内容 hash 使用校验后的规范值，UI 仍按普通文本 escape。
- 每个 Endpoint 必须包含布尔 `public`；false 使用 Gateway session 认证，true 表示普通 Endpoint 可以在 Gitea 和 Manager 双重校验后匿名访问。该值由持有 Runtime Token 的工作环境进程明确声明，不从 repository 可见性、创建用户权限、端口或 label 推导，也不在 Gitea 页面保存第二份确认状态。声明随 Manager 当前快照跨 stop 保留，stopped 阶段没有访问入口，resume ready 后重新发布当前值。
- `endpoints` 只保存 Runtime 实际声明；稳定的 `workspace` 描述由 Gitea 另行生成。同名记录存在时 Manager 使用其 Runtime upstream，不存在时 Manager 使用内置 Web SSH；两种情况的 Open Token binding 都是 `endpoint_id=workspace`。**设计如此：`workspace` 的 `public` 固定为 false。**这保证同名 Runtime Endpoint 删除后回退到内置 Web SSH 时不会继承公共访问能力；需要公开服务时使用普通 Endpoint。
- Runtime Metadata 保存在 Gitea cache。
- key：`codespace:runtime-meta:{codespace_uuid}`
- value：当前 `endpoints + internal_ssh + boot`、Gitea 接受请求时写入的 `last_reported_unix`，以及 request envelope 中的 `metadata_generation` 和规范化内容 hash
- ttl：`MANAGER_OFFLINE_TIMEOUT * 2`
- 只要所属 Manager 在线，Gitea 即信任当前 cache 中的 Runtime Metadata。
- Gitea 信任 Runtime Metadata cache 仅表示 open/SSH 的 ready、普通 Endpoint existence/public 属性、internal SSH 和 UI 展示信任当前 cache 内容；resume 不读取该 cache。
- Gitea 缓存未命中后，Runtime Metadata 由 Manager 重建；外部缓存实现在 TTL 内保留的合法快照可以继续使用。
- Manager 离线时，新的 open、公共 Endpoint 请求和 SSH 都不能通过授权校验。
- Runtime Metadata 仅记录当前最新快照，cache miss 只影响交互与展示。
- `metadata_generation` 由 Manager 每个 Codespace 的单一 metadata 发布任务管理。boot、Endpoint、internal SSH 和恢复流程先更新同一份本地完整快照并唤醒该任务；规范化内容变化时 checked increment 并原子持久化，内容不变时复用原 generation 刷新 TTL。更高版本覆盖 cache，相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回不可重试的 generation conflict，更低版本返回当前版本。Manager 只对 stale 使用服务端当前值加一；同代不同内容表示本地状态损坏或第二写入者，返回硬错误并删除该 Codespace 的归属 Incus 实例和本地状态文件。
- metadata 发布任务同一时刻最多发送一个请求，并在发送前保存该请求的 generation 和完整快照。成功空响应确认 Gitea 接受了本次请求；请求快照中的 boot 等于当前 create/resume operation 且 stage 为 `ready` 时，本轮 boot 就已满足 final 前置条件。即使本地已经产生更高 Endpoint generation，发布任务也只需继续发送最新快照，不会撤销已成立的 ready。该接受记录只存在于 Manager 进程内，重启后通过相同 generation、相同内容的幂等重报恢复。
- metadata generation 无法递增时返回不可重试的 `version_exhausted`，不提交本地快照、路由或 generation 的部分结果；Manager 按单 Codespace 持久状态损坏流程清理该 UUID，不增加独立恢复阶段。
- `last_reported_unix` 由 Gitea 在接受请求时写入，不参与 Manager 快照内容或 generation 比较。
- Runtime Metadata 规范化使用固定 JSON 字段、对象 key 排序和按 `endpoint_id` 排序的 endpoints；内容 hash 不受 Manager 原始 JSON 空白或对象 key 顺序影响。
- Runtime Metadata 是动态运行信息，用于展示和交互入口。主状态由 operation 状态写入和 reconciliation 处理，推进依据来自数据库状态。

实现验收点：

- metadata generation 相同的重试幂等，更低 generation 不覆盖 cache。
- 相同 generation、不同规范化内容被拒绝；相同内容的周期刷新可以延长 TTL。
- metadata generation stale 以服务端当前值为基线升代；同代冲突和 checked increment 耗尽分别返回 `generation_conflict` 和 `version_exhausted` 硬错误。
- endpoint ID 在单个 codespace 内唯一；每项具有必填布尔 `public`，`workspace` 只能为 false；internal SSH 不进入 Gitea 页面数据或任何面向用户的响应。
- Endpoint label 在 Manager 和 Gitea 使用相同 UTF-8、去除首尾 Unicode 空白、1 到 64 字符及禁止字符规则；非法 label 不写入本地路由或 Gitea cache，合法中文和其他普通展示文本保持原值。
- metadata ready 且没有 `workspace` 记录时，默认 workspace open 仍有效，UI 使用稳定 workspace 描述，Manager 将其解析为内置 Web SSH。
- resume 在 final 前完成同一 operation 版本的系统初始化、Token 写入、环境恢复和 ready 上报；Manager 重启后从 active operation 和本地 boot 上下文继续，final 成功后无需恢复独立凭据任务。
- 未知字段、缺失固定字段、非法 boot stage、错误 boot operation 版本和不完整 internal SSH 被拒绝；create 在当前 operation 的 ready 快照前不能 final done。
- active create、active resume 和 running 使用固定 boot 版本与阶段矩阵；无 active operation 的 stopped 拒绝 metadata，同版本 ready 不回退，已结束 resume 的迟到快照不能重建当前启动上下文。
- 每个 Codespace 只有一个任务修改 metadata generation 并发布当前完整快照；Endpoint、boot、SSH、恢复和周期刷新不各自维护待发布版本。
- create/resume final 等待任一包含当前 operation ready 的成功上报，不等待随后产生的 Endpoint generation；发布任务仍会继续到本地最新快照被接受。
- metadata generation 耗尽时内容变化没有本地部分提交，并返回 `version_exhausted`；Manager 持久化最小 pending 后清理该 UUID，已有 operation 由完整 inventory 或 running deadline timeout 收敛到既定结果。
- cache TTL 刷新不改写 `last_active_unix` 或主状态。

## 日志存储

Codespace [Operation](glossary.md#operation) 日志存储在 DBFS（`models/dbfs/`，32KB 分块存储）。同一 codespace 的并发写入由 codespace 日志服务串行化，不能把 DBFS revision 字段当作乐观锁。

路径：

```text
codespace_log/{codespace_uuid}.log
```

规则：

- Manager 通过 byte offset 追加，单文件连续写入。
- Gitea 服务层可以为完整 failed 对象和最终状态写入通过内部入口追加摘要；每次内部追加与其日志元数据在同一个 DBFS 事务中提交。
- offset 等于当前大小时追加。
- offset 小于当前大小时，只允许规范化后的完整请求段已存在且逐字节相同的幂等重放；部分重叠返回 offset conflict 和当前文件末尾，不补写尾部。
- offset 大于当前大小时返回 offset gap 分类，保持日志文件连续。
- 每条存储日志都是已脱敏单行。
- Manager 上报结构化 `timestamp_unix_nano + message`；Gitea 统一编码为 UTF-8 `[RFC3339Nano] message\n`。
- `UpdateLog` 成功响应返回规范化、脱敏并写入后的 `next_offset`；Manager 以该服务端值推进下一次追加。
- message 包含换行时，Manager 在提交前按换行拆成多条物理日志行；存储层每个 `lines[]` 元素只接受一行，渲染器按物理行顺序展示。
- 按 `log_indexes` 提供的行号到 byte offset 映射进行 seek 读取。
- `GET /-/codespaces/{uuid}/logs` 使用 byte offset 分页读取，返回 `offset / next_offset / eof / lines / truncated`。
- 读取 offset 必须为 0、文件末尾或 `log_indexes` 中的物理行起点；落在 UTF-8 字符或物理行中间时返回 offset conflict 和该物理行起点。
- 第一条完整物理行超过请求 `limit` 时仍单独返回该行并推进 `next_offset`，避免客户端因过小 limit 永远无法前进；单次响应始终不超过 `LOG_READ_MAX_BYTES`，配置要求 `LOG_MAX_LINE_SIZE <= LOG_READ_MAX_BYTES`。
- delete 成功后删除 codespace 日志。
- `failed` 日志保留到用户 delete，或 `reconcile_codespaces` 按 `OLDER_THAN` 到期清理。
- 日志使用 DBFS，表中无需保存固定值的 storage 类型；当前日志读写只涉及 DBFS 文件和表内日志元数据。
- Gitea 单实例内使用按 `codespace_uuid` 分片的 keyed lock 串行化日志追加；锁内开启数据库事务，并使用该事务 context 打开和写入 DBFS，校验 operation 和 offset，让 DBFS 写入与 `log_size/log_line_count/log_indexes` 更新共同提交。DBFS 的 revision 字段本身不提供 compare-and-swap，不能代替该串行化边界。
- 在 keyed lock 内，普通 batch 会让当前文件从普通日志上限以下跨过 `LOG_MAX_SIZE-LOG_FINAL_SUMMARY_RESERVE` 时，拒绝该 batch 并只写一条固定截断摘要；文件已经达到该上限后的普通 batch 直接拒绝且不重复写摘要。截断摘要和最终状态摘要合计上限为 `LOG_MAX_SIZE`，最终摘要优先使用剩余预留空间。现有大小和摘要元数据足以完成判断。
- Manager 在 final 前写 operation 最终摘要。对于仍保留 Codespace 记录的 final、timeout、missing 和 failed 状态报告，Gitea 在主事务提交后、释放 Codespace keyed lock 前使用剩余预留空间尽力追加内部状态摘要；该独立 DBFS 事务失败或空间耗尽时只记录服务端日志，不回滚生命周期结果。delete done、Gitea 直接删除和 retention 清理跳过摘要，避免删除后重新创建日志。

日志存储在 DBFS 单文件中，`codespace` 行保存当前日志元数据。只有当前 `operation_status=running` 且 `operation_rversion` 匹配时允许追加日志。DBFS 写入与生命周期事务边界明确，日志归档状态不会进入 Codespace 状态机。

实现验收点：

- 同一 codespace 的并发日志追加被串行化，两个相同 offset、不同内容的请求只有一个可以写入。
- DBFS 内容与 `log_size/log_line_count/log_indexes` 在同一数据库事务中提交或回滚。
- message 中的换行被拆成多条物理日志行，行数、索引和分页结果一致。
- offset 按服务端规范化编码后的完整字节计算，读取不拆分 UTF-8 字符或物理日志行。
- 超过请求 limit 的物理行可以单独分页返回，非法行中 offset 返回该物理行的服务端起点，响应仍遵守服务端读取硬上限。
- 达到普通日志上限后只出现一条截断摘要，最终文件大小不超过 `LOG_MAX_SIZE`。
- 内部状态摘要只为仍保留 Codespace 记录的结果在主事务提交后尝试；摘要事务失败时主状态和 active operation 结果保持已提交，物理删除后日志保持不存在。
- codespace 日志按单文件连续 offset 追加，并随 codespace 物理删除或 failed retention 清理。
- 物理删除调用 DBFS Remove 时把 `fs.ErrNotExist` 视为幂等成功；其他 DBFS 错误回滚当前本地删除事务。尚未写入日志的合法 Codespace 因此不会阻塞资源清理。
- offset conflict/gap 返回服务端当前 offset，Manager 不通过本地编码结果猜测恢复位置。
