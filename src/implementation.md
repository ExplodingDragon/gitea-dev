# 实施

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

Web handler 与 ManagerService RPC handler 分别放在 Web 与 API/Connect 入口下。页面交互、Manager RPC 鉴权和服务层状态推进各自清晰，后续测试也能分别覆盖用户请求和 Manager 请求。

Runtime HTTP API 由 Manager 实现，路由与 Gitea route 分离。

实现验收点：

- Web handler、Manager RPC handler、服务层和数据模型之间没有反向依赖。
- Runtime HTTP API 不注册到 Gitea router。

## 迁移目标

本文档是最终设计基线。

实现以本文档描述的 Gitea 内置 codespace 模型为准：

- 路由、proto name、table 和 runtime option form 使用本文档定义的新命名。统一命名让 Web、RPC、DB 和文档保持一一对应，减少 prototype 遗留概念进入正式实现。
- Runtime 选型由 Manager 本地配置和 repository tag 匹配决定。Gitea UI 保持为创建、打开和管理入口，用户在前端选择代码上下文，管理员在 Manager 侧维护运行能力。
- 生命周期入口使用 `create / open / resume / stop / delete`。这些动作覆盖用户需要的完整生命周期，并与状态机中的 operation 类型保持一致。
- 主状态使用 `creating / running / stopped / deleting / failed`。`queued / booting / stopping / resuming / metadata_rebuilding / recovering` 由主状态、operation 字段和 Manager 运行态派生，用于 UI 和失败分类，不写入 `codespace.status`。
- 异步生命周期统一称为 operation。统一术语后，领取、lease、状态写入和 reconciliation 可以使用同一套处理逻辑，也能和 task、job 等 CI/CD 术语区分开。
- 容量控制由 Manager 上报：Declare 保存 `capacity_total`，`FetchOperations` 提交本次 `capacity_available`。Gitea 使用已声明总量校验本次可用量并判断 create/resume 领取；真实资源占用由 Manager 控制，因为只有 Manager 能看到本地 Runtime 队列、Incus project 限制和启动中实例。
- Gitea 侧复用现有 permission、Token 生成/hash/Secret 工具、SSH key ID 和强制命令入口、setting、cron、routing、DBFS、`modules/cache`、`modules/globallock` 和测试组织方式。Codespace Token 使用独立模型和类型化认证结果；Git SSH 增加 `KeyTypeCodespace` 与一对一关系，不复用普通用户 Key 或 Deploy Key 语义。Codespace 增加自身数据模型、cache key/value 结构和纯 lock key helper，需要串行化的明确路径直接调用 `globallock.Lock`。这样缓存、锁后端与运维配置继续只有 Gitea 现有的一套来源。

实现完成后的最低验证：

```bash
cd gitea
go test ./...
make fmt
make lint-backend
```

实现验收点：

- 实现命名、主状态、operation 类型和路由与最终设计文档一致。
- Gitea 不包含 Incus 驱动、Git SSH 私钥或本地容量计数。

## 测试组织

测试按层组织：

- `models/codespace`：状态字段、固化 Git 首选协议、Manager 地址、Codespace Token、Git SSH Key 关系、索引和查询。
- `services/codespace`：权限判定、State Finalization、repository/owner delete pre-cleanup、Codespace Token resolver、Git SSH 专用鉴权与单仓库授权、日志规范化编码和 offset。
- `routers/api/codespace`：ManagerService RPC auth、`FetchOperations` 领取、FinalizeOperation 幂等。
- `routers/web/codespace`：创建者的 create、详情状态片段、open/continue/auto-stop/stop/resume/delete，以及组织和站点治理列表的 stop/delete/force-delete 页面行为。
- `integration`：create -> fetch operation -> log -> done -> open token -> delete 完整流程。
- `integration`：覆盖未绑定同步 delete 与 Fetch claim 的两种提交顺序、删除事务中主记录/开发凭据/日志共同回滚、resume 签发新 Token 并复用确认 SSH Key、running operation observed 续租与版本更新、旧 generation 拒绝和 Gateway session revalidate。

测试辅助：

- ManagerService 使用 fake Manager identity。
- Runtime Metadata 使用 cache fake。
- Git repo/ref 解析复用 Gitea 现有 repository test fixture。
- DBFS 日志使用测试 DB。
- State Finalization 覆盖并发和重复终态。

Codespace 的主要风险集中在权限、状态事务、开发凭据生命周期和异步领取。服务层测试覆盖核心规则，路由测试覆盖 Web/RPC 输入输出，集成测试覆盖跨层事务边界。Manager Incus 实现不进入 Gitea 服务层测试，可以让测试重点保持在 Gitea 数据库状态和服务行为上。

实现验收点：

