# 术语

## 术语定义

<span id="codespace"></span>
### Codespace
Gitea 中的一条远程开发环境记录。

<span id="runtime-instance"></span>
### Runtime Instance
Manager 为一个 Codespace 创建并持有的单个 Incus 实例。实例可以是虚拟机或系统容器，两者对 Gitea、Runtime HTTP API 和用户生命周期透明；workspace 保存在实例根存储中。

<span id="codespace-manager"></span>
### Codespace Manager
运行侧服务，负责注册、领取 operation、通过 Incus 管理 Runtime Instance、上传日志和上报 Runtime Metadata。删除 Manager 时，Gitea 删除其注册身份及绑定的 Gitea 资源并同步返回；运行侧实例是否回收由部署运维负责。这样账户和身份删除不依赖 Manager 在线。

<span id="codespace-gateway"></span>
### Codespace Gateway
Manager deployment 内的用户 Endpoint 与 SSH 接入组件。

<span id="manager-service"></span>
### ManagerService
Gitea 实现、Manager 调用的 Connect RPC over HTTP/HTTPS 服务；scheme 由部署配置决定。

<span id="runtime-http-api"></span>
### Runtime HTTP API
Manager 实现、Runtime Instance 的受控 helper 使用 Runtime Token 调用的 HTTP(S)/JSON API，只提供 Git SSH 公钥确认和 Endpoint 管理；create/resume 输入与结果通过 Incus exec 环境和本地文件传递。是否要求 HTTPS 由 Manager 配置决定。

<span id="operation"></span>
### Operation
Gitea 当前下发给 Manager 的异步生命周期操作，类型为 create、resume、stop、delete，来源为用户操作或空闲触发。queued operation 有固定等待期限；running operation 通过短 lease 保持当前执行授权，并由首次领取时间计算固定总执行期限，持续续租不能越过该期限。operation 只表示 active 指令，完成后不保留历史状态；`abort_create|abort_resume` 是站点排空时用于结束现有 create/resume 的清理命令，不增加新的 operation 类型。

<span id="automatic-stop"></span>
### 自动暂停
Manager/Gateway 在 Codespace 为 running/ready、设置启用、没有生命周期 worker 且没有已认证 live session 时开始单调计时，连续达到有效超时后发起空闲停止。公共 Endpoint 连接不代表创建者交互，不进入该计数。Gitea 使用当前启用值、有效超时、交互版本和生命周期状态授权并创建来源为 idle 的普通 stop；完成后主状态为 stopped，用户使用普通 resume 恢复。对象设置 `default/custom/never` 分别表示站点默认、自定义时长和关闭空闲触发；延迟设置快照不能绕过 Gitea 的当前值复检。

<span id="manager-matching"></span>
### Manager Matching
Gitea 按 owner scope 和 repository tag 匹配可以领取 create operation 的 Manager。

<span id="manager-capacity"></span>
### Manager Capacity
Manager 通过 Declare 上报 Runtime 总容量，Gitea 规范化写入 `meta_json`，用于管理页面展示、诊断和校验后续启动可用容量。`FetchOperations` 分别提交本次 `capacity_available` 和 `cleanup_capacity_available`，真实 Runtime、启动 worker 和清理 worker 占用仍由 Manager 计算。

<span id="endpoint"></span>
### Endpoint
使用 `endpoint_id` 标识的 HTTP/WebSocket 入口。普通 Endpoint 来自 Runtime Metadata，并以必填 `public` 布尔值明确选择 Gateway session 认证或公共访问；每个 running Codespace 另有稳定且固定需要认证的 `workspace` 逻辑入口，Manager 在 Runtime 声明同名 Endpoint 时连接该 upstream，否则由内置 Web SSH 管理器连接当前 internal SSH 入口。公共访问仍由 Gitea 实时检查当前 Codespace、Manager 和 metadata，不从 repository 可见性推导。

