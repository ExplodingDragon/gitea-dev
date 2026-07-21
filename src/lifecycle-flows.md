# 生命周期流程

## 创建流程

### Ref 解析

Create 支持：

| 参数 | 说明 |
| --- | --- |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | 用户输入：`branch` → 分支名；`tag` → 标签名；`commit` → 完整 commit SHA；`pull` → 十进制 PR index |

repository ID 来自 Web 路由，最终 `commit_sha` 只由 Gitea 解析。pull index 在服务端规范化为持久 `ref_name/start_ref=refs/pull/{index}/head`。客户端提交 repository ID 或最终 commit 字段时返回参数错误，避免把用户输入误当作已验证来源。

Gitea 校验步骤：

1. 校验 repository 可见性和 code-read 权限。
2. 校验 repository 状态。
3. 打开 git repository 并确认非空。
4. 解析并锁定最终 commit SHA。
5. 校验目标 ref/commit 存在且可解析。
6. PR 入口属于 base repository 页面。

Pull Request 规则：

- PR 入口属于 base repository 页面。
- `ref_type=pull` 时从 Gitea 数据加载 PR。
- base repository 与路由 repository 一致。
- 创建用户具备 base repository code-read 权限。
- head repository 与 base repository 不同时，创建用户同时具备 head repository code-read 权限。
- Gitea 从 PR 数据读取 `base_repo_id`、`head_repo_id`、`base_branch`、`head_branch` 和当前 head commit。
- `commit_sha` 固定为 PR 当前 head commit。
- `start_ref` 使用 `refs/pull/{index}/head` 作为 create 脚本准备 workspace 的提示。
- operation 使用 base repository clone URL，并以 `start_ref=refs/pull/{index}/head` fetch PR 当前代码；最终 checkout 以 `commit_sha` 为准，并校验 HEAD 等于 `commit_sha`。
- Manager tag matching 和 `.gitea/codespace.yaml` 使用 base repository。

PR 页面属于 base repository，但初始化代码来自创建时解析出的 head commit。Gitea 把该 commit SHA 固定写入 create 数据，使 head branch 后续移动不会改变本次 workspace 内容；同时校验创建用户对 head repository 有读取权限。Codespace Token 绑定 base repository，因此初始化通过 base repository 的 pull ref 读取该 commit。

### Repository Codespace 配置

配置文件：

```text
.gitea/codespace.yaml
```

当前识别字段：

```yaml
tag: default
```

规则：

- 配置只从 branch tree 读取。
- `ref_type=branch`：读取该 branch。
- `ref_type=pull`：读取 PR base branch。
- `ref_type=tag`：读取 repository default branch。
- `ref_type=commit`：读取 repository default branch。
- 文件缺失等价于 `tag=default`。
- 空仓库在读取配置前返回 empty repository 分类。
- default branch 不存在、目标 branch tree 不可读、配置 blob 不是普通文件时，create 请求返回配置读取错误，不创建 codespace。
- 配置文件超过 `CODESPACE_REPO_CONFIG_MAX_SIZE` 时，create 请求返回配置过大错误，默认上限 64 KiB。
- 配置必须是单个 YAML document，顶层为 mapping；YAML 非法、出现第二个 document、未知字段、重复字段或字段类型错误时，create 请求返回配置解析错误。
- `tag` 缺失或空字符串等价于 `default`。
- `tag` 解析后 lower-case。
- `tag` 使用 `[a-z0-9_-]+`，与 Manager tag 匹配保持大小写无关且便于配置。
- `tag` 确定 create 时的 Manager tag matching。stop、resume、delete 按已绑定的 `manager_id` 执行，不看 tag。
- 实际 checkout commit 仍按用户选择的 branch/tag/commit/PR 锁定 SHA。
- `.gitea/codespace.yaml` 中的 `tag` 字段用于选择 Manager。实际 checkout 以用户选择的 branch/tag/commit/PR 确定的 `commit_sha` 为准。
- tag/commit 场景读取 default branch，避免任意历史 commit 改变 Manager 选择。
- PR 场景使用 base branch，让目标仓库维护者控制运行侧选择；实际代码仍按用户选择的 ref 锁定到具体 commit SHA。

配置缺失是正常路径，非法配置是仓库维护者需要修复的问题。Gitea 使用严格 YAML 解码读取当前唯一字段 `tag`，并在首次解码后确认输入已经结束。**设计如此：配置字段拼写错误不能静默回退到 `default`。**tag 决定运行模板，静默回退可能启动与仓库维护者意图不同的环境；单一严格结构能在创建 Runtime 前给出明确结果。Gitea 先完成 repository 权限与状态、ref/commit 锁定和配置解析；这些步骤失败时直接返回 create 页面错误，不插入缺少 `commit_sha` 或 `repo_tag` 的 Codespace。只有取得完整 `repo_id/ref_type/ref_name/commit_sha/repo_tag`，并读取当前站点默认 `git_protocol` 后才创建记录。协议不是仓库配置项，因为它取决于站点开放的 Git 接入和 Host Key 信任；记录提交后固化该值。

完整来源数据已经确定但没有已注册 Manager 匹配时，Gitea 先生成规范 Codespace UUID，再创建 `status=failed, manager_id=0` 的完整记录。该记录从未下发 operation，因此 `operation_rversion=0`，operation type/status/trigger 为空，operation created/started/deadline、`runtime_generation`、`interaction_generation`、`last_active_unix` 和 `stopped_unix` 都保持初始 0，也不创建 `codespace_gitea_token` 行；`created_unix=updated_unix=now`，`log_filename` 使用 `codespace_log/{codespace_uuid}.log`，日志计数和 index 从空值开始。事务提交后，Gitea 取得 Codespace lock 并重新确认 failed 记录仍存在，再通过内部日志入口尽力写入固定的无匹配 Manager 摘要；记录已经被并发删除时跳过，摘要失败时只记录服务端日志，两者都不回滚 failed 创建事务。进入队列后的 Manager、Runtime、clone 和 boot 失败则在原对象上按 State Finalization 进入 failed。

Manager 匹配查询在创建记录事务中的结果就是本次 create 的判定点。之后并发注册、Declare 或修改 tags 的 Manager 不会把已经创建的 failed 记录恢复为 queued；用户可以查看日志并删除后重新创建。这样无匹配 Manager 的对象既满足真实表的非空约束，也不会伪造从未存在的 operation 版本或引入自动复活规则。

### Manager 匹配

