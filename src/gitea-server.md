# Gitea 服务端

## Web 路由与页面

Codespace 创建者只使用下列三类生命周期页面。站点管理员通过现有管理导航治理全部 Codespace 和 Manager，但不进入其他用户的对象详情页；个人用户在自己的设置页创建和管理个人 Manager 身份。组织只作为源仓库所有者存在，不拥有 Codespace 基础设施或成员工作区的治理权限。

### Repository Codespace 入口

```text
GET  /{owner}/{repo}/codespaces
GET  /{owner}/{repo}/codespaces/new
POST /{owner}/{repo}/codespaces
```

作用：

- 在 repository 代码页的 Code 面板中展示 Codespaces tab。
- 在 repository 代码页、Commit 页和开放的 Pull Request 页基于当前来源创建 Codespace。
- 展示当前用户在该 repository 下已有的 codespace，并提供进入对象页和用户 codespace 列表页的入口。

Repository 代码页的 Code 按钮展开后包含 Clone 和 Codespaces 两个等宽主 tab，两个 tab 共用固定的响应式面板宽度，因此切换时面板和 tab 位置保持稳定。主 tab 使用比 Clone 内部 HTTPS、SSH、Tea 协议 tab 更大的内边距和统一字重，表达“主视图”和“视图内选项”两级关系；两级 tab 始终预留激活下边框的空间，切换只改变颜色，不移动文字。Codespaces tab 使用当前页面的 ref 上下文，提供进入现有确认页的唯一创建按钮，并按更新时间展示当前用户在该 repository 下最近三个 Codespace。每行只展示 ref、状态和最近活动时间；运行中对象可以打开 Workspace，已停止对象可以恢复，其他状态进入对象详情查看当前进度或日志。底部入口进入当前用户的完整 Codespace 列表。

**设计如此：Code 面板是快速开始工作的入口，不是第二套管理页面。**固定宽度让 Clone URL、长 ref 和不同状态按钮不会改变弹层尺寸；只读取三个最近对象可以控制查询和面板高度。UUID、Manager、资源指标、环境配置、停止、删除和设置继续由完整列表或对象详情承载，创建所需的环境、Dev Container、权限和 Secret 仍在确认页集中复核。这样弹层提供创建、打开和恢复所需的最短路径，同时不会复制既有状态和管理逻辑。

Commit 页和开放的 Pull Request 页在既有标题操作区提供相同的 Codespaces 按钮。弹层只展示当前 commit 或当前 PR 已有的三个最近对象，以及进入统一确认页的创建按钮；运行、恢复和详情操作复用 Code 面板的同一模板。关闭、合并、来源分支缺失或已损坏的 Pull Request 不展示创建入口，因为它们不能形成可继续开发的来源分支。Commit 使用完整 SHA 创建固定快照；普通 Pull Request 使用来源仓库的来源分支创建可提交和推送的工作区；AGit Pull Request 没有独立来源分支，因此使用基仓库内部引用创建固定快照。

`GET /{owner}/{repo}/codespaces` 是 repository Codespace 集合路径的读侧归一化入口，重定向回 repository 代码页。**设计如此：**创建入口需要 repository/ref 上下文，而代码页、Commit 页和 Pull Request 页已经具有该上下文；列表入口按用户维度放在 `/-/codespaces`，对象详情按 UUID 放在 `/-/codespaces/{codespace_id}`。这样用户能从具体开发对象进入创建，从用户列表管理已有对象，不会误以为 Codespace 的身份路径包含 repository。对象身份仍只使用 UUID。

Code 面板使用 GET 表单把当前 git ref 带到 `GET /{owner}/{repo}/codespaces/new`。这个确认入口只读取仓库并生成创建计划，页面切换 Dev Container 候选时继续使用 GET 重新生成计划，因此预览不会创建 Codespace、授权或 Secret 关系。用户确认后，页面中的唯一主表单提交到 `POST /{owner}/{repo}/codespaces`；服务端重新解析并锁定 `commit_sha`、配置路径与摘要，客户端不能指定最终 commit 或覆盖路由 repository。

确认页按照仓库与 ref、开发环境、附加仓库权限、Codespace Secret 的顺序展示创建条件。开发环境使用纵向标准表单依次展示运行环境 tag 和 Dev Container 配置：两个字段采用相同宽度与“标签、控件、必要补充信息”顺序，配置只有一个候选时也使用同一种下拉控件。下拉关闭状态只显示 tag 或配置名称；运行环境候选在菜单中显示部署者提供的说明、来源和在线状态，选中离线环境后显示排队说明；Dev Container 文件路径显示在控件下方。运行环境由部署者映射到实例类型、镜像、资源和网络，Dev Container 由仓库定义容器内的开发环境。**设计如此：**环境说明用于帮助用户区分用途不同的 tag，应当出现在做出选择的下拉菜单中；选中后不再重复展示，避免持续占用表单空间。

页面使用一个表单承载最终选择和一个创建按钮，因为这些输入共同组成同一次创建决定；预览刷新只携带 ref、环境 tag 与 Dev Container 选择，不把权限或 Secret 放入 URL。**设计如此：**运行环境和 Dev Container 是创建所需的核心输入，直接展示可以让用户在提交前连续查看完整条件。两者的说明长度和状态信息不同，纵向排列可以按内容自然扩展而不制造控件错位；弹窗适合二次确认或独立编辑，在这里会增加一次进入和确认操作，并使 Dev Container 切换后的计划刷新难以保持上下文。

创建输入：

| 参数 | 说明 |
| --- | --- |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | branch → 分支名；tag → 标签名；commit → 完整 commit SHA；pull → 十进制 PR 编号 |
| `environment_tag` | 创建确认页中显式选择的运行环境；首次打开确认页时为空 |

`owner` 使用 Gitea repository 路由的 owner 语义，可以是用户或组织。`repo_id` 来自 `/{owner}/{repo}` 路由解析结果。Pull Request 页面与确认表单使用易于理解的十进制编号，Gitea 校验 PR 开放状态、基仓库、来源仓库、来源分支和代码读取权限后，在数据库中保存规范 `refs/pull/{index}/head` 与完整 commit SHA。其他类型解析对应 ref 并保存完整 commit SHA；客户端不能指定最终 commit 或覆盖路由 repository。

路径使用复数 `codespaces`，因为 POST 向 repository 下的 Codespace 集合创建对象；集合 GET 重定向到代码页，使 repository 维度的读入口统一回到包含 Code 面板的页面。`codespaces/new` 是创建前的只读确认入口，明确区分“查看当前计划”和“提交创建”。

确认页按 tag 合并可见 Manager 的声明，并显示说明、来源与当前在线提示。来源分为站点、个人以及二者同时提供；相同 tag 只有一个非空说明时展示该说明，多个不同的非空说明只展示 tag，并在 Manager 详情中提示配置不一致。在线状态只帮助用户判断等待可能性，不决定 tag 是否可选，因为暂时离线的 Manager 恢复后仍可以领取已排队的 create。即使只有一个选项也要求用户显式选择，避免用户在不知情时使用部署者新增的基础设施环境。

仓库权限按仓库分组。普通 fork Pull Request 的来源仓库 Code 写能力是该工作区能够推送来源分支所需的固定上限，确认页说明用途但不提供降级选项；Gitea 的当前用户权限和分支保护仍决定具体 Git 操作能否执行，因此该授权不会扩大用户已有权限。Dev Container 申请的其他仓库单元继续使用无权限、读取或写入单选项表达本次授权。

Codespace Secret 区域始终展示当前计划：有代码写权限且来源可信时，列出所有仓库范围或已指定当前仓库的 Secret 名称，并单独提供尚未满足的 Dev Container 推荐项；页面不读取或回显已有值。普通 fork Pull Request 的仓库配置来自贡献者可控制的分支，因此创建计划不提供用户 Secret，也不接受推荐项的值或范围更新。其他没有代码写权限的来源同样不提供 Secret。确认页是提交时刻的说明，不是持久授权；create 和 resume 取得运行材料时仍按当前用户权限、仓库关系和 Secret 范围重新计算。**设计如此：**用户能在创建前知道哪些名称将进入环境，同时权限撤销、范围修改或恢复运行不会继续使用过期的页面结论。

创建校验失败时页面可以保留环境与可选权限选择，但不回显 Secret 明文。没有可见环境时页面明确说明基础设施尚不可用并提供返回仓库的操作，而不是展示一个无法提交的表单。

最终提交在现有用户锁、repository lock 和数据库事务内重新读取可见环境。tag 已消失、格式无效或不属于站点及当前用户声明时，页面重新展示当前选项且不创建 Codespace 或 operation。tag 不进入 `request_hash`：该哈希只锁定会影响 Dev Container 权限和推荐 Secret 复核的仓库内容，环境 tag 是最终表单中的直接输入并由服务端重新校验，加入哈希只会制造一次没有安全收益的额外复核。

**设计理由：创建入口位于已有来源上下文旁。**代码页适合从分支或标签开始，Commit 页适合固定快照，Pull Request 页适合继续处理来源分支；三处都进入同一个确认页和创建事务，不形成专属创建流程。`GET /-/codespaces` 用于展示当前用户已有对象，顶部导航中的 Codespaces 入口直接进入该列表。环境选择位于创建确认页，是因为该页已经集中展示 Dev Container、仓库权限和 Secret，用户可以在一次提交前确认完整运行条件。

实现验收点：

- 创建确认页只聚合成功 Declare 的站点全局 Manager 和当前用户个人 Manager 环境，相同 tag 合并为一个选项并正确显示来源。
- 环境说明一致或只有一个非空值时展示说明；多个不同非空说明时创建仍可进行，Manager 详情提示冲突。
- 用户必须显式选择环境；没有可见环境、提交非法环境或提交期间环境消失时不写入 Codespace 和 operation。
- `request_hash` 不包含环境 tag；最终提交在锁和事务内重新校验 tag，并把规范值写入 `environment_tag`。
- Code 面板通过 GET 打开只读确认页；切换 Dev Container 只重新生成计划，只有最终 POST 可以写入 Codespace、授权和 Secret 关系。
- Commit 和开放、来源完整的 Pull Request 页面复用同一 Codespaces 弹层；查询只返回当前完整 SHA 或当前规范 PR ref 的对象，页面输入的 PR 编号不会回显为内部 ref。
- 普通 fork Pull Request 的来源仓库 Code 写能力固定进入创建授权，表单不能降低；最终访问仍取授权上限、用户当前权限和 Gitea 业务规则的最低结果。同仓库 PR 与 AGit 不生成重复的附加规则。
- Code 面板的 Clone 与 Codespaces tab 使用相同响应式宽度和等宽主 tab，主 tab 的尺寸和字重与内部协议 tab 形成明确层级；点击或使用左右方向键切换时，文字位置、可见内容、焦点顺序和 `aria-selected` 保持一致。
- Codespaces tab 最多读取并展示当前 repository 最近三个对象，显示当前 ref、唯一创建按钮以及每个对象当前可用的 Open、Resume 或 Details 操作；完整管理仍进入列表或对象详情。
- 确认页只有一个最终创建表单；运行环境和 Dev Container 在开发环境区域纵向展示并使用相同宽度和控件结构，单候选配置不切换为另一种摘要样式；Secret 区域列出当前可用名称与未满足的推荐项，错误响应不回显 Secret 值。
- 普通 fork Pull Request 与没有代码写权限的来源明确显示不提供用户 Secret，最终提交也不写入推荐 Secret 值或仓库范围；create 和 resume 继续按实时权限与范围重新解析。
- 没有可见环境时确认页显示不可用原因和返回操作，不显示可提交的创建按钮；离线环境仍可选择并明确说明创建会排队等待。

### 用户 Codespace 列表页

```text
GET /-/codespaces
```

该页面只展示当前用户创建的 codespace。

**设计理由：全局页面使用 Gitea 的 `/-/` 功能前缀。**Gitea 的用户、组织和 repository 都使用根路径名称，合法账户也可以使用 `codespaces`。把产品页面放在 `/-/codespaces` 可以保留稳定对象地址，同时不遮蔽任何账户或 repository。路由和链接统一通过 `AppSubURL` 构造实际地址，使子路径部署得到相同行为。

展示字段：

- repo
- ref
- status
- last active
- 状态摘要
- 当前状态允许的打开、SSH、继续运行、停止、恢复和删除操作

列表页不读取日志文件。每一行都使用服务端返回的展示态和操作集合，点击对象名称进入创建者自己的详情页。

### 单个 Codespace 页

```text
GET    /-/codespaces/{codespace_id}
GET    /-/codespaces/{codespace_id}/state
GET    /-/codespaces/{codespace_id}/logs
POST   /-/codespaces/{codespace_id}/open
POST   /-/codespaces/{codespace_id}/open/{endpoint_id}
POST   /-/codespaces/{codespace_id}/resume
POST   /-/codespaces/{codespace_id}/stop
POST   /-/codespaces/{codespace_id}/continue
POST   /-/codespaces/{codespace_id}/auto-stop
POST   /-/codespaces/{codespace_id}/delete
```

`GET /-/codespaces/{codespace_id}` 是唯一对象页面。

`GET /-/codespaces/{codespace_id}/state` 返回创建者详情页的当前状态 HTML 片段，`GET /-/codespaces/{codespace_id}/logs` 返回日志数据。两者属于创建者 Web 页面的内部数据接口；本设计的用户交互采用服务端 Web 页面，不定义版本化 Codespace REST API。

创建者对象路由按当前登录用户和 `codespace.user_id` 同时校验访问者。对象不存在或对象属于其他用户时，详情、状态、日志、日志下载、打开入口、生命周期操作和自动暂停设置统一返回 404。**设计如此：**UUID 会出现在用户自己的链接和 Gateway 主机名中，但它不应成为查询其他用户工作区是否存在的依据；站点管理员对其他用户对象的治理使用独立管理路由和治理数据结构，因此无需让创建者路由通过 403 暴露对象存在性。

详情页使用 repository 名称作为对象标题，状态紧邻标题，ref、可跳转的短 commit 和创建时间作为次要信息。UUID 继续作为路由和服务端对象标识，但不占用创建者页面的主要信息区域，因为创建者定位工作区时使用 repository 和 ref 更直接。普通运行状态不重复展示状态说明；停止、恢复、失败等需要用户理解当前阶段的状态在次要信息下展示摘要和启动阶段。当前可用操作位于同一全宽页头，长 repository、ref 和操作按钮可以分别换行，避免窄栏挤压。

详情页提供 Overview 和 Logs 两个页签。`queued`、`booting`、`resuming`、`stopping`、`deleting` 和 `failed` 默认打开 Logs，便于用户直接观察当前生命周期操作；`running`、`stopped`、`recovering` 和 `metadata_rebuilding` 默认打开 Overview，便于用户访问工作区或判断当前可恢复状态。用户显式选择页签后，状态刷新保持该选择；使用默认页签且状态跨越上述两类布局时，浏览器完整刷新一次并进入新状态的默认页签。**设计如此：**生命周期过程和稳定使用阶段的首要任务不同，采用同一路径上的两个页签可以保持对象地址稳定，同时避免把日志、入口、资源和内部标识全部挤进同一屏。

Overview 使用弹性连接区域和固定 320 像素的运行上下文区域，低于 992 像素时改为单列。连接尚未就绪时，连接区域显示与当前状态一致的 Access 占位，仍保留相同的两列结构；运行上下文先展示稳定的 Details，再展示可能暂时缺失的 CPU、内存和磁盘用量。**设计如此：**连接入口和瞬时指标会随 Runtime Metadata 变化，repository、ref、环境和自动暂停策略是用户判断对象身份所需的稳定信息；固定主次结构可以避免停止、恢复和缓存重建时页面突然改变宽度或信息顺序。

Workspace 是页头唯一的主要打开操作，因此在 Overview 和 Logs 中位置一致。页头操作按用途分层：Open Workspace 和 Resume 使用带文字的主要按钮；自动暂停已经排队时使用 Keep running 表达取消本次自动停止；Stop 参考 Actions 的 Cancel，使用带文字的紧凑中断按钮；Auto-stop 设置和 Delete 收纳在一个标准更多菜单中，Delete 保留红色文字、垃圾桶图标和确认弹窗。设置只在当前状态允许修改 Auto-stop 时出现。**设计如此：**打开或恢复是主要工作流，Keep running 和 Stop 是当前状态下需要直接发现的操作，设置和删除属于低频对象管理；更多菜单能保持页头紧凑，同时菜单中的文字比孤立图标更明确。额外连接方式按用途分为 SSH 和 Ports 两个独立章节：SSH 使用完整宽度的命令复制控件，主机密钥算法、SHA256 指纹和更新时间收纳在可展开的校验信息中；Ports 按 Service、Port、Visibility 和打开操作分列，操作列表头只提供无障碍名称，移动端把名称与操作放在第一行、端口与访问范围放在第二行。

Overview 和 Logs 共用相同的页面、容器、页头和页签布局。桌面端始终保留稳定的页面滚动槽，页头和页签保持固定的收缩规则；两种模式只替换页签下方的内容。Logs 使用剩余高度和控制台内部滚动，Overview 按内容自然延伸。**设计如此：**页签切换只代表内容视角变化，共用页面外壳可以保持标题、状态、操作和页签的位置稳定，也让浏览器在完整页面导航后使用相同的滚动与页脚几何关系。

Logs 使用全宽控制台。日志面板在桌面、中间宽度和移动端都占满内容列，窄屏仍保持标题与更多菜单在同一行；进入全屏后面板移动到全局高度容器并继续填满宽高，正文使用页头之外的剩余空间。更多菜单使用与 Actions 控制台一致的背景、边框、指向箭头和菜单项状态，时间戳勾选位保持固定宽度。**设计如此：**菜单属于深色控制台的一部分，需要使用同一组控制台颜色；面板移动到全屏容器后不再具有详情页祖先，独立的全屏尺寸规则才能保证宽度变化和 DOM 位置变化不会破坏日志布局。页面进入 Logs 后立即从 `offset=0` 请求已有日志，再按服务端返回的 byte offset 增量轮询。生命周期状态同时展示 Runtime Metadata 中与当前 operation 版本一致的启动阶段，阶段直接表达准备 Runtime、初始化系统、准备 workspace、启动开发环境、发布访问入口和完成启动。Manager 在 bootstrap、镜像构建、Feature 安装和 lifecycle 命令执行期间同时读取 stdout 和 stderr，并把完整正文行通过 `UpdateLog` 有界批量上报；页面正文保持 Manager 上报的原始内容。

Manager 使用 Actions 已有的 `##[group]`、`##[endgroup]` 和 `##[error]` 控制行标记 operation、运行时访问准备、系统与 workspace 初始化、Dev Container 启动和 Endpoint 发布。Gitea 复用 Actions 的命令解析与 ANSI 安全渲染：正在执行和包含错误的分组展开，成功结束的历史分组折叠，原始正文完整保留。分组控制行仍是 protobuf `LogLine.message`，不新增日志枚举、数据库字段或另一套传输协议。**设计如此：**日志分组属于展示语义，Actions 已经提供稳定约定；复用同一格式可以减少协议和前端重复，同时让下载日志仍保留可读的阶段边界。

日志轮询按结果分类处理：offset 冲突清空当前渲染并从零读取一次；权限丢失、对象不存在或重复冲突停止轮询并显示本地化错误；网络错误和服务端临时错误保留已有内容并退避重试。镜像拉取使用开始、完成和低频聚合进度表达当前状态。这样刷新、重试和下载继续使用同一份 DBFS 日志，同时避免永久加载和重复节点。

**设计理由：repository 路径只是创建上下文和来源筛选，不是既有 Codespace 的身份路径。**创建成功后，对象的规范地址只包含 `codespace.uuid`。这样 repository 删除、改名、转移或变得不可访问时，既有 Codespace 的详情和生命周期操作仍保持稳定，也与 create 完成后不再依赖 repository 的状态模型一致。

路由行为：