<span id="gateway-open-token"></span>
### Gateway Open Token
Gitea 为打开需要认证的 Endpoint 签发的一次性短期 opaque token。采用 OAuth2 Authorization Code 模式：Gitea 作为 Authorization Server 签发 authorization code（`hex(CryptoRandomBytes(32))`），Gateway 作为 Client 以 Manager 身份提交 code 换取 open binding。公共 Endpoint 不使用该 token。完整流程见 [Gitea 服务端 - Gateway Open Token](gitea-server.md#gateway-open-token)。

<span id="gitea-token"></span>
### Gitea Token
Gitea 为 Runtime Instance 签发的独立、不透明开发凭据，使用 `gcs_` 前缀并存储在 `codespace_gitea_token`。它代表 Codespace 创建用户，在有效 create/resume 初始化期和 `running` 都能授权新请求，用于开发协作 API、LFS，以及 HTTP 协议 Codespace 的 Git smart HTTP；创建用户登录限制、单仓库绑定和现有业务权限仍在每次请求中检查。稳定 `stopped` 没有 Token，它不是普通 PAT。

<span id="codespace-git-ssh-key"></span>
### Codespace Git SSH Key
Runtime 尝试通过 SSH 访问 Gitea 仓库时使用的运行环境凭据。`start.sh` 在首次 SSH clone 前生成 Ed25519 密钥对，create 重试和 SSH remote 的 resume 校验并复用；私钥只保存在 Runtime，公钥由 Manager 通过 `EnsureCodespaceGitSSHKey` 确认到 Gitea 的 `codespace_ssh_key`。SSH 尝试失败而 HTTP(S) 回退成功时，已经登记的关系按 Codespace 生命周期保留，但不参与 HTTP(S) remote 的 ready 校验。有效 create/resume 初始化期和 `running` 可以使用，稳定 `stopped` 保留关系但拒绝命令。私钥、公钥或 Gitea 绑定相互矛盾时，Manager 将该 Runtime 收敛到 failed，因为原 workspace 的 Git 身份已经无法安全确认。Gitea 在每个 Git SSH 命令上按 Codespace 当前仓库、阶段、创建用户登录限制和权限鉴权。它与用户连接工作区的 Gateway SSH Key、Manager 连接内部 sshd 的 client key 是三个独立凭据。

<span id="registration-token"></span>
### Registration Token
管理员为 owner scope 创建的当前明文注册凭据，存储在 `codespace_manager_token` 表，每个 owner 最多一行。Manager 通过 `RegisterManager` 注册并获得 manager secret；Registration Token 轮换会原地替换该行，停用会物理删除该行，不保存历史。

<span id="runtime-token"></span>
### Runtime Token
Manager 签发给 Runtime Instance 调用 Runtime HTTP API 的 token。

<span id="manager-secret"></span>
### Manager Secret
Manager 调用 ManagerService RPC 的长期凭据。它在注册成功时签发，并与 Manager 记录保持相同生命周期；registration token 的轮换或停用不影响已注册 Manager。

<span id="runtime-metadata"></span>
### Runtime Metadata
Manager 上报到 Gitea 缓存的 Endpoint、internal SSH 和 boot 当前完整快照。每个 Codespace 由一个发布任务管理单调递增的 `metadata_generation`；缓存未命中后直接重发当前快照，外部缓存实现在 TTL 内保留的合法快照可以继续使用。`running` 对应已经完成的 `ready` boot，启动中的阶段只出现在 active create/resume。

<span id="interactive-access"></span>
### Interactive Access
open Endpoint、SSH、继续运行、resume。

<span id="administrative-permission"></span>
### 管理权限
按调用者、Manager 归属和具体操作判定的 Codespace 管理能力。创建者可以查看自己的详情和日志、修改自动暂停设置并执行 stop/delete；组织所有者只可在组织治理列表中 stop/delete 绑定到该组织自有 Manager 的对象；站点管理员只可在全站治理列表中 stop/delete/force delete。未绑定 Manager 或绑定全局 Manager 的对象不进入组织治理列表，由创建者和站点管理员管理。Manager 首次领取 create 时提交的归属决定后续治理范围，仓库随后转移不改变已经建立的绑定。非创建者治理权限只提供治理列表和允许的操作，不提供对象详情、连接入口或自动暂停设置。

<span id="state-finalization"></span>
### State Finalization
主状态写入流程。Gitea 根据 operation 结果、超时、Runtime 缺失或 failed 运行状态报告，在同一事务中写入 Codespace 主状态、Codespace Token 与 Git SSH Key 结果，并清空 active operation。物理删除路径直接删除记录、开发凭据与日志。

<span id="state-reconciliation"></span>
### State Reconciliation
状态差异处理规则。Gitea 比较数据库主状态与 Manager 当前有效报告，并按状态表写入唯一确定的结果。单个周期任务处理数据库可以独立判断的 operation 超时和 failed 到期清理；Manager offline 由请求实时派生，Runtime inventory 差异在 `ReportInstances` 请求内处理。Codespace Token 由签发和生命周期事务维护，Git SSH Key 由 active create/resume 登记并由同一生命周期事务清理。

<span id="stale-report"></span>
### Stale Report
Manager 上报中的 `codespace_uuid`、`operation_rversion`、`manager_id` 或 operation status 与 Gitea 当前 active operation 不匹配。

<span id="state-divergence"></span>
### State Divergence
Gitea 记录状态与 Manager 上报的 Runtime Instance 实际状态不一致。

<span id="runtime-inventory"></span>
### Runtime Inventory
Manager 通过 `ReportInstances` 上报的本地 Runtime Instance 完整快照。每次成功扫描使用更高的 `inventory_generation`；Gitea 接受任意高于当前值的版本，相等或更低版本返回 stale。generation 只用于确定快照新旧，不比较内容哈希。`observed_operation_rversion=0` 表示没有完整 active operation 上下文，正数表示持有对应版本的完整上下文；正数高于已存在且绑定当前 Manager 的 Codespace 当前版本时返回 Manager 级 `state_history_conflict`，无记录或 binding 不匹配继续按 cleanup 处理。正常 inventory 中的 failed 表示 Runtime identity 仍存在但 Manager 已确认不可恢复：无 active operation 时用它取得 transition 版本；本地持有正版本上下文但低于当前 active operation 时取得 refetch action；版本相同时直接提交当前 operation 的 final failed；本地版本为 0 时等待原 deadline。

<span id="manager-action"></span>
### Manager Action
Gitea 在每个 `ReportInstances` 结果中返回的互斥处理动作：删除本地 Codespace 对应的 Incus 实例、上报 Runtime 状态变化、重新获取当前 operation、清除旧 operation 上下文或停止本地 Runtime。每个结果最多设置一个 action；transition action 携带 Gitea 当前 operation 版本。cleanup 用于数据库成功确认 UUID 不存在、Manager binding 冲突或主状态为 failed 的实例，要求 Manager 先持久化清理状态，再关闭会话、删除该 UUID 的 Incus 实例和本地状态文件；实例内凭据随根存储一并删除。Manager 只接受身份认证成功、完整 inventory generation 已接受且仍为本地当前 generation 的明确 cleanup；数据库或 RPC 错误不构成清理依据。

<span id="minimal-page-data"></span>
### 最小页面数据
Web 列表使用明确的服务端页面数据结构。创建者列表可以包含自身 repository/ref 和活跃时间；组织与站点治理列表只包含 UUID、展示态、创建者、Manager、更新时间、状态摘要和允许操作。两类页面数据都由服务端按权限构造，治理数据不包含 repository/ref/commit、日志、自动暂停、Endpoint 或 SSH。完整字段定义见 [Gitea 服务端 - 最小页面数据](gitea-server.md#最小页面数据)。

实现验收点：

- 本章术语与 proto、数据模型、状态机和组件文档使用同一名称。
- 术语解释只说明当前目标设计中的含义，不引入历史别名或多套说法。
- 读者可以从每个术语定位到负责完整规则的专题文档。

## 命名规则

- codespace 创建者字段统一为 `user_id`。
- repository owner 仍为 `repository.owner_id -> user.id`。
- Endpoint 字段统一为 `endpoint_id`。
- Endpoint 唯一性范围是单个 `codespace_uuid`。
- Endpoint 不是端口模型。
- 动态运行时数据统一称为 Runtime Metadata。

实现验收点：

- operation、Runtime 状态报告、inventory 和 metadata 使用不同术语及版本，各自使用对应的版本字段。
- 文档中的 Codespace、Manager、Gateway、Runtime Instance 和 token 名称与接口定义一致。
- “删除 Manager”与“Codespace delete operation 清理 Runtime”是两个不同动作，不混用。
- “自动暂停”表示 idle 来源的普通 stop 与后续 stopped/resume 闭环，不表示新的 paused 主状态。