- create 记录固定 `repo_tag`。
- create 记录同时固化站点当前 `git_protocol`；Manager 匹配不按协议分组，领取后按 payload 协议执行初始化。
- 已注册 Manager 按 owner scope 和 tag 参与匹配。
- global Manager 参与所有 owner scope 的匹配。
- owner scoped Manager 参与相同 repository owner 的匹配；owner 可以是个人用户或组织，组织 ID 使用 Gitea `user.id`。
- 没有已注册 Manager 同时满足 owner scope 和 `repo_tag` 时，create 进入 `failed` 并写入无匹配 Manager 日志。
- 无匹配 Manager 的 failed 记录使用 `operation_rversion=0` 且没有 active operation；之后 Manager 可用性变化不自动复活该记录。
- create 创建时不绑定具体 Manager。
- 具体 `manager_id` 只在某个 Manager 通过 `FetchOperations` 成功领取 create [Operation](glossary.md#operation) 时写入。
- 有匹配 Manager 但全部离线、满载、不调用 `FetchOperations`，或调用 `FetchOperations` 但声明不可接收 create 时，create 保持 `status=creating, operation_status=queued`（参见 [Manager Capacity](glossary.md#manager-capacity)），页面可派生展示为 queued。

owner scope 表达 Manager 管理边界，tag 表达运行能力需求。global Manager 用于站点级容量，owner scoped Manager 用于个人或组织自有容量。repository 中可被 create 读取的配置能够选择该 scope 已声明的任一 tag，因此 tag 不承担用户授权或信任等级判断。global Manager 的每个 tag 都适用于站点范围内有权创建 Codespace 的仓库代码；owner scoped Manager 的每个 tag 都适用于该 owner 仓库范围内有权创建 Codespace 的用户。需要不同信任边界的环境由部署管理员使用独立 Manager 身份和 owner scope 管理，不把该环境的 tag 声明到普通创建范围。

**设计如此：tag 选择开发能力，不授予额外权限。**仓库内容可以影响工具链、架构和资源模板，但不能依靠“用户不会选择某个 tag”保护宿主资源或长期凭据。这个边界保留 repository 自主选择开发环境的能力，同时让运行安全由 Manager 的部署范围明确承担，无需增加难以维护的 tag ACL。

Create operation 领取：

- 领取前：`codespace.status=creating`，`codespace.manager_id=0`，`codespace.operation_type=create`，`codespace.operation_status=queued`，`codespace.operation_trigger=user`。
- `FetchOperations` 通过数据库条件更新完成领取。
- 领取同时写入 `codespace.manager_id`、`codespace.operation_status=running`、`codespace.operation_started_unix`、`codespace.operation_deadline_unix`。
- 领取条件包含 caller Manager online、caller Manager owner scope 匹配、caller Manager 支持 `repo_tag`、本次 `FetchOperations` 声明可接收 create、`codespace.manager_id=0`、`codespace.status=creating`、`codespace.operation_type=create`、`codespace.operation_status=queued`。
- Fetch request 不提交 tags；Gitea 使用认证 Manager 最近一次成功 Declare 保存的 `tags_json`，客户端修改 tags 后只影响之后尚未领取的 create。
- 本次 `FetchOperations` 的 `capacity_available` 大于 0 时才领取 create/resume。
- Fetch 使用本次 `capacity_available` 限制 create/resume，并另行提交 `cleanup_capacity_available` 限制 stop/delete；Gitea 使用最近成功 Declare 的 `capacity_total` 校验启动容量范围。Declare 容量同时用于管理页面展示和诊断，清理容量只属于单次 Fetch。
- 领取提交后，operation 保持归属于领取它的 Manager；同一 Fetch 在 payload 构造失败时按 UUID、版本、Manager 和 running 状态做条件回退。系统错误或响应丢失保留 binding 和原 deadline，Manager 未持久化上下文时由普通 timeout 收敛。
- create payload 中的 `repo_web_url` 和其他 Web URL 以配置的 `ROOT_URL`（`setting.AppURL`，包含 `AppSubURL`）构造；`repo_clone_http_url` 与 `repo_clone_ssh_url` 由 Gitea 现有仓库克隆地址生成器分别产生规范 HTTP(S) 和 SSH clone URL。三类 URL 都使用 payload 构造时重新读取的当前 owner/repository 名称。Fetch 是 Manager 发起的控制面请求，不能用该请求的 Host 或浏览器转发头推导对外地址；Manager 按 payload 原值注入，`git_protocol` 表示首次首选项。内置脚本在首选地址的 clone/fetch 非零退出时清理当前受控临时 workspace 并用另一地址重试，本地前置错误和 HEAD 校验失败不切换协议；自定义脚本可以选择任一地址。部署方负责让 Runtime 可访问两种已启用的 Git 接入面和 Web URL。
- 并发领取失败不是系统错误。
- queued create 在最终条件 UPDATE 中重新确认 repository 仍存在，并使用该语句看到的当前 owner 做 scope 匹配；`repo_tag` 仍使用创建时已经固定的值。repository transfer 与 claim 并发时，claim 先成立则 binding 固定，transfer 先成立则旧 owner Manager 领取失败；领取后 transfer 不再影响 binding。

Create 初始化流程：

```mermaid
sequenceDiagram
    participant U as User
    participant G as Gitea
    participant M as Manager
    participant R as Runtime

    U->>G: create
    G->>G: 校验来源与配置
    alt 来源或配置校验失败
        G-->>U: 返回创建错误，不创建对象
    else 无匹配 Manager
        G->>G: 写入完整 failed 对象和摘要
        G-->>U: 展示失败状态
    else 进入队列
        G->>G: 写入 creating 和 queued operation
        G-->>U: 展示创建状态
        M->>G: FetchOperations
        G-->>M: 下发 create 数据
        M->>R: 创建 Runtime，写入本轮选定脚本
        M->>R: root exec init.sh
        M->>G: RequestGiteaToken
        G-->>M: 返回 token
        M->>R: 原子写入两种 Token 文件
        M->>R: root exec start.sh prepare
        opt 本轮尝试 SSH clone
            R->>M: PUT Git SSH public key
            M->>G: EnsureCodespaceGitSSHKey
            G-->>R: 经 Manager 返回可信服务器公钥
        end
        M->>R: 持久化 prepare 结果，root exec start.sh activate
        M->>R: 读取并校验 activate 结果
        alt 初始化失败
            M->>G: FinalizeOperation failed
            G-->>U: 展示失败状态
        else 初始化完成
            M->>G: 上报 ready metadata
            M->>G: FinalizeOperation(final done)
            G-->>U: 展示运行状态
        end
    end
```

### 系统初始化与环境启动

create 的 running operation 是首次环境初始化阶段，页面可派生展示为 `booting`。

Manager 创建或启动 Incus 实例并确认 file/exec API 可用后，原子发布本次 operation 固定使用的 `init.sh`、`start.sh` 和 `resume.sh`。每轮 create/resume 先以 root 执行 `init.sh`，再按 operation 依次执行 `start.sh|resume.sh prepare` 和 `start.sh|resume.sh activate`。三者共享 `flock` 和 `CODESPACE_ENV`，stdout/stderr 进入同一 operation 日志；每次调用使用独立结果文件，Manager 只在结果与共享环境同时通过校验后推进本地阶段。

脚本可以使用 Manager 内置版本，也可以由部署方通过本地配置替换。Manager 核心只理解 init、prepare、activate、共享环境和通用输出，不理解软件包管理器、工作用户名称、直接运行、devcontainer、内部容器或端口转发。完整契约和当前内置实现见[脚本契约与内置实现](builtin-scripts.md)。

**设计如此：devcontainer 只是一套完整自定义脚本案例，不是内置模式。**Manager 和 Gitea 的状态、RPC、当前快照与 Endpoint API 都不保存 devcontainer 运行方式、容器标识、容器用户或逻辑端口；管理员显式配置该案例的三个脚本后，由脚本自行读取 repository 配置并提供相同 workspace、Git 本地配置、internal SSH 和实际 Endpoint 端口。这样既证明自定义开发环境能够接入，也不要求 Go 代码支持某一种容器工具。

每次脚本调用的结果只包含 `outcome` 和固定 boot stage。`done` 提交本次 `CODESPACE_ENV` 追加并进入下一阶段；`recoverable_failed` 在 lease 内重试；`unrecoverable_failed` 沿 create/resume 已定义结果收敛。Manager 主动取消时丢弃本次结果和环境追加，其他结果缺失、损坏或 schema 不匹配按可恢复失败处理。脚本不接收 `operation_rversion`，退出码只用于诊断。

create 脚本取得两种规范 clone URL、首选协议和锁定 commit SHA，输出最终 workspace 路径。Manager 只在该目录 HEAD 等于锁定 SHA，且实际 remote 的本地凭据配置有效时接受 prepare。resume 脚本不取得 repository payload，使用已保存 workspace、实际 remote 和共享环境恢复本地凭据与交互入口，并保留用户当前 HEAD。默认脚本的临时目录、协议回退、Git SSH 密钥和直接运行行为集中定义在[内置脚本实现](builtin-scripts.md#内置脚本实现)；devcontainer 案例单独定义在[自定义脚本案例](builtin-scripts.md#devcontainer-自定义脚本案例)。

**设计如此：resume 的 ready 证明 workspace、本地凭据配置和交互入口已经恢复，不证明来源 repository 当前存在或可访问。**repository 删除后 `repo_id=0`，Manager 仍按已保存 remote 配置 HTTP helper 或确认 SSH 密钥与 known_hosts，Codespace 可以恢复到 running；之后的 pull、push 和 repository API 请求由 Gitea 正常拒绝。

Git SSH 私钥只保存在工作环境用户目录；Manager 和 Gitea 只接收公钥。公钥是 Codespace 生命周期级凭据，不携带 operation 版本，也不因 resume 轮换。相同公钥确保请求幂等，不同公钥返回硬冲突。**设计如此：**稳定 Key 使迟到请求无法覆盖当前绑定，并避免为低收益轮换增加版本协议；它只认证 Runtime 到 Gitea 的绑定仓库，不复用 Gateway 用户 SSH Key 或 Manager 连接内部 sshd 的 client key。

create 实际使用 SSH remote 时必须在 ready 前登记公钥并配置严格 Host Key 校验；HTTP(S) remote 必须配置读取当前 Token 文件的限定路径 helper。SSH 尝试后改用 HTTP(S) 成功时，已经登记的公钥关系继续按 Codespace 生命周期保留，但不参与 HTTP(S) remote 的 ready 校验。

### 脚本输入与共享环境

Manager 使用环境变量向三个脚本传递当前 operation 和本地快照；init 结束并给出非 root 数值身份后，Manager 才签发并写入本轮两个 Token，再把当前 Token 快照提供给 prepare 和 activate。create 取得两种 clone URL、首选协议及锁定 ref，resume 不取得 repository 字段。

三个脚本通过 `>> "$CODESPACE_ENV"` 追加共享变量，非预定义变量由最后一行覆盖前值。Manager 预定义输入的同名追加覆盖无效并在规范化时移除。只有当前调用结果为 done 时，Manager 才解析、规范化并原子提交本次追加；失败或取消恢复调用前环境。完整变量表、优先级、持久化和校验规则见[调用与共享环境](builtin-scripts.md#调用与共享环境)。

### 脚本实现边界

内置脚本固定在 Incus 实例内直接运行，并只保存 `GITEA_BUILTIN_*` 私有状态。完整自定义套件可以通过 `CODESPACE_ENV` 保存自己的实现选择、内部环境和转发状态，并最终输出同一组通用 workspace 与 internal SSH 变量。Manager 只保存规范共享环境，不解析其中的实现私有变量。

Endpoint helper 始终向 Manager 提交 Incus 通信地址上已经可以访问的实际端口和明确的 `public` 布尔值。helper 默认要求认证，只有显式 `--public` 才公开普通 Endpoint；`workspace` 固定要求认证。**设计如此：持有 Runtime Token 的工作环境进程是 Endpoint 声明主体，`--public` 是 Runtime 提交的访问方式，不表示 Gitea 页面再次确认。**需要内部容器的自定义脚本先在实例内建立转发，再登记实际端口；devcontainer 案例也只使用这条通用规则。Manager 的路由只保存该实际端口与访问方式，容器逻辑端口与内部转发由脚本保存和恢复。

**设计如此：脚本实现可以变化，Incus 实例边界保持不变。**stop、delete 和 inventory 只管理 Incus 实例；内部环境的安装、恢复、端口转发和用户选择由当前脚本负责。默认直接运行行为见[内置脚本实现](builtin-scripts.md#内置脚本实现)，devcontainer 作为完整自定义案例见[自定义脚本案例](builtin-scripts.md#devcontainer-自定义脚本案例)。

Manager 的启动编排如下。图中的步骤是 Manager 本地执行阶段；Gitea 数据库仍只保存主状态和 active operation，具体脚本步骤不写入主状态：

```mermaid
flowchart TB
    begin([领取 create 或 resume])
    prepare[prepare-runtime<br/>启动 Incus 并发布脚本]
    init[以 root 执行 init.sh<br/>初始化系统与 codespace 用户]
    credentials[申请并原子写入<br/>Gitea Token 与 Runtime Token]
    operation{operation 类型}
    create[start.sh prepare<br/>准备并提交 workspace]
    resume[resume.sh prepare<br/>恢复 workspace 与共享环境]
    persist[持久化 workspace<br/>与规范共享环境]
    activate[start/resume activate<br/>启动内部 SSH 与适配]
    validate[校验本地凭据配置<br/>internal SSH 与 workspace 路由]
    publish[发布当前版本 ready metadata]
    finalize[FinalizeOperation final done<br/>已接受或幂等完成]
    running([Gitea 主状态 running])
    classify{本阶段结果}
    retry[在有效 lease 内<br/>从持久化阶段重试]
    paused[终止在途 launcher 并停止实例<br/>本地 lease_paused]
    renewed{同版本续租成功}
    reconcile([等待 timeout、inventory<br/>或更高 operation])
    createFailed[删除本轮实例<br/>create final failed]
    resumeStopped[停止实例并保留根存储<br/>resume final failed]
    resumeResult{失败是否不可恢复}
    reportFailed[上报 Runtime failed<br/>并进入 cleanup]
    failed([Gitea 主状态 failed])
    stopped([Gitea 主状态 stopped])

    begin --> prepare --> init
    init --> credentials
    credentials --> operation
    operation -- create --> create
    operation -- resume --> resume
    create --> persist
    resume --> persist
    persist --> activate
    activate --> validate
    validate --> publish --> finalize --> running

    prepare -. 失败 .-> classify
    init -. 失败 .-> classify
    credentials -. 失败 .-> classify
    create -. 失败 .-> classify
    resume -. 失败 .-> classify
    persist -. 失败 .-> classify
    activate -. 失败 .-> classify
    validate -. 失败 .-> classify
    publish -. 失败 .-> classify
    classify -- 可恢复且 lease 有效 --> retry --> prepare
    classify -- create 结束 --> createFailed --> failed
    classify -- resume 结束 --> resumeStopped --> resumeResult
    resumeResult -- 否 --> stopped
    resumeResult -- 是 --> reportFailed --> failed

    prepare -. lease 到期 .-> paused
    init -. lease 到期 .-> paused
    credentials -. lease 到期 .-> paused
    create -. lease 到期 .-> paused
    resume -. lease 到期 .-> paused
    persist -. lease 到期 .-> paused
    activate -. lease 到期 .-> paused
    validate -. lease 到期 .-> paused
    publish -. lease 到期 .-> paused
    paused --> renewed
    renewed -- 是 --> retry
    renewed -- 否 --> reconcile
```

重试从 Manager 已持久化的阶段继续；图中回到 `prepare-runtime` 表示重新进入统一编排入口。已经提交的系统初始化、凭据、workspace 和共享环境先复检，仍成立时可以跳过破坏性工作；只要实例曾因 `lease_paused` 被停止，就必须重新执行通用 prepare、activate 和连通校验，再允许 ready/final。脚本自行恢复其内部实现。此前已持久化或上报的 boot stage 保持单调，不向 Gitea 回退，但不能替代本次实例启动后的重新校验。`lease_paused` 只是 Manager 本地 worker 阶段：Manager 终止本轮 launcher 并停止 create/resume 实例，不提交 final；同版本取得新相对 lease 后继续，未取得时由 Gitea timeout、inventory 或更高 operation 给出最终动作。create 的失败终点是 `failed`；resume 的普通失败保留实例根存储并回到 `stopped`，不可恢复结果则在 final failed 后继续上报 `failed`。这些分支与主状态图使用相同结果，不增加 Gitea 主状态或 RPC 字段。

Create 启动完成条件：

- `init.sh`、`start.sh prepare` 和 `start.sh activate` 均写入合法结果并由 Manager 持久化。
- workspace 从当前 create 的受控临时目录原子发布，脚本需要保留的实现状态已经写入共享环境或 Runtime 文件。
- workspace checkout 到锁定 commit SHA。
- internal SSH 可被 Gateway 连通。
- Manager 已从 Incus Runtime identity 派生 `internal_ssh.host`，脚本通过共享环境给出的 port/user/host-key fingerprint 已通过连通和 host-key 校验。
- 至少一版 Runtime Metadata 被 Gitea 接受。
- 实际 workspace remote 为 SSH 时，Codespace Git SSH 公钥绑定完整且与 Runtime 公钥相同；HTTP(S) remote 的 helper 已配置为读取当前 Token 文件。该检查确认本地凭据配置，不要求 repository 可达。
- Manager 已建立有效 `workspace` 路由；Runtime 声明同名 Endpoint 时连接 Web IDE，未声明时使用内置 Web SSH，两者不改变 Gitea 侧的 `endpoint_id=workspace`。

boot stage 是 Manager 对自身编排的展示，不是 Runtime 脚本协议。固定顺序见[运行快照阶段](state-machine.md#runtime-metadata)。

具体包安装、Git 和内部环境子步骤写入 operation 日志和失败摘要，不扩充持久状态枚举。Manager 只在前一阶段成功后推进；active create/resume 的凭据提交中断或校验不一致时，本地执行阶段可以回到 `write_credentials` 重放，Gitea 的同一 operation boot stage 不回退，`ready` 成立后保持 `ready`。

`ready` 是 create/resume 的终态阶段；只有两种 Token 文件、本地实际 remote 凭据配置、internal SSH 和 `workspace` 路由可用后才写入 Manager 当前完整 metadata 快照。普通 Endpoint 和用户进程不参与 ready 判定；它们可以在 running 后继续声明或启动。Manager 的单一发布任务确认 Gitea 已接受任一包含当前 operation 版本 ready 的快照后，才允许 final done；之后产生的 Endpoint generation 继续异步同步，不延迟 final。同一 operation 版本的阶段只按上表前进，`ready` 成立后保持 `ready`。

Resume 使用已有 workspace：Manager 持久化并领取 resume payload 后关闭本地准入、启动 Runtime，并等待 Incus exec/file API 和唯一通信地址；随后以 root 执行幂等 `init.sh`，持久化 `write_credentials` 并暂时关闭 Runtime HTTP API，调用 `RequestGiteaToken` 取得新 Token 和 `server_url`、原子替换两种 Token 文件，再把 Runtime Token verifier 与 `run_prepare` 原子提交到 Manager 快照，依次执行 `resume.sh prepare` 和 `resume.sh activate`。prepare 从 `CODESPACE_ENV` 恢复脚本私有状态，验证 workspace 和实际 remote 的本地凭据配置；activate 在脚本选择的内部环境中安装当前 Manager 公钥、启动或转发 sshd，并恢复通用 internal SSH 输出，不读取 repository payload，也不修改当前 HEAD。Manager 使用当前内部 private key 校验结果文件、规范共享环境、internal SSH、Host Key 和 workspace 路由后推进到 `ready`。唯一 metadata 发布任务确认 Gitea 已接受包含本次 resume ready 的快照后，Manager 调用 `FinalizeOperation(final done)`。Gitea 只在 ready metadata 和 Token 行完整时写入 `running` 并清空 operation；实际 remote 协议和对应凭据由 Manager 在 ready 前验证。旧 operation 版本的 ready 不能完成本次 resume。final accepted 或幂等完成后，Manager 在本地协调锁内复检当前 operation 和 cleanup，再开放 session 准入。

临时错误在 operation 当前 lease 内退避重试，续租总量受固定总执行期限限制。Manager 重启时，本地 resume payload、boot 结果和 worker 阶段完整的 worker 先保持暂停；普通 Fetch 成功续租并返回新的相对有效时长后，才继续 token、credential、ready 和 final 的未完成步骤。上下文缺失或服务端已超时时不重新执行，等待普通 timeout 回到 stopped。站点排空时由 `abort_resume` 停止本轮启动的 Incus 实例、保留实例根存储并提交 final failed；确认无法写入 credential 或恢复服务时也先停止本轮实例，再提交 final failed。Manager 把 boot 终态保存为 `operation_type + operation_rversion + outcome`，其中 `outcome` 为 `done|recoverable_failed|unrecoverable_failed`。普通失败、timeout 或 abort 清除本轮 boot 发布上下文并保持 stopped；`unrecoverable_failed` 在 final failed 后继续驱动 failed 状态报告，报告接受后清理实例。repository 初始化只在 create 中执行；resume 不读取 repository payload，也不要求 workspace HEAD 等于创建时的 `commit_sha`。

每个 init/prepare/activate exec 都由 Manager 内置 launcher 建立独立进程组。Manager 每次取得当前 operation 的 payload 或续租回执后，用自己的剩余本地 lease 原子更新实例内 pulse 文件；launcher 按 Runtime 单调时钟等待下一次 `pulse_sequence`，在 `remaining_lease_milliseconds` 到期前没有更新时终止整个进程组。Manager 自己到达 `local_worker_deadline` 时也取消 Incus exec、终止 launcher，并停止 create/resume 实例；停止和终止属于收缩本地执行，不授权继续初始化。Manager 崩溃时，pulse 停止更新，launcher 会自行结束；Manager 重启先清理遗留 launcher，再把完整 worker 恢复为 `lease_paused`。只有同版本 Fetch 成功返回新的正相对时长后，Manager 才重新启动实例，复用仍然有效的持久结果，并重做本次启动所需的环境准备、activate 和校验。

resume final 前若 delete 以更高 `operation_rversion` 接管，Manager 先原子替换本地 operation 上下文，再执行 delete；旧 resume worker 不再申请 Token、写 credential、上报 ready 或提交 final。delete 已在 Gitea 事务中删除可能提前签发的 Token 行。该优先级复用 active operation 的版本和 lease，无需保存 final 后任务。

实现验收点：

- repository/ref/commit/config 前置失败不创建对象；来源数据完整但无 Manager 匹配时形成可查看日志的 failed 对象，且不创建 active operation。
- repository 配置只接受单个 YAML mapping 和字段 `tag`；未知字段、重复字段、错误类型、第二个 document 与非法 YAML 都返回配置错误，文件缺失或合法空 tag 使用 `default`。
- global Manager 声明的全部 tag 可由站点范围内符合创建权限的仓库代码选择，owner scoped Manager 声明的全部 tag 可由该 owner 范围选择；tag 只决定开发能力和资源模板，不承担授权或信任等级判断。
- 无匹配 Manager 的 failed 记录使用版本 0 和空 operation 字段，之后出现可用 Manager 不会自动复活该记录。
- PR create 只使用 base repository clone URL 和 `refs/pull/{index}/head`，token 不访问 head repository。
- create payload 提供 Manager 选择本地模板所需的 `repo_tag`、首选 `git_protocol`、两种规范 clone URL，以及 Runtime 初始化所需的 repository、owner、创建者和 ref 数据；Web URL 基于配置的 `ROOT_URL` 并保留 `AppSubURL`，所有 URL 都不受 Manager 控制面请求 Host 影响。`repo_tag` 只用于 Manager 选择并持久化有效模板，不传入 Runtime 环境。
- resume 基于已有 workspace，不读取 repository、不 checkout 初始 commit，并在初始化阶段轮换 Gitea Token；SSH remote 校验并确认原 Git SSH Key，不生成新 Key，也不以 repository 网络可达性作为 ready 条件。
- 使用 SSH remote 时，start/resume 脚本按固定私钥、公钥和 known_hosts 路径持久化密钥材料；Manager 与 Gitea 的持久状态只保存公钥绑定。
- 脚本只接收当前运行环境所需输入，不接收 operation 版本；init、prepare 和 activate 每次调用都写入 `root:root 0600` 的唯一结果文件，Manager 先持久化严格 schema 的结果和本地阶段再继续。非主动取消场景的缺失或损坏结果按可恢复失败处理。
- create/resume 都仅在当前 operation 版本的 `ready` 快照、Token 行、本地实际 remote 凭据配置、internal SSH 和 workspace 路由完整后 final done；普通 Endpoint 和用户服务不阻塞 ready。resume 顺序为 `系统初始化 -> Token -> prepare -> activate -> ready -> running`。
- ready 接受记录来自任一成功 metadata 请求实际携带的当前 operation ready；空响应不重复返回 boot 或 generation，并发 Endpoint 变更继续同步最新 generation，不阻塞 final。
- Manager 只在 final accepted/idempotent done 后开放本地 session 准入；进程重启后在凭据、SSH、路由和 ready 上报重新确认前保持关闭。
- active create、active resume 和 running 使用固定 boot 阶段与版本关系；同版本 ready 不能回退。稳定 stopped 只在 Manager 本地保留最新 boot 终态，等待下一次 resume 从保留的 Incus 实例重建并发布 metadata。
- resume failed、timeout 或 abort 后不发布历史 ready；迟到的失败版本 metadata 不能重新成为当前启动上下文，下一次 resume 从保留的 Incus 实例重建。
- Git SSH 密钥材料矛盾和 Gitea 返回 `key_conflict` 时保存 `unrecoverable_failed`；resume final failed 后继续上报 failed，进程重启和并发新 resume 都不能丢失该收敛目标。
- resume 在本地上下文完整且重启后成功取得新相对 lease 时长时继续，final done 后没有独立凭据刷新任务。
- 最新 boot 终态结果固定包含 operation 类型、版本和三值 outcome，保留到下一次合法 create/resume session 或 Runtime 删除。
- 更高版本 delete 会替换旧 resume worker，旧 boot 上下文不再产生 token、credential、ready 或 final 写入。
- recovering Manager 通过普通 Fetch 恢复 active resume；站点排空通过 abort 回到 stopped，记录缺失通过完整 inventory 确认本地处理。
- stopped Runtime 只能由 Gitea 下发的 resume operation 启动；inventory 发现无对应 operation 的 running Runtime 时停止 Incus 实例并保留根存储。
- Manager 向 create 脚本提供两种 clone URL、首选协议和锁定 SHA，并校验脚本提交的最终 workspace、HEAD 和实际 remote 本地凭据。内置脚本的临时目录、协议回退与崩溃恢复按独立脚本文档实现。
- create/resume 均先以 root 运行幂等 `init.sh`，再分别运行 prepare 和 activate；create 校验锁定 SHA，resume 不修改用户当前 HEAD。
- 内置脚本的 apt/dnf/pacman、固定用户、直接运行和 internal SSH 由独立文档的实现验收点覆盖；devcontainer 案例另以完整自定义套件覆盖 CLI、lifecycle commands、恢复和端口转发。Manager 核心测试只验证通用脚本契约和输出，不增加 devcontainer 分支。
- lease pulse 停止或本地截止点到达时 launcher 终止进程组，Manager 停止 create/resume 实例并保留 operation 上下文；同版本续租前不继续 Runtime 修改，Manager 崩溃后脚本也不能无限运行。
- `lease_paused` 后重新启动实例时复检持久 workspace、凭据和共享环境，并重新执行 prepare、activate 与连通校验；旧 ready 快照不能直接触发 final，boot stage 也不向 Gitea 回退。
- Runtime Token 通过固定文件交付，create/resume 时轮换，普通 Manager 重启不轮换。active create/resume 在凭据提交中断或文件与 verifier 不一致时回到 `write_credentials` 重做本轮后续步骤；稳定 running 的不一致关闭入口、停止实例并上报 stopped，下一次 resume 重新生成。
- Git SSH 私钥只存在于 Runtime；create 重试和 resume 复用已落盘密钥。stopped 且无 active resume 时公钥不能使用；active create/resume 初始化和 running 可以使用；failed、deleting 和物理删除会清理 Gitea 公钥绑定。

## 自动暂停与恢复流程

自动暂停是 stop 的一种触发来源，不是新的生命周期状态。Gitea 在 create/resume payload 和完整 inventory response 中下发当前有效开关、超时和交互版本；Manager/Gateway 在 running/ready、策略启用、没有 lifecycle worker 且认证 live session 为 0 时使用单调时钟累计空闲。公共 Endpoint 连接不进入 session 计数，也不产生用户交互。create/resume 首次 ready、最后一个认证 session 关闭、从 never 或排空重新启用以及恢复 inventory 完成都会重新计算这组条件，条件首次成立便从完整时长开始。达到超时后，Manager 携带观察到的开关、超时和交互版本调用 `RequestIdleStop`。Gitea 在 Codespace lock 内重新校验当前策略、用户交互、主状态和 active operation，成立时创建 `operation_trigger=idle` 的 queued stop。

```mermaid
sequenceDiagram
    participant U as User
    participant W as Gateway
    participant M as Manager
    participant G as Gitea
    participant R as Runtime

    W->>M: live session 归零
    M->>M: 单调计时达到有效超时
    M->>G: RequestIdleStop(enabled, timeout, interaction_generation)
    G->>G: 锁内复检并创建 queued idle stop
    G-->>M: pending(operation_rversion)
    M->>G: FetchOperations
    G-->>M: stop payload
    M->>M: 原子写入普通 stop worker
    M->>W: 关闭该 Codespace session
    M->>R: 停止 Incus 实例，保留实例根存储
    M->>G: FinalizeOperation(final done)
    G->>G: status=stopped，删除 Token、保留 Key，清空 operation
    U->>G: Resume
    G-->>M: resume payload + 当前设置
    M->>R: 启动 Runtime
    M->>R: root exec init.sh
    M->>G: RequestGiteaToken
    M->>R: 原子刷新两种 Token 文件
    M->>R: root exec resume.sh prepare
    opt workspace remote 为 SSH
        R->>M: PUT Git SSH public key
        M->>G: EnsureCodespaceGitSSHKey
    end
    M->>R: 持久化 prepare 结果，root exec resume.sh activate
    M->>R: 读取结果并验证本地凭据 / SSH / workspace 路由
    M->>G: ready metadata
    M->>G: FinalizeOperation(final done)
    G->>G: status=running，清空 operation
```

用户活动与请求竞争由 Gitea 决定。需要认证的 Open Code 签发/消费、SSH 成功认证和“继续运行”会推进 `interaction_generation` 并取消 queued idle stop；resume 也推进版本。公共 Endpoint 校验不推进版本，也不取消 queued idle stop。queued idle 保持 running 展示和创建者交互能力，但公共请求因 active stop 被拒绝；用户 stop 遇到它时将来源改为 user，使后续交互不能取消用户明确的停止。用户事务与 `RequestIdleStop` 由 Codespace lock 串行，和 Fetch claim 则由双方只匹配 queued 的数据库条件更新决定提交顺序。Manager 已领取 idle stop 后页面和连接入口转为 stopping，停止完成后使用普通 resume。这条边界让尚未执行的资源回收可以响应用户活动，已经开始的停止保持单向完成。

设置为 never 会关闭 Manager 普通计时并取消 queued idle stop；已经 running 的 stop 完成后设置仍保留，用户 resume 后不会再次因空闲暂停。相同持久值幂等成功且不取消 queued idle stop；只有解析后的开关或有效超时变化才取消 queued idle stop。启用策略之间变化按当前本地 `idle_started` 重新计算剩余时间，从关闭变为启用则从当前时间开始完整计时。Manager 使用最后收到的完整设置覆盖本地策略，交互版本只向前；延迟设置最多暂时改变本地计时，Gitea 仍以当前实际设置值复检并返回最新设置。控制面恢复稳定后，下一次成功完整 inventory 会在一个 `inventory_report_interval` 加当前 RPC 退避内重新下发当前设置。

Manager 重启时，普通计时在恢复完成且统一条件成立后从当前设置的完整时长开始。Gitea 已经创建的 queued idle stop 由普通 Fetch 领取；running stop 从完整本地上下文恢复为暂停 worker，成功 Fetch 续租并取得新的相对有效时长后继续，上下文缺失或服务端已超时时等待普通 timeout。idle stop 与用户 stop 的 payload 完全相同，Gitea 内部来源可以因用户 stop 接管从 idle 变为 user，但相同版本仍由同一个普通 stop worker 执行。

**设计理由：复用 stop/resume 保持一条资源状态闭环。**自动触发只影响 stop 创建前的授权，Manager 真正停止 Runtime、Gitea 写入 stopped、Token 吊销、Git SSH Key 状态禁用、workspace 保留和用户恢复都沿用已经定义的操作。请求携带的启用值、有效超时和交互版本足以发现请求在途期间的变化，Gitea 无需保存连接心跳或按 `last_active_unix` 扫描。

实现验收点：

- 自动暂停只创建来源为 idle 的普通 stop，完成后主状态为 stopped，数据和 workspace 保留。
- 认证 live session 归零并持续达到有效超时后才请求；任一认证 live session 存在时不累计 Codespace 空闲时间，公共 Endpoint 流量不改变计时。
- create/resume 首次 ready、从 never 或排空重新启用以及恢复完成时，即使没有发生 session 归零事件，也会从完整时长开始计时。
- Gitea 使用当前启用值、有效超时和交互版本授权，过期 Manager 观察值不能创建 stop。
- 请求响应丢失、Manager 重启和 Fetch 空响应下，当前 idle stop 保持同一 operation 版本且不会出现并行 stop；queued timeout 明确结束后，持续空闲才可创建更高版本重试。
- queued idle stop 可被有效用户活动或设置变化取消，已领取 stop 完成后由普通 resume 恢复。
- 自动暂停 stop 完成时清理 Token 并保留 Git SSH Key；稳定 stopped 状态拒绝 Key，恢复初始化重新签发 Token、确认原 Key 后可以直接使用。
- queued idle stop 保持 running 展示与 open/SSH/continue 能力；queued user stop 或已领取 stop 展示 stopping。
- 延迟设置快照不能绕过当前启用值、有效超时和交互版本复检；stop payload 只通过普通 Fetch 与本地 operation 快照交接。
- 控制面稳定后，当前自动暂停设置在一个 inventory 周期加当前 RPC 退避内重新覆盖临时旧快照。
- never 只关闭空闲触发，手动 stop/delete、failed、排空和账户管理流程保持有效。
- 自动暂停不读取 `last_active_unix`，Gitea Cron 不创建 idle stop，Runtime 后台活动不隐式延长空闲时间。
- 公共 Endpoint 请求不推进交互版本且不取消 queued idle stop；需要持续公开服务时由创建者显式选择 never。

## 外部变化

### Repository 删除

Repository archived、migrating、pending transfer、broken、deleted、Git 不可读或 ref 不可解析时，只影响 create 的来源校验和后续 Git HTTP(S)/SSH、LFS、repository API 访问。已经初始化完成的 workspace 按 Runtime 数据和 Manager binding 继续提供 open、SSH、resume、stop、delete 和 logs；resume 从不读取 repository payload。已领取 create 可能因后续 repository 访问被拒绝而上报 failed，但如果 Manager 已持久化成功 boot 结果、确认 workspace 初始化完成并上报 `ready` metadata，即使 repository 已删除，也可以用当前 `operation_rversion` 上报 done 并进入 running。

repository 删除后 Gitea 无法再构造 running create 的 repository payload。Manager 收到 create payload 后先持久化 payload、operation 版本和 boot 结果，再启动 worker；本地上下文完整时在 Fetch 中声明已观察到相同版本，Gitea 只续租，Manager 继续使用本地数据。Manager 重启后若该上下文不完整，就停止本轮 Incus 修改并等待原 deadline，running create timeout 后进入 failed。尚未领取且 `repo_id=0` 的 create 不进入候选 payload，最终由 queue timeout 写入 failed 和来源不可用摘要。repository 删除事务本身不直接改写主状态。

Repository 删除：

- repository 删除确认 UI 提示会影响的 codespace 数量。
- repository 删除成功页或确认摘要展示受影响的 codespace 数量。
- `DeleteRepositoryDirectly` 是取得 repository working lock 并拥有最外层数据库事务的公共入口。入口首先用 Gitea 现有 `db.InTransaction(ctx)` 检查调用 context；已经处于事务时立即返回内部调用错误，避免 `TxContext` 复用外层事务后把无效的内层 `Commit` 误当成已经提交。合法调用取得 `modules/repository.WorkingLockKey(repoID)` 返回的 repository lock，并在锁内重新读取 repository。所有上层单仓库删除入口复用这个公共入口。
- 公共入口在锁内开启短事务并调用 `deleteRepositoryDBLocked(txCtx)`。该私有函数只执行数据库写入，不开启、提交或关闭事务；它在删除 repository row 前执行 `UPDATE codespace SET repo_id=0 WHERE repo_id=?`，完成现有 repository 数据库删除，并返回 `RepositoryCleanupPlan`。任一数据库步骤失败时由公共入口回滚整个事务。
- `RepositoryCleanupPlan` 只携带 Gitea 现有提交后清理所需数据：repository 与 wiki 路径、archives、LFS、attachments、Actions logs/artifacts、avatar，以及是否需要重写 keys。它是数据库事务提交后立即消费的内存返回值，生命周期到本次删除调用结束为止。
- 最外层数据库事务提交成功后，公共入口释放 repository lock，再调用 `cleanupDeletedRepository(plan)` 执行既有文件清理。repository 与 Codespace 关系已经由数据库事务确定，文件清理不参与并发判定且可能耗时，因此放在锁外执行。清理失败继续使用对应 Gitea 删除入口现有的日志、system notice 和错误返回方式；某个入口可以在数据库已经提交后向 caller 返回文件清理错误，但不能回滚或恢复已删除的 repository 或 Codespace 关系，也不增加补偿队列。
- 这一拆分保持 Gitea 现有“数据库删除先提交、文件随后清理”的行为：Codespace 的 `repo_id=0` 与 repository 数据库删除原子提交，同名 repository 的后续创建和旧文件清理继续服从 Gitea 现有 repository 服务语义。
- `deleteRepositoryDBLocked` 只在 repository service 包内使用，调用者持有对应 repository lock，并明确提供本次短事务的 context。owner purge 逐个取得 repository lock，为每个 repository 开启短事务、调用该私有函数并提交，累计已经提交记录的 cleanup plan；文件清理在对应数据库事务提交后执行。
- repository 数据库删除使用字段级 SQL 只把匹配记录的 `repo_id` 写为 0，不修改主状态、Codespace Token、Git SSH Key、日志或 cache。其他 Codespace 写路径只更新各自负责的字段，因此状态流转、续租、日志元数据、设置或展示时间更新在前后任一顺序提交都不会恢复旧 `repo_id`。repository lock 已在事务前取得，`CreateCodespace` 记录插入事务也使用同一锁；这个边界既阻止删除提交后插入带旧 `repo_id` 的新记录，也使删除无需逐个取得 Codespace lock。
- `repo_id=0` 表示来源 repository 已不可再解析。当前 Token 和 Git SSH Key 随 Codespace 保留，但任何 repository 都无法通过 binding；后续进入 stopped 时删除 Token 并保留 Git SSH Key，进入 failed/deleting 或物理删除时删除两类开发凭据。
- `CreateCodespace` 记录插入先把创建者与 repository owner ID 去重并按升序取得 Codespace owner relation lock，再取得 repository lock，并在事务中重新确认用户和 repository。插入先提交时，后续 repository 删除把记录置 0；repository 删除先提交时，插入返回 repository 不存在且不写 Codespace 记录。Fetch queued claim 继续使用现有条件更新确认 repository 存在，不取得 repository lock。
- source repository 删除后，相关 codespace 列表和详情页根据 `repo_id=0` 显示来源 repository 已删除或不可用。
- repository 删除的用户提示由确认页、成功摘要和 Gitea 现有文件清理失败 system notice 共同表达。

Repository working lock 的公共使用范围固定为 repository 删除、`CreateCodespace` 主记录插入、repository 重命名，以及 transfer 的 start、accept、reject、cancel。每个公共入口都在数据库事务外取得 `modules/repository.WorkingLockKey(repoID)`，锁内重新读取 repository、owner 和适用的 transfer 记录，再调用不重复加锁的私有 helper。transfer 不改写已有 Codespace 主状态、Manager binding、开发凭据或 workspace；提交后尚未领取的 create 按新 owner 匹配 Manager，已领取 create 和既有 Codespace 保持原 Manager binding。账户清理在自己的关系锁内按当时已提交的 repository owner 关系复检范围，不保存 transfer 历史。

**设计如此：repository lock 只串行化上述需要稳定 repository 身份、路径或 owner 的入口，Codespace owner relation lock 只串行化新增的 Codespace 所有者关系。**普通 repository 创建、push、设置修改、package、组织成员和 team 成员继续使用 Gitea 现有服务流程；把这些无关写入口全部接入同一锁会扩大回归范围，却不会改善 `repo_id=0` 的原子性。repository 删除事务和 `CreateCodespace` 共享 repository lock 已足以保证“先插入后置零”或“先删除后拒绝创建”两个确定结果；同名 repository 后续创建继续服从 Gitea 现有服务语义。


### 用户与组织删除

用户和组织删除沿用 Gitea 现有的分阶段服务流程，并在其中补齐 Codespace 关系清理。`codespace_owner_{owner_id}` 是 Codespace owner relation lock，只由 CreateCodespace、Manager、registration token 等新增关系入口和账户删除服务使用；它不改变 repository、package、组织成员或 team 成员的现有并发模型。需要多个 owner 时先去重并按 ID 升序取得锁，锁内短事务重新读取关系双方；owner 不存在或类型不符合时返回明确业务错误。

Gitea 现有 repository、package 和成员清理继续使用 purge 复扫与最终事务检查。Codespace 设计只保证新增的 Codespace、Manager 和 registration token 关系不能在最终复检与 owner 删除之间插入；它不宣称修复或替换 Gitea 其他子系统的账户删除并发语义。

**设计如此：账户删除只为 Codespace 新关系增加专用锁。**成功删除必须保证不留下 Codespace、Manager 或 registration token，但没有必要让 package 上传、组织成员和全部 repository 创建入口承担一把新的全局 owner 锁。保留 Gitea 现有分阶段删除，并在相同阶段加入 Codespace 复扫，可以用更小的改动得到完整 Codespace 清理结果。

六个人工删除入口统一进入上述服务顺序：用户自助 Web 删除、管理员 Web 删除用户、管理员 API 删除用户、`gitea admin user delete`、组织 Web 删除和组织 API 删除。inactive-user Cron 也调用用户删除服务；用户 purge 因 last owner 触发组织删除时调用组织删除服务。入口只负责参数、权限和错误适配，不在 router 或 CLI 中直接删除 owner、repository 或 Codespace 数据，因此 Web、API、CLI、Cron 和 purge 不会形成不同的清理边界。

普通删除在第一项 Codespace 破坏性清理前完成所有当前可判定的 Gitea 前置检查。用户包括最后一个站点管理员、repository 所有权、组织成员关系和 package 所有权；组织包括 repository 与 package 所有权。前置检查通过后取得目标 Codespace owner relation lock，在锁内重读 owner 并再次检查相同条件，再清理 Codespace 关系。最终短事务沿用 Gitea 当前 repository、package和成员检查，并额外确认 Codespace、Manager 和 registration token 关系为空后删除 owner。已知会拒绝删除的条件因此不会造成 Codespace 已经清理而 owner 仍因同一条件保留。

purge 使用以下分阶段顺序：

1. 用户 purge 沿用 Gitea 当前短事务先禁用登录、管理员权限和仓库创建能力，使被删除用户不能继续主动创建自身资源。
2. 取得用户 Codespace owner relation lock，完成一次 Codespace、owner-scoped Manager 和 registration token 前置清理后释放。该次清理先于第一条 repository 删除，仍能用当前 repository owner 关系找到完整范围。
3. 沿用 Gitea 服务逐个删除 repository、组织成员关系和 package；repository 使用上一节的独立短事务与 `RepositoryCleanupPlan`，last owner 引发的组织删除从目标组织自己的流程开始。
4. 重新取得用户 Codespace owner relation lock，复扫并清理步骤 2 之后可能提交的 Codespace 新关系。最终短事务沿用 Gitea 当前 repository、package 和成员空集合检查，并额外确认 Codespace、Manager 和 registration token 为空后删除用户记录；提交并释放关系锁后执行缓存、文件和授权文件清理。
5. 组织 purge 同样先在组织 Codespace owner relation lock 内完成 Codespace 前置清理，再使用独立 repository 事务处理仓库；最后重新取得该关系锁，复扫 Codespace 新关系，并在 Gitea 现有最终检查通过后删除组织记录。

用户 purge 释放 Codespace owner relation lock 期间，Codespace 新关系只有两个闭环结果：关系先提交，最终复扫负责清理；最终删除先提交，写入口在关系锁内复读时得到 owner 不存在并返回硬错误。repository、package 和成员关系仍由 Gitea 现有复扫及最终检查决定成功或错误。分阶段清理允许重试，但成功结果不会留下指向已删除 owner 的 Codespace 关系。

`DeleteOrganization` 的逐仓库数据库删除在组织最终事务之前完成。每个仓库都调用只接受独立事务 context 的 `deleteRepositoryDBLocked` 并返回 cleanup plan；组织最终事务只处理剩余关系和组织记录。这个边界使仓库数据库提交与其文件清理保持真实先后，也避免复用外层 `TxContext` 时把尚未提交的仓库误当成已经删除。

Codespace 前置清理按以下方式执行：

- 在 Codespace owner relation lock 内按 Manager ID 升序逐个处理该 owner 自有的 Manager。每个 Manager 取得 Manager lock 后，按完整 UUID keyset 每批至多 100 条查询 binding；每条记录单独取得 Codespace lock，在短事务中复检 `manager_id`，删除 Codespace Token、Git SSH Key 关系及其 `PublicKey`、DBFS 日志元数据和 Codespace 主记录。集合为空后用最终短事务复检并删除 Manager 地址与 Manager，再释放 Manager lock。
- owner 自有 Manager 清理完成后，按完整 UUID keyset 每批至多 100 条查询仍由创建用户、当前 repository owner 或 Manager owner 任一关系命中的 Codespace。每条记录只取得 Codespace lock，短事务重新读取三条关系后直接删除 Codespace Token、Git SSH Key 关系及其 `PublicKey`、DBFS 日志元数据和 Codespace 主记录。绑定 Manager 属于其他 owner 或 `owner_id=0` 时也使用相同路径；账户删除无需取得该 Manager lock，因此全局 Manager 可以继续领取和处理其他 Codespace。
- 与账户删除并发的 Fetch claim 由数据库结果决定先后。账户删除先物理删除时 claim 影响 0 行；claim 先提交时账户删除在 Codespace lock 内看到最新 binding 并删除该记录。Manager 可能已经收到 create payload 并创建 Incus 实例，但已删除 UUID 的后续 operation RPC 无法通过数据库复检；原 Manager 身份仍有效时，下一次成功的完整 inventory 查询不到该 UUID 并返回 `cleanup_local_runtime`。
- Codespace 清空后删除该 owner scope 的 registration token。用户和组织 ID 都是正数，所有 owner 清理条件精确使用 `owner_id=目标 ID`；`owner_id=0` 的全局 Manager、地址和 registration token 由站点管理员管理并保持有效。绑定全局 Manager 的 Codespace 只有在创建用户或当前 repository owner 与目标匹配时删除，其他 Codespace 保持不变。
- 组织不作为 Codespace 创建用户；查询和最终空集合检查仍覆盖 `codespace.user_id=组织 ID`，用于清理历史或异常数据。组织删除只处理组织 repository、组织自有 Manager 及其 binding，不处理成员用户创建的无关 Codespace。
- 每个子事务提交并释放 Codespace lock 后，尽力清除 Runtime Metadata，并按 Gitea 当前 SSH 配置同步外部授权文件；每批最多保留 100 条待清理输入。Codespace Token 和 Git SSH Key 都按 `codespace_uuid` 在对应短事务中删除，分别绕开普通 PAT 与普通用户 Key 管理入口。未消费 Open Code 继续由现有 `code_hash` 缓存项和短 TTL 管理，交换时重新读取数据库并因记录不存在而拒绝。缓存或授权文件清理失败记录服务端日志，已提交的数据库删除继续有效；授权文件残留的旧 key ID 无法通过数据库鉴权。

普通 repository 删除仍使用上一节的弱关联规则。repository 此前已单独删除时，`repo_id=0` 已经表达来源关系结束；该 Codespace 之后只按创建用户和 Manager owner 关系参与账户清理。例如，由其他用户创建、绑定全局 Manager 且 `repo_id=0` 的 Codespace 与原 repository owner 已无关系，会继续保留。

Codespace 以创建用户、来源 repository 和绑定 Manager 三条现有关系判定用户或组织删除范围，不新增 owner 字段。账户删除直接清理 Gitea 资源，不生成需要等待领取的 Manager operation；仍有效的全局或其他 owner Manager 通过现有完整 inventory 对无记录 UUID 执行本地清理。正常向前运行的 Gitea 数据库记录不存在和 Manager 的 Incus 实例存在共同构成可重复计算的差异，因此无需新增清理任务或删除墓碑。

**设计选择：用户或组织删除采用有界、分阶段提交的 Gitea 本地清理。**删除成功表示 owner 记录已经删除，并且 repository、package、组织与 team 成员、Codespace、Manager 和 registration token 都不再以目标 ID 建立有效关系。任一数据库子步骤失败时返回错误，已经提交的子对象保持删除，owner 记录保留；用户 purge 已经禁用时继续保持禁用，重试从剩余关系继续。issue、comment、commit 等历史署名继续使用 Gitea 现有删除映射，因为这些记录不参与删除前置条件。这里保证的是删除判定关系完整闭环，而不是把历史署名改造成强外键关系。

Manager 在线状态和 Runtime 回收不参与 Gitea 账户删除结果。删除后，owner 自有 Manager 的身份记录失效，无法继续通过 inventory 取得清理指令，其运行资源由部署运维处理。全局或其他 owner Manager 身份继续有效：在单 Manager 不超过 10000 个 UUID 且 Incus 完整扫描成功时，operation RPC 会因记录不存在而停止，完整 inventory 在数据库成功确认无记录后返回 `cleanup_local_runtime`；Manager 先持久化本地 cleanup，再删除 Incus 实例、本地会话、凭据和快照，失败或重启后继续完成。两类结果都不能恢复开发凭据、cache 或 Codespace 记录。

### Manager 删除

Manager 删除是 Gitea 侧同步管理操作。个人 owner、组织管理员或站点管理员提交删除并确认影响范围后，服务取得对应 Codespace owner relation lock 和目标 Manager lock，然后执行有界的本地清理：

1. 按完整 UUID keyset 每批至多 100 条查询 `manager_id` 当前绑定的 Codespace。
2. 每次只取得一个 Codespace lock，在短事务中重新检查 Manager 记录和 `manager_id` binding，再删除该 Codespace 的 Gitea Token、Git SSH Key 关系及其 `PublicKey`、DBFS 日志元数据和数据库记录。
3. 提交并释放该 Codespace lock 后尽力清除相关 Runtime Metadata，然后继续下一条；未消费 Open Code 保留到原短 TTL，并在交换时因记录不存在而拒绝，metadata 清理失败只记录服务端日志。
4. 查询不到绑定 Codespace 后，用最终短事务再次确认集合为空并删除 Manager 的两类地址行、Manager 记录及其 secret verifier。
5. 提交最终事务，释放 Manager 和 Codespace owner relation lock。

删除服务需要串行化时直接调用 Gitea `globallock.Lock`。完整层级是按 `owner_id` 升序的 `codespace_owner_{owner_id}`、按 `repository_id` 升序的 `repo_working_{repo_id}`、按 `manager_id` 升序的 `codespace_manager_{manager_id}`、`codespace_{uuid}`。该层级只约束明确使用这些 Codespace 锁的路径，不扩展到 Gitea package 或成员服务。删除流程持续持有父级 Codespace owner/Manager lock，但同一时刻最多持有一个子级 Codespace lock。Fetch 持有 Manager 后按需取得 Codespace；`ReportInstances` 逐项取得 Codespace lock 并复检当前 inventory generation，单 Codespace command RPC 也只取得 Codespace lock，并在锁内事务中重新确认 Manager 记录、binding 和版本，因此不会形成 Codespace 反向等待 Manager 的锁环。每个子事务开始前取得对应 lock，提交后先释放子 lock，再尽力清理 cache；数据库记录已经不存在，后续请求取得 lock 后重新查询也不能重建资源。持锁期间不调用 Manager、Gateway 或其他网络服务。

Codespace 功能只支持单个活动 Gitea 进程。上述路径直接复用站点配置的 Gitea `globallock` backend，Gateway Open Code 和 Runtime Metadata 直接复用 Gitea cache adapter；配置 Redis 只沿用 Gitea 现有后端，不增加多实例协调或支持范围。固定锁序、锁内数据库重读和条件更新共同处理并发；cache 清理失败不改变数据库删除结果，也不需要增加 `deleting manager` 状态。

该流程不检查 online/offline/recovering，不创建 stop/delete operation，也不调用或等待 Manager。删除成功后，被删除的 Manager 身份调用 ManagerService 返回 `manager_unregistered`；对应 Manager 观察到该结果后关闭入口并强制停止 Incus 实例，但在此之前或永久失联时仍可能保留运行中的实例、实例根存储或本地快照，这属于用户确认时已经接受的运行侧结果，不影响 Gitea 删除成功。registration token 属于 owner scope，可供同一 owner 注册其他 Manager，因此单独删除一个 Manager 时保留 registration token；用户或组织删除时再按上一节删除整个 scope 的 token。数据库子步骤失败时，已经提交的 Codespace 保持删除，Manager 记录保留；相同删除请求重试剩余 binding，直到最终事务删除 Manager。

**设计选择：Manager 删除对调用方是同步完成的管理操作，但内部使用多个可重试短事务。**成功响应表示 Manager、Manager 地址行及其当时绑定的 Gitea 资源均不存在；失败响应可能已经清理部分子对象，但不会留下 `manager_id` 指向已删除 Manager 的记录。该语义用父记录充当自然的重试边界，在最多 10000 个 Runtime 的上限下避免一次持有全部 Codespace lock 或执行超大事务。

**设计理由：Manager 生命周期由注册身份、心跳状态、Fetch 调度意愿和删除操作共同表达。**临时停止领取新 create/resume 时，Manager 在 Fetch 中上报零容量或省略对应 operation 类型；永久撤销身份使用本节的直接删除。Manager 删除与用户或组织删除采用同一处理范围：Gitea 提交本地身份和资源清理后返回，不等待运行侧回收。这样删除结果不受 Manager 是否在线影响。

### 重命名

- 记录关联以 ID 为准。
- 名称每次展示时解析。
- create operation 返回数据使用当时的当前名称生成 clone/web URL；resume 基于已初始化 workspace，不重新生成 repository payload。
- 显示缓存和 runtime 动态数据按需从 cache 或 Manager 获取，每次展示时计算。

实现验收点：

- repository 数据库删除事务在删除 repository row 前只把匹配 Codespace 的 `repo_id` 写为 0；主状态、active operation、Token、Git SSH Key 和日志保持原值，提交并释放 lock 后执行既有文件 cleanup。
- `DeleteRepositoryDirectly` 收到已处于数据库事务中的 context 时拒绝执行；强制数据库回滚不会删除 repository 文件或清理 cache。
- `deleteRepositoryDBLocked` 只接受 repository service 内部的事务 context 并返回 cleanup plan，不自行提交事务或执行文件清理；组织 purge 在最终组织事务开始前完成逐仓库删除。
- repository 文件 cleanup 沿用各 Gitea 删除入口现有的提交后清理和错误返回语义；无论 caller 最终收到成功还是提交后的清理错误，已提交的 `repo_id=0` 和数据库删除都保持有效，同名 repository 创建继续使用现有 repository 服务语义。
- repository 删除与状态 final、operation 续租、日志元数据、自动暂停设置和 `last_active_unix` 更新分别按两种提交顺序并发执行，最终 `repo_id` 始终为 0，其他动作负责的字段也保留各自提交结果。
- `CreateCodespace` 记录插入事务与 repository 删除使用同一 repository lock，并只形成两种结果：记录先插入后由删除事务置 0，或者删除先提交后创建返回 repository 不存在。
- 已初始化 codespace 在 repository 或访问权限变化后仍可 open、SSH、resume、stop、delete 和读取日志。
- repository 删除后，本地上下文完整的 running create 可以继续并 final done；上下文缺失的 create 等待原 deadline 后 timeout 为 failed。
- 用户或组织删除在任何 owner repository 删除前，以每批至多 100 条、每个 Codespace 一个短事务的方式清理当时仍由三条关系关联的 Codespace、Codespace Token、Git SSH Key 和日志，并清理目标 owner 自有的 Manager、地址和 registration token。
- Fetch 与 Manager 身份删除通过同一 Manager lock 排序；账户清理绑定到外部或全局 Manager 的 Codespace 时只取得 Codespace lock，RPC 和删除事务分别复检当前记录，删除完成后不会留下指向已删除 owner 的 Codespace 关系。
- 已单独删除 repository 的 `repo_id=0` Codespace 不再跟随原 repository owner 删除；创建者和 Manager owner 关系仍正常生效。
- repository 数据库删除只持有 repository lock，并使用字段级 SQL 批量置 0；其他 Codespace 写路径保留各自字段，因此无需取得 Codespace lock。与创建记录并发时只产生插入先提交后被置 0，或 repository 删除先提交后插入拒绝两种结果。
- 普通 repository 创建、fork、template、migration、adopt、push-to-create、package 和成员写入不增加 Codespace owner relation lock，继续通过 Gitea 现有服务、purge 复扫和最终事务检查处理账户删除并发。
- repository 删除、`CreateCodespace` 主记录插入、重命名以及 transfer start/accept/reject/cancel 都使用同一 repository lock，并在锁内重读适用记录；普通创建、push 和设置修改不增加该锁。transfer 不修改已有 Codespace 状态或 binding，账户清理按已提交的当前 owner 关系复检范围。
- 用户/组织普通删除在清理 Codespace 前检查现有 repository、组织与 team 成员、package 和最后一个管理员等适用条件；最终事务沿用这些 Gitea 检查，并在 Codespace owner relation lock 内额外确认 Codespace、Manager 和 registration token 空集合。中途失败保留 owner 和未处理子对象，重试继续清理，已经提交的子对象保持删除。
- 用户 purge 先禁用账户，在第一条用户 repository 删除前提交 Codespace 前置清理；处理完 Gitea 现有 repository、组织成员和 package 后，重新取得用户 Codespace owner relation lock 并重复扫描再删除用户。
- 组织 purge 在第一条组织 repository 删除前提交 Codespace 前置清理；repository 按 ID 逐个使用短事务删除，最终重新取得组织 Codespace owner relation lock 并复扫后提交组织删除，再执行 `RepositoryCleanupPlan`。
- CreateCodespace、Manager 和 registration token 的关系写入口取得涉及 owner 的 `codespace_owner_{owner_id}` 并在事务内复读；删除成功后这些 Codespace 关系中没有目标 owner ID。repository、package、组织与 team 成员保持 Gitea 原有检查，历史 issue、comment 和 commit 署名按 Gitea 现有删除映射处理。
- 用户自助 Web、管理员 Web、管理员 API、`gitea admin user delete`、组织 Web、组织 API、inactive-user Cron 和 user purge 的 last-owner 组织删除都进入同一用户或组织删除服务，不在 router、CLI 或调用方复制清理事务。
- 用户或组织删除请求本身不创建 operation、不调用 Manager，也不等待或判断 Manager 状态；仍有效的 Manager 在后续完整 inventory 中按无记录差异取得 cleanup。
- 普通未绑定 delete 与 Fetch claim 竞争时，带 UUID、版本、binding 和 operation 条件的数据库写入只有一方成功；claim 成功则 delete 重新读取并创建绑定 Manager 的 delete operation，delete 成功则 claim 影响 0 行。claim 构造 payload 前再次确认当前 running operation，不返回已删除或已替换记录的旧 payload。
- 账户删除与 Fetch claim 竞争时，claim 先提交由账户清理直接删除最新 binding，删除先提交则 claim 影响 0 行；并发旧 RPC 不能重新写入已删除记录、开发凭据或 cache。
- 每个 Codespace 子事务提交并释放对应子 lock 后尽力清除相关 cache；仍有效的原 Manager 后续成功提交完整 inventory 时，无记录 UUID 触发运行侧完整清理。
- 全局或其他仍有效 Manager 收到 cleanup 后先持久化本地清理并等待旧 worker 退出；Incus 实例部分删除、进程重启和 Incus 实例已删除但快照仍存在都能继续完成。
- Manager 删除按 UUID keyset 分批、逐 Codespace 短事务同步清理 binding、Codespace Token、Git SSH Key 和日志，空集合复检后再删除 Manager 地址行与 Manager；不检查 Manager 状态，也不向 Manager 发送指令。
- 与删除并发的已认证 RPC 必须在同一 keyed lock 内重新检查记录和 binding，删除完成后不能重建 Gitea 资源。
- 需要多个 Codespace 锁的路径按 Codespace owner relation、repository、Manager、Codespace 的固定层级取得；Manager 地址唯一性使用数据库约束。Manager 删除保持 Codespace owner relation 和 Manager 父级 lock 并一次只取得一个 Codespace 子锁；账户清理外部或全局 Manager 绑定时只取得 Codespace lock，已进入该路径后不再向上取得 Manager lock。
- 每个删除阶段在数据库事务提交后先释放对应 `globallock`，再尽力执行 cache 或文件清理；后续请求通过锁内数据库重读拒绝，不因清理移出临界区而重建资源。
- 单独删除 Manager 时保留 owner scope registration token；用户或组织删除时删除该 scope 的全部 Manager 和 registration token。
- 用户或组织 ID 的清理条件精确匹配正数 owner ID；删除普通账户后 `owner_id=0` 的全局 Manager、地址和 registration token 仍存在，绑定该 Manager 的无关 Codespace 仍可正常工作。
- 用户或组织成功删除后，数据库不存在以目标为 owner 的 repository、package、组织与 team 成员、Codespace、Manager 或 registration token 关系，也不存在通过当前 repository owner 或 Manager owner 继续关联目标的 Codespace。
- 删除确认页展示将删除的 Manager、Codespace 数量，并区分两种运行侧结果：身份仍有效的全局或其他 owner Manager 将通过 inventory 自动清理，随 owner 删除而失效的 Manager 资源需要部署运维处理。
- 身份仍有效的 Manager 在协议资源上限内完成 Incus 全量扫描后自动清理；超限、永久失联和 Incus 无法枚举沿用部署运维处理边界。