- `POST /{owner}/{repo}/codespaces` 成功后重定向到 `GET /-/codespaces/{codespace_id}`。
- `POST /-/codespaces/{codespace_id}/open` 始终选择默认 `workspace`；`POST /-/codespaces/{codespace_id}/open/{endpoint_id}` 选择明确的普通 Endpoint，并拒绝保留值 `workspace`。默认路由不接收可选 `endpoint_id` 字段，避免缺失值和空值产生两套默认语义。
- 创建者在列表或详情页点击入口时，页面使用一个复用弹窗显示入口名称和访问类型；确认表单使用现有 CSRF 防护并 POST 到上述路由。需要认证的入口签发 code；无 active operation 的公共 Endpoint 直接 303 到服务端当前推导的公共 URL，不签发 code，也不记录用户交互。queued idle stop 期间公共入口显示但不可打开，创建者先使用“继续运行”。
- Gateway 在需要认证的入口缺少本地 session 时跳转到 `GET /-/codespaces/{codespace_id}?open_endpoint={endpoint_id}`。Gitea 完成登录并重新读取创建者详情数据，目标仍存在且可打开时自动显示同一弹窗；确认后在当前标签页 POST，使 Gateway 保存的原 path/query 能在 code 交换后恢复。目标已经不可用时详情页显示当前状态提示，不签发 code。修改请求和 WebSocket 不经过该恢复流程。
- Codespace 页面、状态、日志和打开路由沿用 Gitea Web 的同源访问与现有 Session/CSRF 校验，不新增 CORS 允许头。Gateway 与 Gitea 之间的浏览器切换只使用顶层 303 导航；Endpoint 页面不能跨源读取这些 Web 响应或借 Gitea Session 调用 ManagerService。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /-/codespaces/{codespace_id}`。
- `POST /-/codespaces/{codespace_id}/continue` 表示用户仍在使用当前运行实例：服务在 Codespace lock 内推进交互版本，并取消尚未领取的自动 stop；没有 queued idle stop 时仍可成功，用于重置 Manager 的下一轮空闲计时。
- `POST /-/codespaces/{codespace_id}/auto-stop` 在 `running` 或 `stopped` 保存 `default|custom|never`。Web 表单在 `custom` 模式提交正整数 `timeout_value` 和 `seconds|minutes|hours|days` 单位，Router 完成溢出检查并精确换算成秒，服务再按站点范围校验；`default` 和 `never` 不使用时间字段，并清零对象自定义秒数。规范化后的持久值未变化时幂等成功；解析后的启用状态或有效超时变化时取消尚未领取的自动 stop。模式变化但实际运行值相同时只保存用户选择，当前计时和 queued idle stop 保持有效。已经领取的 stop 继续完成，新设置保留到普通 resume 后生效。
- delete 后返回经过校验的显式 `return_to`；服务端把它解析为 URL relative-reference，只接受 scheme 和 host 均为空、规范化 path 以单个 `/` 开头的站内地址。若没有，则 repository 仍可解析且当前用户可见时回到 repository 代码页，否则回到 `/-/codespaces`。
- delete 时 `manager_id=0` 表示没有已绑定的 Incus 实例。服务在 Codespace lock 内按 UUID、版本、`manager_id=0`、主状态和预读到的全部 operation 字段物理删除主记录，再在同一事务中删除 Token、Git SSH Key 和日志；这同时覆盖 queued create 和没有 active operation 的 failed 记录。若 Fetch 已先完成 claim，queued create 的条件删除影响 0 行，服务重新读取后按 `manager_id!=0` 路径写入绑定 Manager 的 delete operation。进入 `deleting` 的事务同时物理删除两类开发凭据。

**设计理由：协议幂等以同一 `operation_rversion` 为单位。**每次被服务端接受的新 create POST 创建一个新 Codespace；生命周期 POST 按到达时的主状态和 active operation 返回成功、冲突或不存在。系统只保存当前资源与 operation，不保存 HTTP 请求键或删除墓碑，因此响应丢失后的重复 create 可能代表新的创建，物理删除后的重复 delete 返回不存在。这个范围让实现人员能够区分 operation 重试与两个独立的 Web 请求。

创建者详情布局和操作：

| 展示态 | 可提交操作 | 页面表现 |
| --- | --- | --- |
| `queued` / `booting` | delete | 展示创建日志和进度；创建操作显示为禁用的进度按钮 |
| `running`，无 active operation | open、SSH、stop、delete、configure auto-stop | 展示 Workspace、普通 Endpoint、SSH 信息和自动暂停设置 |
| `running`，queued idle stop | open、SSH、continue、stop、delete、configure auto-stop | 保持运行中展示；成功交互取消尚未领取的自动停止 |
| `stopping` | delete、configure auto-stop | 停止按钮禁用并显示“正在停止”；关闭连接类入口 |
| `stopped`，无 active operation | resume、delete、configure auto-stop | 展示恢复入口和自动暂停设置 |
| `resuming` | delete、configure auto-stop | 恢复按钮禁用并显示“正在恢复” |
| `deleting` | 无 | 删除按钮禁用并显示“正在删除” |
| `failed` | delete | 展示日志和明确失败摘要 |
| `metadata_rebuilding` | stop、delete、configure auto-stop | 暂时禁用 Workspace、普通 Endpoint 和 SSH |
| `recovering`，主状态为 running | stop、delete、configure auto-stop | 暂时禁用 Workspace、普通 Endpoint、SSH 和继续运行 |
| Manager offline，主状态为 stopped | delete、configure auto-stop | 恢复按钮禁用并说明 Manager 暂时不可用 |

自动暂停是创建者对自己 Codespace 的运行策略。设置只写入 Gitea，因此在 stop/resume 进行中或 Manager 暂时不可用时仍可保存；Manager 恢复并取得当前设置后应用。创建者列表的更多菜单和详情页的设置按钮打开同一个 Auto-stop 弹窗，保存后分别返回发起操作的列表页或详情页；该来源只使用固定的 `list|detail` 值，不接受浏览器提交任意返回地址。弹窗位于实时状态片段之外，状态轮询只在弹窗打开期间同步当前是否可提交，不覆盖用户正在编辑的模式、数值和单位。非创建者治理摘要不显示设置值，也不提供修改入口。

页面按以下规则处理操作按钮：

- 当前身份无权执行的操作不显示；不适用于当前稳定状态的操作也不显示。
- 用户提交操作后，页面立即禁用会与该操作冲突的按钮。服务端确认 active operation 后，页面根据展示态保留对应的禁用进度按钮；delete 仍按状态机规则保持可用，可以接管 create、stop 或 resume。
- 页面禁用只用于防止重复点击。每个 POST 在 Codespace lock 内重新校验身份、主状态和 active operation；冲突返回 `409 Conflict` 及当前展示态，页面据此刷新，不把浏览器中的旧操作集当作授权依据。
- 完整详情页和 `GET /-/codespaces/{codespace_id}/state` 调用同一个创建者详情服务并渲染同一个状态模板片段。状态响应使用 `Content-Type: text/html` 和 `Cache-Control: no-store`，根节点固定为 `id=codespace-live-state`，并通过 `data-refresh-after-ms` 声明下一次刷新间隔：过渡状态为 2 秒，稳定状态为 15 秒。页面不可见时暂停计时，重新可见后立即刷新；同一页面同一时刻只保留一个状态请求，因此晚到响应不会覆盖更新结果。
- 状态片段包含页头、操作、状态摘要、页签和 Overview 内容。使用默认页签时，片段中的默认展示模式发生变化会触发一次完整页面刷新；URL 中已有合法 `tab=overview|logs` 时保持用户选择。这样状态变化可以重组完整页面，同时日志控制台和设置弹窗不会被周期刷新误删。
- 状态刷新失败时保留当前页面，不自行判定 operation 失败，并逐步退避到最长 30 秒。成功响应中没有规范状态片段，或者对象、登录状态和权限已经变化时，浏览器执行完整页面跳转，由现有登录页、对象页或 404 页面给出结果。该接口只读取当前服务端状态，不推进生命周期版本。

Manager 在状态切换期间离线时，Gitea 保持已登记 operation 和原有截止时间。页面继续显示当前过渡状态，并明确说明正在等待 Manager；Manager 恢复后按现有 Fetch 和续租流程继续，截止时间到达后按[超时处理](state-machine.md#超时处理)进入唯一结果。稳定 `running` 或 `stopped` 对象不会仅因 Manager 离线改变主状态：连接类操作和 resume 暂时禁用，stop 与 delete 仍可提交并等待 Manager 领取。这样短暂故障不会被误报为 Codespace 失败，永久故障又会由 operation 超时、普通重试和站点管理员强制删除得到明确结果。

**设计理由：页面区分权限不足、状态不适用和基础设施暂时不可用。**权限不足的操作不应暴露，已经提交的状态切换需要保留可见进度，Manager 离线则需要告诉用户持久状态没有被改写。服务端始终负责最终校验，使多标签页、重复点击和 Manager 状态变化不会绕过生命周期规则。

实现验收点：

- 用户 repository 和组织 repository 都通过代码页 Code 面板展示当前用户在该 repository 下的对象；Commit 和开放 Pull Request 页面按当前来源精确展示对象。所有创建入口使用 `GET /{owner}/{repo}/codespaces/new` 生成确认计划，最终创建使用 `POST /{owner}/{repo}/codespaces`，并由服务端解析 repository、ref 和 commit。
- `GET /{owner}/{repo}/codespaces` 重定向到 repository 代码页。设计如此是因为仓库入口属于 Code 面板的一部分，不是对象身份路径。
- 所有 Codespace Web 集合与对象路由使用复数 `codespaces`；创建成功后的规范地址不包含 repository 路径。
- `/-/codespaces` 使用 Gitea 功能前缀；名为 `codespaces` 的用户、组织和 repository 继续使用原有通用路由。
- repository 删除、改名、转移或权限丢失后，已有对象仍通过 `/-/codespaces/{codespace_id}` 执行详情、日志和允许的生命周期操作。
- 代码页、Commit 页和开放 Pull Request 页只提供进入同一确认页的链接，确认页提交到同一 repository 的 Codespace 集合；全局页面只负责列表和对象详情。
- 顶部导航在 Codespace 启用且用户已登录时显示 Codespaces，进入 `/-/codespaces`。
- 生命周期态默认进入 Logs 并从 `offset=0` 读取同一份日志；稳定态默认进入 Overview。用户显式选择 Overview 或 Logs 后，状态轮询保持该选择；使用默认页签且状态跨越布局类型时只完整刷新一次。
- 详情页以 repository、ref 和可跳转的短 commit 标识工作区，UUID 只用于内部路由和对象身份。Workspace 使用页头唯一的主要打开操作，运行中 Overview 分别展示 SSH 和 Ports；其他状态展示仍然有效的运行上下文。
- 当前允许的 Keep running 和 Stop 在页头直接显示并使用带文字的紧凑按钮；Auto-stop 设置与 Delete 位于同一个标准更多菜单，Delete 使用红色文字和图标并保留确认弹窗。Ports 的图标操作列宽度稳定，列表头只提供无障碍名称。
- Overview 在桌面端始终使用弹性连接主列和 320 像素上下文列；连接不可用时主列显示 Access 占位而不是移除主列。上下文先展示 Details，再展示存在的 Runtime usage；低于 992 像素时按相同顺序变为单列。
- Overview 和 Logs 使用相同的页面祖先布局、页头高度、页签高度、底部间距和页面滚动槽；切换页签时标题、状态摘要、操作区和页签位置保持一致。
- 日志面板在桌面、中间宽度、移动端和全屏状态均占满可用宽度；窄屏页头保持标题与菜单同一行，全屏正文使用菜单页头之外的剩余高度。更多菜单的背景、边框、指向箭头、悬停状态和固定勾选位与 Actions 控制台一致。
- booting 和 resuming 在 Runtime Metadata 的 operation 版本与当前操作一致时显示明确启动阶段；缺少匹配阶段时只展示状态摘要，不推测进度或百分比。
- [x] Manager 为 operation 和主要启动阶段写入 Actions 格式分组，失败使用错误控制行；Gitea 复用 Actions 解析和 ANSI 渲染，当前与失败分组展开、成功历史分组折叠。
- [x] 日志 offset 冲突只从零重载一次，403、404 和重复冲突停止轮询并展示错误，网络与 5xx 错误保留已有内容并退避。
- 初次详情渲染与状态片段刷新使用同一个创建者详情服务、权限检查和操作集合；需要版本标识的协议范围固定为 ManagerService 和 Runtime 本地 manifest，状态片段按 Web 路由维护。
- 状态片段响应禁止缓存，包含固定根节点和服务端给出的下一次刷新毫秒数；对象不存在和非创建者访问在全部创建者对象路由统一返回 404。
- 过渡状态按 2 秒、稳定状态按 15 秒刷新，页面隐藏时停止请求；失败保留当前展示并最多退避到 30 秒，不把网络错误写成 operation 结果。
- create、continue、resume 和 stop 回到唯一 Codespace 对象页；Auto-stop 根据固定的 `list|detail` 来源回到发起页；delete 使用经过站内地址校验的明确 `return_to`。open 成功后进入 Gateway，失败回到对象页并显示当前状态提示。
- 外部 URL、scheme-relative URL 和其他非站内相对值不能作为 `return_to`。
- 站点和用户设置中的 Codespace 管理入口统一使用复数 `codespaces`；组织设置不提供 Codespace 管理入口。
- `manager_id=0` 的 delete 不创建无法领取的 operation。
- 未绑定 delete 与 Fetch create claim 并发时由数据库条件写入确定先后；删除事务的主记录、Token、Git SSH Key 和日志共同提交或共同回滚，claim 成功后 delete 转入绑定删除，delete 成功后 claim 影响 0 行。
- 创建者对象路由不接受 force delete；站点管理员只通过 Manager 管理页或异常区域中的独立强制删除路由执行本地清理。
- running 且存在 queued user stop、已经领取的 stop 或 delete operation 时，页面禁用 Endpoint 和 SSH；queued idle stop 保持可交互并由成功交互事务取消。
- 只有创建者可以为自己的 Codespace 设置站点默认、自定义超时或永不自动暂停；`never` 只关闭空闲自动暂停，不改变手动 stop/delete、排空、failed 和账户管理动作。
- 自定义自动暂停表单提交正整数数值和秒、分钟、小时或天，Router 精确换算成秒并由服务校验站点范围；站点默认和永不自动暂停不提交无效的从属时间。
- queued idle stop 可由“继续运行”、有效 open/SSH 或设置变更取消；Manager 已领取 stop 后页面稳定展示 stopping，完成后使用现有 resume。
- 默认 open 和显式 Endpoint 都要求 Runtime Metadata ready 且存在对应记录；默认 open 只接受属性固定的私有 `workspace`，显式路由拒绝保留值并只打开当前 metadata 中存在的普通 Endpoint。
- 打开弹窗本身不产生副作用，POST 才为需要认证的入口签发 code；公共 Endpoint 的 POST 不签发 code。两类路径都使用服务端当前 Manager 地址和 metadata，不接受浏览器提交目标 URL。
- stop/resume/create/delete 进行中时，对应进度按钮保持可见并禁用；服务端仍拒绝冲突 POST，`409 Conflict` 会使页面刷新到当前展示态。
- Manager 在 operation 进行中离线不会延长截止时间或改写主状态；页面持续展示等待状态，超时后显示状态机确定的结果。稳定对象只禁用依赖 Manager 的连接和恢复入口，stop/delete 仍可提交。
- 同一 operation 版本在 Manager 执行和 final 层幂等；Web create/delete 不声称无法由当前数据证明的跨请求网络幂等，且不增加请求历史或删除墓碑。

设置管理入口：

```text
GET      /-/admin/codespaces/managers
POST     /-/admin/codespaces/managers/create
GET      /-/admin/codespaces/managers/{manager_id}
POST     /-/admin/codespaces/managers/{manager_id}/delete
POST     /-/admin/codespaces/managers/{manager_id}/codespaces/{uuid}/stop
POST     /-/admin/codespaces/managers/{manager_id}/codespaces/{uuid}/delete
POST     /-/admin/codespaces/managers/{manager_id}/codespaces/{uuid}/force-delete
POST     /-/admin/codespaces/managers/unassigned/{uuid}/stop
POST     /-/admin/codespaces/managers/unassigned/{uuid}/delete
POST     /-/admin/codespaces/managers/unassigned/{uuid}/force-delete
GET      /user/settings/codespaces/managers
POST     /user/settings/codespaces/managers/create
GET      /user/settings/codespaces/managers/{manager_id}
POST     /user/settings/codespaces/managers/{manager_id}/delete
GET/POST /user/settings/codespaces/secrets
GET      /user/settings/codespaces/secrets/repositories
POST     /user/settings/codespaces/secrets/{secret_id}/value
POST     /user/settings/codespaces/secrets/{secret_id}/access
POST     /user/settings/codespaces/secrets/{secret_id}/delete
```

站点管理只提供 Codespace Managers 入口：列表创建站点全局 Manager 身份并概览全部全局和个人 Manager，单项管理页展示当前声明和绑定 Codespace。已绑定 Codespace 按 Manager 分页治理，尚未分配 Manager 或引用已不存在 Manager 的记录在 Manager 列表页的异常区域治理。用户设置中的 Managers 子页创建和管理当前用户的个人 Manager，Secrets 子页管理该用户的 Codespace Secret；用户自己的 Codespace 仍使用顶部 `/-/codespaces` 工作区入口。

Codespace 的开发工具由仓库选中的 `devcontainer.json` 声明，Gitea 固定配置路径、提交和原始文件摘要，Manager 从锁定 workspace 解析标准 Feature。平台 Web IDE 由 Manager 使用固定的 code-server Feature 提供，不形成用户设置项。**设计如此：**仓库 Feature 随提交接受审阅并可通过锁文件固定，平台 Feature 随 Manager 发布和部署配置管理；两类输入都有明确所有者，同一仓库提交不会再因 Gitea 用户偏好产生隐式差异。

Secrets 子页使用一个列表展示名称、范围摘要和更新时间。新增弹窗一次保存名称、值和初始访问范围；值替换和访问范围分别使用独立弹窗，删除使用标准确认。访问范围可以选择“所有仓库”，也可以选择零个或多个指定仓库。所有仓库表示该用户当前和以后仍有代码写权限的仓库；指定仓库为空表示先保存 Secret，暂不提供给任何仓库。仓库搜索只返回当前个人用户具有代码写权限的结果，表单提交仓库 ID，服务层在每次写入和运行时解析时再次确认权限。值在创建或替换成功后不再返回浏览器。

**设计如此：Secret 值和访问范围是两个独立设置。**创建不要求仓库可以避免用户为了保存值而授权无关项目；所有仓库模式适合明确希望跨项目复用的值，并通过每次权限复核自动包含以后取得写权限的仓库、排除已经失去写权限的仓库。指定仓库模式保留最小范围选择。范围变化使用完整集合替换，服务端可以在一个事务中完成权限、去重和 512 KiB 实际注入总量校验。

Dev Container 顶层 `secrets` 只表达该环境建议使用的名称和说明。创建确认页列出当前仓库可用的全部 Secret 名称，并把尚未满足的建议项单独展示；用户可以为缺失项填写一次值，也可以明确选择把已有但尚未授权的 Secret 用于当前仓库。该操作更新用户 Secret 设置，随后创建流程按相同范围规则取得值。普通 fork Pull Request 不展示或更新这些设置，因为其配置内容来自贡献者分支。**设计如此：**仓库配置负责说明环境需要什么，用户设置负责保存私密值和决定哪些仓库可以使用；确认页可以完整说明本次启动计划，仓库提交内容仍不会携带 Secret 明文或自行扩大使用范围。

Manager 单项管理页的 Codespace 表格只返回并展示治理所需字段：展示态、UUID 缩写、repository/ref、创建用户、更新时间和当前可提交操作。站点管理员的表格行不链接创建者详情，也不返回 commit、日志、Endpoint、SSH、自动暂停设置、Token、资源指标或运行侧内部信息。Manager 列表页的异常区域使用相同数据结构和操作，只覆盖尚未分配 Manager 或绑定 Manager 已不存在的记录。

| 展示态 | 站点管理员操作 |
| --- | --- |
| `queued` / `booting` | delete、force delete |
| `running` / `recovering` / `metadata_rebuilding` | stop、delete、force delete |
| `stopping` / `resuming` / `stopped` / `failed` | delete、force delete |
| `deleting` | force delete |

Manager 管理页和异常区域中的 stop、delete 使用普通生命周期服务，与创建者操作具有相同的状态、抢占、超时和 Manager 恢复语义。Manager offline 时仍允许对 `running` 提交 stop 和对可删除状态提交 delete；超时后刷新为状态机确定的稳定结果。站点管理员 force delete 使用独立路由和明确确认，同步删除 Gitea 记录、Codespace Token、Git SSH Key 和日志，不等待 Manager；原 Manager 身份仍有效时，后续完整 inventory 会清理无记录 Runtime。全部操作路由使用 Gitea 现有登录校验和 CSRF 保护，路由同时校验页面中的 Manager 归属或异常归类，成功或冲突后回到原 Manager 页面。

非创建者只有站点管理员可以使用上述治理表格和直接操作，表格不提供对象详情、日志、连接、resume、continue 或自动暂停设置。个人用户的 Manager 页面同时按 `manager_id` 和当前 `user_id` 查询，只链接该用户自己的 Codespace 详情。组织管理员仍按普通用户身份管理自己创建的 Codespace，不因组织角色获得成员工作区权限。

**设计如此：治理按 Manager 归属进入单项管理页。**Manager 是运行资源的实际归属边界，分页列出绑定 Codespace 可以同时确认节点状态、声明 tags 和受影响实例；异常区域让尚无有效 Manager 的记录仍可清理。管理员只取得治理摘要和独立 POST 操作，不进入其他用户的完整对象页，因此不会因节点管理扩大到日志、连接或凭据访问。

**设计理由：Manager 管理页分别展示身份、运行状态和调度意愿。**记录存在表示身份有效；计划排空由 Manager 在 Fetch 中上报 `startup_capacity_available=0` 且不接受 create/resume；维护中断使用 recovering/offline；永久撤销身份使用删除操作。职责分开后，管理操作不会隐式改变 active operation、Token、Gateway session 或 Runtime transition。

Manager 身份只由 Gitea 管理页面创建。站点管理页使用 `user_id=0` 创建全局 Manager，用户设置页使用当前个人用户 ID 创建个人 Manager。创建在 Codespace user relation lock 和同一数据库事务中插入 Manager 记录、生成随机 Manager Secret、保存 `secret_hash / secret_salt`，并把明文 secret 只在本次响应中展示一次。页面刷新后不再返回 secret；需要替换凭据时创建新的 Manager 身份并删除旧身份。

**设计理由：Manager 只服务站点或创建者本人。**个人 Manager 接收该用户有权读取的仓库代码，包括组织仓库；组织管理员不需要为成员集中注册运行环境，也不能借此取得成员工作区治理权。身份创建由 Gitea 管理页完成，可以让凭据签发、审计和删除都落在同一个服务边界内；Manager 进程只使用已经签发的身份调用 RPC，不再拥有“自行注册新身份”的入口。

Manager 删除确认页展示绑定 Codespace 数量，并说明 Gitea 会同步删除这些 Codespace、开发凭据、日志和 Manager 地址行，但不会联系 Manager 或保证 Runtime 回收。确认后，服务层不读取 Manager runtime state，保持 Codespace user relation/Manager lock，按内部 Codespace ID 顺序分批读取，并按内部 ID 或绑定后的 Runtime UUID 取得对象锁，在短事务中清理后复检空集合，最后删除 Manager 地址行与 Manager；已经通过认证的并发 RPC 也必须在最终写入前重新检查记录和 binding。

用户自助删除、管理员 Web/API 删除用户、`gitea admin user delete` 和 inactive-user Cron 统一调用 `services/user.DeleteUser`。Codespace 清理只挂在用户删除入口中，删除该用户创建的 Codespace、个人 Manager、用户 Secret 及其仓库选择关系。组织删除继续使用 Gitea 原有流程；所属 repository 删除时统一把相关 Codespace 的 `repo_id` 写为 0，并清理该仓库的 Secret 选择关系，个人工作区继续存在。CLI 只负责定位用户、初始化服务依赖和适配错误，不直接删除 Codespace 关系。

Codespace 和个人 Manager 写入统一进入 Codespace user relation 服务边界，取得 `codespace_user_{user_id}`，在事务中复读个人用户后才提交关系。全局入口使用 `codespace_user_0`。repository、package、组织成员与 team 成员继续使用 Gitea 现有服务和事务边界。

**设计如此：组织仓库只是代码来源。**组织删除和仓库转移不改变 Codespace 创建者，也不迁移 Manager；仓库删除只解除来源关联。把组织成员关系或仓库所有权引入个人工作区清理会误删其他用户资源，因此 user relation lock 只保护本功能的个人关系。

实现验收点：

- 站点管理员可以在 `/-/admin/codespaces/managers/{id}` 对该 Manager 绑定的 Codespace 执行 stop、delete 或 force delete，并在 Manager 列表页处理尚未分配或 Manager 已不存在的记录；同一入口创建全局 Manager 身份并管理全部 Manager。
- 组织设置没有 Codespace 或 Manager 入口；组织管理员不能查看或操作成员的 Codespace。
- 非创建者治理表格没有对象详情链接，可显示定位记录所需的 repository/ref，但不返回 commit、日志、Endpoint、SSH、自动暂停设置、资源指标或任何 Token；站点管理员不能通过治理权限修改自动暂停。
- 用户只能创建和管理自己的个人 Manager；站点管理员创建全局 Manager 身份并管理全部 Manager。
- Manager 列表只保留进入单项管理页的编辑入口并独立展示 tags；声明字段在管理页只读，删除位于单项页底部并显示绑定数量。
- 用户设置只包含 Managers、Repository permissions 和 Secrets；开发工具由锁定提交中的 Dev Container 配置声明，平台 code-server 由 Manager 配置提供。
- 用户只能管理自己的 Codespace Secret，列表和更新响应不返回已有值；仓库搜索和保存只接受当前有代码写权限的仓库，运行时再次复核。
- Secret 可以使用所有仓库范围或可为空的指定仓库集合；所有仓库不展开关系行，指定范围更新一次替换完整集合。
- 512 KiB 限制按当前用户实际注入目标仓库的 Secret 总量计算，不统计其他用户的值。
- 创建确认页列出当前仓库可用的全部 Secret 名称，并显示 Dev Container 尚未满足的建议；用户明确提供缺失值或授权已有值时只建立当前仓库关系，普通 fork Pull Request 不读取或更新这些设置。
- 创建者对象页与设置管理页的 stop/delete 复用相同生命周期服务、状态校验和事务逻辑。
- Manager offline 时，适用状态下的 stop/delete 仍可登记；页面显示等待 Manager，operation 使用原截止时间收敛。只有站点管理员可在任意未物理删除状态使用独立 force delete。
- Manager 管理页没有 enable、disable、pause 或 quarantine 动作；零容量、recovering/offline 和直接删除分别覆盖排空、维护和撤销身份。
- Manager 创建成功时只在当前响应中展示一次明文 secret；页面刷新、列表读取和详情读取都不返回 secret 明文。
- 删除任意状态的 Manager 都只执行 Gitea 本地事务，不创建 operation、不发送 ManagerService 请求。
- 个人删除 Manager 在清理前复检全部绑定 Codespace 均属于当前用户；发现跨用户异常绑定时整次返回错误且不产生部分删除，站点管理员仍可按全站权限处理。
- 删除完成后，Manager、地址行、关联 Codespace、开发凭据和日志均不存在，并发旧 RPC 不能重新写入这些记录或 cache。
- 用户自助、管理员 Web/API、`gitea admin user delete`、inactive-user Cron 和 purge 使用同一个用户服务删除入口，并只清理该用户的 Codespace 资源。
- 用户删除同时清理其 Secret 和选择关系；仓库删除只清理指向该仓库的选择关系，不删除仍用于其他仓库的 Secret。
- 用户删除成功前复检个人 Codespace 和 Manager；不会改变 `user_id=0` 的全局管理资源或其他用户的 Codespace。
- 组织删除不执行 Codespace 用户资源清理；其 repository 删除只解除现有 Codespace 的来源关联。
- Codespace 和个人 Manager 写入通过 Codespace user relation 服务边界；用户已删除或不是个人用户时不提交新关系。

## 权限模型

Codespace 权限由服务层统一判定，Web handler、ManagerService、Gateway Open Token 校验和 SSH 公钥校验都调用同一组入口：

```text
CanCreateCodespace(ctx, user, repo, ref) Decision
CanInteractiveAccessCodespace(ctx, user, codespace, action) Decision
CanAdministerCodespace(ctx, user, codespace, action) Decision
```

`Decision` 包含 `allowed`、`failure_category` 和 `failure_message`。调用方按稳定分类和对应 Connect code 选择处理方式，避免再维护一个可能与分类矛盾的布尔值。

统一入口确保 Web、RPC 和 Gateway 对用户状态、codespace 状态与 Manager 状态得到一致结论，避免权限规则在多个 handler 中逐渐分叉。

服务层判定复用 Gitea 现有用户、组织、仓库、unit、visibility、blocking、restricted user、login restriction、2FA 和 repository permission 逻辑。repository permission 只作为 create 来源校验和 Git HTTP(S)/SSH、LFS、repository API 访问时的 Gitea 既有权限检查，不作为既有 Codespace 交互入口的生命周期依赖。

用户登录状态至少包含：

- `is_active`
- `prohibit_login`
- `must_change_password`
- 站点强制 2FA

create 阶段 repository 访问边界复用 Gitea 现有结果：

- user blocking
- restricted user
- owner visibility
- internal/private repository visibility
- repository code unit 可读性（`CanRead(unit.TypeCode)`）
- repository 生命周期状态

### Create 要求

| 条件 | 说明 |
| --- | --- |
| 登录 | 当前用户已登录 |
| 登录限制 | 满足 Gitea 登录限制（`is_active`、`prohibit_login`、`must_change_password`、站点强制 2FA） |
| 代码读取 | 拥有 repository code-read 权限（`CanRead(unit.TypeCode)`） |
| 仓库状态 | repository 状态允许 create，目标 ref/commit 可解析 |

Repository 状态只参与 create：

| repository 状态 | create | 设计原因 |
| --- | --- | --- |
| 正常且 code unit 可读 | 允许 | 用户具备代码读取能力时，可以用该 repository 初始化自己的私有开发环境。 |
| `archived` | 返回 repository archived 分类 | archived 表示仓库进入只读/冻结管理状态，create 不再产生新的运行侧 workspace。 |
| `empty` | 返回 empty repository 分类 | 空仓库没有可锁定 commit，无法形成可复现 workspace。 |
| migrating / pending transfer / broken | 返回 repository unavailable 分类 | 这些状态下 repository 权限、路径或 git 数据可能正在变化，create 暂停可以避免 clone/checkout 与权限判定出现不一致。 |
| source repository deleted | 返回 source repository deleted 分类 | repository 已不存在时无法再解析来源、锁定 commit 或构造新的 create payload；已有 workspace 后续仍可在 `repo_id=0` 时取得 token，源仓库能力消失，仍存在的附加授权和匿名公开读取继续按各自规则处理。 |
| mirror | 允许 | mirror 本身仍是可读取 repository，同步来源属性不改变远程开发入口；实际写入能力继续由用户对 Gitea repository 的权限决定。 |
| create 目标 ref/commit 不可解析 | 返回 ref not found 分类 | create 需要先锁定 commit，已有 codespace 后续按已保存的 `commit_sha` 和运行时数据管理。 |

create operation 完成后，repository 的后续状态不再参与 open、SSH、resume、stop、delete 或 logs 判定。workspace 已经由 Runtime 数据和 Manager binding 初始化完成，repository 后续删除、归档、迁移、ref 移动或访问权限变化只影响 Runtime 的 Git HTTP(S)/SSH、LFS 和 repository API。仍处于 creating 的初始化过程可以因 repository 访问被拒绝而上报 failed，但 repository 事件本身不直接改写主状态。

### Interactive Access 要求

`open`、SSH、`resume` 和“继续运行”都只允许 codespace 创建用户本人发起，并要求创建用户当前满足 Gitea 登录限制。各动作在身份检查后按实际依赖继续判断：

| 动作 | 状态与运行信息要求 |
| --- | --- |
| `resume` | codespace 为 `stopped`、没有 active operation，绑定 Manager online；不读取 Runtime Metadata 或 Endpoint，因为恢复动作只依赖已经初始化的 workspace |
| 打开默认 `workspace` | codespace 为 `running`，无 active operation 或只有 queued idle stop，绑定 Manager online，Runtime Metadata 为 `ready` 且包含属性固定的私有 `workspace` |
| 打开普通 [Endpoint](glossary.md#endpoint) | 满足默认 `workspace` 的 ready 条件，并且当前 metadata 中存在目标 `endpoint_id` |
| SSH 新认证 | codespace 为 `running`，无 active operation 或只有本次认证可以取消的 queued idle stop；Manager online，Runtime Metadata 存在且 ready，提交的 SSH key 归创建用户所有 |
| 继续运行 | codespace 为 `running`；无 active operation 或当前为 queued idle stop，后者在同一事务中取消 |

每个入口只检查完成该动作所需的数据。特别是 resume 不依赖可能在 stopped 期间过期或丢失的 cache；open 和 SSH 则需要 ready 快照，避免用户进入凭据或 Endpoint 尚未处理的 Runtime。判定顺序固定为数据库身份与主状态、Manager 状态、metadata 是否存在、ready 和目标 Endpoint。`running` 只由当前 create/resume 的 ready 快照和 Token 都完整的 final done 建立，后续同一 boot 版本不能从 ready 回退，因此正常的 running 快照始终 ready；cache miss 统一返回 `metadata_rebuilding`。Gitea 的 allowed 结果只是控制面授权，Gateway/SSH 还会在本地 Codespace 协调锁内检查本轮进程已经恢复凭据、Incus backend 和路由，并把最终检查与 session 登记一同提交；Manager 刚进入 online 而单个 Codespace 尚未恢复时不能建立连接。

### 管理权限

`CanAdministerCodespace` 按具体 action 判定，不把“可以治理资源”扩大为“可以查看对象详情”：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 通过 Gitea 现有登录限制后，可以查看自己的详情和日志、修改自动暂停设置并执行 stop/delete |
| 非创建者的站点管理员 | 在 Manager 管理页和异常区域查看治理摘要并执行 stop/delete/force delete |

创建者权限独立于 repo code-read 权限，失去 repo 访问后仍可管理自己的 Codespace。这里的创建者是 `codespace.user_id`，通过身份认证和 Gitea 现有登录限制后不再检查 repository；账户已被限制或删除时，不能通过 Codespace 路由建立第二套登录入口。

组织角色不形成 Codespace 治理范围。用户从组织 repository 创建的 Codespace 仍归该用户本人，组织管理员只能按普通用户身份管理自己创建的对象。repository 转移、组织成员变化和组织管理权限变化都不改变现有 Codespace 的创建者或 Manager binding。

同一调用者同时是 Codespace 创建者和组织所有者或站点管理员时，创建者可以通过 `/-/codespaces/{codespace_id}` 管理自己的对象；Manager 管理页仍只返回治理页面数据结构。这样管理员管理自己的 Codespace 时保留普通用户体验，同时管理其他用户对象时保持最小信息边界。

站点管理员可在明确确认后强制删除 Gitea 记录、Codespace Token、Git SSH Key 和日志，不以 Manager 失联或特定状态为前提。该动作的完成条件是 Gitea 本地事务提交，不等待 Incus 实例回收，也不保存墓碑。若原 Manager 身份仍有效，后续成功的完整 inventory 查询不到该 UUID 时返回 `cleanup_local_runtime`；Manager 身份已删除或永久失联时，残留实例和本地状态文件由部署运维处理。

**设计理由：创建者管理和站点治理解决不同问题。**创建者需要使用、诊断和配置自己的开发环境；站点管理员需要控制全站资源是否继续运行或保留。组织管理员管理代码仓库与成员，不代表其拥有成员个人开发环境。按 action 授权可以直接表达这个差异，避免仓库管理权限扩大为工作区访问权限。

实现验收点：

- repository 删除、transfer 或权限丢失后，已登录且未受登录限制的创建者仍可查看日志、修改自动暂停设置并执行 stop/delete。
- 受 Gitea 登录限制的用户不能通过 Codespace 页面、Open Code 或 SSH 绕过账户限制。
- 组织管理员不能因组织角色查看、停止或删除成员 Codespace；自己创建的对象继续按创建者权限管理。
- 站点管理员无需 repository 权限即可 stop/delete/force delete 全部 Codespace，但非创建者身份不能查看详情、日志或自动暂停设置。
- 非创建者提交其他用户的 UUID 或对象 ID 时，创建者详情、日志、打开入口、生命周期和用户 Secret 修改均不返回目标数据且不产生状态变化；创建者对象路由对不存在与无权对象均返回 404。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | codespace 归创建用户使用和管理；创建用户删除时由账户删除流程物理清理 |
| 组织仓库 | codespace 仍归创建用户使用和管理；候选基础设施是站点全局 Manager 或创建者的个人 Manager，组织及其管理员不取得治理权 |

**设计如此：组织 repository 是合法来源，但组织不是 Codespace 所有者。**这样成员可以使用自己有权读取的组织代码，同时个人 Manager 的权限边界、账户删除和工作区管理都只依赖创建者，避免组织删除或仓库转移误删个人环境。

实现验收点：

- 用户对组织 repository 具有 code-read 权限时，可以从代码页、Commit 页或开放 Pull Request 页创建自己的 Codespace。
- 组织管理员不能创建组织 Manager，也不能通过组织设置或直接路由管理成员 Codespace。
- repository 转移、组织成员变化和组织权限变化不改变已有 Codespace 的创建者与 Manager binding。

### 最小页面数据

Web 页面使用明确的服务端页面数据结构，不直接序列化 `codespace` 数据库行。创建者列表使用 `CodespaceOwnerListItem`，共享字段为：

- `uuid`
- `status` 和 `display_status`
- `created_unix / updated_unix / last_active_unix`
- `repo_id / ref_type / ref_name / commit_sha`
- `manager_id / manager_display_name / manager_runtime_state`
- `status_summary`
- `allowed_actions`

创建者详情使用 `CodespaceOwnerDetail`，在上述字段基础上增加当前 Codespace Token 和 Git SSH Key 是否存在、`log_size`、自动暂停持久选择和有效超时，以及后述规范化 `workspace/endpoints/ssh/resource_usage`。自动暂停页面数据包含持久 `mode`、自定义表单使用的精确 `timeout value/unit`、站点默认值与允许范围、当前有效启用状态和有效超时，以及已有自定义值是否超出当前范围；时间展示选择能够精确表达秒数的最大单位，数据库和 Manager 协议仍统一使用秒。`interaction_generation` 只用于 Manager 协议，不返回 Web 页面。凭据展示字段只说明当前绑定是否存在，不返回 Token verifier、salt、密文、明文、公钥正文或指纹。Git clone 首选协议不是详情属性，因为它只在 create payload 构造时按站点当前配置计算。

站点管理列表使用 `CodespaceGovernanceListItem`，只包含 `uuid / display_status / updated_unix / user_id / user_display_name / manager_id / manager_display_name / manager_runtime_state / status_summary / allowed_actions`。该结构没有详情变体，因此非创建者不能通过修改 URL 或请求格式取得 repository、ref、commit、日志、自动暂停、Endpoint 或 SSH 数据。

`manager_runtime_state` 固定为 `pending / online / recovering / offline`：`manager_id=0` 返回 `pending`，已经绑定时使用服务端根据声明和 heartbeat 派生的当前状态。页面据此区分等待分配、恢复中和离线，不根据更新时间自行推断 Manager 状态。

对象详情还返回经过规范化的展示入口：

```json
{
  "workspace": {
    "endpoint_id": "workspace",
    "label": "Workspace",
    "open_path": "/-/codespaces/01234567-89ab-cdef-0123-456789abcdef/open",
    "public": false,
    "can_open": true
  },
  "endpoints": [
    {
      "endpoint_id": "app-3000",
      "label": "App 3000",
      "open_path": "/-/codespaces/01234567-89ab-cdef-0123-456789abcdef/open/app-3000",
      "public": true,
      "can_open": true
    }
  ],
  "ssh": {
    "host": "ssh.codespace.example.com",
    "port": 22,
    "username": "cs-01234567-89ab-cdef-0123-456789abcdef",
    "command": "ssh -p 22 cs-01234567-89ab-cdef-0123-456789abcdef@ssh.codespace.example.com",
    "host_key_algorithm": "ssh-ed25519",
    "host_key_fingerprint_sha256": "SHA256:...",
    "host_key_updated_unix": 1735689600
  }
}
```

页面模型把 metadata 中固定的 `endpoint_id=workspace`、`public=false` 记录映射为单独的 `workspace` 主入口，并使用请求语言对应的 “Workspace” 文案；Manager 把它代理到当前 Dev Container 的 code-server。`endpoints` 只包含其余普通 Endpoint，并原样带出必填 `public`。普通 Endpoint 的固定 `port-<port>` ID 让页面可以同时展示端口和可见性；upstream 协议与 host 仍留在 Manager 路由，不扩展 Runtime Metadata。**设计如此：**页面布局可以突出默认开发入口，但可用性仍来自 Manager 上报的完整集合，避免展示层重新猜测 workspace。端口是用户识别服务所需信息，内部连接协议不是 Gitea 的授权或展示事实。`open_path` 是 Gitea 站内 POST 路由，`can_open` 是当前页面状态判定；Gateway URL 只在 POST 服务内部由当前绑定 Manager 最近一次成功 Declare 的规范 `gateway_url`、完整 UUID 和 Endpoint ID 派生，页面不接收或拼接目标 URL 与 Runtime upstream。

`ssh` 只由绑定 Manager 对外声明的 `gateway_ssh_addr` 和 Gateway host key 展示字段构造。服务端拆分规范化的 host 与 port，用户名固定为 39 字节 ASCII 的 `cs-{小写规范 UUID}`，command 固定由这些字段生成。该用户名只供 Gateway 定位 Codespace，不映射为操作系统账户；Runtime 执行用户由 Manager 本地保存的非 root UID/GID 决定。该结构只提供用户实际连接所需的公开地址和 host key 核对信息，Runtime 内部目标、upstream 和任何 token 都不会进入详情响应。

只有创建者详情在具有 Interactive Access 且当前 metadata ready 时返回普通 `endpoints`。页面把 `public=true` 显示为公共入口：无 active operation 时通过弹窗 POST 打开，queued idle stop 时保留展示但设置 `can_open=false` 并提供既有“继续运行”动作；需要认证的入口通过同一弹窗 POST 建立 session，并可取消 queued idle stop。workspace 固定使用认证动作。`ssh` 还要求绑定 Manager online，并且 Manager 的公开 SSH 地址、host key algorithm、SHA256 fingerprint 和更新时间全部有效；任一条件缺失时省略该对象。治理摘要数据结构从类型上没有 `workspace/endpoints/ssh` 字段。

只有创建者详情在当前 Runtime Metadata 存在时返回 `resource_usage`。该对象只包含 CPU、内存和磁盘当前用量、对应 limit 和采样时间；limit 为 0 时页面显示限制未知。指标缺失不影响 workspace、Endpoint、SSH 或 allowed actions 的返回，页面显示暂不可用。治理摘要不包含资源指标，也不按这些指标排序。**设计如此：**创建者需要快速判断自己的工作区是否接近资源上限，管理员治理只依赖状态、归属和允许动作；把瞬时指标放进治理数据会引入容易误判的运维含义。

创建者详情使用 Gitea 原生进度条展示 CPU、内存和磁盘的 `used/limit`，并在旁边保留格式化后的真实数值。limit 大于 0 时进度条表达当前占比，used 超过 limit 时进度条显示为满格而文字继续显示真实数值；limit 等于 0 时只显示当前用量和“限制未知”。**设计如此：**limit 等于 0 表示 Manager 没有取得有效上限，并不表示资源无限或使用率为零；省略进度条可以避免向用户展示无法成立的比例。页面不自行增加告警阈值和告警颜色，因为不同 Incus 配置下瞬时用量与可执行动作没有统一告警语义。

创建者列表继续使用 Gitea 的响应式分隔列表，并在顶部使用与工单和合并请求控制面板一致的用户上下文切换。个人上下文汇总当前用户创建的全部 Codespace；选择组织后，只筛选当前用户在该组织所属仓库中创建的 Codespace。组织上下文不读取其他成员的 Codespace，也不改变 Codespace 创建者。列表使用服务端分页，按 `updated_unix DESC, created_unix DESC, id DESC` 稳定排序；内部 ID 只作为相同时间值的数据库排序尾列，不进入页面或分页参数。分页链接保留组织上下文，超出当前总页数的页码回到最后一个有效页。每行只展示 repository、状态、ref、环境 tag 和最后活动时间；稳定状态不重复展示状态说明，过渡、恢复和失败状态补充当前说明。列表只从 Runtime Metadata 中确认 Workspace 是否可打开，不构造详情使用的普通 Endpoint、SSH、资源指标和启动阶段。

**设计如此：组织切换表达仓库来源范围，不表达 Codespace 所有权。**用户需要像查看工单和合并请求一样快速聚焦某个组织的开发环境，但 Codespace 的权限、生命周期和账户清理仍只由创建者决定。服务端先按创建者限制数据，再关联仓库 owner 完成筛选，可以让页面上下文变化保持熟悉，同时不扩大组织管理员权限。分页和列表专用运行时投影限制了用户长期积累 Codespace 后的查询与页面开销，不需要增加数据库字段或另一套页面状态模型。

Manager 列表和单项页的绑定 Codespace 使用与 Actions Runner 相同的基础表格：Manager 列表只展示名称与版本、状态、可选所属用户、tags、最后在线、绑定数量和编辑图标；单项页在基础信息区展示可换行的 Gateway、SSH 和 Host Key，再用分页表格展示绑定 Codespace。窄屏时表格只在 attached segment 内横向滚动，不扩大整个设置页面。**设计如此：**Manager 是低频管理对象，列结构稳定且需要快速纵向比较；单项页承载长连接信息和实例管理，可以避免列表弹窗为每行重复生成详情内容。

创建者详情采用与 Gitea 其他对象页一致的全宽标题、操作区和页签。标题使用 repository 名称并紧邻展示状态，ref、可跳转的短 commit 和创建时间作为次要信息；UUID 只承担路由和服务端对象身份。普通运行状态不重复展示摘要，过渡、停止和失败状态在次要信息下补充状态摘要与当前启动阶段，使用户能理解正在发生的操作。Overview 在桌面端使用弹性连接主列和固定 320 像素上下文列，低于 992 像素时按自然文档流排列；连接尚未可用时主列保留 Access 占位，上下文始终先展示 Details，再展示存在的 Runtime usage。连接区域按 SSH 和 Ports 分节，Workspace 打开操作固定在页头。

页头按用途展示当前可执行操作：Open Workspace 和 Resume 是主要文字按钮，Keep running 是取消已排队自动停止的普通文字按钮，Stop 使用与 Actions Cancel 一致的中断样式；Auto-stop 设置和 Delete 收纳到标准更多菜单，Delete 使用红色文字、垃圾桶图标并通过确认弹窗说明影响。**设计如此：**打开或恢复是用户进入工作区的主要任务，Keep running 和 Stop 需要在当前状态下直接发现；设置和删除是低频对象管理，使用带文字的更多菜单既保持页头紧凑，也比两个孤立图标更容易理解。稳定的 Overview 主次结构则避免连接和指标随 Runtime Metadata 变化时导致页面宽度与信息顺序跳动。

Auto-stop 使用创建者列表和详情页共用的设置弹窗。模式使用纵向原生单选组：站点默认项直接展示当前站点时长，自定义项展开数值和单位并展示允许范围，永不自动暂停项说明运行环境由用户手动停止；弹窗同时展示当前已保存策略的实际结果。自定义数值使用剩余行宽，单位使用 Gitea 标准紧凑下拉框并保持稳定宽度；窄屏可以换为上下排列。切换离开自定义项时禁用从属字段但保留尚未保存的输入，切回后可以继续编辑；详情状态变化只更新弹窗是否可提交。已有自定义秒数超出管理员后来调整的范围时，弹窗保留原值并显示范围提示，下一次保存由用户明确选择新值。Auto-stop 和打开 Workspace 弹窗在各自范围内通过保存或取消结束交互，Resume、Continue、Stop、Delete、Manager 管理和权限缩减表单只提交服务端生成的固定命令，因此这些表单不参与页面级未保存内容检测。创建确认与 Secret 编辑包含用户尚未提交的值，继续使用页面离开保护。**设计如此：**Auto-stop 是低频设置，不需要长期占用详情页空间；共用弹窗让列表页也能直接设置，同时三项单选仍能清楚表达继承、自定义和保持运行的区别。把即时命令与内容编辑分开，可以避免隐藏弹窗阻止生命周期操作跳转，同时保留对真正未保存内容的保护。

操作日志使用一个完整的 Actions 风格控制台面板。面板顶部提供时间列切换、全屏和下载操作，更多菜单使用与 Actions 控制台一致的背景、边框、指向箭头和交互颜色；时间戳勾选位固定宽度，状态变化不会移动菜单文字。正文按完整物理行增量渲染，每行由固定宽度行号、可选时间和可换行正文组成。日志面板在所有页面宽度下占满唯一内容列，窄屏仍保持标题与更多菜单同一行；进入全屏后即使面板移动到全局容器，也继续填满完整宽高并让正文使用剩余空间。页面复用 Actions 的 ANSI 安全渲染和 `##[group]`、`##[endgroup]`、严重级别控制行解析，使阶段可以折叠且错误保持醒目；它仍是一条生命周期日志流，不引入 Actions job 或 step 数据模型。新日志到达时，页面只在用户原本位于底部附近时跟随到底部；用户正在阅读历史行时保持当前位置。下载接口先完成权限和首个分页读取，再把同一 DBFS 日志逐页写入 HTTP 响应。**设计如此：**复用现有日志展示约定可以获得一致的阅读体验，明确面板自身的响应式和全屏尺寸可以避免 DOM 位置变化后意外继承普通页面高度，同时 byte offset 和单文件存储仍是唯一的读取与下载来源。

