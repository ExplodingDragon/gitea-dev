# 术语

## 术语定义

<span id="codespace"></span>
### Codespace
Gitea 中的一条远程开发环境记录。

<span id="runtime-instance"></span>
### Runtime Instance
Manager 为一个 Codespace 创建并持有的单个 Incus 实例。实例可以是虚拟机或系统容器，两者对 Gitea、Gateway 和用户生命周期透明；workspace 保存在实例根存储中。

<span id="codespace-manager"></span>
### Codespace Manager
运行侧服务，使用 Gitea 管理页创建的身份领取 operation、通过 Incus 管理 Runtime Instance、上传日志和上报 Runtime Metadata。删除 Manager 时，Gitea 删除其身份及绑定的 Gitea 资源并同步返回；运行侧实例是否回收由部署运维负责。这样账户和身份删除不依赖 Manager 在线。

<span id="codespace-gateway"></span>
### Codespace Gateway
Manager deployment 内的用户 Endpoint 与 SSH 接入组件。

<span id="manager-service"></span>
### ManagerService
Gitea 实现、Manager 调用的 Connect RPC over HTTP/HTTPS 服务；scheme 由部署配置决定。

<span id="runtime-endpoint-manifest"></span>
### Runtime Endpoint Manifest
Runtime Instance 内的本地 JSON 文件，用于声明 Endpoint。Runtime helper 只写这个文件；Manager 通过 Incus file API 主动读取并替换本地 Gateway 路由和 Runtime Metadata。这个设计让 Runtime 不需要访问 Manager 端口，避免为 VM、容器、本地和远程 Incus 分别设计私网直连规则。

<span id="operation"></span>
### Operation
<span id="operation"></span>
### Operation
Gitea 当前下发给 Manager 的异步生命周期操作，类型为 create、resume、stop、delete，来源为用户操作或空闲触发。queued operation 有固定等待期限；running operation 通过短 lease 保持当前执行授权，并由首次领取时间计算固定总执行期限，持续续租不能越过该期限。operation 只表示 active 指令，完成后不保留历史状态；`abort_create|abort_resume` 是站点排空时用于结束现有 create/resume 的清理命令，不增加新的 operation 类型。

<span id="automatic-stop"></span>
### 自动暂停
Manager/Gateway 在 Codespace 为 running/ready、设置启用、没有生命周期 worker 且没有已认证 live session 时开始单调计时，连续达到有效超时后发起空闲停止。公共 Endpoint 连接不代表创建者交互，不进入该计数。Gitea 使用当前启用值、有效超时、交互版本和生命周期状态授权并创建来源为 idle 的普通 stop；完成后主状态为 stopped，用户使用普通 resume 恢复。对象设置 `default/custom/never` 分别表示站点默认、自定义时长和关闭空闲触发；延迟设置快照不能绕过 Gitea 的当前值复检。

<span id="manager-matching"></span>
### Manager Matching
Gitea 按 Codespace 创建者和用户在确认页显式选择的环境 tag 匹配可以领取 create operation 的 Manager；站点全局 Manager 可服务全部创建者，个人 Manager 只服务其所属用户。Manager 每次 Fetch 再提交本轮可创建的已声明 tag 子集。仓库 Dev Container 配置不参与 Manager 匹配，create 绑定后 resume、stop 和 delete 只使用原 Manager。

<span id="manager-capacity"></span>
### Manager Capacity
Manager 本地的 `capacity_total` 限制运行实例数量，`startup_workers` 和 `cleanup_workers` 分别限制启动与清理并发。`FetchOperations` 提交当次可用的 `startup_capacity_available`、`cleanup_capacity_available` 和 `accepted_create_tags`，由 Gitea 据此限制返回数量及可领取的 create 环境。**设计如此：**总容量和环境配额属于 Manager 本地调度实现，Gitea 只需要知道当前能立即执行多少工作，避免持久化很快过期的容量快照。