- models 测试覆盖规范小写 UUID v4 生成与非规范输入拒绝、generation 的 0 初始值、有效值从 1 开始、checked increment 不回绕、operation 版本耗尽无部分写入、Manager generation 耗尽停止 RPC 并要求删除后重新注册、与 keyset 排序一致的索引、`codespace_gitea_token` 的 Codespace UUID 主键、hash 唯一约束和末八位索引、`codespace_manager_address` 的 Manager/type 与 type/address 双唯一约束，以及 registration token 的 owner/token 双唯一约束和无 inactive/deleted 字段。
- models 测试覆盖已有记录迁移为 `git_protocol=http`、新记录固化站点默认协议、`codespace_ssh_key` 的 Codespace/key 双唯一约束，以及一条关系只对应一个 `KeyTypeCodespace` PublicKey。
- Git SSH 服务测试覆盖关系缺失时创建、相同公钥幂等、不同公钥冲突、全局指纹冲突、内置 SSH 与 `AuthorizedKeysCommand` 直接使用数据库、外部 authorized_keys 文件同步失败重试、`cmd/serv` 与 private serv 的专用类型分流、普通用户 Key 按 ID 管理拒绝该类型，以及 stop/resume 失败保留 Key、failed/deleting/全部物理删除路径清理关系与 PublicKey。
- Git SSH 鉴权集成测试覆盖 active create、active resume、running 和稳定 stopped 阶段、当前仓库 binding、`repo_id=0`、登录限制、code unit 和读写权限、保护分支、upload-pack/receive-pack/LFS；active create/resume 与 running 允许使用，稳定 stopped 拒绝。hook 使用创建用户且 `DeployKeyID=0`，其他仓库、wiki、upload-archive 和 push-to-create 在启动 subprocess 前拒绝。
- Runtime API 测试覆盖使用 SSH 的脚本在首次连接前原子生成 Ed25519 密钥、create 重试与 resume 校验并复用已落盘密钥、Manager 只转发公钥、known_hosts 严格校验、resume 保留 HEAD，以及密钥文件缺失、公私钥不匹配或返回 `key_conflict` 时保存 `unrecoverable_failed`。create 直接收敛到 failed；resume 停止本轮启动、final failed 后继续上报 failed，测试在两个请求之间重启和创建更高 resume，确认不可恢复结果不会停留在 stopped。
- services 测试覆盖状态事务、按 operation 区分的 queued/running timeout 结果、resume final failed 回到 stopped、`updated_unix` 更新时间矩阵、无匹配 Manager 的版本 0 failed 初始记录、registration token GetOrCreate/原地 Rotate/物理 Deactivate、RegisterManager 锁前定位 owner 与锁内复读认证、独立 Codespace Token 的生成/hash/加密/解密校验、损坏密文或 verifier 的删除与修复、并发签发唯一冲突重读、stopped 结果删除 Token 并保留 Git SSH Key、failed/deleting 结果删除两类开发凭据、普通 PAT 行为无 Codespace 特判、owner 分阶段清理、purge 释放并重新取得 owner 写锁后复扫、repository 删除先提交和另一更新先提交两种并发顺序、任意运行状态下 Manager 有界删除、删除成功后的 Codespace/Manager/registration token 空集合、日志并发 offset、部分重叠拒绝、截断摘要幂等、日志行边界读取，以及 DBFS 文件不存在时物理删除幂等成功、其他删除错误只回滚当前子事务。并发动作覆盖状态 final、续租、日志元数据、设置和 `last_active_unix` 更新，并同时断言 `repo_id=0` 与另一动作负责的字段。
- RPC 测试覆盖批量独立 claim、Fetch 全请求持有调用方 Manager lock、ReportInstances 以任意更高 generation 条件写入并逐项取得 Codespace lock、单 Codespace command 在事务内复检 Manager/binding/version、Fetch 与 Manager 身份删除并发、Fetch 与普通未绑定 delete 及账户直接清理并发、claim 后 payload 复检、create payload 的 `repo_tag` 与 claim 使用的锁定 tag 一致、由 Gitea 现有生成器同时产生 HTTP(S)/SSH clone URL 并返回首选协议、Web URL 保留 `AppSubURL`、global/owner-scoped Manager 同时匹配时由首个条件更新确定 binding、observed-only 续租回执与 payload/abort 互斥、续租回执不占 `max_operations`、普通 payload/续租的正数精确毫秒相对时长与 abort 的 0、Gitea 内部绝对 deadline 向未来取整且协议不返回该值、Fetch 遇到过期 queued 候选时按类型条件 timeout 并继续本批、running observed 相同版本续租、较低版本返回当前 payload、省略项等待原 deadline、online/recovering/offline 使用相同 deadline 规则、站点排空的 abort 不续租且 create/resume 分别写入 failed/stopped、单条 payload 构造失败后条件释放、系统错误或响应丢失后已提交 claim 等待 timeout、当前 Manager tags 与 repository owner scope 筛选、transfer/claim 条件更新竞争、deadline/Cron 竞争、过期 FinalizeOperation 请求内 timeout 与四种确定 outcome、active operation 存在时同版本错误类型的 stale outcome、active 清空后的目标状态幂等、访问判定 oneof、日志 next/current offset detail，以及 inventory/runtime/metadata 三类 generation 的 stale 校正和版本耗尽处理。Fetch 和 inventory 在业务写入前拒绝高于已存在且绑定当前 Manager 的 Codespace 当前版本的正数 observed operation，返回 Manager 级 `state_history_conflict`；Fetch 不续租、不执行 timeout 或 claim，inventory 不推进 generation 或生成 cleanup。UUID 无记录或 binding 不匹配时等待完整 inventory 收敛。inventory generation 耗尽停止整个 Manager，runtime/metadata 冲突或耗尽清理单个 Codespace。
- Runtime Metadata RPC 测试覆盖 active create 阶段顺序、active resume 的适用阶段顺序直到 `ready`、running 只接受 ready、无 active operation 的 stopped 拒绝 metadata、同 boot 版本 ready 不回退，以及 resume failed/timeout/abort 后迟到同版本快照返回 stale。测试确认任一成功请求包含当前 operation ready 时即可满足 final 的 metadata 前置条件，之后产生的更高 Endpoint generation 继续异步上报；cache miss 使用 `metadata_rebuilding`，inventory 不返回 metadata 专用指令。
- 稳定 running 凭据修复测试确认 metadata 始终保持 ready；原子文件刷新失败时先关闭会话并停止 Runtime，可恢复 workspace 上报 stopped，损坏资源上报 failed。
- RPC 测试覆盖 Declare 完整快照与两条地址记录原子覆盖、可修改字段、Gateway URL 与 SSH 地址数据库唯一冲突、失败声明不更新地址/metadata/heartbeat、recovering 与 online heartbeat 更新声明和在线时间但不修改 operation deadline、Declare/Cron 竞争不改变 timeout 结果、Declare 返回由离线超时计算的心跳和 metadata 刷新毫秒数及双向消息上限、Manager 对非法响应保持 recovering 和零容量、单个进行中的 Declare 及重试退避不超过服务端周期、Declare 容量上限、超过 10000 个 Runtime 拒绝截断 inventory、reported creating 只作为存在证据，以及未绑定 creating 不返回 cleanup。
- 自动暂停 RPC 测试覆盖实际启用值、有效超时、交互版本、Manager binding、running 主状态、恢复保护和 active operation 的固定校验顺序，以及 `pending`、`observation_changed`、`not_applicable` 三种互斥结果。`not_applicable` 覆盖 operation conflict、already stopped 和 state unavailable；交互或 operation 版本耗尽返回 Connect `version_exhausted` 硬错误。测试在响应提交前后模拟丢失，确认当前 idle stop 存在时重试返回同一版本且不创建并行 stop，queued timeout 后持续空闲可创建更高版本。
- 自动暂停并发测试固定 Open Code 签发、Open Code 消费、SSH 成功认证、继续运行、resume、用户 stop、设置变化、相同设置提交、RequestIdleStop 和 Fetch claim 的提交顺序。queued idle stop 被活动或有效设置变化取消，相同设置保持 operation，用户 stop 原地接管，Fetch 已领取后 stop 完成且交互返回 stopping；每种顺序只形成一个可解释的展示态、主状态和 active operation 结果。
- integration 测试覆盖 create、stop、resume Token 与 Git SSH Key 生命周期；session revalidate 拒绝或通信失败时关闭 session 且不转发当前请求；用户、组织或 Manager 删除同步清理 Codespace、开发凭据、日志和目标 owner 的 Manager 地址行；普通用户或组织删除保留全局 Manager、地址、registration token 和无关 Codespace；分阶段删除中途失败保留父记录和剩余子项，重试完成剩余清理，已提交子项保持删除。
- integration 测试确认用户、组织、force delete 和 failed retention 物理删除后，仍有效的原 Manager 在成功、当前 generation 的完整 inventory 中对无记录 UUID 收到 `cleanup_local_runtime`；响应在本地持久化前丢失时，以更高 generation 重新扫描并取得相同 action，持久化后由本地 cleanup 续做。
- integration 测试覆盖 failed retention 直接清理 Gitea 资源，以及账户/Manager 删除与 inventory、Token、metadata 并发时的数据库复检；账户清理外部或全局 Manager binding 只取得 Codespace lock，Manager 身份删除使用 owner、Manager、Codespace 层级。账户删除后全局或其他仍有效 Manager 自动清理无记录 Runtime；随账户删除的 Manager 身份无法继续认证，其资源保持部署运维边界。10000 个绑定 Codespace 的删除仍按 100 条 keyset 批次、逐条短事务处理，同一时刻只持有一个 Codespace 子锁。
- integration 测试覆盖 Web URL 使用配置的 HTTP/HTTPS `ROOT_URL` 和 `AppSubURL`，create payload 同时返回 HTTP(S)/SSH clone URL 和固化首选协议，resume 返回首选协议但不返回 repository payload；repository 删除后本地上下文完整的 create 通过 observed 续租继续且上下文缺失时等待原 deadline、resume 无 repository payload、deadline 未到期的 missing creating 不提前失败且重启不延长 deadline、metadata 同 generation TTL 刷新、resume final 在当前版本 ready 或 Token 行缺失时保持 active operation、stopped/failed 数据库提交后 cache 清理失败仍成功且残留 cache 无法授权、Open Code 部分签发与消费删除失败、inventory action 及其 operation 版本恢复、相同 Manager 的 Fetch 不被大 inventory 全程阻塞、新 inventory generation 成立后旧请求停止写入且不返回 result、Manager 丢弃低于本地当前 generation 的延迟响应、数据库查询或 RPC 失败不生成无记录 cleanup、无记录和 binding 不匹配进入单项 cleanup 而不是提前结束请求、任一 UUID 失败时响应不含部分 result、Manager observed operation 版本较低时 refetch、正数 observed operation 高于 Gitea 当前版本时整次请求返回无写入的 Manager 级 `state_history_conflict`、无 active operation 时明确清除旧上下文、running 主状态/stopped Runtime 返回 transition、stopped 主状态/running Runtime 返回 stop，以及空 Fetch 响应不清除 worker。
- Open Code integration 测试分别覆盖无法解析、显式过期、功能关闭、Manager 不匹配、Codespace 不存在、状态或权限变化、metadata/Endpoint 缺失、Manager offline、成功删除、删除失败、删除后交互事务失败和交互版本耗尽；暂时访问条件失败保留 code 到原 TTL，allowed 只在删除成功且交互事务提交后返回。
- 自动暂停设置测试覆盖只有创建者可以提交、组织所有者和非创建者站点管理员被拒绝，以及 `default/custom/never` 持久值、running/stopped 状态矩阵、自定义最小/最大范围、站点默认值变化、create/resume 与 ReportInstances 乱序下发和排空模式下有效设置关闭。有效策略变化与 queued idle stop 取消同事务提交，相同持久值幂等成功；延迟快照携带的开关、超时或交互版本不能通过当前值复检，running stop 完成后设置保留，stopped 对象修改设置后仍等待用户 resume。
- integration 测试覆盖 `ENABLED=false` 时 `RequestGiteaToken` 返回 `state_unavailable` 且 Token 行保持原状、重新启用后按当前主状态继续；并分别固定 stop final 或进入 failed/deleting 先提交、授权查询先完成两种并发顺序。前者使新 Git/LFS/API 请求返回 401，后者使当前请求按 Gitea 现有行为结束。active stop 创建后现有 Token 仍按 running 状态使用，stop worker 的 `RequestGiteaToken` 返回 `state_unavailable`；已签发的对象存储和 artifact 短期 URL 按原 expires 到期。
- integration 测试覆盖单活动 Gitea 进程边界、`CreateCodespace` 记录插入事务与 repository 删除串行、transfer 与 owner 删除串行，以及需要多锁路径的 owner/repository/Manager/Codespace 固定层级。用户自助 Web、管理员用户 Web、管理员用户 API、组织 Web、组织 API 五个外部删除入口分别验证前置条件、有界子事务和统一服务顺序；inactive-user Cron 使用同一用户服务，user purge 在 last-owner 组织删除前释放用户 owner 写锁，并在组织与 package 阶段结束后重新取得 owner 写锁复扫。
- integration 测试分别覆盖 memory/twoqueue cache miss 和外部 cache 在 TTL 内保留两种重启结果，确认保留的 Open Code 仍执行完整访问校验、保留的 Metadata 不替代数据库主状态；Manager/Gateway 重启后全部 Codespace 的本地 session 准入从关闭开始，外部 cache 保留 ready 也要等凭据、SSH、路由和当前 ready 重报完成后才能建连。同时确认 Codespace 明确 TTL 不读取通用 `ITEM_TTL`，Session Provider 不参与 Codespace cache。
- services 测试确认文档列出的写路径直接调用 `globallock.Lock`；repository transfer/delete 与 `CreateCodespace` 记录插入事务通过 `modules/repository.WorkingLockKey` 共用 `repo_working_{repo_id}`。多对象锁按 owner、repository、Manager、Codespace 的固定层级取得；Manager 删除保持 owner 和 Manager 父级 lock 并一次只取得一个 Codespace 子锁，账户清理外部或全局 Manager binding 时只取得 Codespace lock。Manager 地址冲突由数据库唯一约束判定；pending transfer 创建/取消/拒绝取得 repository lock，实际 owner 变更取得排序后的原/新 owner 写锁和 repository lock。
- owner 关系集成测试覆盖普通创建、fork、template、migration、adopt、push-to-create、repository transfer/delete、通用 package/version、container、Terraform、组织成员、team 成员、组织初始 owner、Codespace、Manager 注册和 registration token 写入。每条路径断言使用 `owner_write_{owner_id}`、锁内复读和 owner 不存在硬错误；多 owner 升序取得。repository 创建还覆盖提交关系后在释放 owner 前取得新 repository lock、初始化与 purge 并发及重复清理不存在结果。
- 账户删除并发测试让每类 owner 关系分别在 purge 释放锁期间先提交，或让最终删除先提交。前者必须被最终复扫清理或使禁用 owner 保留并返回明确错误，后者的关系写入必须在锁内复读后失败；成功删除后 repository、package、组织与 team 成员、Codespace、Manager 和 registration token 均不存在目标 owner ID。
- 组织 purge 与成员写入测试覆盖用户 ID 小于和大于组织 ID 两种顺序：公开入口按 ID 升序取得两把 owner 写锁，purge 持有组织锁后通过内部函数只删除 `OrgUser/TeamUser`，不会反向等待用户锁；两种提交顺序都收敛为关系已清理或写入返回组织不存在。
- Gateway session 测试覆盖首次 Open 的 `connecting -> live`、30 秒未激活清理、同 Host 同 binding 旧 cookie 的原子一换一、配额排除旧项、旧连接锁外关闭、不同浏览器保持、无效 cookie 清除和不同 binding 不替换。测试断言一换一不产生自动暂停 0/1 通知，首次 Open 与激活超时产生正确通知，并覆盖 stop/delete/cleanup/路由更新与替换临界区的两种合法先后。
- Manager Web SSH 测试覆盖嵌入 xterm.js 页面与固定 CSP、精确 Origin、binary 输入输出、resize 与 ready/exit/error 控制消息、frame/输出队列边界、PTY 登录 shell 和 `TERM=xterm-256color`。内部连接只使用当前 `internal_ssh`、Manager client key 和严格 host key fingerprint；网络拨号在协调锁外，附着前复检路由与 session，并在 stop/delete/cleanup、路由切换、到期和 revalidate 失败时关闭 WebSocket、PTY 与 SSH。
- 服务端页面数据测试确认 `CodespaceOwnerListItem`、`CodespaceOwnerDetail` 和 `CodespaceGovernanceListItem` 字段互不越界；非创建者不能访问对象详情或日志，治理页面数据不包含 repository/ref/commit、自动暂停、Endpoint、SSH 或 token。创建者详情的 workspace label 使用 metadata 同名记录或本地化默认值，普通 Endpoint 排除 workspace 并按 ID 排序；`open_endpoint` 只在列表非空时返回，SSH 展示字段只由 Manager 公开声明构造。
- Web 状态测试覆盖 queued、booting、stopping、resuming、deleting、recovering 和 metadata rebuilding 的 `display_status` 与 `allowed_actions`。过渡状态只渲染禁用进度按钮，冲突 POST 返回 `409` 和当前状态；Manager offline 时连接与 resume 不可提交，适用状态的 stop/delete 仍可登记且 operation 截止时间不变。
- 组织治理路由测试覆盖组织 owner 权限和已绑定 Manager 的 owner scope；未绑定记录和绑定全局 Manager 的记录不进入组织列表，repository transfer 不改变已经绑定的治理范围。站点治理路由覆盖全部 Codespace。两类列表都没有详情链接或自动暂停动作，只有站点管理员能通过独立确认路由 force delete。
- cache 测试覆盖读取错误按未命中处理：Open Code 拒绝、Metadata 返回 `metadata_rebuilding`；同时覆盖损坏值的固定处理、Open Code 写入或消费删除失败、对象删除后残留 code 的数据库复检，以及协议要求成功的 Put/Delete 失败和数据库提交后 metadata 清理失败的不同结果。
- authentication integration 测试覆盖 Basic、Bearer 和 `DISABLE_QUERY_AUTH_TOKEN` 开关两种 query 行为，并验证凭据分派函数的 `unmatched / authenticated / rejected` 三种互斥结果。有效 `gcs_` 通过一次候选查询返回真实创建用户以及 Codespace UUID、仓库绑定、状态和登录限制的请求内认证数据并跳过 `auth.Group`；不存在、损坏、关联缺失或 verifier 失败的 `gcs_` 返回 401 并结束认证。普通 Web 路由即使没有 `AllowBasic`/`AllowOAuth2` 也会识别 Authorization 中的有效 `gcs_` 并由默认权限检查返回 403；已有 Session 不改变这两种结果。非 `gcs_` 凭据和 query token 关闭后的其他普通认证保持 Gitea 原有类型与优先级。
- API pre-middleware 按精确 method/route 写入 policy，测试收集全部 `(method, route pattern, policy)` 并与代码内审阅快照比较；marker 或 policy 变化时同步更新审阅快照。resolver 执行一次授权查询，读取 Codespace Token、Codespace、创建用户和与 `HasTwoFactorOrWebAuthn` 等价的配置存在性；后续权限检查复用该请求内数据，对 Git、LFS、repository API、self 和 public-info policy 统一检查 active、prohibit-login、must-change-password 与站点强制 2FA。登录限制成立时新请求返回 403，但 Token 行和主状态不变，限制解除后同一工作态 Token 恢复使用；并发测试分别固定授权查询和 stop、用户限制、2FA 配置变化的提交顺序。
- Token 能力 integration 测试覆盖 clone/fetch/push/LFS、Contents/Diff Patch commit、branch/tag/status、Issue、Pull Request/Review/merge、Release、Wiki、Actions 查询/dispatch/rerun/artifact 下载、当前用户和公共版本/signing key 在 binding、route 允许面、登录限制和创建用户当前权限通过后成功。测试同时覆盖可见其他 repository 返回 403、不可见或不存在目标保持 404、`sudo` 拒绝、绑定 repository 的 Issue/PR 开发操作、fork PR update/merge/head branch 删除、跨 repository dependency/cross-reference、commit/PR close/reopen、project assignment、scheduled auto-merge 创建/取消和有效 scoped workflow；关系副作用按创建用户当前 Gitea 权限成功或返回原有拒绝，直接访问无关 repository 和全局 Issue 搜索保持拒绝。已排期 auto-merge 在 Codespace stop、failed、delete 或 Token 轮换后不被取消。对象存储 artifact 直传、严格登录配置下无 PAT 的有效 artifact raw 签名和 LFS 直传 URL 继续覆盖。
- Token 路由策略 integration 测试确认开发允许面以外的 repository 管理、Hook/Deploy Key/Protection/Mirror、Actions Secret/Variable/Runner、Package、PAT/OAuth/Key、用户/组织/站点管理、普通 Web、Git dumb/wiki、upload-archive、push-to-create、未标记 API 和其他 repository 在副作用前返回 403；新增 route 默认拒绝。普通 PAT 页面/API 不显示 Codespace Token，Codespace Token 自身调用 Token 管理 API 返回 403，普通 PAT 行为保持不变。
- Issue/PR 权限差异测试对同一用户、同一对象分别使用普通 PAT 和 Codespace token；API 路由的 binding 与工作状态通过后，两者的 handler 权限结果一致。请求体中的 fork head、跨 repository dependency 和 project 只经过 Gitea 现有关系权限检查，不被误作直接 API 路由目标。
- Web 测试确认 Codespace 创建者详情只展示当前 Token 是否存在、创建时间和末八位，页面与普通响应不包含 verifier、salt、密文或明文；组织和站点治理响应不包含任何 Token 展示字段。
- integration 测试确认 `DeleteRepositoryDirectly` 拒绝已处于事务中的 context；repository 数据库删除提交并释放 owner/repository lock 后才执行 `RepositoryCleanupPlan`，强制数据库回滚不执行文件或 cache 清理；文件清理失败沿用各 Gitea 删除入口现有 system notice、日志和错误返回，不回滚数据库结果或创建补偿任务。
- Web/RPC 配置测试覆盖非法大小关系启动失败、control-plane timeout 不大于四分之一 Manager 离线超时、protobuf 最大不可拆分 request/response 的实际编码大小、lease 的整数毫秒精度、Manager 离线/queue/Open Code/自动暂停的整数秒精度、control-plane timeout 包含认证/锁等待/数据库/cache，deadline/caller cancel 分别返回 Connect `DeadlineExceeded`/`Canceled` 且无业务 detail，以及日志 JSON 行换行保留、默认 limit、400 参数错误和 409 `current_offset` 恢复。消息上限不足时启动错误指出实际值、要求值和消息类型；超限输入在业务事务前返回 `ResourceExhausted`。启动测试覆盖启用时 HTTP/SSH 两种入口必须同时可用、`DISABLE_HTTP_GIT`、内置 SSH 首启生成 Host Key、内置 SSH 复用已有 Key和外部 SSH 显式 known_hosts，以及排空模式关闭两种 Git 接入后继续管理清理。
- Cron 测试覆盖 operation timeout、Manager 可用性和 failed retention 的 100 条 keyset 批次、单记录短事务、单条失败继续、数据库级错误终止和下一轮重试失败项；`reconcile_codespace_states` 不扫描或修复开发凭据，`cleanup_failed_codespaces` 随 failed 记录物理删除 Token 与 Git SSH Key。
- integration 测试覆盖 running/stopped 主动 failed 状态报告、failed inventory 恢复 operation 版本基线、active operation 存在时低正版本先 refetch 后 final failed、同版本使用已有上下文直接 final failed、版本 0 等待原 deadline、resume operation failed 后需继续 failed 状态报告才能进入不可恢复状态、recovering 上报、站点排空时接受 stopped/failed、offline 先 Declare recovering、active operation conflict、transition 对 current-operation/stale-operation/stale-generation/generation-conflict/manager-offline/codespace-not-found/manager-unregistered 的固定处理、runtime generation 的 stale/目标幂等/conflict/新版本矩阵、stopped 主状态/running Runtime 的本地停止、active resume 经 Fetch 恢复并在 final 前完成 Token/credential/ready、token/cache/session 清理、failed retention 起点不被重试刷新，以及 failed 或数据库无记录时删除 Incus 实例、stopped 只停止实例并保留根存储的 inventory action。
- Manager worker 测试覆盖四种 FinalizeOperation outcome、resource absent 触发完整 inventory、同一 UUID 动作与 cleanup 串行、cleanup pending 的崩溃续做，以及 create/resume/stop/delete 经 timeout 和 inventory 收敛。lease 测试以 Fetch 请求开始时的单调时钟建立保守截止点，确认续租 pulse 只能缩短本地授权；pulse 或本地截止点到期时 launcher 终止进程组，create/resume 实例停止并持久化 `lease_paused`，Manager 崩溃后脚本同样退出。重启先清理 launcher，再由同版本正数续租恢复；恢复复用持久 workspace、凭据和规范共享环境，但重做 prepare、activate 与连通校验，旧 ready 不能直接 final。上下文缺失、abort、stale 和更高 delete 分别等待 timeout、只做缩减清理、停止旧 worker 或接管当前动作。
- Manager/Runtime 测试覆盖 init、prepare、activate 的固定只读输入，`CODESPACE_ENV` 追加、非预定义变量最后值生效、预定义变量同名追加被移除、成功阶段原子提交以及失败或取消回滚，`root:root 0600` 严格结果 schema，缺失或损坏结果的可恢复失败。动态文件环境变量只包含 `CODESPACE_ENV` 与 `CODESPACE_RESULT`，Token 和 Git SSH 材料使用固定路径。自定义脚本与内置脚本使用相同的调用和恢复路径；Manager 只消费凭据 UID/GID、workspace 路径与 internal SSH 通用输出。ready 测试只要求两种 Token 文件、本地 remote 凭据配置、internal SSH 和 workspace 路由；repository 删除、普通 Endpoint 或用户进程不阻塞 resume，实际 Git/API 请求仍由 Gitea 返回拒绝。其余测试继续覆盖 Runtime API 生命周期矩阵、source IP 到 Incus identity 的唯一反查、Token 文件原子刷新、实际 Endpoint 端口路由与 metadata generation 提交、Gateway HTTP/WebSocket/SSH session、Open Code、Host/binding、wildcard DNS/TLS、限流和 secret 轮换恢复。
- Incus 测试使用隔离 project 覆盖虚拟机和系统容器两种模板，但断言两者生成相同的 Gitea operation、inventory 和 Runtime HTTP 行为。测试覆盖 tag 键生成 Declare tags、create 前有效模板持久化、tag 映射修改不影响既有实例、`cs-{short_uuid}` 名称与完整归属字段冲突、固定 image fingerprint、版本化 profile、根盘随实例 stop 保留并随 delete 删除，以及集群模式返回 `incus_cluster_unsupported`。
- Incus 容量测试覆盖运行名额、启动 worker 和服务不可用对 `capacity_available` 的影响；project 配额只能容纳已有 stopped 实例时，`accepted_operation_types` 包含 resume 而不包含 create，stop/delete 仍可领取。多个 tag 规格不同时使用最大新建模板判断 create 配额。
- Incus 通信测试覆盖展开设备的显式 `hwaddr`、实例自动生成的 `volatile.<device>.hwaddr`、Instance State 中 MAC 到来宾接口、地址族与子网过滤和恰好一个地址；同一地址同时用于 Runtime API 来源绑定、Endpoint upstream 和内部 SSH。测试在地址缺失、重复、变化和临时 Incus 不可用时确认准入关闭且不产生错误路由或立即上报 failed。
- Incus 生命周期测试覆盖 create 创建 stopped 实例后启动、两个 Token 文件的临时写入/权限/`fsync`/rename、所选三个脚本和 launcher 的摘要固定与原子发布、prepare/activate 分段、正常关机超时后强制停止、delete 全量确认实例缺失和 cleanup_pending 崩溃续做。虚拟机测试验证 guest agent 可用前 file/exec API 保持等待，系统容器走同一 Manager 代码路径。默认脚本另行覆盖 apt/dnf/pacman 探测、固定非 root 用户与 sudo、create 临时 workspace/锁定 SHA/原子发布、resume 保留用户 HEAD、直接运行/devcontainer 选择与恢复、内部转发和 lifecycle commands。
- Runtime Token 测试确认 create/resume 轮换、普通 Manager 重启不轮换、明文不进入 Incus 配置/exec 参数/日志、文件与 verifier 不一致时关闭准入并停止实例，以及下一次 resume 生成新 token 并通过 prepare/activate 向本轮脚本和 lifecycle commands 提供当前值。
- Manager metadata 发布测试确认每个 Codespace 只有一个 generation 写入者且同一时刻最多一个请求；boot、Endpoint、internal SSH、恢复和周期刷新并发时只发布当前完整快照。任一成功空响应对应的请求快照包含当前 operation ready 就解除 create/resume 等待，即使本地已有更高 Endpoint generation；发布任务仍继续到最新 generation。resume final failed 后清除本轮发布上下文，stopped 阶段不发布历史 ready；`unrecoverable_failed` 随后继续上报 failed。
- Codespace 当前快照故障测试固定临时文件写入、文件 fsync、rename、父目录 fsync、内存快照替换、外部动作和响应返回各边界。父目录同步成功前不发布内存结果、不调用依赖新状态的 RPC 或 Incus 动作，也不返回成功；rename 后父目录同步失败时关闭准入并重试，持续失败以固定存储错误退出。进程重启读取完整旧版或新版时，Fetch、inventory、cleanup 和 Runtime POST/PUT/DELETE 都能幂等收敛。Manager Secret 测试确认 pending 完成父目录同步后才调用 Rotate，Rotate 成功后的任意退出点都能用 current/pending 恢复服务端当前 Secret。
- 状态目录损坏测试覆盖 Manager 根快照缺失、损坏或身份不匹配时启动硬失败且不发送 RPC、不修改 Incus；单 Codespace 快照缺失或损坏时关闭该 UUID 准入、按 Incus 归属字段写最小 pending，并删除对应实例和本地状态文件。后续完整 inventory 使 running/stopped 进入 failed、deleting 完成物理删除，active create 在原 deadline 到期后进入 failed。测试在清理各阶段模拟崩溃，确认 pending 续做且不按旧 operation 猜测恢复。
- 数据库时间点恢复测试覆盖 inventory generation 跳号接受、相等或低版本 stale，以及响应丢失后以更高 generation 重新扫描。Fetch 和 inventory 的正数 observed operation 高于已存在且绑定当前 Manager 的 Codespace 当前版本时返回 Manager 级 `state_history_conflict`；测试确认对应请求没有租约、超时、claim、generation、Codespace、operation、Token 或 cache 写入，也不返回 cleanup。Manager 关闭全部准入、领取和新的 Incus 修改并保留实例及根存储；时间点恢复要求先停止 Gitea 和全部 Manager。
- operation 版本倒退测试分别覆盖三个顺序：响应版本低于请求发出时最高版本时产生 `operation_version_regression` 并关闭整个 Manager；响应版本不低于请求版本、但低于处理时本地最高版本时只丢弃该 UUID 的延迟结果；响应版本不低于当前最高版本时先持久化版本再执行。测试包含 inventory 版本 5 action 延迟于 Fetch 版本 6 payload 的正常并发，以及请求发出时已为版本 6、响应仍为版本 5 的真实倒退。`manager_unregistered` 和 current/pending Secret 都认证失败时关闭全部入口、强制停止 Incus 实例并停止 RPC，同时保留实例根存储和状态目录等待同一身份凭据恢复。
- Gateway session 并发测试固定 Open Code 调用前预检、调用后最终检查与登记、Endpoint 路由变更、stop/delete/cleanup 的协调锁顺序；每种交错只能形成“session 已登记并被取消”或“动作先成立、session 登记失败”。SSH 测试覆盖 connecting reservation 在后端连接完成前被取消、session 上限包含 reservation、自动暂停在 connecting/live 总数归零后才开始计时。
- Manager 重启测试确认 Declare online 表示必要 listener、完整 inventory、Runtime 映射和 worker 上下文分类已经完成，并允许按真实容量领取其他 operation；它不直接开放任一 Codespace 交互。恢复出的 operation worker 在成功 Fetch 续租取得新相对有效时长前不修改 Incus。每个 running Codespace 在凭据、internal SSH、当前路由和 ready 重报完成后分别开放本地准入，stopped/failed/cleanup 保持关闭，单个临时失败不阻塞其他健康 Codespace。
- metadata generation 耗尽测试确认 Endpoint 内容变化没有本地部分提交，Runtime HTTP 返回固定 `503 runtime_unavailable`，Manager 记录内部 `version_exhausted` 并按 Incus 归属字段清理该 UUID；相同 generation、相同内容仍能重试和刷新 TTL，版本不回绕。
- Manager 自动暂停测试覆盖 HTTP/WebSocket/IDE/SSH live session 的 0/1 边界、create/resume 首次 ready 即零连接、never 或排空重新启用、worker 结束、Gateway idle timeout 后才开始 Codespace 计时、SSH channel 活动刷新与纯 keepalive 超时、后台进程不续期、超时缩短/延长重算、设置响应乱序和单调时钟不受墙上时钟跳变影响。测试在 RPC 提交前后和普通 stop worker 持久化前后模拟崩溃：Gitea 已创建的 queued stop 由 Fetch 领取，running stop 先暂停并在成功续租后恢复，上下文缺失时由原超时和 inventory 收敛；尚未创建 stop 时从完整时长重新计时，停机时间不计入。
- 自动暂停设置收敛测试在 create/resume、inventory 和 observation changed 响应乱序时确认旧设置最多影响本地计时，Gitea 以当前开关、超时和交互版本拒绝错误 stop；控制面稳定后，当前设置在一个 inventory 周期加当前 RPC 退避内覆盖旧快照。
- schema、RPC、配置和 Web 路由测试确认 Manager 身份、运行状态、领取意愿和永久撤销分别由记录存在性、heartbeat、Fetch 容量/接受类型和删除操作表达；Fetch 上报零容量只影响新 operation 领取，已有 operation、Token 和 session 保持原状态。
- Web 路由测试确认 `/-/codespaces` 和 `/-/codespaces/{uuid}` 解析到 Codespace 页面，名为 `codespaces` 的用户、组织及其 repository 仍使用 Gitea 通用路由。完整详情页与 `/-/codespaces/{uuid}/state` 使用同一个创建者详情服务和 `allowed_actions`，覆盖普通 running、queued idle、queued/running user stop、stopped、active resume、Manager offline/recovering 和排空矩阵；正在停止时不再返回可提交 stop。状态片段测试覆盖过渡状态 2 秒、稳定状态 15 秒、隐藏页面暂停、单请求串行和失败退避到 30 秒。
- integration 测试覆盖 State Finalization 主事务成功而内部状态摘要事务失败的情况，确认生命周期结果不回滚且后续 operation 可继续追加同一日志文件；delete done 和其他物理删除路径不重新创建日志。