创建者列表和详情页中的 Workspace、Open Workspace 和普通 Endpoint 入口共用页面内的确认弹窗。普通点击确认后，浏览器在新标签页提交 POST 并进入 Gateway，提交事件完成后原页面关闭弹窗并清除加载状态，使原来的 Gitea 列表或详情页继续用于查看状态、日志和管理工作区。Gateway 认证恢复进入详情页时，弹窗在当前标签页提交 POST，使该 Gateway 标签页能在 code 交换后回到原 path/query。**设计如此：**两种提交目标服务于不同上下文，但都复用同一弹窗和 POST 路由；只在新标签页路径主动结束原页面弹窗，当前页恢复仍沿用 Gitea 传统表单等待页面跳转的行为。页面脚本不接收 Gateway URL，目标地址始终由服务端按当前 Manager 和 metadata 推导。

Resume、Stop、Codespace 删除、站点强制删除和 Manager 删除使用 Gitea 公共确认弹窗。Resume 说明运行环境将启动并在初始化完成后可用；Stop 说明当前连接和运行进程会结束，并且以后仍可恢复。普通删除说明工作区、凭据和操作日志会被清理；强制删除说明 Gitea 记录会立即移除，Manager 在后续对账中清理残留运行时资源；Manager 删除说明该 Manager 身份和绑定的 Gitea Codespace 记录会一并清理。确认后仍由服务端复检当前身份、状态和允许操作；强制删除和 Manager 删除还需要服务端要求的 `confirm=force-delete` 或 `confirm=delete-manager` 标记。创建者从列表执行 Resume、Continue、Stop、Delete 或 Auto-stop 后，成功和可恢复业务错误都返回原组织上下文和原分页；从详情执行时返回当前详情，删除完成后返回列表。返回目标只接受当前 Codespace 详情或 Codespace 列表的站内地址。

**设计如此：**Resume 会启动计算资源，Stop 会中断当前开发会话，两者虽可逆但都会产生即时影响；提交前明确说明结果可以避免误触，同时弹窗只负责交互确认，不替代服务端校验。动作完成后回到发起上下文可以让用户连续管理列表，不需要前端维护一套容易与服务端状态分离的行状态；明确的站内返回范围同时保留分页体验和重定向边界。

`allowed_actions` 使用固定值 `open_workspace / open_endpoint / ssh / continue / configure_auto_stop / stop / resume / delete / force_delete`，但按调用者角色返回不同子集：

- 创建者的 `running` 且无 active operation 时返回 `configure_auto_stop/stop/delete`，功能启用、Manager online 且 metadata ready 时加入 `open_workspace`；存在普通 Endpoint 时按各自 `can_open` 渲染打开动作；SSH 展示字段和内部条件完整时加入 `ssh`。
- queued idle stop 使用相同交互条件，并加入 `continue`；queued user stop 或 running stop 只返回 `configure_auto_stop/delete`。
- 创建者的 `stopped` 且无 active operation 时返回 `configure_auto_stop/delete`，功能启用且 Manager online 时加入 `resume`；active resume 期间只返回 `configure_auto_stop/delete`。
- 创建者的 queued create 或 booting 返回 `delete`，failed 返回 `delete`，deleting 返回空集合。
- 站点管理员的 Manager Codespace 表格按状态返回 `stop/delete` 的适用子集，并在任意未物理删除状态加入 `force_delete`。
- `configure_auto_stop` 只向创建者返回。组织所有者和非创建者站点管理员的治理页面数据永远不返回该值。

`allowed_actions` 只表示当前请求可以提交的动作。`stopping/resuming/deleting/booting` 对应的禁用进度按钮由 `display_status` 渲染，不把正在执行的动作重新放入可提交集合。Runtime Metadata cache 未命中、Manager offline/recovering 或站点排空时移除当时不可执行的交互动作和 resume，但保留创建者的 `configure_auto_stop` 以及当前状态可登记的 stop/delete。页面完全依赖服务端页面数据，不从 Manager metadata、内部地址或字段缺失推测其他操作。

以下字段保留在服务端内部或 Manager/Gateway 内部，不进入页面数据：

- Codespace Gitea Token verifier 与密文
- Manager Secret
- Gateway Open Token
- `token hash / salt`
- Endpoint upstream
- 完整 Manager 声明字段
- 日志正文
- Runtime Instance 内部 host / port / user

创建者页面数据和治理页面数据分开定义，是为了让数据权限由服务端类型保证，而不是依赖模板隐藏字段。治理摘要只提供识别对象、判断状态和发起允许动作所需的信息，使管理员能够治理资源而不进入其他用户 workspace。这些结构的稳定使用方是服务端模板和状态片段；本设计需要版本标识的协议范围是 ManagerService 和 Runtime 本地 manifest，服务端 Web 页面及其状态片段按 Gitea 路由契约维护。

实现验收点：

- create 使用 repository 权限；既有 codespace 的交互和管理权限不依赖 repository row。
- 创建用户只能交互、查看日志和配置自己的 Codespace；组织所有者不因组织角色取得成员工作区权限；站点管理员对非本人对象只使用治理摘要执行 stop/delete/force delete。
- 个人控制面板分页展示当前用户创建的全部 Codespace；组织控制面板只展示该用户在所选组织仓库中创建的记录，分页切换保留当前组织，修改组织参数不能取得其他用户的 Codespace。
- stopped 状态的 resume 在 Runtime Metadata cache 为空时仍可提交；workspace、普通 Endpoint 和 SSH 在 cache miss 时返回 `metadata_rebuilding`，running 状态下缓存中的 boot 快照保持 `ready`。
- 普通 Endpoint 只有在 metadata ready 且目标存在时可打开；SSH 只有在 ready 且公钥归创建用户时可认证，实际 Incus backend 由 Manager 本地准入复检。
- `CodespaceOwnerListItem`、`CodespaceOwnerDetail` 和 `CodespaceGovernanceListItem` 使用互不混用的明确字段；治理页面数据只增加定位所需的 repository/ref，不包含 commit、日志、自动暂停、Endpoint、SSH、token、resource usage、upstream 或完整 Manager metadata。
- 对象详情能无歧义展示 default/custom/never 的持久选择和当前有效超时，但不暴露 Manager 使用的交互版本。
- 对象详情的 `workspace` 使用固定的本地化 Web IDE 文案；普通 `endpoints` 按 ID 排序，页面无需解析 Runtime Metadata。
- 对象详情的 `resource_usage` 来自 Runtime Metadata typed fields，只展示 CPU、内存、磁盘和采样时间；字段缺失时页面显示暂不可用，不隐藏其他操作。
- CPU、内存和磁盘在 limit 大于 0 时显示原生进度条及真实 `used/limit`；limit 等于 0 时显示当前用量和“限制未知”，页面不生成虚假的使用比例。
- SSH 展示只使用 Manager 公开地址和公开 host key 信息，command、host、port 与 `cs-{完整 UUID}` 用户名一致；响应不包含 Incus backend、upstream 或 token。
- 非创建者没有对象详情响应；治理摘要只返回当前状态可提交的 stop/delete，站点管理员额外获得 force delete，任何非创建者都没有 configure auto-stop、open、SSH、continue 或 resume。
- 完整详情页和状态片段对相同身份与对象使用相同 `allowed_actions`；普通 Endpoint 在 metadata ready、目标存在且当前没有 active operation 时设置 `can_open=true`，私有入口加入 `open_endpoint`，公共入口由同一弹窗提交后直接重定向。queued idle stop 时只有私有入口仍可打开并加入 continue，公共入口设置 `can_open=false`；只有 SSH 展示字段和内部就绪条件都完整时才有 `ssh`，领取后的 stop 只保留创建者设置和 delete。
- 创建者详情中的 workspace 和普通 Endpoint 都带站内 `open_path` 和当前 `can_open`；workspace 固定需要认证，普通 Endpoint 的 `public` 标记与 Runtime Metadata 一致。页面只通过弹窗 POST 打开，Gateway URL 不进入页面数据。
- `display_status` 与 `allowed_actions` 分工明确：前者产生正在创建、停止、恢复或删除的禁用进度按钮，后者只产生可以提交的操作。
- 创建者列表、Manager 列表和 Manager 单项页在 1440、1024、768 和 375 像素宽度下不产生页面级横向滚动；Manager 表格在 attached segment 内滚动，长仓库名、引用名、Gateway URL、SSH 地址、SSH 命令和主机密钥指纹在各自内容区内换行。
- Logs 在桌面端占用主内容剩余高度并在控制台内部滚动；Overview 使用自然文档流和“宽连接区、窄上下文”布局。两种页签共用页面外壳和稳定滚动槽；低于 992 像素时 Overview 改为单列。日志面板在桌面、中间宽度和移动端都占满内容列，窄屏标题与菜单保持同一行；全屏面板移动到 `.full.height` 后继续填满宽高，正文使用页头之外的剩余空间。
- 状态、操作和页签使用全宽页头，状态紧邻 repository 标题，Workspace 只在页头提供一次主要打开操作。Open Workspace、Resume、Keep running 和 Stop 使用符合用途的紧凑文字按钮；Auto-stop 设置只在可配置状态显示，设置与 Delete 使用同一个标准更多菜单，Delete 保留红色文字、图标和确认弹窗。SSH 使用独立章节和完整宽度命令控件；Ports 使用 Service、Port、Visibility 和固定图标操作列，操作列表头只提供无障碍名称，移动端使用两行结构。主机密钥校验可以展开查看并复制指纹。Auto-stop 使用状态片段之外的公共弹窗，状态轮询不会覆盖正在编辑的模式和时间。
- Overview 在连接可用与不可用状态下都保持同一主次结构；不可用时主列显示 Access 占位。上下文先展示 Details，随后展示存在的 CPU、内存和磁盘指标；桌面端上下文列固定为 320 像素，低于 992 像素时按相同顺序变为单列。
- 列表页更多菜单和详情页设置按钮打开同一个 Auto-stop 弹窗。三种模式使用原生单选组；站点默认展示当前默认时长，自定义只在选中且当前状态可配置时启用正整数数值和秒、分钟、小时、天标准下拉框，永不自动暂停说明由用户手动停止。保存返回服务端生成并校验的原列表上下文或当前详情页。
- 列表中的 Resume、Continue、Stop、Delete 和 Auto-stop 在成功或可恢复业务错误后返回原组织上下文和原分页；所有展示状态都通过仓库标题或 Details 操作进入详情。更多菜单使用标准图标项目，Delete 使用垃圾桶图标、危险文字和确认弹窗。
- 打开并取消 Auto-stop 或 Workspace 弹窗后，Resume、Continue、Stop、Delete、页签切换和正常状态刷新不会触发未保存内容提示；创建确认或 Secret 编辑存在未提交输入时，离开页面仍会提示。
- 操作日志使用 Actions 风格的单一控制台面板，行号、可选时间列和正文分别对齐；更多菜单的背景、边框、指向箭头、菜单项状态和固定勾选位与控制台一致。时间默认隐藏，用户可以切换时间显示、进入全屏或下载日志。页面初始化后立即从 byte offset 0 读取，后续增量轮询只在用户位于底部附近时自动跟随。
- 日志下载在完成访问校验后逐页输出纯文本，内容和页面读取来自同一 DBFS 文件；下载过程不在服务端内存中拼接整份日志。
- 创建者列表和详情页的 Workspace 与普通 Endpoint 入口共用一个页面弹窗；普通确认在新标签页提交后关闭原页面弹窗并清除加载状态，Gateway 恢复确认在当前标签页提交，原来的管理页面和恢复路径都保持可用。
- 创建者列表和详情页的 Resume、Stop 在提交前显示与实际影响一致的确认弹窗，Manager 治理页的 Stop 使用相同确认；取消确认不提交请求。普通删除、强制删除和 Manager 删除继续显示各自影响说明，强制删除和 Manager 删除确认后仍由服务端验证各自的确认标记。

## ManagerService RPC

Gitea 实现：

```text
codespace.v1.ManagerService
```

传输：

- Connect RPC over HTTP 或 HTTPS（参考 Actions runner Connect 服务形态）；具体 scheme 由部署地址和 Manager 本地配置决定
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口

HTTP 适合受信私网和本地开发，HTTPS 适合跨主机或不受信网络。协议选择不改变 RPC、认证 header 或状态语义；启用 HTTPS 时由部署配置提供 CA、证书和 server name 校验，使用 HTTP 时运维侧负责把控制面限制在受信网络。

ManagerService 是服务间接口，不返回 CORS 允许头，也不处理浏览器预检。它不使用 Gitea Session Cookie、浏览器 Origin 或转发头认证；所有 RPC 都接受 Manager ID 与 Manager Secret header。这样 Endpoint 页面不能通过浏览器环境取得一条控制面认证路径。

Gitea 的 RPC handler 负责 Connect 请求认证、协议版本检查和服务错误到 Connect code 的映射。ManagerService 的请求枚举、批量消息和 `oneof` 响应由 Codespace 服务层直接使用共享 proto 生成类型；服务层在需要查询和写入数据库时，再把协议枚举明确映射为 Gitea 模型值。Web 页面共用的领域数据继续使用服务层自身结构，不依赖 Connect handler。**设计如此：ManagerService 消息已经是 Gitea 与 Manager 共同认可的接口类型，服务层直接构造它可以避免维护字段完全重复的中间结构和转换表；同时把 Connect 传输细节留在 handler，Web 路由不会因此耦合到 RPC 传输实现。**

Manager 认证 header：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

每个 request 都必须携带当前 ManagerService 主版本；版本字段属于逐请求协议前置条件，不由最近一次 Declare 或数据库记录代替。Gitea 先通过统一入口认证 Manager ID 和 secret，再在取得业务锁、更新 heartbeat/generation 或执行生命周期读写前校验版本。

完整 proto 定义和消息结构见 [RPC 接口定义](rpc-spec.md)。

### 统一失败分类

ManagerService 和访问判定使用以下稳定字符串。handler 选择表中最具体的分类，日志可以附带内部错误正文，协议只返回分类；Manager/Gateway 按分类和 Connect code 的固定组合处理重试、清理和用户提示。

| 分类 | Connect code / 处理方式 | 使用场景 |
| --- | --- | --- |
| `invalid_argument` | `InvalidArgument`，修正请求 | 字段格式、枚举、数量、request 大小、配置 JSON 或 Runtime Metadata typed fields 不合法 |
| `unauthenticated` | `Unauthenticated`，停止使用当前凭据 | Manager secret 无效 |
| `invalid_credentials` | `PermissionDenied`，拒绝访问 | Gateway 用户 SSH 公钥或一次性 open code 未通过访问判定 |
| `permission_denied`、`login_restricted` | `PermissionDenied`，拒绝访问 | 当前身份不再允许该动作 |
| `repo_permission_denied`、`unsupported_resource` | `PermissionDenied`，拒绝请求 | repository 当前权限、附加仓库确认或资源类型不允许访问 |
| `repository_archived`、`repository_empty`、`repository_unavailable`、`source_repository_deleted` | `FailedPrecondition`，修正来源后重试 | create 来源 repository 当前不能形成 workspace |
| `ref_not_found` | `NotFound`，修正目标后重试 | create 目标 ref/commit 无法解析 |
| `manager_unregistered` | `Unauthenticated`，停止该身份的 RPC | request 中的 Manager ID 已注销、随 owner 删除或不存在 |
| `protocol_mismatch` | `FailedPrecondition`，升级 Gitea 或 Manager 后重新启动 | 任一 request 提交的 ManagerService 主版本不是当前版本 1 |
| `manager_offline` | `Unavailable`，先恢复 Declare | heartbeat 已超时，当前 Manager 不满足交互或领取条件 |
| `manager_recovering` | `Unavailable`，等待恢复完成 | Manager 已声明 recovering，当前动作需要等待其恢复完成 |
| `codespace_not_found` | `NotFound`，进入完整 inventory | UUID 不存在；`FinalizeOperation` 对任意 operation 类型改用 `resource_absent` outcome |
| `codespace_not_running`、`endpoint_not_found` | `FailedPrecondition`，等待状态或目标变化 | 当前 codespace 或 Endpoint 不满足交互入口条件 |
| `manager_mismatch`、`stale_operation` | `FailedPrecondition`，停止旧上下文 | 请求来自错误 binding 或旧 operation 上下文 |
| `current_operation_conflict` | `Aborted`，重新 Fetch | 当前 active operation 已变化，caller 应重新 Fetch 权威 payload |
| `generation_conflict` | `FailedPrecondition`，清理单对象损坏状态 | 相同 generation 对应不同当前状态，表示本地状态损坏或存在第二写入者 |
| `state_history_conflict` | `FailedPrecondition`，停止该 Manager 的新动作 | Fetch 或 inventory 中正数 observed operation 高于已存在且绑定当前 Manager 的 Codespace 当前版本，表示 Manager 与 Gitea 的 operation 历史不一致 |
| `offset_conflict`、`offset_gap` | `Aborted`，按服务端 offset 继续 | 日志 offset 已变化，并附 `LogOffsetDetail` |
| `stale_generation` | `FailedPrecondition`，按服务端 generation 继续 | generation 过旧，并附 `StaleGenerationDetail` |
| `metadata_required` | `FailedPrecondition`，先上报当前 ready metadata | create/resume final done 尚未取得当前 operation 版本的 `ready` Runtime Metadata |
| `gitea_token_required` | `FailedPrecondition`，重新取得并刷新凭据 | create/resume final done 缺少当前 Codespace Token 行 |
| `key_conflict` | `FailedPrecondition`，保留当前绑定；Manager 保存不可恢复 boot 终态并按 create/resume 失败流程收敛 | Codespace 已绑定不同公钥，或该指纹已被其他 Key 使用 |
| `git_ssh_host_key_unavailable` | `FailedPrecondition`，修正 Gitea SSH Host Key 配置 | 无法为 Runtime 返回匹配当前 SSH host/port 的可信 Host Key |
| `version_exhausted` | `ResourceExhausted`，执行对应硬清理 | operation、交互或 Manager generation 无法继续递增；本次请求没有部分写入 |
| `state_unavailable` | `FailedPrecondition`，等待生命周期变化 | 功能关闭、工作状态凭据不可用或当前生命周期不允许该动作 |
| `metadata_rebuilding` | `Unavailable`，等待当前快照重建 | 主状态有效，但当前节点的 Runtime Metadata cache 尚待 Manager 重建 |
| `log_size_exceeded` | `ResourceExhausted`，停止追加普通日志 | 普通日志已达到固定上限 |
| `internal_error` | `Internal`，按幂等边界重试或重新同步 | 非 timeout/cancel 的未知服务端故障，服务端无法保证本次命令是否执行 |

create 的 repository archived/empty/unavailable、ref not found 和 repo permission 等分类继续使用权限模型中定义的稳定名称；它们都属于 create 前置结果，不改变既有 codespace 的生命周期。访问判定 RPC 在 `denied` outcome 中使用同一分类字符串，不把正常拒绝转换成 Connect error。`FinalizeOperation` 对已经结束或被替换的 operation 返回普通成功，只用 `resource_absent` 标记数据库记录不存在；表中的 Connect `stale_operation` 用于 `UpdateLog`、`ReportRuntimeTransition` 等仍可能继续写入旧上下文的 command RPC。

请求格式不合法和 Runtime Metadata typed fields 校验错误统一使用 `invalid_argument`；create/resume final 尚未取得当前 ready 快照使用 `metadata_required`，交互入口 cache 暂时缺失使用 `metadata_rebuilding`。active create/resume 的阶段进度仍由 Runtime Metadata 表达，进入 running 后 ready 不再回退，因此无需为 running 增加另一个未就绪分类。Manager 的 declared runtime state 与 heartbeat 分别映射为 `manager_recovering` 和 `manager_offline`。

`CONTROL_PLANE_TIMEOUT` 到期返回 Connect `DeadlineExceeded`，caller 取消返回 Connect `Canceled`；两者是传输执行边界，不附 `FailureDetail`。Manager 对可重放 RPC 使用已有 operation/generation/offset 幂等规则恢复。这样业务拒绝使用稳定 category，传输终止使用 Connect 标准 code，不把 timeout 伪装成内部业务错误。

实现验收点：

- 同一失败条件在不同 handler 中返回同一 category 和 Connect code，调用方按表中处理方式执行。
- final 缺少当前 ready 快照、Token 行与交互 cache miss 分别返回 `metadata_required`、`gitea_token_required` 和 `metadata_rebuilding`；running 没有独立的未就绪分类。
- FinalizeOperation 的首次接受、重复提交和旧结果统一返回 `resource_absent=false`，记录不存在返回 `resource_absent=true`；非法参数和仍需调用方修复的 command rejection 使用 Connect error detail。
- `stale_generation` 携带当前 generation；`generation_conflict` 和 `state_history_conflict` 不携带 stale detail 且不可重试；历史冲突不触发 Gitea 状态写入或本地清理指令。日志 offset 冲突携带当前 offset，Manager 不解析 message 文本恢复。
- 非法 metadata 使用 `invalid_argument`；final 缺少当前 ready 快照和交互 cache miss 使用上文两个明确分类。
- 未知内部错误统一为 `internal_error`，不会把数据库或 token 正文暴露给 caller。
- control-plane deadline 和 caller cancel 分别返回 `DeadlineExceeded`、`Canceled` 且不附业务 detail；已提交事务由幂等重试读取当前结果。

### Manager 身份创建

Manager 身份由 Gitea 管理页创建，不通过 ManagerService RPC 创建。站点管理员可以创建 `user_id=0` 的全局 Manager；个人用户只能在自己的设置页创建个人 Manager。创建服务在 Codespace user relation lock 和同一数据库事务中插入 `codespace_manager`，生成随机 Manager Secret，保存 `secret_hash / secret_salt`，并把明文 secret 只返回给当前 Web 响应。

Manager 进程通过本地状态读取 Gitea 控制面 URL、Manager ID 和 Manager Secret。本地状态可由管理员面板写入；单机部署使用 SQLite 保存，Manager Secret 加密后落盘。RPC 层只验证已存在 Manager 身份；删除 Manager 记录后，旧 secret 在下一次 RPC 认证时失效。**设计如此：**身份签发属于 Gitea 的管理和审计动作，运行进程只消费既有身份。把身份放入 Manager 本地状态，可以支持一个部署管理多个 Gitea 站点，同时避免通过可重复调用的注册 RPC 在网络重试、配置复制或多站点部署时产生额外 Manager 身份。

实现验收点：

- Manager 创建成功只在当前页面响应中展示一次明文 secret；列表、详情、刷新和 API 错误都不回显 secret。Manager 管理面保存 secret 后只返回站点和 Manager 摘要，不返回明文 secret。
- 创建 Manager 身份与保存 secret hash/salt 在同一事务中完成，失败不留下半条 Manager 记录。
- 全局 Manager 使用 `user_id=0`，个人 Manager 使用当前个人用户 ID；组织没有 Manager 身份创建入口。
- ManagerService 不包含创建身份的 RPC；所有 RPC 都使用 Manager ID 和 Manager Secret header 认证。
- 删除 Manager 记录后，旧 Manager ID 和 secret 不能继续认证；旧进程收到明确认证失败后关闭本地入口并停止 RPC。

### BindRuntimeIdentity

`BindRuntimeIdentity` 是 create operation 被 Manager 领取后的第一步。queued create 在 Gitea 数据库中只有内部 `codespace.id`，没有运行侧 UUID；Manager 领取 payload 后先生成新的 UUID v4，并在修改 Incus 或写入运行侧资源前调用该 RPC 绑定到当前 Codespace。

服务端在 Codespace lock 内按 `codespace_id`、`manager_id` 和 `operation_rversion` 复检当前 create operation。`codespace.uuid` 为空时写入 Manager 提交的 runtime UUID；已经写入相同 UUID 时幂等成功；已经写入不同 UUID 或同一 UUID 被其他 Codespace 使用时返回状态冲突。绑定完成后，metadata、inventory、Gateway、SSH、日志、凭据和 final 等运行侧 RPC 均使用 runtime UUID 解析回该 Codespace。

**设计如此：Gitea 负责生命周期记录，Manager 负责运行侧身份。**create 排队期间使用数据库自增 ID 可以让 Web 页面、日志和删除操作立即可用；Manager 在真正承接运行资源前分配 UUID，可以保证 Incus 名称、Gateway host、SSH username、本地快照和缓存命名都由同一运行侧身份驱动。绑定 RPC 是 Gitea 接受该身份的提交点，因此不会出现已经创建 Incus 实例但 Gitea 不认识该 UUID 的正常路径。

实现验收点：

- create payload 在绑定前携带 `codespace_id`，`runtime_uuid` 为空；Manager 必须先成功调用 `BindRuntimeIdentity` 才能创建 Incus 资源。
- `BindRuntimeIdentity` 只接受当前绑定 Manager、当前 create operation version 和合法 UUID v4。
- 相同 UUID 的重复绑定幂等成功；不同 UUID 的重复绑定、跨 Codespace UUID 重复和错误 Manager 请求都失败且不修改数据库。
- 绑定后所有运行侧 RPC 按 runtime UUID 查找 Codespace；未绑定对象的 open、SSH、Endpoint 和 metadata 相关入口不可用。

### DeclareManager

- `DeclareManager` 提交 Manager 客户端当前稳定配置和运行状态的完整快照，不是身份创建后不可修改的配置。客户端可修改并重新声明名称、版本、Gateway/SSH 地址、环境 tag 与说明、SSH host key 信息和 `manager_runtime_state`；容量由 Manager 本地配置与每次 Fetch 的当前可用槽位表达。
- Declare 与所有其他 request 一样必须提交 `protocol_version=1`。统一入口先认证 Manager，再在更新 heartbeat、取得声明写锁或校验其余快照字段前完成协议版本检查；不匹配时返回 `protocol_mismatch`，现有 Manager 记录、地址和在线时间全部保持原值。
- 每次请求都携带完整字段；Gitea 校验成功后在同一事务整体覆盖 `name`、`tags_json`、`runtime_state`、版本、Gateway SSH host key 类型化列和两条 `codespace_manager_address`。字段缺失或空值只按该字段自身规则校验，不表示“保持旧值”，因此不需要 PATCH、字段掩码或 declaration version。
- `manager_id`、`user_id`、secret verifier、inventory generation 和已有 Codespace binding 不由 Declare 修改。Manager secret 从身份创建成功起保持有效，删除 Manager 记录时失效。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Declare 要么完整接受，要么完整拒绝；任一字段格式校验失败时，不更新任何声明字段或 `last_online_unix`。共享 Gateway URL 或 SSH 地址只作为部署诊断保存，不作为声明失败条件。其他 RPC 认证成功也不隐式恢复 online。超过 offline timeout 的 Manager 必须先 Declare recovering，完成完整 inventory、Runtime 映射和 worker 上下文分类后再 Declare online，才能领取新的 create/resume。
- response 确认完整快照已经接受，并返回服务端选定的心跳周期、Runtime Metadata 刷新周期、控制面消息大小上限和规范 `gitea_web_url`。前三项控制运行周期与传输，`gitea_web_url` 来自 Gitea `ROOT_URL`，供 Gateway 把缺少本地 session 的浏览器导航带回 Codespace 详情页完成登录和打开确认；Manager 启动环境中的 Gitea URL 可能是内网控制面地址，不能承担该职责。这些响应字段不增加新的持久状态。
- 设 `MANAGER_OFFLINE_TIMEOUT` 的毫秒值为 `O`。Gitea 返回 `heartbeat_interval_milliseconds=floor(O/4)`、`runtime_metadata_refresh_interval_milliseconds=floor(O/2)`；Runtime Metadata TTL 保持 `O*2`。Manager 启动后立即以 recovering Declare，成功取得三个正数和合法 `gitea_web_url` 后才启动周期任务和领取流程，后续成功响应原子替换当前值。相同的 Runtime Metadata 刷新周期不重新开始计时；只有首次取得或实际变化时才重新调度，这样心跳不会把 ready metadata 的续期推迟到 TTL 之后。
- Manager 使用本地单调时钟维持单个进行中的 Declare，请求完成后在返回的心跳周期内发起下一次；临时错误的退避也不超过该周期。心跳不使用正抖动，使服务端选定的周期就是最晚重试边界。
- Manager 重启恢复期间通过 `DeclareManager` 上报 `manager_runtime_state=recovering`，必要 listener、完整 inventory、Runtime 映射和 worker 上下文分类完成后上报 `manager_runtime_state=online`。
- `codespace_manager.runtime_state` 只保存 Manager 声明的 `online|recovering`；offline 根据 `last_online_unix + MANAGER_OFFLINE_TIMEOUT` 实时派生，不回写该字段。

服务端统一计算周期，是因为 Manager 无法读取 Gitea 配置，分别配置会产生健康 Manager 被判离线或 metadata 提前过期的组合。四分之一离线超时允许一次短暂网络抖动或单次 heartbeat 延迟，二分之一离线超时等于 metadata TTL 的四分之一，允许多次刷新失败后再过期。`recovering` 运行态让 Gitea 区分“Manager 正在恢复本地控制能力”和“Manager 完全不可达”，从而保留已有 codespace 主状态并暂停新的 create/resume 领取。它不暂停或延长 active operation lease，operation 始终使用自身 deadline。

**设计理由：Manager 的全局恢复和单个 Codespace 的交互恢复使用不同边界。**完整 inventory、Runtime 映射和 worker 上下文分类完成后，Manager 可以 Declare online，并按真实容量领取其他 operation；上下文完整的旧 operation 只有在 Fetch 成功续租并返回新的相对有效时长后才能继续，上下文缺失的 operation 等待正常超时。Runtime Metadata、凭据、Incus backend、Endpoint proxy、路由和本地 `pending_runtime_transition` 由 online 后的逐 Codespace 任务恢复，单个对象完成当前 ready 上报前保持本地 session 准入关闭。这样对象级故障不会阻塞其他工作，外部 cache 中保留的旧 ready 快照也不能提前建立连接。

Declare 校验：

- `gateway_url` 使用 absolute `http://` 或 `https://` URL，只包含 ASCII DNS base domain 和可选 port，不接受 IP literal、userinfo、query、fragment 或非根 path。根 path `/` 在规范化后移除。base domain 转小写后不能有末尾点，每个 label 长度为 1..63 且只使用字母、数字和内部连字符；使用最长普通 Endpoint label 派生出的完整 Host 不能超过 253 字节。站点可通过 `GATEWAY_REQUIRE_HTTPS` 要求 HTTPS；默认允许 HTTP，便于受信内网和开发环境部署。
- Gitea 使用公共后缀规则计算 `ROOT_URL` host 和 `probe.{gateway_domain}` 的可注册域。两者相同、Gateway base domain 覆盖 Gitea host，或 Gateway base domain 落入 `[session].DOMAIN` 时，Gitea 记录部署告警但继续接受 Declare。Gitea `ROOT_URL` 使用 IP literal 时，它与 DNS Gateway 天然分属不同站点，继续执行其余诊断。**设计如此：推荐 Runtime 用户内容与 Gitea 登录站点使用不同可注册域，但开源部署可能处于受信内网、本地开发、单用户环境或自定义域策略下；系统负责识别并说明风险，不替管理员阻断明确选择。**
- `gateway_url` 的 base domain 可以和 Gitea `ROOT_URL` 或 `[session].DOMAIN` 处于同一 cookie scope；该情况只进入告警日志。比较时 host 和 Cookie Domain 转小写、移除 Cookie Domain 的前导点，并按完整 DNS label 判断。语法非法、IP literal、业务 path、派生 Host 过长和 HTTPS 强制配置不满足仍是硬错误；与其他 Manager 的规范化地址相同只进入共享入口诊断。
- 规范化 `gateway_url` 按 `scheme + lower-case host + effective port` 写入 `codespace_manager_address(kind=gateway)`，普通索引用于查找共享入口。Endpoint host 不包含 `manager_id`，Gateway 通过 Runtime UUID、Open Code binding 和 session 复检确认目标 Manager 与站点。
- Gitea 从该 base domain 派生 `{uuid32}.{domain}` 和 `{endpoint_id}-{uuid32}.{domain}`，因此部署需要把 base domain 与单层 wildcard DNS 都指向 Gateway；HTTPS 证书需要同时覆盖 base domain 和单层 wildcard。
- `gateway_ssh_addr` 来自 Manager 当前状态，固定格式为 `host:port`；DNS host 转为小写，port 规范化为十进制且范围为 1-65535。规范化结果写入 `codespace_manager_address(kind=ssh)`，普通索引用于诊断共享入口；同 host 不同 port 可以分别使用。共享 SSH 入口通过用户名中的完整 Runtime UUID 解析目标。
- 两类规范化地址编码后的长度上限均为 512 bytes；超限返回 `invalid_argument`。服务层在写入前完成长度检查，地址表普通索引用于按完整地址查找共享入口。
- `gateway_ssh_host_key_algorithm` 非空，例如 `ssh-ed25519`。
- `gateway_ssh_host_key_fingerprint_sha256` 使用 OpenSSH SHA256 fingerprint 格式，例如 `SHA256:...`。
- `gateway_ssh_host_key_updated_unix` 是 Unix 时间戳。
- `name` trim 后长度为 1-255，`version` trim 后长度为 1-64；二者用于展示和诊断，不参与生命周期推进。
- [x] `protocol_version` 固定等于当前 ManagerService 主版本 1，不保存到 Manager 行，也不参与 Manager matching。软件 `version` 和最近一次 Declare 都不能替代当前 request 的检查。
- 环境声明必须包含 1..64 项。每项 tag 转为 lower-case 后使用 `[a-z0-9_-]+`、长度为 1..64，说明 trim 后最长 255 字符；规范化后的重复 tag 作为配置错误拒绝，避免同一个 Manager 对同一环境给出两套解释。
- Declare 只提交 Manager 的身份、Gateway 地址、环境声明、软件版本和当前运行状态，不提交容量。环境声明以 `{tag, description}` 快照写入现有 `tags_json`；字段名沿用数据库既有结构，值的语义是环境对象数组。Manager 本地 `capacity_total` 继续限制 Runtime 总数，当前可用槽位及本轮可创建的 tag 在每次 Fetch 时提交。**设计如此：**环境 tag 与说明是需要持久化和展示的稳定能力声明，而容量会随实例、配额与 worker 状态持续变化，把两者分开可以避免 Gitea 使用过期容量。

SSH 是 Manager 的必备能力。Web Endpoint 和 SSH 都属于 codespace 的交互入口，统一要求 Manager 声明 SSH 地址和 Gateway SSH host key 指纹，可以让 UI、权限判定、用户首次连接核对和 Gateway 部署健康检查有稳定能力基线。

实现验收点：