<span id="endpoint"></span>
### Endpoint
使用 `endpoint_id` 标识的 HTTP/WebSocket 入口。普通 Endpoint 来自 Runtime manifest，并以必填 `public` 布尔值明确选择 Gateway session 认证或公共访问；Manager 固定补入需要认证的 `workspace`，再把完整集合写入本地路由和 Runtime Metadata。`workspace` 由 Manager 代理到当前 Dev Container 的 code-server Web IDE，是平台保留入口，Runtime manifest 使用其他 ID。公共访问仍由 Gitea 实时检查当前 Codespace、Manager 和 metadata，不从 repository 可见性推导。

<span id="gateway-open-token"></span>
### Gateway Open Token
Gitea 为打开需要认证的 Endpoint 签发的一次性短期 opaque token。采用 OAuth2 Authorization Code 模式：Gitea 作为 Authorization Server 签发 authorization code（`hex(CryptoRandomBytes(32))`），Gateway 作为 Client 以 Manager 身份提交 code 换取 open binding。公共 Endpoint 不使用该 token。完整流程见 [Gitea 服务端 - Gateway Open Token](gitea-server.md#gateway-open-token)。

<span id="gitea-token"></span>
### Gitea Token
Gitea 为 Runtime Instance 签发的独立、不透明开发凭据，使用 `gcs_` 前缀并存储在 `codespace_gitea_token`。它代表 Codespace 创建用户，在有效 create/resume 初始化期和 `running` 都能授权新请求，用于开发协作 API、LFS，以及 HTTP 协议 Codespace 的 Git smart HTTP；创建用户登录限制、源仓库权限、用户确认的附加仓库权限和现有业务规则仍在每次请求中检查。稳定 `stopped` 没有 Token，它不是普通 PAT。

<span id="codespace-secret"></span>
### Codespace Secret
个人用户保存的私密环境变量。它可以适用于该用户当前和以后具有代码写权限的所有仓库，也可以适用于一个可为空的指定仓库集合。Gitea 在独立表中加密保存值；create/resume 复核当前权限后，只把适用于当前源仓库的值交给绑定 Manager。Manager 把它写入运行中实例的 `/run/gitea-codespace/secrets.json`，供 Dev Container、shell 和 exec 使用，并在 stop 时清理。仓库 Dev Container 顶层 `secrets` 只提供名称和说明建议，不包含值或使用授权。**设计如此：**所有仓库是随用户当前写权限变化的动态范围，指定仓库用于更小范围；两者都不把 Secret 绑定到单个 Codespace。

<span id="codespace-git-ssh-key"></span>
### Codespace Git SSH Key
Runtime 访问 Gitea Git SSH 入口时使用的运行环境凭据。Manager 在 create/resume 内优先复用 Runtime 最终路径或 root seed 中已有的密钥对，缺失时用 Go 生成；先把密钥对写入 root seed，再通过 `RequestRuntimeAccess` 一次提交当前 operation 版本和公钥，并取得 Gitea Token、Codespace Secret 与 known_hosts，最后把响应材料写入 seed，由 bootstrap 安装到最终用户路径。**设计如此：**公钥绑定和本轮运行凭据由同一个版本化请求确认，避免两个 RPC 之间生命周期已经变化；RPC 前先持久化密钥，可保证进程中断后的重试继续使用同一公钥。密钥类型是 Manager 本地配置项，默认 `ed25519`，可选 `rsa-4096`；私钥只存在于 Manager 内存和 Runtime 凭据文件中。`GIT_SSH_KNOWN_HOSTS` 是 Gitea SSH 服务端 Host Key 信任材料，与用户 SSH Key、Gateway SSH Host Key 相互独立。

<span id="manager-secret"></span>
### Manager Secret
Manager 调用 ManagerService RPC 的长期凭据。它由 Gitea 管理页创建 Manager 身份时签发，只在创建响应中展示一次，并与 Manager 记录保持相同生命周期。Manager 记录删除后，该 secret 立即失效。

<span id="runtime-metadata"></span>
### Runtime Metadata
Manager 上报到 Gitea 缓存的 Endpoint、boot 和 CPU/内存/磁盘当前完整快照。每个 Codespace 由一个发布任务管理单调递增的 `metadata_generation`；缓存未命中后直接重发当前 typed snapshot，外部缓存实现在 TTL 内保留的合法快照可以继续使用。`running` 对应已经完成的 `ready` boot，启动中的阶段只出现在 active create/resume。CPU/内存/磁盘指标只用于创建者详情展示，不参与生命周期、授权、容量领取或治理排序。SSH、SFTP、Web IDE 和 Endpoint proxy 的实际后端保存在 Manager 本地 Incus backend 快照中。

<span id="interactive-access"></span>
### Interactive Access
open Endpoint、SSH、继续运行、resume。

<span id="administrative-permission"></span>
### 管理权限
按调用者和具体操作判定的 Codespace 管理能力。创建者可以查看自己的详情和日志、修改自动暂停设置并执行 stop/delete；站点管理员通过 Manager 单项管理页和未分配异常区域执行 stop/delete/force delete。组织所有者不会因为仓库归属或组织角色取得成员工作区权限。非创建者治理权限只提供治理摘要和允许的操作，不提供对象详情、连接入口或自动暂停设置。

<span id="state-finalization"></span>
### State Finalization
主状态写入流程。Gitea 根据 operation 结果、超时、Runtime 缺失或 failed 运行状态报告，在同一事务中写入 Codespace 主状态、Codespace Token 与 Git SSH Key 结果，并清空 active operation。物理删除路径直接删除记录、开发凭据与日志。

<span id="state-reconciliation"></span>
### State Reconciliation
状态差异处理规则。Gitea 比较数据库主状态与 Manager 当前有效报告，并按状态表写入唯一确定的结果。单个周期任务处理数据库可以独立判断的 operation 超时和 failed 到期清理；Manager offline 由请求实时派生，Runtime inventory 差异在 `ReportInstances` 请求内处理。Codespace Token 由签发和生命周期事务维护，Git SSH Key 由 active create/resume 登记并由同一生命周期事务清理。

<span id="stale-report"></span>
### Stale Report
Manager 上报中的 `runtime_uuid`、`operation_rversion`、`manager_id` 或 operation status 与 Gitea 当前 active operation 不匹配。

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
Web 列表使用明确的服务端页面数据结构。创建者列表可以包含自身 repository/ref 和活跃时间；站点治理摘要包含 UUID、repository/ref、展示态、创建者、Manager、更新时间、状态摘要和允许操作。两类页面数据都由服务端按权限构造，治理数据不包含 commit、日志、自动暂停、Endpoint、SSH、资源指标或凭据。完整字段定义见 [Gitea 服务端 - 最小页面数据](gitea-server.md#最小页面数据)。

实现验收点：

- 本章术语与 proto、数据模型、状态机和组件文档使用同一名称。
- 术语解释只说明当前目标设计中的含义，不引入历史别名或多套说法。
- 读者可以从每个术语定位到负责完整规则的专题文档。

## 命名规则

- codespace 创建者字段统一为 `user_id`。
- repository owner 仍为 `repository.owner_id -> user.id`。
- Endpoint 字段统一为 `endpoint_id`。
- Endpoint 唯一性范围是单个 `runtime_uuid`。
- Endpoint 不是端口模型。
- 动态运行时数据统一称为 Runtime Metadata。

实现验收点：

- operation、Runtime 状态报告、inventory 和 metadata 使用不同术语及版本，各自使用对应的版本字段。
- 文档中的 Codespace、Manager、Gateway、Runtime Instance 和 token 名称与接口定义一致。
- “删除 Manager”与“Codespace delete operation 清理 Runtime”是两个不同动作，不混用。
- “自动暂停”表示 idle 来源的普通 stop 与后续 stopped/resume 闭环，不表示新的 paused 主状态。