- Manager 修改可声明字段后，下一次成功 Declare 用当前完整快照覆盖原值；Gitea 不保存声明历史。
- [x] Declare 协议版本不匹配时不更新声明字段、地址或 `last_online_unix`；协议不匹配的 Manager 不能保持 online。
- 环境声明修改只影响之后尚未领取的 create；已有 binding、已领取 operation 和 stop/resume/delete 不重新匹配。
- 相同 Manager 的地址未变化 heartbeat 正常更新在线时间；其他 Manager 使用相同 Gateway URL 或 SSH 地址时，本次 Declare 仍然成功并写入当前快照。
- Gateway 基础域名与 Gitea 派生 Endpoint 处于同一可注册域、覆盖 Gitea host/wildcard，或与 session Cookie Domain 冲突时记录部署告警；修改 `ROOT_URL` 或 `[session].DOMAIN` 后，Gitea 启动扫描已有 Gateway 地址并执行相同诊断，启动继续完成。
- Gateway base domain、最长派生 Host、label、末尾点和端口规范化使用同一校验器；Declare、启动扫描和页面 URL 派生不会接受不同的 Host 语法。
- Declare 在 Manager lock 内整体写入 Gateway/SSH 地址和声明快照；与 Manager 删除并发时只产生完整声明或记录不存在两种结果。
- Manager 本地 Runtime 总数超过 10000 时保持 recovering；该本地保护不扩展为 Declare 字段。
- recovering heartbeat 只更新声明快照和 `last_online_unix`，不读写 active operation deadline。
- Declare 响应中的三个数值参数都为正数，心跳周期等于离线超时毫秒值的四分之一向下取整，metadata 刷新周期等于二分之一向下取整，消息上限等于当前有效配置；`gitea_web_url` 是包含 AppSubURL、path 以 `/` 结尾且不含 userinfo/query/fragment 的规范 HTTP(S) `ROOT_URL`。修改 Gitea 配置不要求同步修改 Manager 配置；持续收到相同 Declare 响应时，Manager 仍按既定刷新周期续期 Runtime Metadata。
- Manager 在 operation deadline 之后才 Declare recovering 时，Fetch 和 final 均按普通超时结果处理。
- Manager 恢复完整 inventory、Runtime 映射并完成 worker 上下文分类后可以 Declare online，再逐 Codespace 恢复 metadata、credential、Incus backend、Endpoint proxy 和本地 `health_stop_pending`、`pending_runtime_transition`、`cleanup_pending`。单个 Codespace 在本地验证完成前保持 session 准入关闭，但不阻塞 Manager 领取其他 operation；stopped Runtime 只在后续 resume 阶段重新验证 Incus exec/file、workspace 和 proxy。
- Manager online 后的 Fetch 使用真实 `startup_capacity_available`、`cleanup_capacity_available` 和当前 `accepted_operation_types`；只有全局 Incus、listener 或控制面能力不可用时才以 recovering 或两类零容量暂停新任务领取。

### FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。认证完成后，handler 取得调用方 `codespace_manager_{manager_id}` lock，并在整个请求期间持有；随后在锁内重新读取 Manager 的 runtime state、heartbeat、tags 和用户作用域，再处理版本预检、running operation、queued claim 与 payload 构造。Manager 身份删除取得同一 Manager lock，因此能与该 Manager 的 claim 和上报形成明确先后。用户删除逐条取得 Codespace lock 并依靠数据库复检裁决，不阻塞该 Manager 对其他 Codespace 的处理。

`FetchOperations` request：

| 字段 | 说明 |
| --- | --- |
| `startup_capacity_available` | Manager 可立即承接的新 create/resume 数量（仅用于本次领取判断，不写入数据库） |
| `accepted_operation_types` | 本次接受的新建类型：`create|resume`；stop/delete 不依赖该字段 |
| `accepted_create_tags` | 本轮具备 create 容量的已声明环境 tag 子集；只影响新的 create 领取 |
| `observed_operations` | Manager 已持有完整 active operation 上下文的 `runtime_uuid + operation_rversion` |
| `cleanup_capacity_available` | Manager 可立即承接的新 stop/delete 数量（仅用于本次领取判断，不写入数据库） |

Fetch 先校验 observed UUID 唯一且版本为正数，并批量读取仍存在且绑定当前 Manager 的 Codespace 当前 `operation_rversion`。任一 observed 版本高于对应当前版本时，整个请求返回 `state_history_conflict`；该检查发生在租约续期、timeout State Finalization、queued claim 和其他业务写入前，因此冲突请求没有部分结果。UUID 无记录或 binding 不匹配不能证明历史倒退，本次不续租该项，由后续完整 inventory 根据当前数据库关系返回 cleanup。

预检通过后，Fetch 处理已绑定当前 Manager 的 running operation，并先检查原 deadline。功能启用且 deadline 未到期时，相同 `observed_operations` 版本只刷新 lease，并通过 `renewed_leases` 返回相对有效时长；observed 版本较低表示本地仍有完整的较早 operation 上下文，此时返回当前 payload 并刷新 lease。未提交 observed 项表示本地上下文缺失，无论 Manager 声明为 online 还是 recovering，Gitea 都保持 operation 等待原 deadline。站点排空时，本地上下文完整的 running stop/delete 仍按普通规则恢复，running create/resume 只在 deadline 未到期时返回对应的 `abort_create|abort_resume` 空命令。abort 不重发来源数据，也不刷新 lease。然后再按以下优先级领取 queued operation：

```text
delete -> stop -> resume -> create
```

领取条件：

| operation | 条件 |
| --- | --- |
| `delete` | 已绑定当前 Manager，主状态为 `deleting`，`operation_status=queued`，清理容量可用 |
| `stop` | 已绑定当前 Manager，主状态为 `running`，`operation_type=stop`，`operation_status=queued`，清理容量可用 |
| `resume` | 功能启用，已绑定当前 Manager，主状态为 `stopped`，`operation_type=resume`，`operation_status=queued`，本次声明接受 resume，容量可用，caller 声明 `runtime_state=online` 且未按 heartbeat timeout 派生为 offline |
| `create` | 功能启用，未绑定 Manager，主状态为 `creating`，`operation_type=create`，`operation_status=queued`，Manager 为站点全局或属于创建者本人，tag 匹配，本次声明接受 create，容量可用，caller 声明 `runtime_state=online` 且未按 heartbeat timeout 派生为 offline |

create、resume、delete 和用户 stop 的 `operation_trigger` 为 `user`；自动暂停 stop 为 `idle`。来源只在 Gitea 中区分领取前是否可被用户交互取消，Manager 对两类 stop 执行同一命令，因此 operation envelope 不返回 trigger。queued idle stop 在 claim 条件更新前可被用户交互或设置事务取消；claim 成功把 `operation_status` 写为 running 后，后到交互按 stopping 处理。

领取成功后返回 `operations[]`：

- `operation_rversion`
- `runtime_uuid`
- `lease_valid_for_milliseconds`
- `log_offset`
- create 所需 repository/ref/commit 字段；resume 不包含 repository payload
- `repo_id=0` 的 running create 在 Manager 已观察到相同版本时只续租；Manager 缺少上下文时等待原 deadline
- 站点排空后，已领取且 deadline 未到期的 running create/resume 只返回对应 abort 命令，用于本地清理和 `final failed`

observed-only 续租返回 `renewed_leases[]`，每项只包含 `runtime_uuid + operation_rversion + lease_valid_for_milliseconds`。同一 UUID 在一次响应中只能进入 `operations` 或 `renewed_leases` 之一；abort 不续租，因此只进入 `operations` 且相对有效时长为 0。

`operation_deadline_unix` 是 Gitea 写入数据库并用于 Fetch、FinalizeOperation 和 Cron 竞态判定的绝对截止边界。首次领取固定 `operation_started_unix`，总执行期限由 `operation_started_unix + OPERATION_MAX_DURATION` 推导。每次领取或批量续租在事务内读取一次 `grant_time`，把向未来取整的 `grant_time + OPERATION_LEASE_TIMEOUT` 与固定总期限取较早值写入数据库。`lease_valid_for_milliseconds` 通常等于配置 lease；最后一段授权返回从 `grant_time` 到总期限向下取整的实际正整数毫秒数，剩余不足 1 毫秒时直接 timeout。绝对 deadline 只属于 Gitea，不通过 RPC 回传；Manager 只用本次实际相对时长和本地单调时钟限制 Incus 执行。

delete 和 stop 是资源回收动作，使用 Manager 独立的清理容量；resume 和 create 使用启动容量。优先级只在仍有对应容量的候选之间生效：清理容量为 0 时跳过 delete/stop 并继续检查 resume/create，启动容量为 0 时仍可领取 delete/stop。这样资源回收不与 Runtime 启动争用执行槽，也不会在本地清理 worker 全部繁忙时提前开始新的 operation deadline。resume 基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository。`operation_rversion` 绑定本次 Gitea 下发的 operation 版本，Manager 后续 operation-bound RPC 都用它校验归属。

Manager matching 沿用 Actions `runs-on` 的分层方式。Gitea 从认证后的当前 `codespace_manager.tags_json` 解析环境声明快照，并要求 Fetch 的 `accepted_create_tags` 是其中的规范 tag 子集。create 候选查询按 operation 字段、`environment_tag IN accepted_create_tags` 和 `codespace.user_id` 筛选，站点全局 Manager 不加用户限制。`accepted_operation_types`、capacity 和最终状态在 Go 中判断。**设计如此：**Declare 表达 Manager 稳定提供哪些环境，Fetch 表达这些环境中本轮哪些还能创建实例；二者分开后，一个高规格环境配额不足不会阻塞同一 Manager 上仍可创建的其他环境。

**设计理由：站点全局 Manager 与创建者的个人 Manager 同时匹配时采用同等竞争。**满足创建者范围、tag、online 和 capacity 条件的 Manager 都参与同一条件 UPDATE，首个更新成功者取得 create；绑定成立后保持不变。站点全局 Manager 表示可服务全部用户的容量，个人 Manager 表示该用户自有容量，两者均没有等待优先级。一次数据库竞争即可完成 claim，无需等待窗口或容量预留。

最终 create claim 使用单条条件更新，按内部 ID、`status=creating`、当前 `operation_rversion`、`manager_id=0`、`operation_type=create`、`operation_status=queued`、`operation_trigger=user`、候选读取到的正数 `repo_id` 和属于本轮 `accepted_create_tags` 的 `environment_tag` 匹配目标；个人 Manager 还要求 `codespace.user_id` 等于 Manager 的 `user_id`，站点全局 Manager 不限制用户。affected rows 为 1 才表示 claim 成功。create payload 使用内部 ID 作为绑定 Runtime UUID 前的 Gitea 记录定位，页面也使用内部 ID；绑定完成后的运行侧协议继续使用 Runtime UUID。repository 转移不改变创建者，因此不会改变候选 Manager；repository 删除会先把 `repo_id` 置零，普通未绑定 delete 或用户删除会物理删除记录，因此这些事务先提交时 claim 影响 0 行。Fetch 已持有调用方 Manager lock，完整条件更新已经给出唯一提交结果，因此 claim 不需要 repository 或 Codespace lock；`CreateCodespace` 记录插入事务使用创建者的 Codespace user relation lock 与 repository lock，repository 删除和 transfer 只使用 repository lock。

`startup_capacity_available` 和 `cleanup_capacity_available` 范围均为 `0..256`。Gitea 以两者之和推导 `operations` 上限，并限制为 `1..256`；`renewed_leases` 最多与 request 的 observed 数量相同，不占 payload 名额。已有 running operation 的当前 payload、续租和 abort 都不扣减两类新领取容量。两个容量都为 0 时，Fetch 仍处理 observed operation 和 timeout，但不领取 queued operation。`observed_operations` 最多 10000 条，每个 UUID 在一次请求中唯一。每种优先级在稳定 scope/tag 筛选后使用 `operation_created_unix, id` 升序读取有界候选；单次 Fetch 合计最多检查 1024 个 queued 候选。内部 ID 只解决相同创建时间的稳定排序，不进入 payload。Manager 调用 Fetch 的周期不超过 `OPERATION_LEASE_TIMEOUT / 3`。站点排空时不领取 queued create/resume，queued stop/delete 仅按清理容量领取，running operation 继续正常处理。abort create/resume 不续租；create 的 `final failed` 写为 failed，resume 的 `final failed` 在确认启动回滚后写为 stopped。

Fetch 在处理每条 running operation 时，于 Codespace lock 内先检查 `operation_deadline_unix`，再决定 observed 续租、返回当前 payload 或 abort。deadline 未到期时按普通规则处理，但新 deadline 不能越过固定总执行期限；已经到期时执行 timeout State Finalization，不返回 payload、续租回执或 abort，也不计入服务端推导的 payload 上限。站点排空的 create/resume 只在 deadline 未到期时返回一次性 abort 命令且不写新 deadline。这与 FinalizeOperation 和 Cron 使用同一条件更新边界，observed 批量续租不能恢复已经超时或达到总期限的 operation。

Fetch 对每个 queued 候选在 claim 前检查 `operation_created_unix + QUEUE_TIMEOUT`。已到硬截止时间的候选由处理函数在 Codespace lock 内重新读取并确认仍为同一 queued operation，再通过内部 ID 执行 timeout State Finalization，然后继续本批其他候选。该项不计入服务端推导的 payload 上限，未被 Fetch 遇到的过期记录由 reconciliation Cron 处理。

timeout State Finalization 使用固定映射：queued create/delete 进入 failed，queued resume/stop 分别保持 stopped/running；running create/stop/delete 进入 failed，running resume 写为 stopped。所有分支清空 active operation；failed 结果删除 Token 与 Git SSH Key，stopped 结果删除 Token 并保留 Git SSH Key，保持 running 的 queued stop 保留现有开发凭据。该映射保留 resume 已经初始化的 workspace 和恢复所需 SSH 私钥配对关系；stop 超时进入 failed 是因为 Gitea 没有收到 Manager 对 stopped 结果的证明。详细原因见[状态机超时处理](state-machine.md#超时处理)。

单次 Fetch 不持有覆盖整批操作的事务。running lease 刷新和每条 queued claim 都在各自短事务中条件更新；claim 提交后再构造 payload。payload 加入响应前按候选内部 ID 重新读取，并确认 `operation_rversion`、`manager_id`、`operation_type`、`operation_trigger` 和 `operation_status=running` 与本次 claim 一致；账户清理已经删除记录或其他流程已经替换 operation 时跳过该候选。create repository/user 数据加载或 payload 构造失败时，服务在仍持有 Manager lock 的情况下，以单独短事务按当前内部 ID、`operation_rversion`、`manager_id`、`operation_type`、`operation_trigger` 和 `operation_status=running` 释放尚未下发的 claim：恢复 queued 和 operation 时间字段，create 同时恢复 `manager_id=0`，来源保持不变。payload 构造或释放失败会终止本次 RPC，不返回已经累积的部分 response；数据库连接等系统性错误、RPC 响应失败或响应丢失也不提供部分结果，已经提交且无法确认释放的 claim 保持 running 并等待原 deadline。**设计如此：**Connect 错误响应不能同时携带可安全消费的部分调度结果，Manager 只处理完整成功响应；内部 ID 与调度索引和数据库主键一致，适合短事务复读和条件更新，UUID 继续作为对象锁、日志与 Manager 协议中的公开身份。每条 claim 独立提交，无法确认 payload 已被 Manager 持久化时不会再次启动动作。

实现验收点：

- Fetch 在租约、timeout 和 claim 前批量预检 observed operation；任一版本高于已存在且绑定当前 Manager 的 Codespace 当前版本时，整次请求返回 `state_history_conflict` 且没有业务写入。无记录或 binding 不匹配不续租，等待完整 inventory 收敛。
- 单次 `FetchOperations` 可返回多个 operation。
- `operations` 总返回数量不超过服务端由两类容量推导并限制在 `1..256` 的 payload 上限。
- 本次新领取的 queued create/resume 数量不超过 `startup_capacity_available`；已有上下文的 running operation 和 abort 不占新容量。
- 本次新领取的 queued stop/delete 数量不超过 `cleanup_capacity_available`；清理容量耗尽时跳过该类并继续处理具有启动容量的 resume/create。
- running operation 的当前 payload 因 observed 版本较低而返回时不占 create/resume capacity，但计入服务端推导的 payload 上限。
- 功能启用时，以及站点排空下的 stop/delete 已上报相同 `observed_operations` 版本时，不重复下发完整 payload，而是返回 `renewed_leases` 回执。
- 上述仍在 deadline 内的已观察 operation 由 Fetch 刷新 lease，续租回执不计入 payload 上限；站点排空下的 create/resume 在 deadline 未到期时返回 abort 并计入 `operations`，到期时直接 timeout。
- 普通 payload 和续租回执返回与本次服务端授予一致的正数相对有效时长；abort 返回 0，且不写新 deadline。
- 普通领取、当前 payload 和批量续租把向未来取整的 `grant_time + OPERATION_LEASE_TIMEOUT` 与 `operation_started_unix + OPERATION_MAX_DURATION` 取较早值作为 Gitea deadline；响应返回本次实际授予的正整数毫秒数，只有最后一段授权可以短于标准 lease。
- Fetch 不提交总容量或重复的总数上限；Gitea 只校验两类当前可用容量并据此确定本次 payload 上限。
- timeout、当前 payload 和 abort 都不进入 `renewed_leases`；Manager 不能把缺少续租回执解释为 operation 已清除。
- running operation 在 observed 续租或返回当前 payload 前检查 deadline；过期项直接 timeout，不进入 response。
- 领取通过数据库条件更新完成；affected rows 为 0 时继续尝试下一个候选。
- 遇到过期 queued 候选时条件写入 timeout 结果，不领取、不计入 payload 上限，且不阻断同批其他候选。
- timeout 按 operation 类型写入稳定主状态；resume timeout 不进入 failed 或触发破坏性 workspace cleanup，stop timeout 进入 failed 后按 failed 记录收敛。
- Fetch 的 `accepted_create_tags` 只能选择认证 Manager 最新环境声明中的 tag；声明或本轮接受集合变化后，下一次 create 候选查询和 claim 使用新值。
- create claim 条件更新重新确认 repository 存在和当前 owner；与 transfer 并发时只产生 transfer 前成功绑定或 transfer 后旧 scope 领取失败两种结果。
- 站点全局 Manager 与创建者的个人 Manager 同时匹配时允许任一合格 Manager 领取，但只有一个条件更新成功；成功 binding 不自动迁移。
- 每条领取在自己的短事务中写入 `operation_status=running`、`operation_started_unix`、`operation_deadline_unix`；create 领取额外写入 `manager_id`。
- 领取不递增 `operation_rversion`。
- observed 版本较低的 running operation 返回当前 payload 时不执行 claim、不递增版本，但刷新 `operation_deadline_unix`；abort 不刷新。
- 站点排空后的 create/resume 在 deadline 未到期时返回 abort 命令且不刷新 lease；到期后不再返回命令。
- stop/delete 不占 create/resume 容量，并且只在本次存在清理容量时领取；两个容量都为 0 时仍可完成 observed 续租。
- 并发领取时只有一个 Manager 成功。
- Fetch 从重新读取 Manager 到完成 claim、payload 构造或条件释放始终持有调用方 Manager lock；Manager 身份删除取得同一 lock 后重新查询，因此删除提交后不会遗留指向已删除 Manager 的 binding。账户删除只锁定目标 Codespace 并通过事务复检清理关系，不取得外部或全局 Manager lock。
- create claim 与未绑定 delete 都包含内部 ID、当前版本、binding 和 operation 条件；只有一方 affected rows 为 1。claim 后按内部 ID 复读，payload 复检失败的候选不进入响应；绑定后的 Runtime UUID 继续用于运行侧对象锁和 Manager 协议。
- payload 构造失败的 operation 会被条件释放，且不会覆盖已经被替换的 operation；系统故障留下的 running claim 等待原 deadline。
- 单条候选构造失败不会回滚同批已经提交的 operation，但本次 RPC 整体返回错误且不返回部分 payload；Manager 未取得的已提交 operation 保持 running，并由原 deadline 收敛。系统性事务错误同样不返回部分未知结果。
- 系统性错误不返回 response；已提交 claim 和事务提交后响应丢失都保留 running，并由普通 timeout 收敛。
- 同类型 FIFO、request 上限、10000 条 observed 上限和单次合计候选扫描上限得到校验。

### FinalizeOperation

`FinalizeOperation` 只上报当前 operation 的 `final done` 或 `final failed`。运行中 operation 的续租统一由 `FetchOperations.observed_operations` 批量完成，使每个 lease 只有一条更新路径，也避免每个 worker 额外发送独立续租 RPC。

Gitea 校验：

```text
runtime_uuid
operation_rversion
manager_id
operation_status=running
```

首次 final 在写入前直接检查 `operation_deadline_unix`。该字段已由固定总执行期限封顶；handler 发现当前版本 `now >= deadline` 且 Cron 尚未处理，就在 Codespace lock 内按 operation 类型执行 timeout State Finalization，随后保持已经成立的 timeout 结果并返回普通成功。该判断与 Fetch 批量续租和 Cron 使用相同条件更新，先成功的 final、续租或 timeout 生效，后到请求不覆盖当前状态。Manager 的 online、recovering 或 offline 状态不改变该 deadline 判断。

功能启用时按正常规则接受 final。站点在 operation 领取后进入排空时，stop/delete 仍按正常规则完成；create/resume 只允许追加清理日志和提交 `final failed`，Fetch 不再续租而是返回 abort。create 删除本轮新建的 Incus 实例后进入 failed；resume 确认本轮启动的实例已经停止后回到 stopped，保留实例根存储。该规则停止站点新增运行工作，同时不把可恢复 workspace 误标为破坏性失败，也不阻塞已有实例的 stop/delete。

final 必须携带 Manager 本地保存的原始 `operation_type`。active operation 仍存在时该类型必须与数据库一致；当前版本匹配但有效类型不同、版本已经被替换或主状态已经变化时，Gitea 不写入旧结果并返回普通成功，Manager 结束该 worker 的本地上下文。`UNSPECIFIED` 和未知枚举返回 `invalid_argument`。active operation 已清空后，数据库已经没有足够信息恢复原操作类型，因此 Gitea 保留当前主状态并返回普通成功。abort create/resume 仍分别携带本地原始类型。**设计如此：**final 表示 Manager 已经结束本地动作；旧结果不能覆盖服务端当前状态，也不值得仅为区分重复结果而保存 operation 历史。只有 Codespace 已物理删除需要 `resource_absent=true`，以便立即触发完整 inventory。

create/resume final done 都要求当前 operation 版本的 Runtime Metadata 已为 `ready` 且 Codespace Token 行完整。Manager 在 ready 前校验实际 workspace remote 的本地配置：HTTP(S) helper 必须读取当前 Gitea Token 文件，SSH 必须已经通过 `RequestRuntimeAccess` 确认同一公钥并写入可信 known_hosts。Gitea 不保存实际 remote 的第二份字段，也不根据首选 `git_protocol` 猜测，因此 final 不重复检查协议或 SSH Key；SSH 命令只有存在有效公钥关系时才能进入专用鉴权。任一步失败都仍由 active operation 的 lease、重试和 final failed 处理。这样 final done 提交后即可清除 operation，`running` 同时表示本次启动的本地凭据配置和交互入口已经就绪，不需要另一个跨重启的后置任务。

状态写入：

| operation | done | failed |
| --- | --- | --- |
| `create` | `status=running`，保留当前开发凭据并清空 active operation | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |
| `resume` | `status=running, last_active_unix=now`，保留 Token 与 Git SSH Key 并清空 active operation | `status=stopped`，物理删除 Token、保留 Git SSH Key 并清空 active operation |
| `stop` | `status=stopped`，物理删除 Token、保留 Git SSH Key 并清空 active operation | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |
| `delete` | 物理删除 Codespace、Token、Git SSH Key、日志和绑定数据 | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |

resume failed 只在 Manager 已确认本轮启动的 Incus 实例停止后上报，因此 operation 事务先保留实例根存储并写回 stopped。主状态事务提交后，Gitea 尽力清除本次 resume 的 Runtime Metadata；Manager 清除本轮 boot 发布上下文，不恢复历史 ready。普通可恢复失败允许下一次 resume 使用更高 operation 版本重建；实例根存储损坏、Git SSH 密钥材料矛盾或 Gitea 公钥绑定冲突时，Manager 已持久化的 `unrecoverable_failed` boot 终态会在 final failed 后驱动现有 `ReportRuntimeTransition(failed)`。进程重启继续该报告；如果新 resume 已先创建，Manager 领取后直接 final failed，再次上报 failed。详细原因仍留在 Manager 日志，final 协议保持现有 done/failed 两值。

Manager 负责报告 Gitea-issued operation 的动作结果，Gitea 负责把结果写成主状态、开发凭据生命周期绑定和日志追加窗口。State Finalization 在同一事务内完成这些写入，保证用户看到一致的生命周期结果。operation 完成后不保留 `done|failed` 状态，失败诊断从 Codespace 日志读取。

State Finalization 首次完成 final、timeout、missing 或 transition 处理时写 `updated_unix=now`；queued resume/stop timeout 或 queued idle stop 取消即使保持原稳定主状态，也因 active operation 首次结束而更新时间。创建或替换 active operation 同样更新该字段。claim、lease 续租、日志、Runtime Metadata、token 读取或修复、未取消 operation 的 open/SSH/继续运行/设置变更和相同结果的幂等重试不更新它，repository 删除仅把 `repo_id` 写为 0 时也不更新。这样 `updated_unix` 可以稳定表达生命周期变化，并作为 failed retention 起点，而不会被调度或普通交互活动延后。

State Finalization 主事务提交后，timeout、missing 和 Runtime 状态报告等由 Gitea 独立判定的异常通过日志专用锁尽力追加内部状态摘要。摘要由独立的 DBFS 追加事务保证内容与日志元数据共同提交；摘要失败只记录服务端告警，不回滚主状态。正常 final 和 Manager 已报告的失败使用已有 operation 分组及页面主状态表达，不再追加分组外的重复结果。delete done 已经物理删除记录和日志，直接跳过摘要；force/account/Manager delete 与 retention 清理同样不能重新创建日志。

实现验收点：

- lease 只由 Fetch observed 批量续租；FinalizeOperation 不包含续租分支。boot stage 由 Runtime Metadata 和日志表达。
- final result 触发一次 State Finalization。
- 首次接受、相同结果重复提交、过期 operation 版本或当前主状态不再接受旧结果时都返回 `resource_absent=false`；只有 Codespace 记录不存在时返回 `resource_absent=true`。
- final 的有效 operation 类型与当前同版本 active operation 不一致时不写入生命周期结果，Manager 清除旧上下文；非法枚举返回 invalid argument。active 已清空时保留当前主状态并返回普通成功，不声称恢复原类型。
- State Finalization 同事务处理主状态、包括来源在内的 active operation 清空，以及彼此独立的 Codespace Token 与 Git SSH Key 生命周期；active operation 清空后日志追加窗口关闭。
- create/resume 的 final done 在当前 operation 版本 ready metadata 或 Token 行缺失时被拒绝，active operation 保持可重试；实际 remote 的本地凭据配置由 Manager 在 ready 前验证，Gitea final 不增加协议分支，成功后不再存在凭据刷新任务。
- resume failed、timeout 和 abort 在状态结果成立后尽力清除本次启动 metadata；迟到的同版本上报不能在无 active resume 时重新写入。
- `updated_unix` 在创建记录、创建或替换 active operation，以及首次 final/timeout/missing/transition/queued idle stop 取消时更新；未改变 active operation 的交互或设置、claim、续租、metadata、日志、token 修复、幂等结果和 `repo_id` 置 0 不刷新该字段。
- timeout、missing 和 Runtime 状态报告等独立控制面判定在主事务提交后通过日志专用锁追加内部摘要；final 不重复写结果，物理删除不创建摘要。
- deadline 到期后的 final 在请求路径立即触发按 operation 类型定义的 timeout，并返回普通成功；Manager runtime state 不延长 deadline，且与 Fetch/Cron 并发时只有一个条件更新生效。
- codespace 已物理删除时返回 `outcome.resource_absent`；worker 清除本地 operation 上下文、结束该 operation 的上报并触发完整 inventory。`resource_absent` 本身不授权删除 Runtime；当前 inventory 查询明确无记录时再返回 `cleanup_local_runtime`。UUID 不复用，也不保存 operation 历史或 tombstone。
- 站点排空后已领取的 create/resume 只能 final failed，已领取或新领取的 stop/delete 可以正常完成。

### UpdateLog

- 写入 DBFS 路径 `codespace_log/{runtime_uuid}.log`。
- Gitea 服务层可为 timeout、missing runtime 和主动 Runtime 状态变化通过内部入口写入诊断摘要；Manager operation payload 携带当前 `log_offset`。
- request 使用结构化 `LogLine(timestamp_unix_nano, message)`；Gitea 脱敏后统一编码为 UTF-8 `[RFC3339Nano] message\n`，offset 按编码后的完整字节计算。
- 校验 `runtime_uuid + operation_rversion + manager_id` 匹配当前 running operation。
- offset 等于当前日志大小时追加。
- offset 小于当前日志大小时，只有规范化后的完整请求段已经全部存在且逐字节相同时才是幂等重放；请求段只与文件尾部分重叠时返回 offset conflict 和当前文件末尾，不追加剩余部分。
- offset 大于当前日志大小时返回 offset gap 分类，保持日志文件连续。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许当前 `operation_rversion` 对应的 running operation 追加日志。
- active operation 清空后，日志进入封闭状态。
- 单行最大长度由 Gitea 内部保护值控制，保证异常大行不会放大单次写入和页面读取。
- 日志总大小由 `LOG_MAX_SIZE` 控制。普通日志可用上限为 `LOG_MAX_SIZE` 减去内部状态摘要预留空间，超过后返回 log size exceeded 分类并写入明确截断摘要。
- 服务端固定预留内部状态摘要空间；达到普通日志上限后拒绝原始行，但 timeout、missing runtime 等控制面诊断仍可写入预留空间。
- keyed lock 内发现普通 batch 将使当前文件首次跨过普通日志上限时，只写一条截断摘要；文件已经达到上限后的普通行直接返回 `log_size_exceeded`，不再写摘要。截断摘要和内部状态摘要共同受 `LOG_MAX_SIZE` 硬上限约束。
- Manager 收到 `log_size_exceeded` 后停止对应生命周期 sink 的普通日志上传并继续执行 operation。这样日志上限同时限制存储和后续控制面请求，不会让已经明确截断的输出持续占用 RPC 与数据库事务。
- Manager 在 final 前关闭 operation 日志分组并上传剩余日志。final 结果由该分组中的执行结果和页面主状态共同表达；Gitea 只在独立判定 timeout、missing runtime 或 Runtime 状态变化时使用预留空间追加诊断摘要。该 DBFS 追加事务失败或预留耗尽时只记录服务端告警，不回滚生命周期状态。物理删除路径删除整份日志。
- 成功追加和内容一致的幂等重放都返回服务端当前 `next_offset`；该值是脱敏和规范化编码后的真实文件末尾。
- offset conflict/gap 返回 `FailureDetail` 和 `LogOffsetDetail(current_offset)`；Manager 从服务端位置恢复，不根据本地原始 message 估算 offset。

日志使用 byte offset 而不是行号作为写入幂等键，是因为 DBFS 提供 seek/write 能力，Manager 重试时可以精确重放同一段内容。offset gap 分类可以保证 UI tail、下载和后续清理都面对连续文件，不需要处理缺失片段。

实现验收点：

- 成功追加和相同内容幂等重放都返回真实 `next_offset`。
- 服务端脱敏改变字节数时，Manager 下一次追加仍使用 response offset 并成功连续写入。
- offset conflict/gap 携带 `LogOffsetDetail.current_offset`，且不产生不连续文件。
- 达到普通日志上限后只写一条截断摘要，重复请求不消耗内部状态摘要预留空间。
- 达到普通日志上限后，Manager 不再为当前 sink 发送后续普通行；生命周期命令继续运行，timeout、missing runtime 等内部状态摘要仍可写入预留空间。
- 部分重叠的重放不会补写尾部；内部状态摘要写入失败不回滚已经提交的 State Finalization，物理删除不会重新创建日志。

### ReportRuntimeMetadata

- 只写 [Runtime Metadata](glossary.md#runtime-metadata) 到 Gitea cache。
- Gitea 接受请求时写入 `last_reported_unix=now`；该字段不由 Manager 提交，也不参与内容 hash。
- request 携带 `metadata_generation`；高于 cache 当前版本时覆盖，相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回不可重试的 generation conflict 且不附 stale detail，更低版本返回 stale 和当前版本。cache miss 接受 Manager 重建的正 generation 快照。Manager 只对 stale 使用服务端当前值加一并重报当前完整快照；同代冲突表示本地状态损坏或存在第二写入者，Manager 停止发布并进入保守停止流程。
- 不写主状态。
- 校验调用方 Manager 已通过认证。
- 校验 `codespace.manager_id == caller.manager_id`，不匹配时返回 `manager_mismatch`。
- 只接受 `creating|running|stopped` 状态写入。
- 功能必须启用；站点排空返回 `state_unavailable`。
- Manager 必须声明为 online 或 recovering 且 heartbeat 有效；heartbeat 已派生 offline 时返回 `manager_offline`。
- `deleting|failed` 状态、旧 boot operation 版本以及已结束 resume 的同版本快照返回 `stale_operation`。
- stale 上报不写 cache，不改主状态。
- 成功写入时刷新 cache TTL 为 `MANAGER_OFFLINE_TIMEOUT * 2`。
- Manager 使用最近一次成功 Declare 返回的 `runtime_metadata_refresh_interval_milliseconds` 周期刷新；相同 generation、相同内容的刷新同样延长 TTL。
- `boot` 上下文按当前状态校验：active create/resume 使用当前 operation 版本并按适用的 `prepare-runtime|initialize-system|prepare-workspace|start-environment|publish-ready|ready` 顺序前进；running 只接受 boot 版本不大于当前 operation 版本的 `ready`；stopped 且无 active operation 时拒绝 metadata。同一 boot 版本的 stage 只能前进，已经接受 `ready` 后保持 `ready`。
- `stopped` 状态下只接受 active resume 的当前启动进度；没有 active operation 时不周期发布 Runtime Metadata，也不提供面向用户的 open 或 Gateway SSH。active resume 在原生运行时恢复保存的环境并写入当前凭据后、final done 前即可配置实际 remote 和恢复用户服务。
- metadata 使用 proto 中的 `RuntimeMetadata` typed message；`boot.operation_rversion` 必填，`publish-ready|ready` 的 `endpoints` 必须包含 Manager 生成的固定私有 `workspace`，其余项是 Runtime 声明的普通 Endpoint。Gitea 只校验 proto 声明的 typed 字段，不从字符串 JSON、自由 map 或扩展字段取得业务含义。SSH、SFTP、Web IDE 和普通 Endpoint 的实际 proxy 后端不进入 metadata，ready 证明本次启动已经完成 Manager 的本地后端和完整路由校验。
- Gitea 对每个 Endpoint label 独立执行 Runtime Metadata 统一校验：合法 UTF-8、去除首尾 Unicode 空白后保存、按 Unicode 字符数为 1 到 64，并且不包含控制字符、`<` 或 `>`。Gitea 不依赖 Manager 的校验结果，也不执行 Unicode 归一化、替换或自动清洗；内容 hash 使用校验后的规范值。
- Gitea 接受 CPU、内存和磁盘三类 `resource_usage`。used/limit 必须大于或等于 0，limit 为 0 表示限制未知；`observed_unix` 为正数时作为页面采样时间。资源指标只写入 Runtime Metadata cache 并进入创建者详情展示，不参与 final、open、SSH、公共 Endpoint、自动暂停、容量领取或治理摘要。采样缺失或暂不可用不影响 ready 判定。
- create/resume operation 只有在当前 metadata 的 boot 版本等于当前 operation 且 `stage=ready` 时可 final done。resume 还要求当前 Token 行完整；旧 operation 版本的 `ready` 不能完成本次恢复。stopped 状态下即使 active resume 已上报 ready，面向用户的 open/Gateway SSH 仍按主状态拒绝，直到 final done 原子写入 running；该限制不阻断初始化阶段的仓库开发凭据。
- Manager 启动后先保持 Runtime Metadata 发布关闭。active create/resume 在 Fetch 成功续租并继续启动流程后激活发布任务；稳定 running 在完整 inventory 同时确认 Gitea 与 Incus 状态后激活并重建 Runtime Metadata cache。稳定 stopped 不发布 metadata；Manager 本地保留 resume 输入和收敛状态，下一次合法 resume 从保留的 Incus 实例重建更高 generation 的完整快照。
- Manager 运行期间周期刷新 active create/resume 和 running Codespace 的 Runtime Metadata cache，避免 cache miss 后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 open/SSH 的 ready、普通 Endpoint existence 和 UI 展示。resume 不读取该 cache；主状态校验基于数据库 `codespace.status`，与 cache 信任无关。

每个 Codespace 的完整 metadata 只由 Manager 的一个发布任务串行发送。boot、Endpoint、resource usage、workspace route、Incus backend 和恢复流程先更新同一份本地当前快照，再唤醒该任务；内容没有变化时保留 generation 并只刷新 TTL。每个成功请求都按该请求实际携带的 boot 更新 ready 接受记录：只要 Gitea 接受过当前 create/resume operation 的 `ready`，operation worker 就可以提交 final；本地之后出现的更高 Endpoint 或 resource usage generation 继续由发布任务异步发送，不撤销 ready，也不阻塞 final。该单一写入顺序使阶段单调、Endpoint 更新、指标刷新和周期刷新共享同一个 generation 基线，不需要在 Gitea 保存待发布队列。

Runtime Metadata 是运行时信息，变化频繁，也可以由 Manager 重建，因此放在 cache 中。主状态和权限判断继续使用数据库字段。

实现验收点：

- Runtime Metadata 成功写入 cache。
- Runtime Metadata 请求使用 proto typed fields，Gitea 的校验、缓存写入和页面展示都读取同一份 `RuntimeMetadata`。
- `running` 交互入口同时依据主状态、Manager 在线态和 Runtime Metadata。
- Gitea cache 丢失后由 Manager 重建 Runtime Metadata。
- Manager 重启后不按本地快照存在性直接发布；active create/resume 经续租后的启动流程恢复，稳定 running 经完整 inventory 确认后恢复。
- 稳定 stopped 不周期发布 metadata；resume 不依赖 cache，并以更高 generation 重建当前启动快照。
- 相同 generation、不同内容被拒绝，相同内容的重试和周期刷新幂等延长 TTL。
- metadata generation stale 按服务端当前值升代并重读当前完整快照；同代冲突和版本无法递增分别返回不可重试的 `generation_conflict` 与 `version_exhausted`，不提交部分结果，Manager 按单 Codespace 持久状态损坏流程清理该 UUID。
- 错误 Manager、旧 operation、站点排空、offline、低 generation 和同 generation 不同内容分别稳定返回 `manager_mismatch`、`stale_operation`、`state_unavailable`、`manager_offline`、`stale_generation` 和 `generation_conflict`。
- Manager 收到 `stale_operation` 后清除该对象当前 Runtime Metadata 与 Endpoint 并结束发布任务，不按周期刷新继续重试旧快照。
- ready 快照缺失固定 boot 字段时被拒绝，且 create/resume 都不能提前 final done。
- CPU、内存和磁盘指标合法时写入 cache 并在创建者详情展示；指标缺失或采样失败不阻断 ready、final 或交互入口，治理摘要不返回指标字段。
- label 非法 UTF-8、去除首尾 Unicode 空白后为空、超过 64 个 Unicode 字符或包含控制字符、`<`、`>` 时被拒绝且不写 cache；合法中文和其他普通展示文本在 Manager 与 Gitea 得到相同规范值。
- resume 在 active operation 内依次完成 Token 写入、保存环境恢复、实际 remote 的本地 Git 凭据配置和当前版本 ready 上报；任一前置缺失时不提交 final done，主状态保持 stopped。repository 可达性不参与 ready 判定。
- active create/resume 和 running 执行固定 boot 版本与阶段矩阵；无 active operation 的 stopped 拒绝 metadata，同版本 ready 不回退，已结束 resume 的迟到快照返回 stale。
- boot、Endpoint、resource usage、workspace route、Incus backend、恢复重建和周期刷新都通过同一发布任务串行发送当前完整快照；final 等待任一实际携带当前 operation ready 的成功请求，不等待更高 Endpoint 或指标 generation 完成同步。

### ReportRuntimeTransition

`ReportRuntimeTransition` 用于 Manager 在没有 Gitea-issued active operation 时上报本地主动 stopped 或不可恢复的 failed 状态。stopped 包括 Incus 外部停止、运行健康检查确认基础交互持续失败后由 Manager 主动停止，以及凭据恢复无法继续但根存储仍可保留；running 只能由 Gitea 下发的 create/resume operation 通过 final done 建立。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `runtime_uuid` | Runtime 对应 runtime UUID |
| `runtime_generation` | Manager 对该 codespace 主动运行状态报告的单调版本 |
| `observed_operation_rversion` | Manager 生成该状态报告时观察到的最新 Gitea operation 版本 |
| `runtime_state` | 只接受 `stopped|failed`；状态报告不携带原因、时间或 Runtime Metadata |

接受规则：

| 当前状态 | Manager 状态报告 | 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped` 和 `updated_unix=now`、物理删除 Token 并保留 Git SSH Key |
| `running/stopped` 且无 active operation | `failed` | 写 `status=failed` 并物理删除 Token 与 Git SSH Key，提交后尽力清除交互 cache；不伪造停止时间 |
| `running/stopped` 且有 active operation | 任意 | 返回 `current_operation_conflict` |
| `failed` 且相同 generation 的 `failed` 重试 | `failed` | 目标主状态已经成立，幂等成功，不刷新 `updated_unix` |
| `creating/deleting`，或 `failed` 收到 stopped | 任意 | 返回 `stale_operation` |
| 站点排空且无 active operation | `stopped` | 允许 |
| 站点排空且无 active operation | `failed` | 允许 |

校验顺序固定为：读取 Codespace 并检查 `manager_id` 绑定；检查 active operation 冲突；检查功能开关和 Manager runtime state；检查 `observed_operation_rversion`；检查 `runtime_generation`；最后检查主状态与状态报告是否兼容。功能启用且 Manager 声明为 online 或 recovering、heartbeat 有效时可以提交 stopped/failed；站点排空时也接受这两种缩减状态；已派生 offline 的 Manager 先 `DeclareManager(recovering)` 再上报。`ReportRuntimeTransition` 不递增 `operation_rversion`，因为它不是 Gitea 下发的 operation。

runtime generation 只保存当前值，因此幂等以 stopped/failed 状态报告映射的目标主状态为准：低于当前值返回 `stale_generation`；等于当前值且目标状态已成立时幂等成功；等于当前值但目标不同时返回 `generation_conflict`；高于当前值时只在状态转换合法时写入。已处于 failed/creating/deleting 等不兼容状态时，更高 generation 返回 `stale_operation`，不改写当前 generation。

stopped 状态报告在同一事务提交主状态、runtime generation，删除 Token 并保留 Git SSH Key；failed 状态报告删除两类开发凭据。随后尽力清除 Runtime Metadata；清理失败只写服务端日志，已提交结果和交互权限保持数据库事务的结果。尚未消费的 Open Code 在短 TTL 内可能仍存在，但交换时会重新读取数据库并因主状态或记录不存在而拒绝。响应丢失后的相同状态报告按数据库目标状态幂等成功，并可再次尝试清理 metadata。failed 状态报告首次提交时写 `updated_unix=now`，幂等重试不刷新该字段，并通过内部日志入口追加固定摘要；详细原因只写 Manager 本地日志。

**设计理由：running 只表示 Gitea 明确下发且已经完整完成的启动。**用户 resume 具有 active operation、lease、abort 和 final failed 的现成恢复边界；复用它可以在进入 running 前完成 Token、实际 remote 的本地 Git 凭据配置和 ready 检查。repository 删除或权限变化由后续 Git/API 请求返回实际结果，不阻止已有 workspace 恢复。inventory 看到 Gitea stopped、Runtime running 时只返回 `stop_local_runtime`，从而不会把残留进程误认作新的启动意图。

**设计如此：健康检查不会向 Gitea 增加 degraded 或 unhealthy 状态。**检查中的暂时失败只影响 Manager 本地准入；确认需要恢复时，Manager 先把实例实际停止，再使用本接口写入既有 stopped。该状态会在同一事务删除 Gitea Token 并保留 Git SSH Key 和实例根存储，用户随后通过普通 resume 重新建立 ready。资源明确不可恢复时仍使用 failed。

Manager 主动 transition 不更新 `last_active_unix`；该字段只尽力记录用户 resume final、成功签发或消费 Open Code、成功 SSH 认证和继续运行。停止和失败结果都通过主状态与 `updated_unix` 表达，不增加第二个结果时间字段。

Manager 在 failed 状态报告前关闭 session，并停止该对象尚未完成的 metadata 上报和生命周期 worker。请求被首次接受或按目标状态幂等成功后，Manager 先持久化本地 cleanup，再删除归属 Incus 实例和本地快照；清理失败或进程重启时由 pending 快照续做，尚存实例继续在 inventory 中上报 failed。记录仍为 failed 或已经物理删除时，成功的完整 inventory 都返回 `cleanup_local_runtime`；`resource_absent` 单独响应只触发 inventory，不直接授权无记录实例删除。

Manager 按 transition Connect error 选择下一步：`current_operation_conflict` Fetch 当前 operation；`stale_operation` 重新上报完整 inventory；`stale_generation` 按 detail 的当前值加一并重新读取 Incus 状态；`generation_conflict` 关闭该 Codespace 交互并按不可恢复的单对象持久状态损坏执行带 pending 的实例清理；`manager_offline` 先 Declare recovering 后重建当前状态；`codespace_not_found` 停止当前状态上报并触发完整 inventory；`manager_unregistered` 或明确认证失败关闭全部入口、强制停止 Incus 实例并停止 RPC，实例根存储和本地状态文件等待同一身份凭据恢复。正常丢失版本可以恢复，同代内容冲突则以明确实例清理结束，不通过自动升代掩盖。

实现验收点：

- transition 请求不携带不参与判定的观察时间和原因字段。
- transition 只接受 stopped/failed 两种缩减状态；running 由 create/resume final done 建立。
- 健康检查确认持续失败后先停止实例再提交 stopped，不增加健康状态或专用 operation；资源仍可恢复时保留 Git SSH Key 和根存储，明确不可恢复时才提交 failed。
- 站点排空时可提交 stopped/failed 状态报告。
- 功能启用且 Manager online/recovering 时可提交 stopped/failed，offline Manager 先 Declare recovering。
- 相同 generation 以目标主状态判断幂等，目标不同时返回 generation conflict；数据库只保存当前 generation 和主状态。
- operation 上下文或 runtime generation 不满足时不改主状态；stopped/failed 的数据库结果不依赖 cache 清理成功，残留 cache 也不能绕过数据库状态复检。
- failed 状态报告只从无 active operation 的 running/stopped 生效，物理删除 Token 与 Git SSH Key，且相同请求重试不刷新 failed retention 起点。
- failed 状态报告成功后先持久化本地 cleanup，再删除归属 Incus 实例和本地快照；失败或重启后由 pending 快照续做，尚存实例仍可通过 failed inventory 取得同一 cleanup action。
- transition 被 operation conflict、stale operation、generation stale/conflict、Manager offline 或 Codespace/Manager 记录缺失拒绝时，Manager 按固定分支转入 Fetch、inventory、Declare、新 generation 或停止上报。
- 多个条件同时不满足时仍按固定校验顺序返回同一失败分类。

### RequestRuntimeAccess

`RequestRuntimeAccess` 是 active create、active resume 和稳定 running 恢复运行访问材料的统一入口。Manager 先生成或从本地 state 恢复固定 Git SSH key，再提交 `runtime_uuid + operation_rversion + git_ssh_key.public_key`。Gitea 用同一个 Codespace 生命周期版本验证本次请求，成功响应在 `RuntimeAccessBundle` 中一次返回当前 `gitea_token`、规范化 `gitea_server_url`、当前源仓库可用的所有仓库或指定仓库 Secret，以及 Git SSH known_hosts。

允许条件如下：

1. 功能启用，调用方 Manager 与 `codespace.manager_id` 匹配，声明为 online 或 recovering 且 heartbeat 有效。
2. 请求版本等于 Codespace 当前 `operation_rversion`。`creating/create` 或 `stopped/resume` 还要求 operation 已领取、状态为 running 且 lease 未到期；主状态 running 要求没有 active operation。
3. `codespace.user_id` 解析到可用创建用户。`repo_id=0` 时 Secret 为空，后续 Git/LFS/API 仍由每次实际授权判定。
4. 公钥是一把规范 Ed25519 或 4096 位 RSA Key。关系不存在时创建，相同公钥幂等确认，不同公钥或跨类型指纹冲突返回 `key_conflict`。

Token 行存在时，Gitea 解密后重新计算 verifier 并以常量时间比较；损坏行在锁内删除，并且只在当前生命周期仍允许时重新生成。新 Token 使用 `gcs_` 加 256 位随机值，数据库保存 verifier、末八位和 Gitea Secret 密文，不创建普通 PAT。Secret 按名称排序并只在本次响应中返回；Manager 将其写入 Runtime 的 root 管理临时文件，不保存到本地 state。

公钥创建沿用 User、Deploy 与 Codespace 共享的 PublicKey 指纹锁。Codespace lock 内取得指纹锁并开启短事务复查，事务提交后再调用 Gitea 既有授权文件同步入口。数据库是授权事实来源；外部 `authorized_keys` 同步失败时，同一 operation 版本和公钥可以安全重试。known_hosts 来自内置 SSH 实际 Host Key 或外部 SSH 显式配置；HTTP-only 部署返回空集合，SSH clone 启用时返回匹配规范 clone URL 的完整集合。

**设计如此：运行启动每次都需要 Token、Secret、公钥确认和 known_hosts，合并为一个 RPC 可以只做一次 Manager、binding 和 operation version 校验。**Token 与 Secret 的数据库事务、公钥指纹锁和授权文件重写继续保持各自边界；把文件重写纳入大事务既不能获得真正原子性，也会延长数据库锁。公钥属于 Codespace 生命周期，但请求仍携带当前 operation 版本，避免迟到的启动任务在新 operation 已经接管后读取或修复材料。

服务在 Codespace lock 内先确认 Manager 当前可用、binding 与 operation 版本匹配并读取创建用户，再校验 Runtime 公钥、SSH clone 配置和用户当前登录条件。Manager 已离线、对象已不存在或 operation 已经变化时返回对应状态错误，即使请求同时携带无效公钥也不改写为公钥格式错误。Token 与 Secret 事务可以先于公钥关系事务提交；后续公钥、known_hosts 或授权文件同步失败会使本次 RPC 返回错误，Manager 使用同一 operation 版本和公钥重试时复用已经提交的 Token。**设计如此：**数据库凭据和外部授权文件无法组成真正的原子事务，幂等重试比扩大数据库事务更可靠；稳定的错误优先级也让 Manager 先处理生命周期变化，而不是错误修复已经失效的本地密钥。

实现验收点：

- active create、active resume 和无 active operation 的 running 使用当前 `operation_rversion` 和固定公钥取得 `RuntimeAccessBundle`；其中包含 `gitea_token`、`gitea_server_url`、按名称排序的 Secret 与 known_hosts。active stop/delete、租约过期、版本不匹配和排空状态不返回材料。
- 当前 operation 的 ready metadata 和 Token 行缺一时，create/resume final done 被拒绝。
- 相同版本和公钥的响应丢失可以幂等重试；不同公钥不会替换现有 binding，跨 PublicKey 类型的相同指纹只有一个创建结果。
- 公钥登记不要求 repository 仍存在或创建者当前仍有仓库权限；实际 Git SSH 命令每次重新检查 repository、code unit 和用户权限。
- Token 和 Secret 数据处理、公钥关系事务及授权文件同步保持各自现有边界；任一后续步骤失败时请求返回错误，下一次重试复用已经提交的相同结果。
- Manager、binding 和 lifecycle 校验先于 Runtime 公钥校验；离线或 stale 请求返回对应状态分类，状态允许但公钥非法的请求才返回 `invalid_public_key`。
- Secret 明文只出现在本次 response 和 Manager 启动内存；公钥响应只包含公开 known_hosts，不返回私钥或 Runtime 后端信息。
- 排空模式下请求不读取、签发、修复或返回运行访问材料；active create/resume 由现有 abort 流程收敛。

### RequestIdleStop

`RequestIdleStop` 是 Manager 在本地确认 Codespace 已连续空闲达到有效超时后，请求 Gitea 创建普通 stop operation 的入口。Manager 掌握已认证 HTTP、WebSocket、IDE 和 SSH 的实时连接，适合判断创建者是否仍在交互；公共 Endpoint 流量不进入该计数。Gitea 掌握用户设置、交互动作和当前生命周期，适合决定该停止在请求到达时是否仍然成立。Manager 直接提交观察到的启用状态、超时和交互版本，Gitea 在一个事务中与当前实际值比较，不需要为两个简单设置计算摘要。

Gitea 按 `auto_stop_mode` 解析有效设置：`default` 使用当前站点默认秒数，`custom` 使用对象值，`never` 返回 `auto_stop_enabled=false, idle_timeout_seconds=0`。default 与 custom 当前得到相同有效值时，Manager 使用相同计时策略；数据库持久 mode 仍决定站点默认值以后变化时是否跟随。create/resume payload 与 `ReportInstances` 返回完整当前设置，`RequestIdleStop` 再次解析并比较实际值，因此延迟快照最多影响本地计时，不能授权过期策略停止 Runtime。

handler 取得 Codespace lock，在一个短事务中按以下顺序重新读取和判定：

1. 调用方 Manager 记录存在、声明为 online、未派生 offline，且 `codespace.manager_id` 与调用方一致。
2. 当前存在 idle stop 时返回 `pending(operation_rversion)`；该 outcome 同时表达首次请求响应丢失后的幂等确认。存在其他 active operation 时返回 `not_applicable(OPERATION_CONFLICT)`。
3. 主状态已经是 `stopped` 时返回 `not_applicable(ALREADY_STOPPED)`；其他非 `running` 状态返回 `not_applicable(STATE_UNAVAILABLE)`。
4. 重新解析当前启用状态和有效超时，并与 request 的两个观察值及 `interaction_generation` 一起比较；任一值不同、站点排空或当前设置为 never 时返回完整 `observation_changed(runtime_settings)`。
5. checked increment 成功后创建 `operation_type=stop, operation_status=queued, operation_trigger=idle`，写入 operation 创建时间和 `updated_unix`；任一版本无法递增时返回不可重试的 `version_exhausted`，不写部分状态。

response outcome 固定为：

| outcome | 含义与 Manager 行为 |
| --- | --- |
| `pending(operation_rversion)` | idle stop 已存在，可能由本次请求创建，也可能是响应丢失后的重复确认；Manager 保存版本并通过 Fetch 取得 payload、lease 和最终结果。 |
| `observation_changed(runtime_settings)` | 当前启用状态、有效超时或交互版本与本地观察不同；Manager 比较完整新旧设置，交互变化时从完整超时重新计时，仅超时变化时沿用原空闲起点重算。 |
| `not_applicable(reason)` | 当前存在其他 operation、对象已经 stopped 或生命周期暂不可用；Manager 分别交给 Fetch、等待 resume 或等待下一次状态同步。版本无法递增使用 Connect `version_exhausted` 硬错误。 |

如果 `RequestIdleStop` 响应在提交后丢失，Manager 使用相同实际设置和交互版本重试；仍存在的 idle stop 返回同一 `operation_rversion` 的 `pending`，已经完成则返回 `not_applicable(ALREADY_STOPPED)`。Manager 收到 pending 后继续 Fetch 或幂等重试本接口，直到取得 payload、观察到明确状态结果或收到新的设置/交互结果。queued stop 已按 `QUEUE_TIMEOUT` 明确结束、设置与交互仍未变化且 Codespace 仍空闲时，重试可以创建更高版本的新 idle stop；任何时刻仍只有一个 active operation。该闭环复用 stop 的 claim、lease、日志、State Finalization 和恢复规则。

用户交互与 `RequestIdleStop` 使用同一 Codespace lock 确定先后。成功签发 Open Code、成功消费 Open Code、成功 SSH 认证、用户点击“继续运行”和用户提交 resume 都 checked increment `interaction_generation`；无法递增时返回 `version_exhausted`，不签发凭据或提交交互结果。running 状态下前三类交互和“继续运行”会在同一事务中取消 `queued + stop + idle`，清空 active operation 并写 `updated_unix`。用户 stop 遇到 queued idle stop 时保留相同版本和 stop 意图，只把 `operation_trigger` 改为 `user`，随后 open/SSH 不再取消它。Manager 已领取 stop 后，交互入口返回 stopping，stop 按原版本完成；用户在 stopped 后使用普通 resume。

Fetch queued claim 延续现有 Manager lock 与数据库条件更新模型，不额外取得 Codespace lock。idle stop claim 的条件包含候选内部 ID、版本、`operation_type=stop` 和 `operation_status=queued`；用户交互取消事务同样只在 `operation_status=queued + operation_trigger=idle` 时清空。数据库行的提交顺序决定唯一结果：取消先提交时 Fetch affected rows 为 0，用户继续运行；claim 先提交时取消 affected rows 为 0，交互入口重新读取后返回 stopping。用户 stop 把来源改为 user 先提交时，Fetch 继续领取同一 stop，但 payload 与 idle stop 完全相同；claim 先提交时 operation 已是 running，用户 stop 返回已经停止中，已下发的 idle stop 继续完成。两种顺序都不会取消用户明确接受的停止结果。

自动暂停设置只由创建者在自己 `running` 或 `stopped` 的对象页面修改。handler 取得 Codespace lock，在一个事务中复读创建者身份、状态和规范化持久值；值未变化时直接成功。持久值变化时保存新选择，只有解析后的启用状态或有效超时发生变化，才按当前 UUID、版本、`operation_type=stop`、`operation_status=queued`、`operation_trigger=idle` 条件取消尚未领取的自动 stop。Fetch 已先领取时条件取消影响 0 行，事务保存设置并保留 running stop；设置事务先提交时 Fetch claim 影响 0 行。`never` 只关闭空闲触发，手动 stop/delete、站点排空、failed 状态报告和用户、Manager 删除仍按各自生命周期执行。stopped 对象修改设置后保持 stopped，后续由用户 resume 决定何时再次运行。

**设计理由：实际运行策略变化和自动 stop 取消共享一个提交结果。**用户改变启用状态或有效超时后，queued idle stop 已经取消；只改变 default/custom 表达而当前超时相同时，已有计时仍然正确。数据库条件更新给设置事务和 Fetch claim 一个唯一先后，不扩大 Fetch 的锁范围。

实现验收点：

- Manager 使用旧启用状态、旧超时、旧交互版本或已关闭自动暂停的配置请求时，Gitea 不创建 stop operation，并通过 `observation_changed` 返回完整当前设置。
- 当前 idle stop 仍存在时，请求重试返回同一 `operation_rversion`；响应丢失、Manager 重启和空 Fetch 不会创建并行 stop 或使本地误判完成，queued timeout 明确结束旧版本后才可创建新版本。
- pending idle stop 进入现有 stop Fetch、lease、日志、final 和 timeout 流程，完成后主状态为 stopped，普通 resume 可恢复运行。
- Open Code 签发/消费、SSH 成功认证、继续运行、resume 与 RequestIdleStop 通过 Codespace lock 形成确定顺序；它们与 Fetch claim 再由 queued 条件更新的数据库提交顺序形成唯一结果。
- queued idle stop 可取消，running idle stop 保持不可撤销并完成停止；用户 stop 接管 queued idle stop 后不会再被交互取消。
- 设置变为 never 或超时变化后，queued idle stop 被取消，running stop 完成后新设置仍保留；never 不自动恢复 stopped Codespace。
- 任一版本无法递增时返回 `version_exhausted` 且不写部分状态；管理员仍可使用不依赖新 operation 版本的 force delete 完成清理。
- 设置只在 running/stopped 保存；相同实际运行值不取消 queued idle stop，启用状态或有效超时变化与 queued idle 条件取消共同提交。
- 组织所有者和非创建者站点管理员调用自动暂停设置路由时返回权限拒绝，治理页面数据也不返回设置字段或 `configure_auto_stop`。
- RequestIdleStop 的三种 outcome 完整表达已有 stop、观察值变化和当前不适用；版本耗尽作为不可重试硬错误返回。

### ValidateOpenToken

- Gateway 提交 authorization code，Gitea 校验并消费该 code 后返回 open binding。
- response 使用互斥 outcome：成功返回 `allowed(user_id, runtime_uuid, endpoint_id, interaction_generation)`，访问拒绝返回 `denied(category)`。调用方 Manager 已由 RPC 认证且 Gitea 在返回 allowed 前校验 Codespace binding，因此 response 不重复返回 `manager_id`。
- 校验过程遵循 OAuth2 Authorization Code Grant 模式：Gitea 作为 Authorization Server，Gateway 作为 Client（以 Manager 身份认证，代替 OAuth2 标准的 client_id/client_secret）。
- 验证时把 Codespace 功能开关纳入运行时检查，并继续检查 codespace 状态、用户权限和有效 Endpoint，而非仅检查 code 是否有效。无法解析或已经过期的 code 仍按凭据规则清理；可解析且未过期的 code 在功能关闭时返回 `denied(state_unavailable)` 并按原 TTL 失效。无 active operation 或当前只有 queued idle stop 时可以继续，后者在交互事务中取消；running stop 或用户来源 stop 返回 stopping。Runtime Metadata 必须 ready；目标 Endpoint 必须仍在当前 metadata 中且 `public=false`，其中 `workspace` 还必须符合固定平台属性。Endpoint 在 code 签发后改为公共访问或从完整快照消失时，本次交换被拒绝。
- 成功消费 code 后在 Codespace lock 内推进 `interaction_generation`，取消尚未领取的 idle stop，并把提交后的版本放入 binding；版本事务失败时不返回 allowed。`last_active_unix=now` 仍是提交后的尽力展示更新，失败只记录服务端日志，不撤销已经成立的 binding。

### ValidatePublicEndpoint

Gateway 在普通公共 HTTP 请求没有最多 1 秒的新鲜 allowed 时调用 `ValidatePublicEndpoint(runtime_uuid, endpoint_id)`；相同授权键的并发请求共享一次调用。WebSocket 和持续时间超过复检周期的 HTTP 请求继续按周期调用且不复用普通 HTTP 的短期结果。请求使用已认证的 Manager 身份，不携带用户身份或 Gateway session。response 使用互斥 outcome，明确允许时返回空 `allowed`，其他业务结果返回 `denied(category)`。

Gitea 每次重新读取并检查：Codespace 功能启用；调用方 Manager 与当前 binding 一致、声明 online 且 heartbeat 有效；Codespace 为稳定 `running` 且没有 active operation（包括 queued idle stop）；Runtime Metadata 存在并为当前 boot 的 `ready`；`endpoint_id` 是非 `workspace` 的普通 ID，且当前 metadata 中对应记录的 `public=true`。成功结果不推进 `interaction_generation`，不更新 `last_active_unix`，也不创建或复检 Gateway session。

**设计如此：公共访问由 Runtime 本地 manifest 中的 `public=true` 明确提交，不要求用户在 Gitea 页面再次确认。**工作环境用户具有 sudo，因此 Runtime 是 Endpoint 声明的授权主体，Gitea 只展示当前 metadata 中的结果。校验不读取 repository 可见性、`repo_id`、创建用户当前登录状态或 repository 权限；这些条件只影响 Gitea 页面管理和开发凭据，不会在 Endpoint 已公开后形成另一套隐式访问开关。生命周期、Manager binding 和 metadata 仍实时校验，使 stop、delete、failed、Manager 离线或访问方式改变能够收敛。Gateway 只有持有最多 1 秒的新鲜 allowed 且本地不可变路由仍为公共访问时才转发，RPC 错误按无法确认处理。

实现验收点：

- 公共校验只接受当前绑定 Manager 对稳定 running、ready、无 active operation 的普通 `public=true` Endpoint 发起的请求；workspace、需要认证的入口、缺失和过期 metadata 均拒绝。
- repository 删除、可见性或用户权限变化不改变同一公共 Endpoint 的允许结果；Endpoint 改为需要认证或 Codespace 生命周期变化后，后续请求不再允许。
- 公共校验不创建 session、不写生命周期或交互字段；普通 HTTP 每个请求检查本地状态和最多 1 秒的新鲜 allowed，缺失时调用，WebSocket 和长时间 HTTP 在一个复检周期内再次调用。

### VerifySSHPublicKey

- Gateway 调用，Gitea 校验用户身份和访问权限后返回本次认证结果。
- Codespace 功能关闭时返回 `denied(state_unavailable)`，不推进交互版本，也不触发本地 SSH 建连。
- 认证成功后在 Codespace lock 内推进 `interaction_generation`，取消尚未领取的 idle stop，并在 allowed binding 返回提交后的版本。版本事务失败时不返回 allowed；`last_active_unix=now` 的尽力展示更新失败仍不改变认证结果。

`VerifySSHPublicKeyRequest`：

| 字段 | 说明 |
| --- | --- |
| `runtime_uuid` | runtime UUID（Gateway 从 SSH 连接串 `cs-{id}` 解析） |
| `public_key` | SSH 客户端认证请求中的 wire-format 公钥 bytes |

`VerifySSHPublicKeyResponse` 使用互斥 outcome：

| 字段 | 说明 |
| --- | --- |
| `allowed` | 成功 binding，包含 `user_id + interaction_generation`；Runtime UUID 使用经过本次校验的 request 值 |
| `denied` | 拒绝详情，包含稳定 `category` |

Gitea 校验：

- Codespace 功能当前启用。
- `runtime_uuid` 映射到有效 codespace。
- codespace 为 `running`。
- codespace 当前无 active operation，或只有可以在本次成功认证事务中取消的 queued idle stop；running stop、用户 stop 和 delete 均返回停止中或状态不可用分类。
- Runtime Metadata 存在且 `boot.stage=ready`。
- 公钥认证使用 `ssh.ParsePublicKey` 解析 `public_key`，计算 OpenSSH SHA256 fingerprint，以 `OwnerID=codespace.user_id + Fingerprint + KeyTypeUser` 查询 Gitea SSH key，并再次比较数据库 key 规范化后的 wire bytes。二次比较保证认证依据是同一把 key，而不是仅依赖 fingerprint 文本。部署密钥（`KeyTypeDeploy`）和授权主体（`KeyTypePrincipal`）不接受。若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- 创建用户当前允许登录。
- 绑定 Manager 当前在线。
- `public_key` 解析失败、未匹配用户 key 或 wire bytes 不一致均返回 `invalid_credentials`。
- `public_key` 是认证的唯一依据，Gateway 仅在 `VerifySSHPublicKey` 中传递客户端提交的完整公钥 bytes。

成功认证只授权本次新 SSH transport。用户之后删除该公钥会使新的 `VerifySSHPublicKey` 失败；已建立 session 的 `RevalidateGatewaySession` 继续按用户、Codespace、Manager 和 ready binding 复检，不重复查询原公钥。这样现有连接仍有 session TTL、空闲超时和周期复检的明确上限，同时不需要在 session 协议中增加公钥指纹。

SSH 接入的完整流程（Gateway 中转模型、channel 能力、限流退避配置）参见 [Manager 与 Gateway - SSH 接入](manager-gateway.md#ssh-接入)。

Gateway 按 source IP、`runtime_uuid` 做限流和退避。限流和退避由 Gateway 负责。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

失败分类：

| 分类 | 含义 |
| --- | --- |
| `invalid_credentials` | 公钥认证信息未通过 |
| `login_restricted` | 用户登录受限 |
| `codespace_not_found` | codespace 不存在 |
| `codespace_not_running` | codespace 未运行 |
| `manager_mismatch` | Manager 不匹配 |
| `permission_denied` | 权限判定未通过 |
| `state_unavailable` | Codespace 功能关闭或当前生命周期不接受交互 |
| `internal_error` | 内部错误 |

### RevalidateGatewaySession

Gateway 使用该接口持续复检已建立的 Endpoint 和 SSH session：普通 HTTP 在相同授权键没有最多 1 秒的新鲜 allowed 时调用，Endpoint WebSocket 和 SSH 按固定周期调用。request 使用 `oneof session`：Endpoint session 携带 `user_id / runtime_uuid / endpoint_id`，SSH session 只携带 `user_id / runtime_uuid`；调用方 Manager 必须与 codespace binding 匹配。

Gitea 重新检查：

- Codespace 功能当前启用；关闭时返回 `denied(state_unavailable)`。
- 创建用户仍允许登录，且 request `user_id` 等于 `codespace.user_id`。
- codespace 为 running 且没有 active stop/delete operation。
- 绑定 Manager online。
- Runtime Metadata 仍存在且 `boot.stage=ready`。
- request 选择 `endpoint` binding 时，metadata 中仍存在 `endpoint_id` 且 `public=false`；`endpoint_id=workspace` 时还校验固定平台属性。
- request 选择 `ssh` binding 时，只要求当前 metadata 仍为 ready；Manager 本地负责关闭 Incus backend 已失效的连接。

该接口通过互斥 outcome 返回空的 `allowed` 或带稳定 `category` 的 `denied`，只表达当前访问判定，不消费 Gateway Open Token、不写主状态、不记录访问历史。Gateway 仅在收到明确 `allowed` 时保留 session；普通 HTTP 可以按 Manager 单调时钟复用该 allowed 最多 1 秒，其他结果都立即关闭本地 session。功能关闭后，普通 HTTP 在下一次请求且最迟已有 allowed 的 1 秒期限结束后被拒绝，持续连接最迟在一个复检周期内关闭。revalidate 是持续授权边界，无法确认权限时关闭连接；过期 allowed 不在 RPC 错误期间继续使用。成功 revalidate 不更新 `last_active_unix`；用户实际发起 open 或 SSH 认证时已经完成访问判定，并单独尽力记录活跃时间。

实现验收点：

- 普通 HTTP 每次转发前检查本地状态和最多 1 秒的新鲜 allowed，缺失时复检；Endpoint WebSocket 和 SSH session 都能在配置的 revalidate interval 内感知功能开关、登录状态、codespace 状态和 Manager 状态变化。
- request user、codespace、endpoint 和 Manager binding 任一不匹配时返回拒绝。
- revalidate 不延长一次性 open code，也不改变 codespace 生命周期。
- 普通 Endpoint 从需要认证改为公共访问 后，既有认证 session 的下一次复检被拒绝；Gateway 本地路由提交还会立即关闭对应连接。

### ReportInstances

Manager 通过 `ReportInstances` 上报本地 Runtime inventory 快照。每次完整扫描都使用高于 Manager 本地已使用值的新 `inventory_generation`，包括传输失败后的下一次扫描。handler 先批量读取 request 中已存在且绑定当前 Manager 的 Codespace operation 版本；任一正数 `observed_operation_rversion` 高于 Gitea 当前值时返回 Manager 级 `state_history_conflict`。预检通过后，Gitea 用条件事务接受任何高于数据库当前值的 generation；等于或低于当前值返回 stale 和当前值。handler 不在逐项处理完整请求期间持有 Manager lock；每项写入和响应返回前复检数据库 generation 仍等于请求值。更高请求已经成立或 Manager 已删除时，旧 handler 停止处理且不返回结果。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `inventory_generation` | Manager 单调递增的 inventory 版本 |
| `instances[].runtime_uuid` | 本地 Runtime 对应 runtime UUID |
| `instances[].runtime_state` | `creating|running|stopped|failed` |
| `instances[].observed_operation_rversion` | Manager 看到的本地 operation 版本 |

`ReportInstances` 始终上报 Manager 持有的完整 Runtime 集合，包括 creating 资源和 stopped 的可恢复 Incus 实例。Manager 只在 Incus 实例全量枚举和所有状态读取均成功后分配新 generation 并提交；任一分页、连接或状态读取失败时不生成请求，下一次从头扫描。单个 Manager 最多管理 10000 个带归属字段的 Incus 实例，单次最多 10000 个实例且 UUID 唯一。超限时 Manager 保持 recovering，后续 Fetch 使用两类零可用容量，并等待资源数量恢复到协议上限内。`observed_operation_rversion=0` 固定表示本地没有可继续的完整 active operation 上下文；正数固定表示持有该版本的完整 active operation 上下文，不表示历史最高版本。完整集合是 missing 判定的依据。

成功响应的 `results` 与 request UUID 一一对应。仍属于当前 Manager 且未进入 cleanup 的结果携带当前有效自动暂停设置；cleanup 结果不携带设置；未绑定 creating 的结果可以同时没有设置和 action。每个结果最多携带一个生命周期差异 action。Manager 只处理仍属于本地最新 generation 的响应，先应用完整设置且不降低已经观察到的交互版本，再执行 action。延迟设置最多暂时改变本地计时，`RequestIdleStop` 仍按当前实际值完成最终授权。

inventory generation 只用于排列完整扫描请求的先后，不证明清单内容历史。响应丢失时，Manager 重新扫描并使用更高 generation；Gitea 接受更高值后，仍在执行的旧请求会在下一次复检时停止。stale 表示请求已被相同或更高 generation 取代，Manager 以服务端当前值为基线重新生成更高值。`state_history_conflict` 只表示 Manager 报告的正数 operation 版本高于 Gitea 当前版本，整个 Manager 此时关闭新任务领取、交互入口和新的 Incus 修改，保留资源等待运维恢复一致数据或明确清理。

普通处理中的 `runtime_state=creating` 只证明已有稳定 Runtime identity，`runtime_state=failed` 只证明 identity 仍存在但 Manager 已确认不可恢复，两者都不直接驱动主状态变化。Gitea 为 running 而 Runtime stopped 时，以及无 active operation 的 failed inventory，通过 `ReportRuntimeTransition` 完成；Gitea 为 stopped 而 Runtime running 时返回 `stop_local_runtime`，新的启动等待 Gitea-issued resume operation。有 active operation 的 failed inventory 在 Manager 上报的本地正版本低于当前版本时先 refetch，再由 `FinalizeOperation(final failed)` 处理；版本相同时直接使用已有完整上下文提交 final failed；上下文版本为 0 时等待原 deadline。

Gitea 计算：

```text
expected = Gitea 中绑定该 Manager 且按主状态应存在 Runtime 资源的 codespace
reported = Manager 上报的本地 Runtime 资源
extra = reported - expected
missing = expected - reported
```

处理方式：

| 差异 | Gitea 行为 |
| --- | --- |
| 正常向前运行的 Gitea 数据库成功确认无记录的 reported runtime | 返回 `cleanup_local_runtime`；记录不存在表达该 UUID 不再受 Gitea 管理 |
| Gitea 中有记录且 binding 指向其他 Manager，或主状态为 failed | 返回 `cleanup_local_runtime` action，主状态保持稳定 |
| Gitea 为未绑定 creating，Manager 已有同 UUID Runtime | 不返回 cleanup；等待当前 create 被领取或 queue timeout |
| reported `observed_operation_rversion` 大于 0 且低于 Gitea 当前 active operation 版本 | 返回 `refetch_operation(current_operation_rversion)`，该实例本轮不驱动主状态写入；Manager 在下一次 Fetch 提交本地较低 observed 版本以取得当前 payload |
| reported `observed_operation_rversion=0` 且 Gitea 有 active operation | 不返回 action，不刷新 lease；当前 operation 按原 deadline 超时 |
| reported 正数 `observed_operation_rversion` 高于 Gitea 当前 operation 版本 | 整次请求返回 Manager 级 `state_history_conflict`；不修改主状态、operation、Token 或 cache，也不返回任何差异指令 |
| Manager 以非零 observed version 报告了 operation 上下文但 Gitea 当前没有 active operation | 返回 `clear_operation_context(current_operation_rversion)`；Manager 仅在本地 worker 版本不高于该值时清除上下文并保留 Runtime |
| 功能启用或站点排空时，Gitea 为 running、Runtime 为 stopped 且无 active operation | 返回 `report_runtime_transition(current_operation_rversion)`，由 Manager 使用该版本携带新 generation 上报 stopped 状态报告 |
| 功能启用或站点排空时，Gitea 为 stopped、Runtime 为 running 且无 active operation | 返回 `stop_local_runtime(current_operation_rversion)`；Manager 仅停止 Incus 实例和交互入口并保留根存储，Gitea 主状态保持 stopped |
| 已绑定当前 Manager 的 Runtime 上报 failed，Gitea 为 running/stopped 且无 active operation | 返回 `report_runtime_transition(current_operation_rversion)`；Manager 用该版本提交新 generation 的 failed 状态报告|
| 已绑定当前 Manager 的 Runtime 上报 failed，Gitea 仍有 active operation，且 observed version 大于 0 并低于当前版本 | 返回 `refetch_operation(current_operation_rversion)`；Manager 恢复权威 payload 后使用 `FinalizeOperation(final failed)` |
| 已绑定当前 Manager 的 Runtime 上报 failed，observed version 等于当前 active operation 版本 | 不返回 inventory action；Manager 使用已有完整上下文提交 `FinalizeOperation(final failed)` |
| missing `creating` runtime | active create deadline 未到期时保持 creating；active operation 缺失或 deadline 到期时进入 `failed` |
| missing `running` runtime | 记录 divergence，进入 `failed` |
| missing `stopped` runtime | 进入 `failed`，因为已经无法 resume |
| missing `deleting` runtime | 接受 cleanup 完成，物理删除 codespace |

数量差异来自 Gitea 记录和 Manager 本地 Runtime 列表不同。Gitea 用数据库主状态判断哪些 Runtime 应该存在，Manager 用快照报告本地实际列表，最后由 Gitea 返回处理结果。数据库 generation 条件写入确定同一 Manager 请求的新旧顺序，再按 UUID 分别执行条件状态事务。单个 UUID 失败不回滚其他已提交项；Manager 重新扫描并使用更高 generation，Gitea 从当前数据库状态继续计算。全部结果只在所有 UUID 处理成功且响应返回前 generation 复检通过时一起返回；发生错误时不返回部分结果。每个 UUID 最多返回 `cleanup_local_runtime`、`refetch_operation`、`clear_operation_context`、`stop_local_runtime` 或 `report_runtime_transition` 之一，优先级依次为 cleanup、refetch、clear、stop、report。Runtime Metadata 缺失和 final 的 ready 前置条件由各自接口处理。

**设计理由：正常向前运行的 Gitea 数据库记录和 Manager inventory 已经构成完整的期望状态与实际状态比较。**数据库成功确认 UUID 不存在，表示 Gitea 已经通过用户、Manager、force delete、retention 或其他物理删除路径结束对该对象的管理；Manager 上报的资源又带有当前不可变 Manager/UUID 归属字段，UUID 永不复用，因此可以返回 `cleanup_local_runtime`，无需重复保存墓碑或清理任务。记录仍存在时，只有 `status=failed` 或 binding 明确指向其他 Manager 才执行完整清理；未绑定 creating、running、stopped 和 resume timeout 按当前记录继续保留资源，stop timeout 已经进入 failed 并按 failed 记录收敛。

cleanup 只来自成功的 `ReportInstances` 响应：Manager 已认证，完整 generation 已接受，逐项处理和响应返回前仍为当前 generation，数据库查询正常完成。数据库连接、查询、事务或 RPC 失败不生成部分删除授权。Manager 也只处理本地最新 generation 的响应。这样“查无记录”与“查询失败”具有不同结果；响应丢失后，下一次更高 generation 的完整扫描会再次得到当前 cleanup 结果。

实现验收点：

- Gitea 按 `manager_id` 查询 expected。
- Manager 上报完整快照后计算 extra/missing。
- Incus 枚举或状态读取不完整时 Manager 不生成 inventory 请求；完整扫描才分配并持久化更高 generation。
- inventory 接受任何高于当前值的新 generation；等于或低于当前值返回 stale。正数 observed operation 高于 Gitea 当前版本时在写入前返回 Manager 级 `state_history_conflict`。
- `ReportInstances` 通过条件写入接受 generation，逐项写入按 UUID 取得 Codespace lock；Manager 删除、owner 清理 binding 或更高 generation 成立后，旧请求不能恢复 generation、Codespace 或 cache。
- 逐项处理先复检 Manager 和 generation，再把无记录、binding 不匹配和 failed 分别判定为 cleanup；这些结果不会被前置复检误作整个请求失效。
- Manager 超过 10000 个 Runtime 时不提交截断快照，并保持 recovering、容量为 0。
- 传输失败后的下一次完整扫描使用更高 generation；更高值被接受后，旧 handler 停止处理且不返回结果。
- Manager 上报正数 observed operation 版本且该版本较低时返回 refetch；failed inventory 的 observed version 与当前 active operation 相同时直接使用本地上下文 final failed；observed version 为 0 时等待原 deadline；observed 正数版本高于服务端当前版本时整次请求返回 `state_history_conflict`。inventory 在这些分支都不改写业务状态或生成 cleanup。
- `refetch_operation` 只用于当前存在 active operation 的记录；无 active operation 时明确返回 `clear_operation_context`，Manager 不从空 Fetch 响应推断清理。
- running 主状态对应 stopped Runtime，以及 failed inventory 的 `report_runtime_transition` 始终返回当前 operation 版本，使本地版本基线丢失后仍可上报 stopped/failed 状态。
- stopped 主状态对应 running Runtime 时只返回 `stop_local_runtime`；新的 running 意图必须由 Gitea 下发的 resume operation 表达。
- clear action 先通过请求发出时版本判定，再清除该版本及更早的旧上下文；请求期间本地已经替换为更高版本时只丢弃该延迟 action。
- 站点排空时的差异指令只收敛 Incus 实例状态：running 主状态对应 stopped Runtime 可上报 stopped，stopped 主状态对应 running Runtime 执行本地停止。
- 数据库明确无记录、当前 binding 冲突或 failed 状态返回 cleanup；未绑定 creating、running 和 stopped 在记录存在时保持各自主状态。
- 数据库、认证、RPC 或 generation 校验失败不返回 cleanup，Manager 不从 Connect error、空 Fetch 或普通 `resource_absent` 推导资源删除。
- `cleanup_local_runtime` 要求 Manager 先持久化本地清理，再按销毁语义删除归属 Incus 实例、会话、凭据和本地快照；resume timeout 不会把资源变成该指令的目标，stop timeout 进入 failed 后按 failed 记录收敛。
- failed inventory 只在已绑定当前 Manager、持有正版本本地操作上下文且该版本低于 active operation 时返回 refetch；版本相同时由 Manager 直接提交 final failed，无 active operation 时可以返回 transition，observed version 为 0 且 active operation 仍存在时等待原 deadline。未绑定 creating 不取得 payload 或版本。
- missing runtime 按当前主状态处理；deadline 未到期的 active create 不因启动恢复时的空 inventory 提前失败，重启不延长 deadline。
- 旧 inventory generation 不触发 extra/missing 或主状态写入。
- 同一 Manager 的并发 inventory 由 generation 条件写入确定顺序；每个 UUID 只返回一个最高优先级 action。
- 任一 UUID 处理失败时请求不携带部分结果；已经提交的条件状态写入由下一次更高 generation 的完整扫描继续收敛。
- response 与 request 的 reported UUID 一一对应；每个结果至多携带五种互斥 action 之一，metadata cache 缺失和 final ready 前置条件由对应接口处理。
- 仍绑定当前 Manager 的非 cleanup 结果携带当前有效设置；cleanup 结果不携带设置，未绑定 creating 可以同时没有设置和 action。
- Manager 在执行 action 前应用同一结果的设置；延迟设置最多影响本地计时，不能越过 RequestIdleStop 的当前值复检创建错误 stop。

所有 operation-bound RPC 都携带 `runtime_uuid` 和 `operation_rversion`，Gitea 通过 `codespace.operation_rversion`、`codespace.operation_status` 和 `codespace.manager_id` 完成校验。

[Stale Report](glossary.md#stale-report) 被识别后返回 stale 分类，codespace 主状态保持当前值。

stale report 使用分类响应而不是改写主状态，是因为 Manager 上报可能来自旧 lease、重启后的残留任务或已经被 Gitea reconciliation 接管的 operation。保持主状态不变，可以让 Gitea 数据库状态继续作为判断依据，同时给 Manager 明确 cleanup 或停止上报的信号。

### Operation 返回数据

`FetchOperations` 返回 operation envelope，并通过 `oneof command` 表达命令类型：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `operation_rversion` | 全部 | Gitea 下发 operation 版本 |
| `runtime_uuid` | 全部 | Runtime UUID |
| `lease_valid_for_milliseconds` | 全部 | 普通命令为本次实际授予的正整数毫秒时长，通常等于标准 lease，最后一段受总执行期限截短；abort 为 0 |
| `log_offset` | 全部 | 当前 codespace 单文件日志大小，Manager 从该 byte offset 继续追加 |
| `command.create` | create | create 专属结构 |
| `command.resume/stop/delete` | 对应类型 | 不携带 repository 数据的明确命令分支 |
| `command.abort_create` | 站点排空后 deadline 未到期的 running create | 删除本轮新建的 Incus 实例并 final failed，Gitea 写入 failed |
| `command.abort_resume` | 站点排空后 deadline 未到期的 running resume | 停止本轮启动进程、保留既有 workspace 并 final failed，Gitea 写回 stopped |
| `create.repository.full_name` | create | repository 完整名称 |
| `create.repository.clone_http_url` | create | HTTP clone 启用时由 Gitea 生成的规范 HTTP(S) clone URL |
| `create.repository.clone_ssh_url` | create | Codespace SSH clone 启用时由 Gitea 生成的规范 SSH clone URL |
| `create.repository.start_ref` | create | 普通分支和普通 Pull Request 来源分支使用完整 heads ref，Tag 使用完整 tags ref，AGit Pull Request 使用内部 PR ref，直接 commit 为空 |
| `create.repository.commit_sha` | create | 锁定 commit SHA |
| `create.repository.preferred_protocol` | create | Gitea 构造本次 create payload 时计算出的 `HTTP` 或 `SSH` 首选协议 |
| `create.environment_tag` | create | Manager 本地运行环境键；只用于选择并持久化本次有效环境 |
| `create.runtime_settings` | create | 当前有效自动暂停设置和交互版本 |
| `create.git_identity.gitea_username` | create | 创建时的 Gitea 用户名，同时作为 Git `user.name` 和 Linux 用户名派生输入 |
| `create.git_identity.git_user_email` | create | 创建时隐私保护后的 Git email |
| `create.dev_container.repository_path` | create | 仓库配置的相对路径；读取提交使用 `create.repository.commit_sha` |
| `create.dev_container.template_content` | create | 创建时固化的 Dev Container 模板内容 |
| `resume.runtime_settings` | resume | 当前有效自动暂停设置和交互版本 |

规则：

- command `oneof` 必须且只能设置一个分支，Manager 使用生成类型做穷尽处理。
- operation 类型由 command 分支唯一表达，envelope 不重复返回独立 `operation_type`。
- Gitea 在领取前保存 operation 来源以处理 queued idle stop 的取消；来源不改变 Manager 命令，因此不进入 envelope。
- `start_ref` 对 branch 使用 `refs/heads/<name>`，tag 使用 `refs/tags/<name>`，commit 使用空值。Pull Request 的数据库身份仍是基仓库和 `refs/pull/<index>/head`；领取普通 PR 时，Gitea 重新读取 PR 关系，clone URL 指向来源仓库，`start_ref` 使用 `refs/heads/<head_branch>`；AGit 没有独立来源分支，继续使用基仓库 URL 和内部 PR ref。Manager 据此选择 tracking branch 或 detached checkout，并最终以 `commit_sha` 校验 HEAD。
- `resume|stop|delete` 返回数据不包含 create 专属的 repository、用户身份、ref 或 commit 字段。
- `resume` 完全基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository，不依赖 repository payload。
- create 的 `repository.preferred_protocol` 来自 payload 构造时的站点当前 Git 配置；create 返回当前可用协议的 clone URL，禁用协议字段为空。Manager 在初始化前统一通过 `RequestRuntimeAccess` 确认固定公钥和取得 `RuntimeAccessBundle`，HTTP(S) remote 使用限定路径的 Token helper。SSH 回退到 HTTP(S) 后允许保留已经登记的公钥。resume 不携带协议，恢复以 workspace 实际 remote 为准。
- `create.git_identity` 和 `create.dev_container` 是 create 初始化输入。Gitea 不保存派生后的 Linux 用户名；Dev Container 仓库来源保存路径，模板来源保存创建时内容。Manager 领取 create 后把初始化身份和选择保存到本地 state。**设计如此：**用户名和邮箱只初始化一个具体 Runtime；仓库配置由锁定提交固定，模板配置由创建请求固定，它们都不需要在 resume 时由 Gitea 重放。
- create/resume payload 让 Manager 在 Runtime 进入 running 前保存当前设置；后续完整快照覆盖本地策略，交互版本只向前更新，RequestIdleStop 继续承担过期策略的最终复检。
- repository 删除后，本地上下文完整的 running create 通过 observed 续租继续；缺少上下文时等待原 deadline，并由 running create timeout 进入 failed。
- `delete` 返回数据使用 `runtime_uuid` 生成，不依赖 repository row。repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Codespace delete operation 清理 Runtime 时只依赖 `runtime_uuid` 的本地确定性映射；这与直接删除 Manager 记录是两条独立流程。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- `create.environment_tag` 必须等于该 Codespace 创建时锁定并用于本次 Manager 匹配的 tag。Manager 用它选择同名运行环境，再把环境有效值持久化到本地 Codespace 快照；后续配置变化不改变已有实例。
- Incus 实例名、实例类型、镜像、profile、资源、通信网卡和 Endpoint port 均由 Manager 对所选环境独立决定；Endpoint port 表示主 Dev Container 的 loopback 端口，Manager 通过 Incus exec 与原生运行时连接，公开 path/query 原样转发到服务根路径。
- Manager 使用 `runtime_uuid` 在本地生成或查找 Runtime Instance 的确定性映射。
- create 时 Manager 把创建者身份、派生后的运行用户名和 Dev Container 选择写入本地 state；init 提交的最终绝对 workspace 路径由 Manager 持久化。resume 把本地快照中的同一路径和 startup input 写入结构化环境状态，不从 repository 数据重新推导。Git SSH 公钥和 known_hosts 由 Manager 在每次 create/resume 通过 Incus 主动确认并写入 Runtime。
- Gitea 在数据库保存受固定总执行期限封顶的本次绝对 deadline；Manager 只使用 `lease_valid_for_milliseconds` 和本地单调时钟约束 worker，并通过 Fetch observed 批量取得后续授权。

实现验收点：

- ManagerService 所有命令通过统一认证、binding 和版本校验。
- RPC handler 只承担认证、协议版本和 Connect 错误映射；请求枚举、批量消息和 `oneof` 响应直接使用共享 proto 生成类型。新增协议字段只在实际业务读取或构造位置处理，不增加字段完全重复的中间 DTO。
- Fetch、final、日志、metadata、transition、inventory 和 session revalidate 的请求响应与 RPC 文档一致。
- command rejection 携带统一 Connect failure detail，访问判定返回 decision response。
- create payload 的 `environment_tag` 等于用户在确认页显式选择并由 Gitea 最终复检的运行环境。仓库不能通过 Dev Container 配置选择 Manager 的基础设施环境；Manager 使用该值精确查找本地环境并保存有效环境快照。
- create payload 的 `git_identity.gitea_username` 使用创建用户当前 Gitea 用户名，`git_identity.git_user_email` 使用隐私保护后的 Git email；Manager 派生 Linux 运行用户名并只保存到本地 state，不回写 Gitea。
- create payload 的 `dev_container` 在仓库来源时携带所选路径并复用 `repository.commit_sha`，在模板来源时携带创建时固化的内容。Manager clone 后从 workspace 读取仓库文件，或直接解析模板内容，再交给 Manager 原生 Dev Container 运行时；resume 使用本地保存的同一选择。
- create payload 对普通分支和普通 Pull Request 下发来源仓库的完整 heads ref，使 Runtime 建立同名本地分支与 `origin/<branch>` upstream；Tag、AGit Pull Request 和 commit 锁定到 detached HEAD。两类结果都必须等于 `commit_sha`。
- create payload 的 `repository.preferred_protocol` 等于 payload 构造时站点当前首选值；create 取得当前可用协议的规范 clone URL，首选协议对应 URL 必须非空。内置 bootstrap 在受控临时 workspace 中先使用首选地址，并在 clone/fetch 失败且另一种 URL 非空时在同一次 init 调用中尝试另一地址；最终失败写入不可恢复结果，不进入启动恢复重试。resume 不取得 repository payload，也不携带协议，只按 workspace 实际 remote 恢复本地凭据配置。
- create/resume payload 的有效设置与当前数据库结果一致，Manager 重启后可恢复当前计时策略；stop 的来源不改变运行侧执行路径。
- 普通 operation payload 返回正数相对 lease 时长，abort 返回 0；Gitea 的绝对 deadline 不进入协议。

## 日志读取

`GET /-/codespaces/{codespace_id}/logs` 使用 byte offset 分页读取：

```text
GET /-/codespaces/{codespace_id}/logs?offset=<byte_offset>&limit=<max_bytes>
```

成功返回固定 JSON：

```json
{
  "offset": 0,
  "next_offset": 128,
  "eof": false,
  "operation_active": true,
  "lines": [
    {"timestamp": 1785037200, "message": "first line"},
    {"timestamp": 1785037201, "message": "second line"}
  ],
  "truncated": true
}
```

规则：

- 默认 `offset=0`、`limit` 为 Gitea 内部日志读取分页大小；`limit` 的有效范围为 `1..内部日志读取分页大小`。
- DBFS 内部物理行使用 `[RFC3339Nano] message\n` 编码，`offset/next_offset` 始终指向这份内部字节流；浏览器只使用服务端返回的 `next_offset` 继续读取，不从 JSON 内容自行计算 offset。
- `lines` 是结构化数组。`timestamp` 使用 Unix 秒数，`message` 是不含时间、stdout/stderr 前缀和行尾换行的正文。这样页面可以独立对齐或隐藏时间列，正文也能保持命令原始含义。
- 服务端只返回完整 UTF-8 物理日志行；`limit` 是软字节上限，加入下一完整行会超过上限时在该行之前停止。
- 负数或非法数字的 `offset`，以及不在有效范围内的 `limit`，返回 HTTP 400 和 `invalid_argument`。超过文件末尾的 offset 返回 HTTP 409、`offset_conflict` 和当前 EOF。
- 如果第一条完整物理行本身超过请求 `limit`，服务端仍单独返回该行并推进 offset，避免客户端无法分页前进；该例外一次只返回这一行，且仍受内部日志读取分页大小约束。
- `next_offset` 是下一次轮询起点。
- `eof=false` 表示仍可继续读取。
- `operation_active=true` 表示 Codespace 仍有 queued 或 running operation，当前 EOF 后仍可能产生新日志；active operation 已清空时返回 false。字段名直接说明它描述生命周期操作，避免与页面请求或日志读取状态混淆。
- `truncated=true` 表示本次响应达到读取上限，客户端继续使用 `next_offset` 拉取。
- delete done 和其他物理删除路径删除 DBFS 日志；`dbfs.Remove` 返回 `fs.ErrNotExist` 时作为幂等成功，其他错误使当前本地删除事务失败。
- `failed` 状态日志保留到用户 delete，或 `reconcile_codespaces` 按 `OLDER_THAN` 到期清理。
- 日志接口只允许 Codespace 创建者访问；对象不存在和创建者权限不足都沿用创建者对象路由的 404 语义，不由日志分页错误覆盖。

日志在 Codespace 存续期间始终保留在 DBFS，并在物理删除时一起清理。纯文本下载按同一内部格式逐页还原时间与正文，因此下载、页面和追加共享一份内容，同时下载所需内存只与单个读取页相关。页面把历史追赶和实时轮询分开：`eof=false` 且 offset 前进时连续读取下一页，批次之间让浏览器完成绘制；到达 EOF 后，仅在 `operation_active=true` 时继续按状态间隔轮询。`operation_active=false` 时页面使用相同 EOF 再确认一次后停止，原因是 timeout、missing runtime 等控制面判定会先提交状态事务，再通过日志锁尽力追加诊断摘要；二次确认可以读取这类摘要，又不需要新增持久化关闭字段。尚未产生任何日志的 Codespace 可能没有 DBFS 文件，因此删除不存在文件表示目标结果已经成立。DBFS 已满足运行中追加、页面读取和同事务日志元数据更新，不需要增加归档状态、存储类型字段或传输任务。

**设计如此：Web 响应采用结构化时间与正文，内部存储继续使用单文件文本和 byte offset。**页面需要独立展示时间列，而 Gitea 的幂等追加与分页需要稳定的物理字节位置；两者在读取边界转换即可闭环，不需要修改 Proto 或增加第二份日志存储。

**设计理由：物理删除把“日志文件不存在”视为成功，而不是数据损坏。**创建后立即失败、从未被领取或内部摘要写入失败都可能合法地没有日志文件；让该情况阻断 Codespace、owner 或 Manager 删除会把诊断文件错误提升为资源生命周期前置条件。

实现验收点：

- [x] 日志读取按 byte offset 稳定分页，`next_offset` 可直接用于下一次请求。
- [x] 多页历史日志连续追赶，到达 EOF 后才进入实时轮询；inactive EOF 经一次确认后停止请求。
- [x] 大页日志分批渲染并保留跨页日志组、行号、错误标记和用户滚动位置。
- [x] `lines` 分别返回 Unix 时间和无前缀正文；非法参数返回 400，超过 EOF 的 offset 返回 409 和可恢复的 `current_offset`。
- [x] 超过请求 limit 的单行可单独返回且不会造成无限重试。
- [x] delete 和 failed retention 删除整份单文件日志，不按 operation 历史截断。
- [x] 从未创建 DBFS 日志的 Codespace 仍可物理删除；缺失文件幂等成功，真实 DBFS 错误回滚当前本地删除事务。
- [x] UI 和下载读取同一份已脱敏内容；UI 可独立显示时间列，下载逐页输出并保留规范文本时间戳。
- [x] 组织和站点治理权限不授权日志读取；管理员只有在本人就是创建者时才能通过创建者对象路由读取自己的日志。

## Runtime 开发凭据

### Gitea Token

[Gitea Token](glossary.md#gitea-token) 使用独立的 `codespace_gitea_token` 模型，并接入 Gitea 现有 Basic、Bearer、Query Token、Git HTTP 和 LFS 认证入口。两种 Git 协议都保留该 Token 供 Runtime 调用开发 API；HTTP 协议同时用它访问 Git smart HTTP，SSH 协议则使用专用 Codespace Git SSH Key。

#### 身份与生命周期

Token 代表 `codespace.user_id` 对应的真实用户。认证继续使用 Gitea 已有的末八位候选查询、带盐 verifier 和常量时间比较，成功后把用户、Runtime UUID、源仓库 ID、已确认附加仓库规则和固定 category scope 写入本次请求的认证快照。Token 表只保存凭据材料，用户、状态和权限始终从当前关系读取。

Token 在有效 create/resume 初始化期和稳定 `running` 可用。stop final、resume failed/timeout、进入 `failed/deleting` 和物理删除会在状态事务中删除 Token 行。认证查询完成的时刻是本次请求的授权生效点：状态变化先提交时拒绝请求，查询先完成时当前请求按 Gitea 现有请求生命周期结束，后续请求读取新状态。该顺序无需增加进行中请求表，也不会试图撤销已经启动的 Git subprocess。

Token 固定派生 `write:issue,write:repository,read:user` category scope，只用于进入 Gitea 现有中间件；它不表示最终权限。最终权限由 Codespace 工作状态、创建用户登录限制、源仓库或附加仓库授权、创建用户当前仓库单元权限、仓库状态、分支保护和 handler 原有业务规则共同决定。

**设计理由：Token 使用真实用户身份，但权限范围不等同于普通 PAT。**这样 commit、Issue、Pull Request、Review 和评论保持正确归属，同时 Codespace 停止、用户撤销授权或用户失去仓库权限后，新请求立即失效。PAT、OAuth、Actions Task Token、Registration Token、Manager Secret、Open Code 和 SSH Key 的主体与吊销条件不同，因此无需建立包含全部凭据的通用表。

实现验收点：

- Basic、Bearer 和站点启用的 Query Token 都能识别 `gcs_` 前缀；被选中的无效 `gcs_` 直接返回未认证，不回退到 PAT、Session 或其他认证方式。
- resolver 一次读取 Token、Codespace、创建用户、登录限制和附加权限，后续检查复用请求快照。
- active create/resume 和稳定 `running` 可以使用当前 Token；稳定 `stopped`、`failed`、`deleting` 和已删除对象不能建立新请求。
- 普通 PAT 页面和 API 不显示或管理 Codespace Token；创建者详情只显示当前绑定是否存在，不返回 verifier、salt、密文或明文。

#### 仓库权限

源仓库由 `codespace.repo_id` 标识。Codespace Token 对源仓库自动使用创建者当前的 Gitea 仓库单元权限，因为创建者已经从该仓库发起开发环境，且每次请求仍经过 Gitea 当前权限检查。

附加仓库权限来自创建时用户确认的 `codespace_permission_authorization` 和 `codespace_permission_repository`。规则使用精确 repository ID、Gitea `unit.Type` 与 `none/read/write`，支持 Code、Issues、Pull Requests、Wiki、Releases 和 Actions。一次请求的有效级别取“用户当前保留授权”和“创建用户当前 Gitea 单元权限”的较低值；仓库单元关闭、用户失权、规则降权或整体撤销都会影响下一次请求。Gitea 当前没有仓库 Project/看板 API，Issue 请求中的项目关联继续使用 Issues 能力和 Gitea 原有业务校验，因此无需增加一项无法独立执行的 Project 能力。

未获得身份权限的公开仓库安全读取按匿名访问处理。API 在 repository assignment 后清除 Codespace 认证快照和创建用户身份，再按公开可见性继续；Git HTTP/LFS 的公开读取只使用公开仓库结果。这样公开内容仍可访问，但不能借用创建者身份看到受限数据。

`repo_id=0` 表示源仓库已删除。Token 仍可以服务生命周期允许的当前用户和公共信息入口；源仓库删除同时清理以它为来源的权限确认，因为该确认已失去配置来源和用户审阅上下文，所以原附加仓库能力也随之消失。公开仓库安全读取继续使用匿名权限。

**设计如此：源仓库自动授权，附加仓库由用户确认。**源仓库是工作区的明确代码来源，再要求一次重复授权不会增加信息；附加仓库则可能扩大到其他私有代码或写操作，必须逐仓库、逐单元展示并由创建者确认。权限状态只保存在 Gitea，Manager 和 Runtime 不成为第二个授权系统。

实现验收点：

- 源仓库请求仍检查创建用户当前单元权限，创建者失权后下一次请求失败。
- 附加仓库请求同时匹配 authorization、repository、unit 和 mode；只拥有 Issues 权限不能读取私有代码，只拥有 Code read 不能 push。
- 用户设置中的降权或撤销对引用该授权的现有 Codespace 下一次请求生效；提升权限需要新的创建确认。
- 未授权公开仓库 GET/HEAD 不保留 Codespace 创建用户身份；私有读取和任何写入均拒绝。
- Git HTTP、LFS、Git SSH 和 repository API 对同一仓库、单元和读写级别得到一致结果。

#### API 能力分类

API 全局守卫在普通路由中间件前运行。允许入口分为固定入口和仓库能力入口：

| 类型 | 入口 |
| --- | --- |
| `self` | `GET /api/v1/user`，仅返回当前创建用户 |
| `public_info` | version 和全局 signing key GET |
| `signed_artifact` | Actions artifact raw 签名下载，由现有签名独立认证 |
| 仓库能力 | 明确标记为 Code、Issues、Pull Requests、Wiki、Releases 或 Actions 的 owner/name repository 路由 |

仓库能力路由先用预路由标记通过全局守卫，再由 repository assignment 和现有 `reqRepoReader/reqRepoWriter` 或对应单元中间件检查精确能力。仓库管理、所有权、删除、转移、凭据、账户、组织、Package、Notification、创建仓库和创建 fork 不属于开发能力。后续新增仓库路由只有明确归入一个支持单元并增加代表性测试后才接受 Codespace Token。

`codespace-token-routes.yaml` 保存可审阅的能力清单，不复制完整 Gitea 路由表。代码中的预分类和现有权限中间件是执行来源；清单用于检查支持范围、明确新增路由需要作出的设计选择。

Pull Request 路由的 base repository 使用路由仓库能力。请求引用外部 head 时，还必须具有该 head 的 Code read，并验证 base/head 位于同一 fork tree；更新外部 head 需要 Code write。fork 由用户使用普通 Gitea 身份提前创建，Codespace Token 不自动创建 fork。已经通过请求授权创建的 scheduled auto-merge、Issue、Pull Request 或 Actions run 是 Gitea 持久业务对象，Codespace 后续停止不会撤销它们。

Git smart HTTP 只处理 upload-pack 和 receive-pack；clone/fetch 使用 Code read，push 使用 Code write。LFS 下载使用 Code read，上传、verify 和 lock 修改使用 Code write。对象存储直传 URL 和 artifact raw 签名 URL 一经 Gitea 现有逻辑签发，按原过期时间结束，不增加 Codespace 专用撤销表。

**设计理由：明确能力分类可以准确表达开发权限。**owner/name 只说明路由能解析仓库，不说明该操作属于代码开发、仓库管理还是账户副作用。显式分类让新 API 默认不可用，开发者必须说明它需要哪个仓库单元和读写级别，同时仍复用 Gitea 已有业务权限实现。

实现验收点：

- 未分类 API 在 handler 副作用前返回 403；新增到 owner/name group 的路由不会自动获得 Codespace Token 准入。
- Code、Issues、Pull Requests、Wiki、Releases 和 Actions 的代表性读写路由分别覆盖允许、级别不足和当前用户失权。
- 仓库 owner/admin、delete/transfer、hook/secret/key、账户、组织、Package、Notification、创建仓库和创建 fork 路由稳定拒绝 Codespace Token。
- 外部 PR head 读取同时要求 Code read 和同一 fork tree，写入 head 还要求 Code write；无关仓库即使获得 Code grant 也不能作为 PR head。
- `signed_artifact` 从入口使用现有 HMAC 和 expires 独立认证，附带 Session、PAT 或 `gcs_` 不改变签名结果。
- 普通 PAT/OAuth/Session 请求不读取 Codespace 路由标记，行为保持 Gitea 现状。

#### Git SSH Key

Git SSH 使用与 Token 相同的生命周期阶段和仓库授权模型。SSH key ID 先解析到唯一 Codespace，再按命令得到目标仓库和 upload-pack/receive-pack 所需 Code read/write。源仓库自动进入当前权限检查，附加仓库必须存在对应 Code grant；随后继续使用创建用户身份执行 Gitea 现有代码权限、保护分支和 hook 检查，`DeployKeyID=0`。

一次 SSH 命令的授权读取是该命令的生效点。状态、授权或用户权限变化在授权前提交时拒绝；授权后已经启动的 subprocess 可以按 Gitea 现有行为结束，下一条命令读取新结果。Git wiki、upload-archive 和 push-to-create 不属于支持范围。

**设计理由：HTTP、LFS、API 和 SSH 共用仓库授权语义。**传输协议只改变凭据形式，不应改变某个 Codespace 能访问哪些仓库。SSH 不具备匿名公开读取分支，因此未授权仓库始终拒绝。

实现验收点：

- upload-pack 和 receive-pack 分别映射 Code read/write，并继续执行创建用户当前权限和保护分支检查。
- 附加仓库 SSH 命令只有匹配 Code grant 时成功；Issues、Pulls 等非 Code grant 不授予 Git 访问。
- Git SSH 以创建用户作为真实用户且 `DeployKeyID=0`，提交归属和 hook 行为与该用户普通 SSH 访问一致。
- stop、failed、delete、用户限制、降权和撤销对下一条 SSH 命令生效。
### Gateway Open Token

[Gateway Open Token](glossary.md#gateway-open-token) 采用 OAuth2 Authorization Code Grant 模式实现：

- Gitea 作为 Authorization Server，在用户请求 open 时签发 authorization code。
- Gateway 作为 Client，以 Manager 身份认证后提交 code 换取 open binding。
- 与 Gitea 现有 `OAuth2AuthorizationCode` 模型（`models/auth/oauth2.go`，`gta_` 前缀，10 分钟有效期）模式一致：code 为 opaque 随机值，单次使用，短期有效。差异仅在于编码方式（hex vs base32）、有效期（60s vs 10min）和存储介质（cache vs DB）。

Authorization code 属性：

- 短期有效（默认 60s）
- 一次性使用（消费后从 cache 删除）
- opaque，非 JWT
- 绑定 `user_id / runtime_uuid / endpoint_id / manager_id`

创建者列表和详情页使用同一个确认弹窗，弹窗只展示服务端页面数据中的入口名称和访问类型，不包含 Gateway 目标 URL。用户确认后由表单 POST 执行动作，因此页面渲染、登录跳转和详情轮询都不会签发 code；POST 继续使用 Gitea 现有 CSRF 防护。弹窗位于实时状态片段之外，状态轮询替换片段时不会移除已经打开的表单。

`POST /-/codespaces/{codespace_id}/open` 在签发前固定选择 `endpoint_id=workspace`；显式 Endpoint 路由使用 path 中匹配 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$` 的 ID，并拒绝保留值 `workspace`。两种需要认证的入口都要求当前 metadata ready、目标记录存在且 `public=false`，其中 `workspace` 还必须符合固定平台属性；active operation 只能为空或是本事务将取消的 queued idle stop。Gitea 在 Codespace lock 内读取当前 binding 和绑定 Manager 最近一次成功 Declare 的 `gateway_url`，把 `manager_id` 写入 code binding，并用该当前地址构造 303 的目标 origin。随后写入 code、推进 `interaction_generation` 并取消 queued idle stop；交互事务失败时尽力删除刚写入的 code 并返回失败。只有 cache 与交互事务都成功才返回带 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer` 的重定向，提交后尽力更新仅供展示的 `last_active_unix`。Manager 用 `endpoint_id=workspace` 连接当前 Dev Container 的固定 code-server Web IDE。

普通 Endpoint 当前为 `public=true` 时，页面弹窗显示公共标记。表单 POST 后，Gitea 按 `ValidatePublicEndpoint` 的相同状态条件复检，通过后直接 303 到服务端当前推导的 URL，不写 Open Code，也不推进交互版本。queued idle stop 和其他 active operation 不通过该分支，页面同时禁用该入口，公共请求不会取消 stop。**设计如此：公共请求不是创建者交互。**该分支与 Gateway 的公共访问计数一致，不会仅因匿名访问延后自动暂停。

**设计如此：Open Code 先由 Gitea 定位当前 Manager，Gateway 再消费 code。**浏览器已经到达目标 Manager 的唯一 Gateway origin 后，Gateway 才以自身 Manager 身份调用 `ValidateOpenToken`；Gitea 重新核对该身份等于 code 中的 `manager_id`。因此成功 binding 只返回 session 所需的用户、Codespace、Endpoint 和交互版本，不重复返回 Manager 地址。地址切换期间发往旧 origin 的请求可以失败并由用户重新 Open，Gitea 不保存旧地址转发关系。

签发算法：

```text
code = hex(CryptoRandomBytes(32))
code_hash = sha256(code)
```

设计原因：

- `CryptoRandomBytes(32)` 生成 256 位随机值，hex 编码为 64 字符字符串。
- `sha256(code)` 直接作为 cache lookup key，不需要 salt。code 自身 256 位熵值足够高，且单次使用、60s TTL，彩虹表攻击不可行。加 salt 后验证时需要 salt 才能重建 hash，在 cache key 查找模式下 salt 不可恢复，反而引入设计缺陷。
- 不使用 PBKDF2：code 是随机值而非用户记忆的密码，高计算成本无安全收益。

过期机制（两层保障）：

| 层级 | 机制 | 触发条件 | 作用 |
| --- | --- | --- | --- |
| Cache TTL | 固定 60 秒 | cache 自动淘汰 | 主力过期，自动清理 |
| 显式校验 | `expires_unix` 比对 | `ValidateOpenToken` 中显式判断 | 防御纵深，消除 TTL 淘汰延迟窗口 |

两层机制确保即使在 cache TTL 淘汰延迟（秒级）的时间窗口内，`expires_unix` 显式比对也能拒绝已过期的 code。

Cache 结构：

```text
key = codespace:open-code:{code_hash}
value = required JSON fields: user_id, runtime_uuid, endpoint_id, manager_id, issued_unix, expires_unix
ttl = 60 seconds
```

Codespace 通过 `modules/cache.GetCache()` 使用站点现有 cache adapter。memory/twoqueue 重启后可以丢失这些 key，Redis/memcache 可在 TTL 内保留；保留的 Open Code 仍必须执行下面的全部实时校验。

规则：

- code 明文只出现在 no-store/no-referrer 的 `303 Location` query string 中，不落数据库和日志。
- code 签发和消费使用 `globallock.Lock(ctx, "codespace_" + canonicalUUID)` 与生命周期写入串行化。签发在 code 写入和交互事务都成功后才返回重定向。Codespace 停止或删除后，已签发 code 即使在短 TTL 内仍存在，也会在消费时因数据库主状态或记录复检失败而拒绝，因此无需为短期缓存维护反向索引。
- code 使用 `CryptoRandomBytes(32)` 生成，256 位熵值使得 hash 冲突概率可忽略，不需要冲突重试逻辑。

校验步骤（code 交换，映射 OAuth2 Token Endpoint）：

1. 计算 `code_hash = sha256(submitted_code)`。
2. 以 `code_hash` 查询并解析 cache，读取 binding 中的 `runtime_uuid`；Gitea cache API 会把后端读取错误表现为 miss，因此 miss 直接按无效凭据拒绝，无法解析时记录服务端日志、尽力删除后拒绝。
3. 取得 `codespace_{uuid}` global lock，并在锁内重新读取同一 code；等待锁期间 code 已消失或 binding 变化时返回失败。
4. 显式校验 `now < expires_unix`；已经过期时尽力删除 code 后拒绝（防御 TTL 淘汰延迟）。
5. 校验 Codespace 功能启用；关闭时返回 `state_unavailable` 并保留 code 到原 TTL。
6. 校验调用方 Manager 身份等于 `manager_id`（代替 OAuth2 标准的 client 认证）。
7. 重新读取 codespace，校验当前为 `running`。
8. 校验用户仍具备 Interactive Access。
9. 校验 Runtime Metadata 仍为 ready；目标 ID 必须存在于当前 metadata 且 `public=false`，`workspace` 还必须符合固定平台属性。
10. 校验 Manager 仍在线。
11. 全部校验通过后删除 code；删除失败时返回内部错误，不返回 binding。
12. checked increment `interaction_generation`，取消 queued idle stop，并读取提交后的版本；版本无法递增时返回 `version_exhausted`，其他事务失败时返回对应错误，两种结果都不返回 binding。code 已经消费，用户从 Gitea 重新发起 open。
13. 尽力更新 `last_active_unix=now`；更新失败记录日志并仍返回 binding。

步骤 3-10 是运行时安全检查，在 code 签发到验证之间的时间窗口内状态可能已变化。缓存值无法解析或 code 已经过期时已经没有后续成功可能，因此尽力删除；功能关闭、Manager 不匹配、Codespace 暂时查无记录、生命周期状态、用户权限、metadata、Endpoint 或 Manager 在线状态不满足时拒绝本次交换并保留 code，由原 TTL 决定最终失效。全部实时检查通过后必须先成功删除 code，再提交交互事务并返回 binding；删除失败返回内部错误，交互事务随后失败或交互版本耗尽时 code 已消费，用户从 Gitea 重新发起 open。这个顺序同时保证暂时条件失败可重试和成功 binding 的一次性语义。

成功返回：

```text
user_id
runtime_uuid
endpoint_id
interaction_generation
```

Cache miss 时 code 失效，用户重新从 Gitea 发起 open；Redis/memcache 在 TTL 内保留的 code 可以继续交换，但仍执行全部实时校验。codespace 生命周期状态不受 cache 影响。

Gateway 只以 GET 交换恰好一个 code，要求请求 Host 与返回 binding 派生的 host 一致，再创建服务端 session。HTTPS 使用 Secure、不带 Domain、`Path=/`、`HttpOnly/SameSite=Lax` 的 `__Host-gitea_codespace_session`，HTTP 使用对应无前缀名称；多个 Cookie 候选只有恰好一个本地有效 session 匹配当前 Host 与完整 binding 时才成立。Gateway 若持有同 Host 的合法短期恢复路径则 303 回到该路径，否则 303 到 `/`；两种响应都清除恢复 Cookie。带 code 的请求不代理到目标，响应设置 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。Gateway 重启后本地 session 失效，用户直接打开私有 URL 时由 Declare 返回的 `gitea_web_url` 进入带 `open_endpoint` 的 Gitea 详情页，登录后自动显示打开弹窗，也可以从普通详情页重新打开。

实现验收点：

- Codespace Gitea Token、Gateway open code 和 Manager 凭据使用各自独立的数据模型、生命周期与校验入口。
- open code 单次消费、60 秒过期，并在消费时重新检查当前访问条件。
- code 写入和交互事务全部成功后才签发；缓存值无法解析和显式过期的 code 尽力删除，实时访问条件不满足时保留到原 TTL，成功校验但 code 删除失败时不返回 binding。
- code 成功签发和消费都会推进交互版本并取消 queued idle stop；消费 binding 返回最新版本，Manager 据此重置完整空闲计时。
- code 成功消费后的 `last_active_unix` 更新失败不恢复 code，也不拒绝已经成立的 binding。
- 默认 open 在当前 metadata 存在固定私有 `workspace` 时签发同一 `endpoint_id`；该 Web IDE 入口不依赖 Runtime manifest 声明，由 Manager 生成并代理到当前 Dev Container 的 code-server。
- 列表和详情页复用一个无副作用的打开弹窗，POST 才可能签发 code；公共 Endpoint 的 POST 只重定向且不生成 code 或用户交互。
- Gateway 恢复使用 `GET /-/codespaces/{codespace_id}?open_endpoint={endpoint_id}` 完成登录和自动弹窗；目标无效或当前不可打开时不提交 POST。普通打开在新标签页提交，恢复打开在当前标签页提交。
- Open 签发使用当前绑定 Manager 最近一次成功 Declare 的 Gateway 地址；Validate 只允许 code 中的 Manager 身份消费，返回 binding 不需要再次提供 Manager ID 或地址。
- Codespace 物理删除提交后先释放 Codespace lock，再尽力清理 Runtime Metadata；未消费 open code 最多保留到短 TTL，后续消费因 Codespace 不存在而拒绝并保留到原 TTL。
- Gitea 以 303 把 POST 转为 Gateway GET；签发和交换响应都禁止缓存并使用 no-referrer。交换后浏览器地址和后续 Referer 不再包含 code，HTTPS `__Host-` session Cookie 不向其他 Endpoint host 暴露。
- 私有深层链接的短期恢复值只接受当前 origin 的合法 path/query，保留路径、外部 URL、控制字符和超过 2048 字节的值不会成为回跳目标；该 cookie 不转发给 Runtime。
- token 或 code 明文不进入日志和非凭据响应。

## Cron 任务

| 任务 | 默认调度 | 职责 |
| --- | --- | --- |
| `reconcile_codespaces` | `@every 1m` | 收敛 queued/running operation 超时，并清理超过保留期的 `failed` Codespace |

`reconcile_codespaces` 每轮只读取一次当前时间，并依次执行 queued operation 超时、running operation 超时和 failed 到期清理三个阶段。queued operation 使用 `operation_created_unix + QUEUE_TIMEOUT` 判定等待超时，running operation 使用已经由 `OPERATION_MAX_DURATION` 封顶的 `operation_deadline_unix` 判定超时；failed 保留期从进入 failed 时写入的 `updated_unix` 起算，到期条件为 `status=failed AND updated_unix <= now-OLDER_THAN`。`OLDER_THAN` 使用 Gitea Cron 通用的正数时长配置，默认 `8760h`；配置变更在服务重启后生效，缩短时长会使满足新边界的记录在下一轮被清理，延长时长不改写现有记录。

Runtime inventory 差异只在 `ReportInstances` 请求内计算。Manager 的 offline 状态由请求根据 `runtime_state`、`last_online_unix` 和 `MANAGER_OFFLINE_TIMEOUT` 实时派生，周期任务不扫描或改写 Manager 状态。自动暂停由 Manager/Gateway 的实时连接索引和本地单调时钟判断，达到超时后通过 `RequestIdleStop` 创建普通 stop，因此周期任务也不扫描 `last_active_unix` 或自动暂停设置。

**设计理由：单个周期任务已经能够表达全部数据库时间边界。**三个阶段操作同一类 Codespace 记录，都使用有索引的短查询；每分钟执行一次 failed 空结果查询的成本很小。统一任务避免维护两套调度配置，也不需要增加“每天是否已经清理”的进程内或持久化计时。**设计如此：`ENABLED`、`RUN_AT_START` 和 `SCHEDULE` 对三个阶段整体生效；启动执行会清理当时已经超过 `OLDER_THAN` 的 failed 记录。`OLDER_THAN` 决定保留边界，调度周期只决定到期后的最长清理延迟。**

任务沿用 Gitea 现有 Cron 注册和 `cron_task:reconcile_codespaces` 全局任务锁，不增加调度器或专用任务锁。三个阶段分别使用 100 条固定批次和稳定排序：queued 按 `operation_created_unix, id`，running 按 `operation_deadline_unix, id`，failed 按 `updated_unix, id`。每个 Codespace 候选单独取得 Codespace lock 并在短事务中处理。单条业务或数据错误记录服务端日志后继续当前批次，并在下一轮重新扫描仍需处理的记录。某个阶段发生候选查询、数据库连接或事务基础设施错误时结束该阶段并继续其他阶段，任务最后汇总返回错误，使 Cron 状态能够显示本轮失败且一个阶段不会长期阻塞其他阶段。任务响应进程关闭 context，处理完当前短事务后停止。**设计如此：**排序尾列使用内部数值主键以匹配生命周期索引；日志、锁和 Manager 协议在 Runtime UUID 绑定后使用同一运行侧身份，绑定前使用内部 ID，不形成第二套外部状态。

failed 到期阶段直接执行 Gitea 本地物理删除：取得 Codespace lock 后在本地事务中删除 Codespace Token、Git SSH Key、单文件日志和数据库记录，提交并释放 lock 后尽力清理对应 cache；cache 清理失败只记录服务端日志，不改变删除结果。该阶段不创建 delete operation，不联系 Manager，也不读取 Manager runtime state。failed 已经是不可恢复终态，保留期只用于给用户读取日志和手动 delete；到期后继续等待运行侧确认不会增加 Gitea 数据安全性，反而会让终态记录无限保留。原 Manager 身份仍有效时，下一次成功的完整 inventory 按无数据库记录返回 `cleanup_local_runtime`。

Token 与 Git SSH Key 都由 `RequestRuntimeAccess` 创建或修复；active create/resume 和无 active operation 的 stable running 使用当前 operation 版本调用。stop final、resume 失败/超时、failed、deleting 和物理删除事务同步删除对应凭据。事务提交或回滚时，主状态与凭据结果保持一致，认证还会检查 Codespace 主状态。周期任务不会扫描或修复开发凭据，只在 operation 超时和 failed 物理删除的既有事务中得到规定的凭据结果。

Codespace 数据库行使用自增 `id` 作为内部主键，创建者 Web 路由和 Gitea 关系表使用 `codespace_id` 关联主记录。规范 Runtime UUID 在 Manager 领取 create 后绑定，随后作为 Manager 协议、日志文件、Gateway Host、SSH 用户名和运行资源的运行侧标识；绑定前为空并使用普通索引支持查找。**设计如此：**数据库 ID 适合 Gitea 页面、事务、关联键和排队阶段对象，Runtime UUID 适合运行侧资源和跨域访问入口。两者承担不同职责，因此 create 排队阶段不需要提前拥有 Runtime UUID，运行侧入口也不暴露顺序 ID。

实现验收点：

- `reconcile_codespaces` 只处理数据库可判断的 queued/running operation 超时和 failed 到期清理，不读取 inventory 快照，也不扫描或改写 Manager 状态。
- 自动暂停由 Manager 的实时连接与单调计时触发，并通过 RequestIdleStop 进入 stop operation；Cron 不从 `last_active_unix` 推算空闲。
- `OLDER_THAN` 必须是正数时长；默认 `8760h`。非正数使本轮 Cron 明确失败并记录配置错误，但不阻止 Gitea 启动；到期判断使用进入 failed 时稳定写入的 `updated_unix`。
- `ENABLED`、`RUN_AT_START` 和 `SCHEDULE` 统一控制三个阶段；启动执行会处理全部当时已经到期的 operation 和 failed 记录。
- failed 到期阶段在本地事务中清理 Codespace 记录、Token、Git SSH Key 和对应单文件日志，提交后先释放 Codespace lock 再清理 cache；cache 清理失败不恢复记录或权限。
- failed 到期清理不创建 operation 或等待远端确认；原 Manager 后续通过成功的完整 inventory 取得 cleanup。
- Codespace Token 和 Git SSH Key 不参与周期修复；两类开发凭据随 Codespace 生命周期事务维护。
- `codespace.id` 用于创建者 Web 路由、事务和 Token/Git SSH Key 关系；`codespace.uuid` 只在 Manager 绑定后用于运行侧 RPC、日志、Gateway 和 SSH。
- 系统不存在按 operation 历史清理日志的 cron 任务。
- 三个阶段各读取最多 100 条稳定排序候选，并对每个 Codespace 使用独立短事务；单条失败不阻塞同批后续记录，阶段级错误不阻塞其他阶段并使本轮任务返回失败。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
GIT_PROTOCOL = http
GIT_SSH_KNOWN_HOSTS =
CONTROL_PLANE_TIMEOUT = 30s
GATEWAY_REQUIRE_HTTPS = false
MANAGER_OFFLINE_TIMEOUT = 120s
OPERATION_LEASE_TIMEOUT = 300s
OPERATION_MAX_DURATION = 2h
QUEUE_TIMEOUT = 5m
LOG_MAX_SIZE = 64MiB
AUTO_STOP_DEFAULT_TIMEOUT = 30m
AUTO_STOP_MIN_TIMEOUT = 5m
AUTO_STOP_MAX_TIMEOUT = 168h

[cron.reconcile_codespaces]
ENABLED = true
RUN_AT_START = true
SCHEDULE = @every 1m
OLDER_THAN = 8760h

```

说明：

- `GIT_PROTOCOL=http|ssh` 是 create payload 的首次 clone 首选协议，默认 `http`。Gitea 创建记录时校验该配置可用，但不写入 `codespace` 表；Manager 领取 create 时按站点当前可用 Git clone 能力提供 URL：HTTP 可用时提供 `repository.clone_http_url`，SSH 可用时提供 `repository.clone_ssh_url`；不可用的协议使用空 URL 表达。内置 bootstrap 只在非空 URL 中选择实际 remote；首选协议的 clone/fetch 非零退出且另一种 URL 非空时清理受控临时 workspace 并在同一次 bootstrap 中重试一次，最终把成功 URL 固定为 workspace remote。resume 以实际 remote 为准，不重新选择。
- 启用功能时，全部 setting 和数据库迁移完成后推导 Git clone 能力。HTTP 可用条件是 `[repository] DISABLE_HTTP_GIT=false`。SSH 可用条件是 `[server] DISABLE_SSH=false`，并且能够取得可信 Host Key：内置 SSH 可从 Gitea Host Key 派生，外部 SSH 需要显式 `GIT_SSH_KNOWN_HOSTS`。`GIT_PROTOCOL=http` 且 HTTP 可用时，外部 SSH 没有 known_hosts 只关闭 SSH clone；`GIT_PROTOCOL=ssh` 时 SSH 必须可用；HTTP 被关闭且 SSH 不可用时没有可交付给 Runtime 的 clone URL。此类配置错误会禁用本进程的 Codespace 功能并写出明确错误，Gitea 其他功能继续启动，管理员修正配置并重启后即可恢复。
- `[server] START_SSH_SERVER=true` 表示使用 Gitea 内置 SSH。`GIT_SSH_KNOWN_HOSTS` 为空时，启动顺序先调用内置 SSH 已有的 Host Key 准备逻辑：读取存在的 `SSH_SERVER_HOST_KEYS`，全部不存在时在既有目录生成默认 Key；随后从实际启用的私钥派生公开 Host Key，并按 `SSH_DOMAIN` 和有效 `SSH_PORT` 构造规范 known_hosts 行。Codespace 校验和内置 SSH 服务使用同一组准备结果，首次启动不会因 Key 尚未生成而误报配置错误。
- `[server] START_SSH_SERVER=false` 表示 SSH 接入由外部服务提供。Gitea 进程不能可靠知道外部 SSH 服务的 Host Key，因此只有显式配置 `GIT_SSH_KNOWN_HOSTS` 时才启用 Codespace SSH clone。每行的 host pattern 必须精确匹配默认端口的 host 或非默认端口的 `[host]:port`，公钥必须通过 Gitea SSH parser。内置 SSH 也可以显式配置该项，以便在 Host Key 轮换期间同时下发多把可信 Key。
- 全部 setting 和数据库迁移完成后，Gitea 在注册 Codespace Web route、ManagerService 和 session 中间件前扫描现有 `codespace_manager_address(kind=gateway)`。每个可解析的基础域名都执行与 Declare 相同的 ASCII DNS、最长派生 Host、可注册域、Gitea host/wildcard 和 `[session].DOMAIN` 诊断；cookie scope 重叠时日志包含 Manager ID、地址、`ROOT_URL`、session domain 和原因，但不阻止启动。数据库中已经存在的坏 Gateway 地址只写启动告警并跳过该条诊断，新的 Declare 仍按同一语法硬拒绝。这样修改 `ROOT_URL`、Cookie Domain 或修复旧数据时管理员仍可进入 Gitea 处理 stop、delete、force delete、Manager 配置和部署修复。
- SSH Host Key 轮换先在配置和 SSH 服务中同时保留旧、新 Key，现有 Codespace 通过后续 stop/resume 取得完整集合；全部实例刷新后再移除旧 Key。未按该顺序更换时，现有 Runtime 的严格校验会明确失败，并通过 stop/resume 重新取得当前集合。这里使用已有恢复流程处理低频运维事件，不增加运行中的 Host Key 推送服务。
- `ENABLED=false` 使用排空模式并跳过 Git clone 能力推导。stop、delete、inventory 收敛、failed retention 和管理清理都不依赖 Git HTTP 或 SSH；管理员可以在仓库接入不可用时启动 Gitea 完成缩减和清理，再恢复至少一种符合当前首选协议的 Git 接入后重新启用。
- Codespace 功能只支持一个活动 Gitea 进程；cache 直接复用 `[cache]` adapter，需要 keyed serialization 的明确写路径直接调用 `[global_lock]` backend 提供的 `globallock.Lock`，Cron 沿用 Gitea 单实例调度。Redis 配置不改变 Codespace 的单进程支持边界。
- `ENABLED=false` 使用排空模式，不删除现有 Codespace/Manager 数据。Web 禁止新 create、resume、open、继续运行和 SSH，但创建者详情、创建者日志、创建者自动暂停设置、stop、普通 delete、站点管理员 force delete 与现有管理页继续可用；`ValidateOpenToken`、`ValidatePublicEndpoint`、`VerifySSHPublicKey` 和 `RevalidateGatewaySession` 都返回 `state_unavailable`。认证和公共普通 HTTP 在下一次请求且最迟已有 allowed 的 1 秒期限结束后拒绝，WebSocket 和 SSH 最迟在一个复检周期内关闭。
- 排空模式拒绝全部 `RequestRuntimeAccess`、新的 idle stop 创建和 Runtime Metadata 写入。`RequestIdleStop` 对已经存在的 idle stop 仍返回 `pending`，对没有 active operation 的 running 对象返回包含 `auto_stop_enabled=false` 的 `observation_changed`；ReportInstances 下发相同关闭设置，使 Manager 清除普通计时。已有 Manager 仍使用已签发的 secret 认证，可以 Declare、ReportInstances、上报 stopped/failed transition，并通过 Fetch 领取 stop/delete 或取得已领取 create/resume 的 abort；对应 UpdateLog 和 final failed 继续可用。stop 从本地 Runtime credential 文件恢复日志脱敏值，无法确认安全的缓冲日志不上传。queued create/resume 不再领取，按现有 queue timeout 处理。
- 排空模式继续运行 `reconcile_codespaces`。Codespace Token resolver 和仓库能力判定不受 `ENABLED` 开关影响，仍会识别并拒绝已有凭据；普通 PAT 行为不需要 Codespace 特判。重新启用后，未进入 stopped/failed/deleting 的现有对象继续按当前状态工作。
- [Gateway Open Token](glossary.md#gateway-open-token) 使用固定 60 秒有效期，同时作为 cache TTL 和 `expires_unix` 计算时长。该期限属于一次性授权码的安全边界，部署配置不需要改变协议行为。
- Runtime Metadata 与 Open Code 直接保存在站点 `[cache]` adapter，并使用各自明确 TTL；即使通用 `[cache] ITEM_TTL=-1`，协议条目仍按自身 TTL 写入。需要串行化的写路径直接使用站点 `[global_lock]` backend。
- `CONTROL_PLANE_TIMEOUT` 从 Connect 应用 handler/interceptor 接管已经受大小限制并完成 framing 的请求开始，到响应提交为止，覆盖认证、`globallock` 等待、数据库、cache 和响应构造。HTTP 请求体读取和网络传输继续使用 Gitea 现有 HTTP server timeout；该配置不替代通用读写超时。该 deadline 到期返回 Connect `DeadlineExceeded`，caller 取消返回 `Canceled`，均不附业务 failure detail；请求结束后不把同一个 RPC 转为后台任务继续执行，已经提交的短事务结果保持有效。
- ManagerService 编码后的 protobuf request 和 response 使用固定 32 MiB 双向硬上限。Gitea Connect handler 用它限制请求读取并在提交响应前检查响应大小，Manager 使用 Declare 返回的同一值限制响应读取和日志分批。该值是协议实现边界，不是部署容量策略；固定值避免 Gitea 与 Manager 因配置不同产生不可通信状态。
- `GATEWAY_REQUIRE_HTTPS=false` 时接受 `http://` 和 `https://` 的 `gateway_url`；设为 true 时只接受 HTTPS。该选项用于部署策略，不改变扁平子域路由或 session 语义。
- SSH 认证限流与退避由 Gateway 配置和管理。
- `OPERATION_LEASE_TIMEOUT` 是 Manager 领取或续租 [Operation](glossary.md#operation) 的标准 lease 时长。`OPERATION_MAX_DURATION` 是同一次 running operation 从首次领取开始计算的总执行时长，默认 2 小时。Gitea 将向未来取整的 `grant_time + lease timeout` 与 `operation_started_unix + max duration` 取较早值作为数据库 deadline；成功响应通常返回完整 lease 毫秒数，最后一段返回到总期限为止向下取整的实际正整数毫秒数，abort 固定返回 0。这样普通 lease 不因秒级数据库时间戳提前结束，持续续租也不能让 active operation 永久存在。
- `MANAGER_OFFLINE_TIMEOUT` 和 `QUEUE_TIMEOUT` 以正整数秒表示，分别用于 `last_online_unix` 和 `operation_created_unix` 的秒级边界计算。自动暂停的默认值、范围和对象自定义值也以正整数秒下发为 `idle_timeout_seconds`。统一存储精度可以让配置、数据库比较和 RPC 数值之间没有隐式截断。
- `AUTO_STOP_DEFAULT_TIMEOUT` 是 `auto_stop_mode=default` 的有效空闲时长；`AUTO_STOP_MIN_TIMEOUT` 与 `AUTO_STOP_MAX_TIMEOUT` 校验之后提交的新自定义值。范围变化不重写或截断已经保存的正数自定义值，Codespace 创建者可在自己的详情页看到原值并主动修改；这样站点配置调整不会让现有 Codespace 在未操作时突然改变超时。`never` 由模式明确表达，不使用超时 0 表达。站点默认值变化通过下一次 inventory 下发，无需批量更新对象记录。
- Gitea 使用固定 64 KiB 上限读取单份 `devcontainer.json`，避免创建确认变成无界大文件解析路径。仓库配置大小属于解析器资源边界，不因部署规模变化。
- `LOG_MAX_SIZE` 限制单个 codespace 日志总量，避免异常 bootstrap、构建或 lifecycle 持续输出导致 DBFS 无限增长。
- Gitea 使用内部默认值限制单条日志行、单次日志读取响应和内部状态摘要预留空间。**设计如此：**管理员通常只需要决定每个 Codespace 最多保存多少日志；行大小、分页大小和摘要预留是保护 DBFS 与页面读取稳定性的实现参数，公开成配置会增加相互约束和错误组合。默认值保证普通日志分页和控制面异常摘要可以闭环，异常输出达到上限时用明确截断摘要收敛。
- Gitea 使用固定 256 KiB 上限检查规范化 Runtime Metadata typed snapshot，避免 Endpoint 声明或资源指标无限放大 cache 和 RPC。控制面继续校验 Endpoint 数量、字段长度和资源值；固定总量上限负责最终资源边界，不需要在启动时构造理论最大 protobuf。
配置在启动时完成关系校验。timeout、lease、queue timeout、大小和 retention 都必须大于 0；`OPERATION_LEASE_TIMEOUT` 必须能精确转换为大于 0 的整数毫秒，`OPERATION_MAX_DURATION`、`MANAGER_OFFLINE_TIMEOUT`、`QUEUE_TIMEOUT`、`AUTO_STOP_DEFAULT_TIMEOUT`、`AUTO_STOP_MIN_TIMEOUT` 和 `AUTO_STOP_MAX_TIMEOUT` 必须能精确转换为大于 0 的整数秒，并且 `OPERATION_MAX_DURATION > OPERATION_LEASE_TIMEOUT`；`CONTROL_PLANE_TIMEOUT` 必须小于或等于 `floor(MANAGER_OFFLINE_TIMEOUT/4)`，使一次达到处理上限的 Declare 仍能在离线边界内重试；自动暂停满足 `AUTO_STOP_MIN_TIMEOUT <= AUTO_STOP_DEFAULT_TIMEOUT <= AUTO_STOP_MAX_TIMEOUT`；`LOG_MAX_SIZE` 必须大于内部日志分页大小和状态摘要预留空间。非法 Codespace 配置会禁用本进程的 Codespace 功能并记录具体错误，Gitea 的代码托管、Issue 和其他功能继续启动。**设计如此：Codespace 是可选功能，配置错误按与 `ENABLED=false` 相同的排空边界处理。**

日志是唯一按消息大小拆分的控制面数据，Manager 使用 `proto.Size` 形成不超过 Declare 返回上限的批次；单条最大日志物理行已由启动校验保证可独立提交。inventory、observed operation 和 Runtime Metadata 保持完整提交。超限请求在进入业务 handler 前返回 Connect `ResourceExhausted`；协议字段或本地数据违反既有限制而导致不可拆分消息超限时，Manager 保持 recovering，后续 Fetch 提交两类零可用槽位，并报告具体消息类型和大小，不截断清单或推测缺失实例。

实现验收点：

- `ENABLED=false` 禁止新增运行与交互，但保留 stop/delete/abort/final、管理清理和 Cron；现有 Codespace Token 始终由专用 resolver 识别并拒绝使用。
- Codespace 配置校验失败时 Gitea 主进程仍能启动，日志指出具体配置错误，Codespace 按 `ENABLED=false` 的边界运行。
- `ENABLED=false` 允许可认证 Manager 提交连续的完整 inventory，并按正常无记录、binding 不匹配、failed 和 missing 规则收敛资源。
- `ENABLED=false` 下 `RequestRuntimeAccess` 返回状态不可用，不读取、签发、修复或登记开发凭据。
- `ENABLED=false` 下 RequestIdleStop 不创建新的 operation；已有 idle stop 的幂等请求返回原版本，其余 running 请求取得关闭自动暂停的完整设置。ReportInstances 下发同一设置，Manager 取消本地普通计时并继续恢复已经接受的 stop。
- Gitea 是功能开关的唯一判定来源。**设计如此：**关闭后的访问收敛复用四个访问 RPC，create/resume 收敛复用 Fetch abort，Runtime Metadata 返回 `state_unavailable`；Manager 依据这些结果处理当前工作，协议保持现有字段和调用方向。
- `ENABLED=true` 时，Gitea 在组件注册前推导 HTTP 与 SSH clone 能力；首选协议必须可用，且至少一种 clone URL 可以下发。错误指出不可用协议和相关配置项。
- `GIT_PROTOCOL=http`、HTTP Git 可用、外部 SSH 未配置 `GIT_SSH_KNOWN_HOSTS` 时启动成功，create payload 的 `repository.clone_ssh_url` 为空；`GIT_PROTOCOL=ssh` 或 HTTP Git 被关闭时，SSH 服务关闭、Host Key 缺失或 host/port 不匹配会阻止启用。
- 内置 SSH 首次启动时，Codespace 校验与 SSH 服务复用同一次 Host Key 准备结果；外部 SSH 不从本机私钥推测服务器身份，使用显式 `GIT_SSH_KNOWN_HOSTS`。返回 Runtime 的每条 known_hosts 行都能匹配规范 SSH clone URL。
- `ENABLED=false` 时可以关闭 HTTP Git 或 SSH，并继续执行 stop、delete、inventory 收敛和管理清理；再次启用前恢复存量 Codespace 所需的接入面。
- 启用 Codespace 时只有一个活动 Gitea 进程；memory、twoqueue、Redis、memcache cache adapter 和 memory、Redis global lock backend 均沿用 Gitea 现有配置，不据此提供多实例能力。
- 重新启用不迁移或重建数据库状态，现有对象按当前持久状态继续。
- 配置项与实际 cron、lease、queue、open code、日志总量限制一一对应；非法值或相互矛盾的大小关系在启动时拒绝。日志行大小、读取分页和内部状态摘要预留使用内部默认值，并通过 `LOG_MAX_SIZE` 的关系校验保证可用。
- 消息大小配置同时覆盖 request 和 response；启动测试使用 protobuf 实际编码大小验证全部最大不可拆分消息，低于最低值时错误指出实际值、要求值和消息类型。
- Manager 使用 Declare 返回的消息上限分批日志；完整 inventory、完整 observed operation 和 Runtime Metadata 不分页、不截断，超限输入在业务事务前返回 `ResourceExhausted`。
- lease 配置可精确表示为正整数毫秒，Manager 离线、queue、Open Code 和自动暂停配置可精确表示为正整数秒；其他精度的值在启动时指出对应配置项。
- control plane timeout 不大于服务端心跳周期；Manager 保持单个进行中的 Declare，成功后按新周期调度，临时错误的退避不越过该周期。
- Fetch 领取和 observed 续租使用同一 `grant_time` 规则：数据库 deadline 向未来取整到 Unix 秒，响应相对时长保持精确配置毫秒值；FinalizeOperation 只提交最终结果。
- control plane timeout 包含认证、锁等待、数据库和 cache；deadline/cancel 使用 Connect 标准 code 且不附业务 detail，超时后不在后台继续同一个 RPC，已提交事务不回滚。
- 自动暂停默认值和自定义范围在启动时完成关系校验；功能开关或站点默认值变化后，default 对象通过下一次有效设置下发自然更新，never 对象保持关闭。
- 自定义范围只校验新的设置提交，范围调整不静默截断已有自定义秒数；重新保存时必须满足当前范围。
- Gitea 不保存容量快照，也不把容量作为站点配置或 quota；领取只使用本次 Fetch request 的两类可用槽位。

Manager 本地配置由 Manager 自己管理。目标运行形态使用 Manager 状态库保存业务配置：

```text
GITEA_CODESPACE_STATE=local
GITEA_CODESPACE_STATE_PATH=/var/lib/gitea-codespace/manager.db
GITEA_CODESPACE_STATE_ENCRYPTION_KEY=<base64-encoded-32-byte-key>
```

local 模式使用 SQLite，适合单进程 all-in-one Manager。etcd 模式使用相同逻辑对象，适合多节点和 Gateway-only。环境变量只指定状态驱动、状态位置、加密密钥、节点 ID 和本地管理 API 入口；Gitea URL、Manager ID、Manager Secret、Gateway、Incus、环境 tag 和缓存策略都由 Manager 管理 API 写入状态。这样设计是为了让配置修改拥有一个事务边界，避免同一部署事实分散在 YAML、环境变量和运行快照之间。

Manager 状态中保存的主要对象如下：

| 对象 | 保存内容 | 原因 |
| --- | --- | --- |
| site | Gitea URL、Manager ID、加密 Manager Secret、启用状态 | 一个 Manager 可以连接多个 Gitea；secret 属于该站点身份 |
| gateway | HTTP/SSH 监听、公开地址、session 和限流参数 | Gateway 可以独立扩展，地址共享是部署拓扑 |
| incus backend | endpoint、project、storage、network 和管理策略 | 后端是部署实现细节，不进入 Gitea 数据库 |
| environment | tag、说明、实例类型、来源、profile 和资源 | 用户只选择 tag，Manager 决定底层后端 |
| runtime binding | Runtime UUID、site、backend、Codespace ID、tag 和 operation 版本 | resume、stop、delete 必须回到创建时绑定的后端 |

`node.state_dir` 仍是 Manager 运行快照目录，保存 `manager-runtime.json`、Gateway SSH Host Key 和每个 Runtime 的恢复文件。它不保存明文 Manager Secret，也不是业务配置数据库。`manager-runtime.json` 只保存 `state_format_version`、`protocol_version` 和最近提交的 `inventory_generation`，以 `0600` 原子写入。

**设计如此：业务配置、控制面 secret 与 Runtime 快照分层保存。**Gitea 管理页是 Manager 身份签发点；Manager 状态库保存连接站点和运行后端；`node.state_dir` 保存可以按 Runtime UUID 恢复的本地运行进度。备份 Runtime 快照不会复制明文 Manager Secret，复制 Manager 状态也不会包含用户 Codespace Secret 或本轮 Gitea Token。

Manager 当前状态是 `node.name`、环境 tag/description、Gateway 地址和 SSH 地址的唯一声明来源，修改后通过完整 Declare 快照覆盖 Gitea 中的当前值。Declare 的环境声明直接从 Manager 状态中的 environment 列表生成。容量只限制 Manager 本地 Runtime 总数，不进入 Declare。**设计如此：**tag 是 Gitea 侧让用户选择基础设施环境的稳定标识，description 解释该选择；二者都不是 Incus image、profile、project 或实例名称，镜像和 profile 调整不应改变 Gitea 中的用户语义。虚拟机或系统容器类型不向 Gitea 上报，因为 Gitea 只按 tag 匹配。配置不包含 `startup_capacity_available`、`cleanup_capacity_available`、Gateway SSH Host Key 指纹或 Host Key 更新时间：两类可用容量由 Manager 在 Fetch 前按本地 Runtime 和 worker 状态计算，Host Key 指纹由 `node.state_dir` 中的 Gateway SSH Host Key 派生后 Declare。

Gateway 地址可以被多个 Manager 或多个 Gitea 站点共享。Gitea 保存地址用于页面展示和诊断，发现共享时只记录警告，不拒绝启动。**设计如此：**共享 Gateway 是多站点和 Gateway-only 的正常部署形态，真正的访问边界是 Open Code、Manager ID、Runtime UUID、Endpoint ID、公钥认证和 session 复检；地址本身只是用户入口，不是权限边界。

`startup_workers` 和 `cleanup_workers` 分别限制启动与资源缩减任务，范围均为 1..256；前者省略时默认为 `min(capacity_total, 4)`，后者省略时默认为 4。Incus 可用时，`startup_capacity_available` 取运行实例剩余名额和空闲启动槽位的较小值，`cleanup_capacity_available` 取空闲清理槽位数；Incus 不可用时两者都为 0。Manager 按每个已声明环境的实例类型和资源要求检查 project 配额，把本轮可创建的 tag 写入 `accepted_create_tags`；集合为空时从 `accepted_operation_types` 移除 create，但有运行名额时仍可接受 resume。`capacity_total` 范围为 1..10000，且单个 Manager 管理的全部 Incus 实例数同样不能超过 10000。

`runtime.git.ssh_key_type` 是 Manager 本地生成 Runtime Git SSH key 的算法选择，默认 `ed25519`，可选 `rsa-4096`。该值只在 Runtime 内没有已有 key 时影响 Manager 生成 root seed 的方式，不进入 Gitea 数据库、RPC payload 或 Codespace state。Runtime Git SSH 私钥位于对应 Incus 实例内，不写入普通配置之外的 Manager 状态目录。**设计如此：**Gitea 只需要保存和鉴权公钥，不需要知道管理员选择哪种本地密钥算法；把算法留在 Manager 配置中可以满足部署偏好，同时不扩大控制面协议。

`runtime.cache.registry` 是 Manager 内置 OCI registry cache。启用后，Manager 在 `listen` 上启动 registry 服务，Runtime 内的 Docker 客户端通过 `public_url` 访问它；`public_url` 必须是 registry 根地址，不带业务 path。`storage_path` 保存 registry 数据，`max_size`、`max_age` 和 `gc_interval` 控制本地清理。`upstreams` 的键是允许进入缓存的原始 OCI registry host，`allow` 是该 host 下允许缓存的 image 路径模式；省略 `allow` 表示该 host 下的 image 都可缓存。mirror 是 Manager 级共享下载缓存，BuildKit 构建缓存按仓库 hash namespace 隔离。省略整个 `runtime.cache.registry` 时，每个 Runtime 只使用自身 Docker daemon 的本地缓存并直接访问原始 registry。

启用后，Manager 只在 create 下发短期 registry 凭据和缓存地址：显式镜像和 Feature 优先从内置 `/mirror/{registry}` 取得，未命中或不可用时拉取原始镜像，并在成功后尽力发布到缓存；Dockerfile、Compose、Feature 和运行用户调整层从内置 BuildKit registry cache 恢复并发布结果；Feature 安装后的纯镜像 artifact 也会按 base image、Feature digest、Feature 选项和安装环境尽力发布，后续相同输入可直接拉取复用。普通代码 commit 不进入跨实例 cache scope，原因是 BuildKit 会按 Dockerfile 实际读取的文件内容判断层命中；把 commit 放进 scope 会让同一开发环境在每次代码提交后失去缓存。resume 和 stop 使用现有环境，不访问 registry。mirror 或 cache 暂时不可用会回退原始 registry 或本地构建，因此缓存用于降低下载流量和重复构建时间，不成为 Codespace 正确运行的依赖。

内置 registry 使用 Runtime 内 root 用户的标准 Docker credential store。Manager 为每次 create 生成短期凭据，凭据只写入本次 Runtime 临时请求文件，执行后删除，不写入 Manager 本地状态、Gitea 数据库或持久 Codespace 状态。HTTP `public_url` 会进入实例 Docker daemon 的 insecure registry 列表，生产部署推荐 HTTPS 或只放在 Incus 私有网络。Manager 合并已有 `/etc/docker/daemon.json`，保留部署者的日志、存储和其他 registry 设置。缓存可能保存 Dockerfile 产生的私有层或 Feature 安装后的镜像 artifact，所以构建缓存路径按仓库全名生成 hash namespace，日志和 registry 路径不暴露明文仓库名；授权判断仍使用 Manager 已知的真实仓库身份，并拒绝跨仓库 blob mount。私有 registry 的上游登录凭据仍由 Runtime 内 Docker 环境负责，Manager 内置 registry 不保存远端 registry 账号。Gitea 数据库不记录缓存条目，因为缓存只影响 Manager 构建效率，生命周期、权限和审计仍以 Codespace、operation 和日志为准。**设计如此：**缓存是 Manager 本地运行数据，放在 Gitea 数据库会把性能优化误认为生命周期状态；短期凭据和 hash namespace 可以满足 create 期间的访问控制，同时不增加一套用户可见的 registry 账号体系。

Manager 版本来自当前二进制构建信息，生产运行固定使用 Incus，Codespace 根路径、Bash、root bootstrap 和系统准备用户属于内置运行协议。**设计如此：**这些值必须与随二进制发布的脚本、状态路径和恢复逻辑保持一致，把它们暴露为配置只会产生看似可改、实际无法闭环的组合。测试后端仍由测试代码直接注入，不作为部署能力。完整行为见[Manager 原生 Dev Container 运行时](devcontainer-runtime.md)。

`runtime.incus.endpoint` 使用 URI 唯一选择 Incus：本机 socket 使用 `unix:///绝对路径`，远程服务使用 `https://主机:端口`。远程连接继续使用本机 Incus client 已建立的信任配置，Manager 本地状态不保存证书或 trust token。**设计如此：**单一 URI 已经同时表达连接方式和目标，避免两个互斥字段形成无效组合；证书生命周期仍由 Incus 工具负责。

`runtime.incus.project.name` 是 Manager 的专用 Incus project。`manage: true` 时 Manager 启动时创建或校验该 project，启用 profile 和 storage volume 隔离，并设置 `features.networks=false` 共享 default project 中的 managed network；项目内 default profile 和实例由 Manager 管理。storage pool 是宿主机级资源，只通过 `runtime.incus.storage.pool` 引用，并在启动时校验存在。managed network 已存在时必须是 managed bridge；不存在且 `runtime.incus.network.manage=true` 时，Manager 在 default project 中创建它，再由 Codespace project 的 profile 引用。`runtime.incus.network.manage=true` 需要 `runtime.incus.project.manage=true`，因为 Manager 需要同时保证 project 功能和 default profile 都采用这条共享网络。Manager 创建的 bridge network 使用自动 IPv4 地址、IPv4 NAT、显式 DHCPv4 和禁用 IPv6，使新实例能通过普通 DHCP 获得出站网络。**设计如此：**Incus project 是实例、profile 和项目存储卷的命名空间，而 managed bridge 是宿主机级网络资源；由 default project 承载网络并让 Codespace project 共享，符合 Incus 不允许非 default project 管理该类 bridge 的规则。storage pool 同样只引用不创建，避免 Manager 承担宿主机存储运维。Manager 托管 network 明确开启 DHCPv4，是因为 bootstrap 和 Dev Container 构建需要访问 Gitea、包源、镜像仓库或代码仓库；非托管 network/profile 由部署者提供等价网络能力，Manager 不实现自己的 IP 地址分配器。

默认 network 名称使用 `csnet`。Incus bridge 名称同时成为宿主 Linux 网络接口名，必须落在 15 字符接口名上限内；短名称可以直接用于本地和远程 Incus，也避免默认配置在创建第一个 Runtime 前才被内核拒绝。自定义 network 名称由部署者按目标 Incus 宿主的接口命名规则设置。

### Incus IPv4 故障排除

当 Incus bridge 已经有 IPv4 地址、Incus `dnsmasq` 也带有 IPv4 DHCP range，但新实例只有 IPv6 地址时，优先按宿主机防火墙路径排查。该现象说明 Manager 创建实例、profile 绑定网卡和实例内 DHCP 客户端通常已经工作，问题集中在实例发往宿主机 Incus `dnsmasq` 的 DHCPv4 请求是否被允许到达。

推荐诊断顺序：

```bash
incus network show <network>
incus network info <network>
incus profile show <profile>
incus launch images:debian/12 ipv4-check --profile <profile> --config limits.memory=1GiB
incus exec ipv4-check -- sh -lc 'ip -4 addr; ip route; networkctl --no-pager'
firewall-cmd --state
firewall-cmd --get-active-zones
firewall-cmd --zone=trusted --list-all
incus delete -f ipv4-check
```

如果手动 `dhclient -4` 持续发送 `DHCPDISCOVER` 但没有 `DHCPOFFER`，并且 `firewalld` 处于运行状态、Incus bridge 没有加入任何可信 zone，则把该 bridge 归入 `trusted` zone 是推荐修复：

```bash
sudo firewall-cmd --permanent --zone=trusted --add-interface=<network>
sudo firewall-cmd --reload
```

这样设计是因为 Incus 管理的 bridge 是宿主机与受控 Runtime 之间的本地运行网络，DHCP、DNS 和实例出站 NAT 都由 Incus 在该 bridge 上提供；把 bridge 明确归入可信 zone，可以让防火墙策略承认这条本地管理链路，同时不把 Gitea、Gateway 或用户 Endpoint 的公开访问策略混入 Incus 内部网络。只在 `public` zone 上零散开放 DHCPv4 端口容易把物理网卡和 Incus bridge 的安全语义混在一起，后续排障也难以判断规则来源。

实现验收点：

- 部署文档和运维手册能按上述命令确认 Incus network 有 IPv4 地址、`dnsmasq` 有 DHCP range、实例网卡已绑定 profile、实例内 DHCP 客户端正在发送 IPv4 请求。
- `dhclient -4` 有 `DHCPDISCOVER` 但没有 `DHCPOFFER`，且 `firewalld` 运行、Incus bridge 未归入可信 zone 时，运维修复路径明确为把该 bridge 加入 `trusted` zone 并 reload firewalld。
- 修复后新建测试实例能在 `incus list` 或实例内 `ip -4 addr` 中看到 IPv4 地址；测试实例在验证结束后被删除。

每个 `runtime.environments` 项指定 `tag`、`type`、`source` 和 `resources`，`profiles` 可省略并默认使用当前 project 的 `default` profile。`source.image` 与 `source.instance` 二选一：image 支持 `images:debian/12`、本地 alias 和 `local:<fingerprint>`；instance 使用当前 Incus endpoint 上的 `project/name`。**设计如此：**字段形状直接表达来源类型，不再要求维护额外的 `type` 判别值，也不会暗示支持跨 Incus 服务器复制。高级 profile 仍以扁平数组明确追加。

Incus 端到端测试复用 `runtime.incus.endpoint`。本地测试使用 unix URI，远程测试使用 HTTPS URI 和 project，并依赖本机 Incus client 的信任配置。测试环境由部署者准备可用 image、storage pool、网络和必要 profile；真实生命周期入口固定单实例内存为 `1GiB`，container/VM 的 provisioner 与完整 Manager 四条链路串行执行。

Manager 从实例展开设备中选择恰好一个连接到 `runtime.incus.network.name` 的 NIC，读取设备配置或 `volatile.<设备名>.hwaddr` 的 MAC，再按 MAC 匹配 Incus Instance State 中的实际来宾接口并取得全局 IPv4 地址。LXC 和 VM 使用同一流程，配置不包含来宾接口名。**设计如此：**profile 设备名和来宾接口名属于不同层级，VM 的接口名还会随镜像和虚拟硬件布局变化；MAC 由 Incus 设备和 guest agent 状态同时提供，能稳定关联两层而不要求用户猜测名称。目标网络没有 NIC 或出现多个 NIC 时，Manager 用明确配置错误说明 network 和设备；唯一 NIC 暂时没有地址时只在启动等待期重试。

managed network 位于 default project，并由 Codespace project 共享。实例入站只通过 Gateway；Manager/Gateway 使用 Incus API 完成 shell、exec、SFTP 和文件访问，并通过 Incus 确认的当前实例地址连接普通 Endpoint 与 Web IDE。Runtime 不需要访问 Manager API 地址。需要保证虚拟机隔离级别的容量使用独立 tag 和 Manager 配置，Gitea 不从实例类型推断安全级别。

`gateway.http.listen` 和 `gateway.ssh.listen` 是本地监听地址；`gateway.http.public_url` 和 `gateway.ssh.public_addr` 是向 Gitea 或用户声明的可达地址，两者可以因反向代理或端口映射而不同。`gateway.http.public_url` 允许 HTTP/HTTPS。Manager 启动配置校验会对 `gateway.http.public_url` 和 `gateway.ssh.public_addr` 做本地语法预检；第一次 Declare 再用数据库事务保存地址并记录共享入口诊断。`gateway.http.public_url` 必须使用规范的 ASCII DNS 主机名，不能带尾随点、业务 path 或 IP literal；每个标签为 1..63 字符，最长派生 Endpoint Host 不超过 253 字符。推荐与 Gitea `ROOT_URL` 使用不同可注册域，若处于同一 cookie scope，Gitea 记录部署告警并继续运行。多个 Manager 可以共享同一规范化地址；访问时仍通过 Runtime UUID、Open Code binding、session 和 Manager 绑定确认目标。部署为该基础域名和 `*.domain` 配置 DNS。Gateway URL 为 HTTPS 时，监听证书或受信反向代理证书同时覆盖基础域名与单层 wildcard；Cookie Secure 和保留名称按外部 URL 的实际 scheme 决定。普通 Endpoint 到 Runtime 的内部连接固定为 HTTP，外部 HTTPS、Cookie 和来源安全由 Gateway 统一处理。

`gateway.sessions` 管浏览器和 SSH session 生命周期，`gateway.limits` 管 Gateway 请求与连接资源，`gateway.ssh.auth` 管 SSH 公钥认证失败限流。`gateway.ssh.handshake_timeout` 同时限制 SSH 协议握手、Gitea 公钥校验和 Manager 本地后端确认，范围为 1 秒到 1 分钟、默认 30 秒；这样没有完成握手的 TCP 连接也会及时释放全局在途名额。`gateway.limits.max_inflight_total` 范围为 1..1000000，默认 4096；`gateway.limits.max_inflight_per_session` 和 `gateway.ssh.max_channels_per_connection` 范围均为 1..1024、默认 32，前者不得大于全进程上限。公共连接的 per-Endpoint 和 per-IP 上限范围均为 1..10000，且 per-IP 不大于 per-Endpoint；默认分别为 64 和 16，并继续受全进程在途上限约束。`gateway.limits.validation_max_inflight` 范围为 1..4096，默认 128，统一限制公共与认证 HTTP 的在途 Gitea 授权校验；相同授权键的并发 miss 只占一个名额。Gateway HTTP listener 固定使用 64 KiB header 上限和 10 秒 read-header timeout，正文保持流式转发。SSH 认证限流状态固定最多 65536 个有期限键。`node.shutdown_timeout` 限制 SIGINT/SIGTERM 后关闭准入、暂停 worker、保存本地状态和停止 listener 的总等待时间。心跳周期、Runtime Metadata 刷新周期、控制面消息上限和 Gitea 浏览器根 URL来自每次成功 Declare 响应，不在 Manager 配置中重复声明，因为这些值由 Gitea 的站点配置决定。

Manager 的运行配置保存在本地状态中，`codespace.yaml` 只作为首次导入或离线生成状态时的输入；它与仓库中的 `devcontainer.json` 职责不同。前者由部署管理员配置 Incus、Gateway 和运行环境，后者由仓库维护开发容器，两者不融合。

实现验收点：

- 控制面和 Gateway 在 HTTP 配置下可正常工作，启用对应 HTTPS 配置后使用证书和 CA 校验。
- `runtime.cache` 省略时创建继续直接访问原始 registry；配置后 Manager 启动内置 OCI registry cache，并且只影响 create。
- 普通代码 commit 变化不会单独改变 Manager 下发的 BuildKit cache scope；Dev Container 仓库路径或模板内容、Manager 环境 tag、Web IDE 版本或架构变化会改变 scope。
- Feature image artifact cache 命中时跳过 Feature 安装镜像构建；cache miss 或发布失败不改变 create 结果。
- `runtime.cache.registry.public_url` 必须是可从 Runtime 访问的 registry 根地址；`max_size` 为正数时启用容量回收；upstream host 和 allow 模式在 Manager 启动时校验；Docker daemon 现有 JSON 字段在合并 cache 设置后保持不变。
- registry 凭据不出现在 Manager 本地状态、Gitea 数据库、持久 Codespace 状态或日志；BuildKit cache 只能访问当前仓库 hash namespace，mirror cache 只能访问配置允许的 upstream host 和 image path，跨仓库 blob mount 被拒绝。
- 内置 registry 按配置执行容量、保留期和清理周期，清理失败或后续缓存引用缺失只影响缓存命中，不改变 Codespace 状态。
- Gateway Cookie Secure 按规范外部 `gateway.http.public_url` 选择 HTTPS `__Host-` 或 HTTP 普通保留 Cookie 名称；显式值与外部 scheme 不一致时启动失败。
- `gateway.http.public_url` 的尾随点、非法 DNS 标签、非根 path、IP literal 和过长派生 Host 都被拒绝；基础域名与单层 wildcard DNS/TLS 可以覆盖所有派生 Endpoint host。
- Manager 启动配置对 Gateway HTTP/SSH 对外地址做本地语法预检；第一次 Declare 负责保存地址并记录共享入口诊断。
- Gitea 启动和 Declare 会识别与 `ROOT_URL` 可注册域、完整 host、Gateway wildcard 或 `[session].DOMAIN` 重叠的 Gateway 基础域名，并记录包含 Manager、地址和配置项的部署告警；设计如此是因为 cookie scope 是部署选择，系统说明风险但不阻断管理员选择。
- Gitea 启动扫描遇到数据库中已有的坏 Gateway 地址时记录 Manager ID、地址和解析错误并继续启动；新的 Declare 仍拒绝同类坏地址，管理员可以进入管理页修复或删除旧记录。
- 两个 Manager 声明相同的规范化 `gateway_url` 时，后声明者正常保存当前快照；Gitea 通过普通索引识别共享入口并记录部署诊断。
- `gateway.ssh.public_addr` 完全来自 Manager 配置；两个 Manager 声明相同规范化 `host:port` 时，后声明者正常保存当前快照；SSH 访问继续由用户名中的 Runtime UUID 和 Manager 绑定决定目标。
- 修改 `node.name`、`runtime.environments[].tag`、`runtime.environments[].description`、`node.capacity_total` 或 Gateway/SSH 地址后，成功 Declare 整体覆盖旧快照；失败 Declare 不产生部分更新。
- [x] `startup_workers` 和 `cleanup_workers` 使用文中固定默认值和范围；已有任务数量超过调小后的配置时继续执行已有任务，两类新领取容量保持 0 直到占用回落。
- [x] 普通运行配置不包含 Gitea URL、`manager_id`、`manager_secret`、inventory generation、Gateway SSH Host Key 私钥、Host Key 指纹或 Host Key 更新时间；这些属于 Manager 本地状态或运行时派生状态。
- [x] 普通配置不包含 `startup_capacity_available` 和 `cleanup_capacity_available`；两类可用容量由 Manager 本地运行状态计算。
- [x] `serve` 从 Manager 本地状态读取站点、Manager 身份、运行配置、inventory generation 与本地运行状态；修改运行配置不能改变已签发 Manager 的 Gitea 归属。
- Manager 配置不包含心跳周期、Runtime Metadata 刷新周期、控制面消息上限或 Gitea 浏览器根 URL；首次 Declare 成功后采用完整服务端响应，非法响应保持 recovering，后续 Fetch 提交两类零可用槽位。
- Runtime 健康周期和单次超时使用配置中的两个正数值且 timeout 小于 interval；检查命令、连续失败阈值、完整轮次共享故障判定和检查并发使用文档固定规则。
- Gateway 进程总在途量、单 session 在途量和每个 SSH transport 的 channel 数使用文中默认值与范围；HTTP/WebSocket/SSH 的取得、拒绝和关闭路径都只释放一次名额，公共请求也受进程总上限约束。
- Gateway HTTP listener 固定拒绝超过 64 KiB 的请求头和超过 10 秒仍未读完的请求头；请求与响应正文按背压流式转发。SSH 认证限流的有期限键最多保留 65536 个；到期键正常清除，容量已满时已有键继续计数，新的未知键在调用 Gitea 前按认证失败处理。
- `node.shutdown_timeout` 与实例停止超时分别限制进程级收尾和实例停止，任一值都不会延长 Gitea operation deadline。
- `runtime.git.ssh_key_type` 默认 `ed25519`，接受 `rsa-4096`，非法值在 Manager 启动配置校验阶段失败；RPC 和 Gitea 数据库中不存在对应字段。
- listener 与对外地址可以不同；Manager 的 Declare 值、本地总容量、Fetch 可用槽位和 SSH 限流均能由上述配置或本地运行状态唯一确定。
- 公共连接的 per-Endpoint 与 per-IP 上限使用文中默认值和范围，任何匿名请求必须同时取得两个本地名额；公共计数不进入认证 session 上限。
- `gateway.validation_max_inflight` 使用文中默认值和范围；公共与认证 HTTP 的相同授权键并发 miss 合并后共同受该上限约束，满载返回 503。
- 一个 Manager 身份与其 `node.state_dir` 共同组成单一部署；同一状态目录的第二个进程在发送 RPC 前因独占锁失败。并行 Manager 使用各自身份和状态目录。
- 状态后端、状态位置和加密密钥必须显式配置并通过严格解析；Gitea 站点身份必须存在于 Manager 状态库且可解密。`manager-runtime.json` 是 inventory generation 的本地提交点，损坏状态和并发 serve 都在发送 RPC 前失败。
- Endpoint 请求只能选择 `http|https` scheme，不能关闭 HTTPS 证书校验或指定任意 host。
- [x] Declare 环境声明与 `runtime.environments[]` 的 tag 和 description 完全一致；虚拟机与系统容器环境都不会把实例类型写入 Gitea。Manager 配置以 `node`、`gateway` 和 `runtime` 为唯一顶层结构，tag、说明、Incus 连接和运行环境都能从这三个结构中唯一确定。
- [x] Manager 代码直接读取 `node`、`gateway` 和 `runtime` 规范结构，不维护 Server、Manager、Provisioner、Incus 或 Gateway 扁平派生副本；默认值和校验只执行一次。
- [x] `runtime.incus.endpoint` 接受本地 unix URI 和远程 HTTP(S) URI；环境 source 恰好选择 image 或 instance，profiles 省略时使用 `default`，显式 profiles 使用字符串数组。
- [x] Manager 软件版本来自构建信息，生产 provisioner、bootstrap shell、root 身份和内部根路径由程序固定；部署配置只暴露能够形成完整运行行为的选择。
- Manager 使用固定 bootstrap 与内置原生 Dev Container 运行时，配置中没有生命周期脚本入口；仓库配置由 create 时锁定的路径、提交和摘要唯一确定，resume 使用已经保存的完整环境状态。
- [x] Incus project、非集群模式以及环境必填字段在领取 create/resume 前完成静态校验；`runtime.incus.network.manage=true` 时配置校验要求 `runtime.incus.project.manage=true`；`runtime.incus.project.manage=true` 时启动前校验 storage pool 存在、managed network 是 bridge、default profile 具有 root disk 和可选 NIC。默认 managed network 名称为符合 Linux 15 字符接口名上限的 `csnet`；Manager 创建的 bridge network 设置 `ipv4.address=auto`、`ipv4.nat=true`、`ipv4.dhcp=true` 和 `ipv6.address=none`。环境 `resources.cpu`、`resources.memory` 和 `resources.root_disk` 在 create 请求中分别写入 `limits.cpu`、`limits.memory` 和实例级根盘 `size`。设计如此是因为 CPU、内存和根盘大小属于新实例资源形状，必须在 Incus 创建记录时确定。
- Incus bridge 有 IPv4 和 DHCP range 但实例没有 IPv4 时，故障排除能区分 Manager 配置问题、实例内 DHCP 客户端问题和宿主机 firewalld zone 问题；firewalld 场景的修复指向把 Incus bridge 加入 `trusted` zone。
- 证书权限最小化、image fingerprint 持久化、展开 profile 校验、根盘展开校验、运行时二进制发布和通信网卡完整运行条件继续按后续实现验收。
- Incus 端到端测试使用同一组 Incus 配置字段连接本地或远程 Incus；测试环境预先提供独立 project、image、profile、network、storage 和 ACL，测试入口只创建和清理带本次运行标识的实例。
- Incus 端到端测试固定使用低资源规格，单实例内存为 `1GiB`；四条真实链路串行执行，不由调用方环境变量调高内存或并行创建实例。
- Git SSH 私钥、公钥和 known_hosts 使用 Manager 固定路径；私钥由 Manager 生成后作为 root seed 写入 Runtime，最终只保存在 Runtime 工作环境内，Manager 状态目录不保存该私钥。
- 已有 Codespace 使用 create 时保存的有效环境快照；修改或删除 tag 环境只影响之后的 create，不改变已有实例的 resume、stop 和 delete。共享 profile 通过新版本名称演进。
- [x] `startup_capacity_available` 同时受运行名额和启动 worker 限制，`cleanup_capacity_available` 受清理 worker 和持久 pending 限制；stop/delete 仅在有清理槽位时领取。
- `cleanup_capacity_available` 继续补齐 Fetch 预留。
- [x] 当前 Incus 环境实现通过 project state 按 tag 判断 create 配额；`accepted_create_tags` 只包含本轮能容纳其实例类型和资源规格的环境。集合为空时 Fetch 仍可在有运行名额时接受 resume，因为 resume 恢复已有实例，不申请新的 project 资源。
- [x] Incus project state 的实例数、实例类型、内存和全局磁盘配额都会影响 create 接受类型；配额不足时 Fetch 仍可在有运行名额时接受 resume。设计如此是因为 resume 使用已有实例，create 才需要申请新的 project 资源；pool 级磁盘细分由部署侧 Incus project/profile 管理。
- [x] LXC 与 VM 使用相同的 `runtime.incus.network.name`；通信地址按连接到该 network 的唯一展开 NIC、设备配置或 `volatile` MAC 以及 Instance State 的 IPv4 地址解析，不依赖来宾接口名。目标网络 NIC 缺失或重复时给出明确配置错误，来宾接口名变化后仍能识别同一设备；真实 Incus matrix 已覆盖两种实例类型的 provisioner 与完整 Manager 生命周期。
- Gateway 是实例服务的唯一用户入站入口；通信 profile 的 ACL 覆盖管理通道和实例间隔离。
