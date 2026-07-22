# Gitea 服务端

## Web 路由与页面

Codespace 创建者只使用下列三类生命周期页面。组织所有者和站点管理员通过现有设置导航中的管理列表直接治理 Codespace，不进入其他用户的对象详情页；Manager 和 registration token 也在这些设置页中管理。

### Repository Codespace 入口

```text
GET  /{owner}/{repo}/codespaces
POST /{owner}/{repo}/codespaces
```

作用：

- 基于当前 repository/ref 上下文创建 codespace。
- 展示当前用户在该 repository 下创建的 codespace。
- 提供进入用户 codespace 列表页的入口。

Repository 页面可以提供 "Open in Codespace" 入口：

- repository 主页
- branch/tag 下拉菜单
- pull request 页面
- commit 页面

这些入口打开 `GET /{owner}/{repo}/codespaces`，并可通过 `ref_type/ref_name` 查询参数预填创建表单。查询参数和 POST 表单都只表达用户选择的 git ref 上下文，由 Gitea 解析并锁定 `commit_sha`；客户端不能指定最终 commit 或覆盖路由 repository。Manager 把 repository tag 映射为本地 Incus 模板，并自行决定实例类型、镜像、资源、Endpoint 和 SSH；这些实现信息不进入 Gitea 创建请求。

创建输入：

| 参数 | 说明 |
| --- | --- |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | branch → 分支名；tag → 标签名；commit → 完整 commit SHA；pull → 十进制 PR index |

`owner` 使用 Gitea repository 路由的 owner 语义，可以是用户或组织。`repo_id` 来自 `/{owner}/{repo}` 路由解析结果。Gitea 对 pull index 生成规范 `refs/pull/{index}/head`，对其他类型解析对应 ref，并把服务端得到的完整 commit SHA 写入 codespace；任何客户端提交的 `repo_id/commit_sha` 字段都作为未知输入拒绝。

路径使用复数 `codespaces`，因为 GET 返回 repository 下的对象集合，POST 向同一集合创建对象。

**设计理由：创建入口位于 repository 页面。**创建请求需要明确的 repository 上下文，因此复用该页面的 repository 选择结果和创建表单；`GET /-/codespaces` 用于展示当前用户已有对象。

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
GET    /-/codespaces/{uuid}
GET    /-/codespaces/{uuid}/state
GET    /-/codespaces/{uuid}/logs
GET    /-/codespaces/{uuid}/open
GET    /-/codespaces/{uuid}/open/{endpoint_id}
POST   /-/codespaces/{uuid}/open
POST   /-/codespaces/{uuid}/open/{endpoint_id}
POST   /-/codespaces/{uuid}/resume
POST   /-/codespaces/{uuid}/stop
POST   /-/codespaces/{uuid}/continue
POST   /-/codespaces/{uuid}/auto-stop
POST   /-/codespaces/{uuid}/delete
```

`GET /-/codespaces/{uuid}` 是唯一对象页面。

`GET /-/codespaces/{uuid}/state` 返回创建者详情页的当前状态 HTML 片段，`GET /-/codespaces/{uuid}/logs` 返回日志数据。两者属于创建者 Web 页面的内部数据接口；本设计的用户交互采用服务端 Web 页面，不定义版本化 Codespace REST API。

**设计理由：repository 路径只是创建上下文和来源筛选，不是既有 Codespace 的身份路径。**创建成功后，对象的规范地址只包含 `codespace.uuid`。这样 repository 删除、改名、转移或变得不可访问时，既有 Codespace 的详情和生命周期操作仍保持稳定，也与 create 完成后不再依赖 repository 的状态模型一致。

路由行为：

- `POST /{owner}/{repo}/codespaces` 成功后重定向到 `GET /-/codespaces/{uuid}`。
- `GET|POST /-/codespaces/{uuid}/open` 始终选择默认 `workspace`；`GET|POST /-/codespaces/{uuid}/open/{endpoint_id}` 选择明确的普通 Endpoint，并拒绝保留值 `workspace`。默认路由不接收可选 `endpoint_id` 字段，避免缺失值和空值产生两套默认语义。
- GET 使用现有登录中间件，登录后只显示当前入口和确认表单，不签发 Open Code、不推进交互版本。POST 使用现有 CSRF 防护并执行打开动作。需要认证的入口签发 code；无 active operation 的公共 Endpoint 直接 303 到页面数据中的当前公共 URL，不签发 code，也不记录用户交互。queued idle stop 期间公共入口显示暂不可用，创建者先使用“继续运行”。Gateway 在需要认证的入口缺少本地 session 时跳转到对应 GET，因此深层链接可以登录后返回原路径，修改请求和 WebSocket 不经过该恢复流程。
- Codespace 页面、状态、日志和打开路由沿用 Gitea Web 的同源访问与现有 Session/CSRF 校验，不新增 CORS 允许头。Gateway 与 Gitea 之间的浏览器切换只使用顶层 303 导航；Endpoint 页面不能跨源读取这些 Web 响应或借 Gitea Session 调用 ManagerService。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /-/codespaces/{uuid}`。
- `POST /-/codespaces/{uuid}/continue` 表示用户仍在使用当前运行实例：服务在 Codespace lock 内推进交互版本，并取消尚未领取的自动 stop；没有 queued idle stop 时仍可成功，用于重置 Manager 的下一轮空闲计时。
- `POST /-/codespaces/{uuid}/auto-stop` 在 `running` 或 `stopped` 保存 `default|custom|never`。`custom` 必须同时提交站点范围内的秒数；`default` 和 `never` 清零对象自定义秒数。规范化后的持久值未变化时幂等成功；解析后的启用状态或有效超时变化时取消尚未领取的自动 stop。模式变化但实际运行值相同时只保存用户选择，当前计时和 queued idle stop 保持有效。已经领取的 stop 继续完成，新设置保留到普通 resume 后生效。
- delete 后返回经过校验的显式 `return_to`；服务端把它解析为 URL relative-reference，只接受 scheme 和 host 均为空、规范化 path 以单个 `/` 开头的站内地址。若没有，则 repository 仍可解析且当前用户可见时回到 repository Codespace 页，否则回到 `/-/codespaces`。
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

自动暂停是创建者对自己 Codespace 的运行策略。设置只写入 Gitea，因此在 stop/resume 进行中或 Manager 暂时不可用时仍可保存；Manager 恢复并取得当前设置后应用。其他用户的管理列表不显示设置值，也不提供修改入口。

页面按以下规则处理操作按钮：

- 当前身份无权执行的操作不显示；不适用于当前稳定状态的操作也不显示。
- 用户提交操作后，页面立即禁用会与该操作冲突的按钮。服务端确认 active operation 后，页面根据展示态保留对应的禁用进度按钮；delete 仍按状态机规则保持可用，可以接管 create、stop 或 resume。
- 页面禁用只用于防止重复点击。每个 POST 在 Codespace lock 内重新校验身份、主状态和 active operation；冲突返回 `409 Conflict` 及当前展示态，页面据此刷新，不把浏览器中的旧操作集当作授权依据。
- 完整详情页和 `GET /-/codespaces/{uuid}/state` 调用同一个创建者详情服务并渲染同一个状态模板片段。状态响应使用 `Content-Type: text/html` 和 `Cache-Control: no-store`，根节点固定为 `id=codespace-live-state`，并通过 `data-refresh-after-ms` 声明下一次刷新间隔：过渡状态为 2 秒，稳定状态为 15 秒。页面不可见时暂停计时，重新可见后立即刷新；同一页面同一时刻只保留一个状态请求，因此晚到响应不会覆盖更新结果。
- 状态刷新失败时保留当前页面，不自行判定 operation 失败，并逐步退避到最长 30 秒。成功响应中没有规范状态片段，或者对象、登录状态和权限已经变化时，浏览器执行完整页面跳转，由现有登录页、对象页或 404 页面给出结果。该接口只读取当前服务端状态，不推进生命周期版本。

Manager 在状态切换期间离线时，Gitea 保持已登记 operation 和原有截止时间。页面继续显示当前过渡状态，并明确说明正在等待 Manager；Manager 恢复后按现有 Fetch 和续租流程继续，截止时间到达后按[超时处理](state-machine.md#超时处理)进入唯一结果。稳定 `running` 或 `stopped` 对象不会仅因 Manager 离线改变主状态：连接类操作和 resume 暂时禁用，stop 与 delete 仍可提交并等待 Manager 领取。这样短暂故障不会被误报为 Codespace 失败，永久故障又会由 operation 超时、普通重试和站点管理员强制删除得到明确结果。

**设计理由：页面区分权限不足、状态不适用和基础设施暂时不可用。**权限不足的操作不应暴露，已经提交的状态切换需要保留可见进度，Manager 离线则需要告诉用户持久状态没有被改写。服务端始终负责最终校验，使多标签页、重复点击和 Manager 状态变化不会绕过生命周期规则。

实现验收点：

- 用户 repository 和组织 repository 都通过 `/{owner}/{repo}/codespaces` 创建和筛选展示；GET 的 ref query 只预填表单，POST 仍由服务端解析 repository 和 commit。
- 所有 Codespace Web 集合与对象路由使用复数 `codespaces`；创建成功后的规范地址不包含 repository 路径。
- `/-/codespaces` 使用 Gitea 功能前缀；名为 `codespaces` 的用户、组织和 repository 继续使用原有通用路由。
- repository 删除、改名、转移或权限丢失后，已有对象仍通过 `/-/codespaces/{uuid}` 执行详情、日志和允许的生命周期操作。
- 创建入口只有 repository 页面中的 `POST /{owner}/{repo}/codespaces`，全局页面只负责列表和对象详情。
- 初次详情渲染与状态片段刷新使用同一个创建者详情服务、权限检查和操作集合；需要版本标识的协议范围固定为 ManagerService 和 Manager Runtime API，状态片段按 Web 路由维护。
- 状态片段响应禁止缓存，包含固定根节点和服务端给出的下一次刷新毫秒数；非创建者与对象页面使用相同的存在性和权限结果。
- 过渡状态按 2 秒、稳定状态按 15 秒刷新，页面隐藏时停止请求；失败保留当前展示并最多退避到 30 秒，不把网络错误写成 operation 结果。
- create、open、continue、自动暂停设置、resume、stop、delete 均回到唯一 codespace 对象页或明确的 `return_to`。
- 外部 URL、scheme-relative URL 和其他非站内相对值不能作为 `return_to`。
- 站点、用户和组织设置中的 Codespace 管理入口统一使用复数 `codespaces`。
- `manager_id=0` 的 delete 不创建无法领取的 operation。
- 未绑定 delete 与 Fetch create claim 并发时由数据库条件写入确定先后；删除事务的主记录、Token、Git SSH Key 和日志共同提交或共同回滚，claim 成功后 delete 转入绑定删除，delete 成功后 claim 影响 0 行。
- 创建者对象路由不接受 force delete；站点管理员只通过管理列表中的独立强制删除路由执行本地清理。
- running 且存在 queued user stop、已经领取的 stop 或 delete operation 时，页面禁用 Endpoint 和 SSH；queued idle stop 保持可交互并由成功交互事务取消。
- 只有创建者可以为自己的 Codespace 设置站点默认、自定义超时或永不自动暂停；`never` 只关闭空闲自动暂停，不改变手动 stop/delete、排空、failed 和账户管理动作。
- queued idle stop 可由“继续运行”、有效 open/SSH 或设置变更取消；Manager 已领取 stop 后页面稳定展示 stopping，完成后使用现有 resume。
- 默认 open 不依赖 Runtime Metadata 中存在 `workspace` 记录；两种 open 都要求 metadata ready，显式 Endpoint 路由还拒绝 `workspace` 并只打开当前 metadata 中存在的普通 Endpoint。
- GET 打开路由只渲染确认信息，POST 才为需要认证的入口签发 code；公共 Endpoint 显示公共标记和直接 URL，POST 不签发 code。两类路径都使用服务端当前 Manager 地址和 metadata，不接受浏览器提交目标 URL。
- stop/resume/create/delete 进行中时，对应进度按钮保持可见并禁用；服务端仍拒绝冲突 POST，`409 Conflict` 会使页面刷新到当前展示态。
- Manager 在 operation 进行中离线不会延长截止时间或改写主状态；页面持续展示等待状态，超时后显示状态机确定的结果。稳定对象只禁用依赖 Manager 的连接和恢复入口，stop/delete 仍可提交。
- 同一 operation 版本在 Manager 执行和 final 层幂等；Web create/delete 不声称无法由当前数据证明的跨请求网络幂等，且不增加请求历史或删除墓碑。

设置管理入口：

```text
GET/POST /-/admin/codespaces
POST     /-/admin/codespaces/{uuid}/stop
POST     /-/admin/codespaces/{uuid}/delete
POST     /-/admin/codespaces/{uuid}/force-delete
GET/POST /-/admin/codespaces/managers
GET/POST /user/settings/codespaces
GET/POST /org/{org}/settings/codespaces
POST     /org/{org}/settings/codespaces/{uuid}/stop
POST     /org/{org}/settings/codespaces/{uuid}/delete
```

站点管理页列出全部 Codespace，并在同一设置导航中提供 Manager、global registration token 管理。组织设置页只列出已经绑定到 `owner_id=组织 ID` Manager 的 Codespace；`manager_id=0` 表示运行资源尚未确定归属，因此只由创建者和站点管理员管理，不进入组织治理列表。组织 Codespace 管理入口使用 Gitea 现有组织 owner 权限，与其他组织设置页保持一致。用户设置页只管理当前用户 owner scope 的 registration token 与 Manager；用户自己的 Codespace 仍使用 `/-/codespaces`。

组织和站点 Codespace 管理列表只返回并展示治理所需字段：展示态、UUID 缩写、创建用户、绑定 Manager 或“等待分配”、更新时间和当前可提交操作。列表行不链接 `/-/codespaces/{uuid}`，也不返回 repository/ref/commit、日志、Endpoint、SSH、自动暂停设置、Token 或运行侧内部信息。

| 展示态 | 组织所有者操作 | 站点管理员操作 |
| --- | --- | --- |
| `queued` | 不进入组织列表 | delete、force delete |
| `booting` | delete | delete、force delete |
| `running` / `recovering` / `metadata_rebuilding` | stop、delete | stop、delete、force delete |
| `stopping` / `resuming` | delete | delete、force delete |
| `stopped` | delete | delete、force delete |
| `deleting` | 无 | force delete |
| `failed` | delete | delete、force delete |

管理列表中的 stop 和 delete 使用普通生命周期服务，与创建者操作具有相同的状态、抢占、超时和 Manager 恢复语义。Manager offline 时仍允许对 `running` 提交 stop 和对可删除状态提交 delete；页面显示“等待 Manager”，超时后刷新为状态机确定的稳定结果。站点管理员 force delete 使用独立路由和明确确认，同步删除 Gitea 记录、Codespace Token、Git SSH Key 和日志，不等待 Manager；原 Manager 身份仍有效时，后续完整 inventory 会清理无记录 Runtime。全部操作路由使用 Gitea 现有登录校验和 CSRF 保护，成功或冲突后都回到原管理列表并刷新目标行。

非创建者只有上述列表和直接操作，不提供对象详情、日志、连接、resume、continue 或自动暂停设置。这个边界让组织和站点管理员完成资源治理，同时不会因为治理权限获得进入其他用户开发环境或修改其个人运行策略的能力。

**设计理由：管理动作直接位于治理列表。**管理员判断是否停止或删除资源只需要身份、状态和 Manager 归属。为此开放完整对象页会额外暴露源码上下文、日志和连接信息，却不会改善治理结果；独立 POST 路由也使 force delete 不会与创建者普通删除混用。

**设计理由：Manager 管理页分别展示身份、运行状态和调度意愿。**记录存在表示身份有效；计划排空由 Manager 在 Fetch 中上报 `capacity_available=0` 且不接受 create/resume；维护中断使用 recovering/offline；永久撤销身份使用删除操作。职责分开后，管理操作不会隐式改变 active operation、Token、Gateway session 或 Runtime transition。

每个 owner scope 最多保存一行 registration token。settings 页面进入时调用当前 scope 的 GetOrCreate，行存在时返回原明文，不存在时创建并展示；重置入口在 Codespace owner relation lock 和同一事务中原地替换随机 token。settings 页面可以显示当前 token 明文，因为它是可重复使用的部署注册凭据。`owner_id=0` 的 global token 只由站点管理员管理，用户或组织删除时物理删除所属 scope 的 registration token。页面交互与 Actions runner 的 registration token 保持一致：下拉中展示当前 token、复制按钮和重置操作。

**设计理由：Registration Token 表保存每个 owner 当前有效的注册入口。**读取页面时自动保证入口存在，重置原地替换当前值；认证只需检查当前行。失败诊断写入服务端日志，凭据历史无需进入数据库或保留任务。owner 删除时再物理删除对应 scope 的 token 行，使注册入口生命周期跟随 owner scope 收敛。

Manager 删除确认页展示绑定 Codespace 数量，并说明 Gitea 会同步删除这些 Codespace、开发凭据、日志和 Manager 地址行，但不会联系 Manager 或保证 Runtime 回收。确认后，服务层不读取 Manager runtime state，保持 Codespace owner relation/Manager lock 并按 UUID keyset 逐 Codespace 短事务清理，空集合复检后在最终事务中删除 Manager 地址行与 Manager；已经通过认证的并发 RPC 也必须在最终写入前重新检查记录和 binding。

用户自助删除、管理员 Web/API 删除用户、`gitea admin user delete` 和 inactive-user Cron 统一调用 `services/user.DeleteUser`；组织 Web/API 和 last-owner purge 统一调用 `services/org.DeleteOrganization`。Codespace 清理挂在这两个服务入口中，先完成适用的 Gitea 前置检查，再按 [用户与组织删除](lifecycle-flows.md#用户与组织删除)执行分阶段清理。CLI 只负责定位用户、初始化服务依赖和适配错误，不直接删除 Codespace 关系。管理员删除用户因此与用户自助删除具有相同的数据关系清理结果；purge 在处理 Gitea 原有 repository、组织和 package 关系前后分别取得 Codespace owner relation lock 并复扫。普通用户或组织删除精确清理自身正数 owner scope，站点级 `owner_id=0` Manager、地址和 registration token 保持有效。

Codespace、Manager 和 registration token 写入统一进入 Codespace owner relation 服务边界，取得涉及 owner 的 `codespace_owner_{owner_id}`，在事务中复读 owner 后才提交关系。repository、package、组织成员与 team 成员继续使用 Gitea 现有服务、purge 复扫和最终事务检查，不接入这把专用锁。

**设计如此：Codespace owner relation lock 只证明本功能新增关系的删除结果。**把 Gitea 全部 owner 关系改造成同一锁会显著扩大修改范围，并重复已有 purge 处理；账户删除在最终事务中仍检查 Gitea 原有关系，因此无需改变它们的服务边界。

实现验收点：

- 站点管理员可以在 `/-/admin/codespaces` 直接 stop、delete 或 force delete 全部 Codespace，并管理全部 Manager 与 global registration token。
- 组织所有者只看到 `owner_id=组织 ID` Manager 已绑定的 Codespace，并只能直接 stop 或 delete；未绑定记录不进入组织治理列表。
- 非创建者管理列表没有对象详情链接，也不返回日志、repository/ref/commit、Endpoint、SSH、自动暂停设置或任何 Token；组织和站点管理员都不能通过治理权限修改自动暂停。
- 用户和组织所有者只能管理各自 owner scope 的 registration token 与 Manager。
- 创建者对象页与设置管理页的 stop/delete 复用相同生命周期服务、状态校验和事务逻辑。
- Manager offline 时，适用状态下的 stop/delete 仍可登记；页面显示等待 Manager，operation 使用原截止时间收敛。只有站点管理员可在任意未物理删除状态使用独立 force delete。
- Manager 管理页没有 enable、disable、pause 或 quarantine 动作；零容量、recovering/offline 和直接删除分别覆盖排空、维护和撤销身份。
- 同一 owner 最多存在一行 registration token；settings 页面读取自动确保当前行存在，重置原地替换后旧 token 立即失效，数据库中没有历史行。
- 删除任意状态的 Manager 都只执行 Gitea 本地事务，不创建 operation、不发送 ManagerService 请求。
- 删除完成后，Manager、地址行、关联 Codespace、开发凭据和日志均不存在，并发旧 RPC 不能重新写入这些记录或 cache。
- 用户自助、管理员 Web/API、`gitea admin user delete`、inactive-user Cron 和 purge 使用同一个用户服务删除入口；组织 Web/API 与 last-owner purge 使用同一个组织服务删除入口。
- 用户或组织删除成功前复检 Codespace、owner-scoped Manager、registration token 和 Gitea 原有前置条件；普通账户删除不会改变 `owner_id=0` 的全局管理资源或无关 Codespace。
- Codespace、Manager 和 registration token 写入通过 Codespace owner relation 服务边界；owner 已删除或类型不匹配时在事务中返回明确错误，不提交新的 Codespace 关系。repository、package 和成员入口保持 Gitea 当前行为。
- 用户或组织删除成功后，repository、package、组织与 team 成员、Codespace、Manager 和 registration token 均不存在目标 owner ID；历史 issue、comment 和 commit 署名仍按 Gitea 现有用户删除映射处理。
- 用户或组织删除后，仍有效的全局或其他 owner Manager 通过完整 inventory 清理无记录 UUID；随 owner 删除的 Manager 身份无法继续认证，其运行资源由部署运维处理。

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
| source repository deleted | 返回 source repository deleted 分类 | repository 已不存在时无法再解析来源、锁定 commit 或构造新的 create payload；已有 workspace 后续仍可在 `repo_id=0` 时取得 token，但该 token 不提供任何 repository binding 能力，公开只读请求仍按 Gitea 现有公开访问规则处理。 |
| mirror | 允许 | mirror 本身仍是可读取 repository，同步来源属性不改变远程开发入口；实际写入能力继续由用户对 Gitea repository 的权限决定。 |
| create 目标 ref/commit 不可解析 | 返回 ref not found 分类 | create 需要先锁定 commit，已有 codespace 后续按已保存的 `commit_sha` 和运行时数据管理。 |

create operation 完成后，repository 的后续状态不再参与 open、SSH、resume、stop、delete 或 logs 判定。workspace 已经由 Runtime 数据和 Manager binding 初始化完成，repository 后续删除、归档、迁移、ref 移动或访问权限变化只影响 Runtime 的 Git HTTP(S)/SSH、LFS 和 repository API。仍处于 creating 的初始化过程可以因 repository 访问被拒绝而上报 failed，但 repository 事件本身不直接改写主状态。

### Interactive Access 要求

`open`、SSH、`resume` 和“继续运行”都只允许 codespace 创建用户本人发起，并要求创建用户当前满足 Gitea 登录限制。各动作在身份检查后按实际依赖继续判断：

| 动作 | 状态与运行信息要求 |
| --- | --- |
| `resume` | codespace 为 `stopped`、没有 active operation，绑定 Manager online；不读取 Runtime Metadata 或 Endpoint，因为恢复动作只依赖已经初始化的 workspace |
| 打开默认 `workspace` | codespace 为 `running`，无 active operation 或只有 queued idle stop，绑定 Manager online，Runtime Metadata 存在且 `boot.stage=ready` |
| 打开普通 [Endpoint](glossary.md#endpoint) | 满足默认 `workspace` 的 ready 条件，并且当前 metadata 中存在目标 `endpoint_id` |
| SSH 新认证 | codespace 为 `running`，无 active operation 或只有本次认证可以取消的 queued idle stop；Manager online，Runtime Metadata 存在且 ready、`internal_ssh` 完整，提交的 SSH key 归创建用户所有 |
| 继续运行 | codespace 为 `running`；无 active operation 或当前为 queued idle stop，后者在同一事务中取消 |

每个入口只检查完成该动作所需的数据。特别是 resume 不依赖可能在 stopped 期间过期或丢失的 cache；open 和 SSH 则需要 ready 快照，避免用户进入凭据、SSH 或 Endpoint 尚未处理的 Runtime。判定顺序固定为数据库身份与主状态、Manager 状态、metadata 是否存在、ready、目标 Endpoint 或 internal SSH。`running` 只由当前 create/resume 的 ready 快照和 Token 都完整的 final done 建立，后续同一 boot 版本不能从 ready 回退，因此正常的 running 快照始终 ready；cache miss 统一返回 `metadata_rebuilding`。Gitea 的 allowed 结果只是控制面授权，Gateway/SSH 还会在本地 Codespace 协调锁内检查本轮进程已经恢复凭据、SSH 和路由，并把最终检查与 session 登记一同提交；Manager 刚进入 online 而单个 Codespace 尚未恢复时不能建立连接。

### 管理权限

`CanAdministerCodespace` 按具体 action 判定，不把“可以治理资源”扩大为“可以查看对象详情”：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 通过 Gitea 现有登录限制后，可以查看自己的详情和日志、修改自动暂停设置并执行 stop/delete |
| 非创建者的组织所有者 | 对该组织治理范围内的 Codespace 只可查看治理列表并执行 stop/delete |
| 非创建者的站点管理员 | 对全部 Codespace 只可查看治理列表并执行 stop/delete/force delete |

创建者权限独立于 repo code-read 权限，失去 repo 访问后仍可管理自己的 Codespace。这里的创建者是 `codespace.user_id`，通过身份认证和 Gitea 现有登录限制后不再检查 repository；账户已被限制或删除时，不能通过 Codespace 路由建立第二套登录入口。

组织治理范围按已经确定的运行资源归属判定：`codespace.manager_id` 必须指向 `owner_id=组织 ID` 的 Manager。未绑定记录尚未占用某个组织 Manager 的运行资源，因此由创建者和站点管理员管理；绑定到全局 Manager 的记录使用站点容量，也只进入站点治理范围。Manager 绑定后保持不变，repository 转移不会改变治理范围。这个设计使组织权限不会因为尚未确定结果的 Manager 领取竞争先出现再消失，也明确区分 repository 协作权限与运行容量治理权限。

同一调用者同时是 Codespace 创建者和组织所有者或站点管理员时，创建者可以通过 `/-/codespaces/{uuid}` 管理自己的对象；治理列表仍只返回治理页面数据结构。这样管理员管理自己的 Codespace 时保留普通用户体验，同时管理其他用户对象时保持最小信息边界。

站点管理员可在明确确认后强制删除 Gitea 记录、Codespace Token、Git SSH Key 和日志，不以 Manager 失联或特定状态为前提。该动作的完成条件是 Gitea 本地事务提交，不等待 Incus 实例回收，也不保存墓碑。若原 Manager 身份仍有效，后续成功的完整 inventory 查询不到该 UUID 时返回 `cleanup_local_runtime`；Manager 身份已删除或永久失联时，残留实例和本地状态文件由部署运维处理。

**设计理由：创建者管理和非创建者治理解决不同问题。**创建者需要使用、诊断和配置自己的开发环境；组织所有者和站点管理员只需要控制资源是否继续运行或保留。按 action 授权可以直接表达这个差异，避免一个宽泛权限同时开放无关数据和连接能力。

实现验收点：

- repository 删除、transfer 或权限丢失后，已登录且未受登录限制的创建者仍可查看日志、修改自动暂停设置并执行 stop/delete。
- 受 Gitea 登录限制的用户不能通过 Codespace 页面、Open Code 或 SSH 绕过账户限制。
- 组织所有者无需对象详情即可 stop/delete 已绑定组织 Manager 的 Codespace；未绑定或绑定全局 Manager 的对象不进入该组织治理范围，绑定后 repository 转移不改变范围。
- 站点管理员无需 repository 权限即可 stop/delete/force delete 全部 Codespace，但非创建者身份不能查看详情、日志或自动暂停设置。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | codespace 归创建用户使用和管理；创建用户删除时由账户删除流程物理清理 |
| 组织仓库 | codespace 仍归创建用户使用和配置；绑定组织 Manager 后由该组织所有者治理，未绑定或绑定全局 Manager 时由创建者和站点管理员管理 |

### 最小页面数据

Web 页面使用明确的服务端页面数据结构，不直接序列化 `codespace` 数据库行。创建者列表使用 `CodespaceOwnerListItem`，共享字段为：

- `uuid`
- `status` 和 `display_status`
- `created_unix / updated_unix / stopped_unix / last_active_unix`
- `repo_id / ref_type / ref_name / commit_sha`
- `manager_id / manager_display_name / manager_runtime_state`
- `status_summary`
- `allowed_actions`

创建者详情使用 `CodespaceOwnerDetail`，在上述字段基础上增加 `git_protocol` 首选项、当前 Codespace Token 是否存在及其创建时间和末八位、Codespace Git SSH Key 是否存在及登记时间、`log_line_count / log_size`、自动暂停持久选择和有效超时，以及后述规范化 `workspace/endpoints/ssh`。自动暂停字段为 `auto_stop_mode`、`auto_stop_timeout_seconds`、`auto_stop_enabled` 和 `effective_idle_timeout_seconds`；`interaction_generation` 只用于 Manager 协议，不返回 Web 页面。凭据展示字段只说明当前绑定是否存在，不返回 Token verifier、salt、密文、明文、公钥正文或指纹。

组织和站点管理列表使用 `CodespaceGovernanceListItem`，只包含 `uuid / display_status / updated_unix / user_id / user_display_name / manager_id / manager_display_name / manager_runtime_state / status_summary / allowed_actions`。该结构没有详情变体，因此非创建者不能通过修改 URL 或请求格式取得 repository、ref、commit、日志、自动暂停、Endpoint 或 SSH 数据。

`manager_runtime_state` 固定为 `pending / online / recovering / offline`：`manager_id=0` 返回 `pending`，已经绑定时使用服务端根据声明和 heartbeat 派生的当前状态。页面据此区分等待分配、恢复中和离线，不根据更新时间自行推断 Manager 状态。

对象详情还返回经过规范化的展示入口：

```json
{
  "workspace": {
    "endpoint_id": "workspace",
    "label": "Workspace",
    "url": "https://0123456789abcdef0123456789abcdef.codespace.example.com/",
    "public": false
  },
  "endpoints": [
    {
      "endpoint_id": "app-3000",
      "label": "App 3000",
      "url": "https://app-3000-0123456789abcdef0123456789abcdef.codespace.example.com/",
      "public": true
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

`workspace` 始终使用固定 `endpoint_id=workspace`、`public=false`。当前 metadata 中存在同名 Endpoint 时使用它的 label，否则使用请求语言对应的 “Workspace” 文案；这个对象只描述稳定的默认入口，不揭示 Manager 最终连接 Runtime upstream 还是内置 Web SSH。`endpoints` 只包含 metadata 中非 `workspace` 的 Endpoint，按 `endpoint_id` 升序返回，并原样带出必填 `public`。`url` 由当前绑定 Manager 最近一次成功 Declare 的规范 `gateway_url`、完整 UUID 和 Endpoint ID 派生，页面不接受或拼接 Runtime upstream。

`ssh` 只由绑定 Manager 对外声明的 `gateway_ssh_addr` 和 Gateway host key 展示字段构造。服务端拆分规范化的 host 与 port，用户名固定为 39 字节 ASCII 的 `cs-{小写规范 UUID}`，command 固定由这些字段生成。该用户名只供 Gateway 定位 Codespace，不映射为操作系统账户；Runtime 登录用户由 Manager 从 `internal_ssh.user` 取得。该结构只提供用户实际连接所需的公开地址和 host key 核对信息，内部 SSH host、Runtime user、upstream 和任何 token 都不会进入详情响应。

只有创建者详情在具有 Interactive Access 且当前 metadata ready 时返回普通 `endpoints`。页面把 `public=true` 显示为公共入口：无 active operation 时直接链接 `url`，queued idle stop 时保留展示但禁用链接并提供既有“继续运行”动作；需要认证的入口通过 POST 打开动作建立 session 并可取消 queued idle stop。workspace 固定使用认证动作。`ssh` 还要求绑定 Manager online、`internal_ssh` 完整，并且 Manager 的公开 SSH 地址、host key algorithm、SHA256 fingerprint 和更新时间全部有效；任一条件缺失时省略该对象。治理列表数据结构从类型上没有 `workspace/endpoints/ssh` 字段。

`allowed_actions` 使用固定值 `open_workspace / open_endpoint / ssh / continue / configure_auto_stop / stop / resume / delete / force_delete`，但按调用者角色返回不同子集：

- 创建者的 `running` 且无 active operation 时返回 `configure_auto_stop/stop/delete`，功能启用、Manager online 且 metadata ready 时加入 `open_workspace`；存在 `public=false` 的普通 Endpoint 时加入 `open_endpoint`；SSH 展示字段和内部条件完整时加入 `ssh`。`public=true` 的普通 Endpoint 使用详情数据中的直接链接，不占用动作枚举。
- queued idle stop 使用相同交互条件，并加入 `continue`；queued user stop 或 running stop 只返回 `configure_auto_stop/delete`。
- 创建者的 `stopped` 且无 active operation 时返回 `configure_auto_stop/delete`，功能启用且 Manager online 时加入 `resume`；active resume 期间只返回 `configure_auto_stop/delete`。
- 创建者的 queued create 或 booting 返回 `delete`，failed 返回 `delete`，deleting 返回空集合。
- 组织治理列表只按状态返回 `stop/delete` 的适用子集。站点治理列表按相同规则返回 `stop/delete`，并在任意未物理删除状态加入 `force_delete`。
- `configure_auto_stop` 只向创建者返回。组织所有者和非创建者站点管理员的治理页面数据永远不返回该值。

`allowed_actions` 只表示当前请求可以提交的动作。`stopping/resuming/deleting/booting` 对应的禁用进度按钮由 `display_status` 渲染，不把正在执行的动作重新放入可提交集合。Runtime Metadata cache 未命中、Manager offline/recovering 或站点排空时移除当时不可执行的交互动作和 resume，但保留创建者的 `configure_auto_stop` 以及当前状态可登记的 stop/delete。页面完全依赖服务端页面数据，不从 Manager metadata、内部地址或字段缺失推测其他操作。

以下字段保留在服务端内部或 Manager/Gateway 内部，不进入页面数据：

- Codespace Gitea Token verifier 与密文
- Manager Secret
- Runtime Token
- Gateway Open Token
- `token hash / salt`
- `internal_ssh`
- Endpoint upstream
- 完整 `meta_json`
- 日志正文
- Runtime Instance 内部 host / port / user

创建者页面数据和治理页面数据分开定义，是为了让数据权限由服务端类型保证，而不是依赖模板隐藏字段。治理列表只提供识别对象、判断状态和发起允许动作所需的信息，使管理员能够治理资源而不进入其他用户 workspace。这些结构的稳定使用方是服务端模板和状态片段；本设计需要版本标识的协议范围是 ManagerService 和 Manager Runtime API，服务端 Web 页面及其状态片段按 Gitea 路由契约维护。

实现验收点：

- create 使用 repository 权限；既有 codespace 的交互和管理权限不依赖 repository row。
- 创建用户只能交互、查看日志和配置自己的 codespace；组织所有者只能 stop/delete 治理范围内的对象；站点管理员只能 stop/delete/force delete 非本人对象。
- stopped 状态的 resume 在 Runtime Metadata cache 为空时仍可提交；workspace、普通 Endpoint 和 SSH 在 cache miss 时返回 `metadata_rebuilding`，running 状态下缓存中的 boot 快照保持 `ready`。
- 普通 Endpoint 只有在 metadata ready 且目标存在时可打开；SSH 只有在 ready、internal SSH 完整且公钥归创建用户时可认证。
- `CodespaceOwnerListItem`、`CodespaceOwnerDetail` 和 `CodespaceGovernanceListItem` 使用互不混用的明确字段；治理页面数据不包含 repository/ref/commit、日志、自动暂停、Endpoint、SSH、token、internal SSH、upstream 或完整 Manager metadata。
- 对象详情能无歧义展示 default/custom/never 的持久选择和当前有效超时，但不暴露 Manager 使用的交互版本。
- 对象详情的 `workspace` 使用同名 Endpoint label 或本地化默认文案；普通 `endpoints` 排除 workspace 并按 ID 排序，页面无需解析 Runtime Metadata。
- SSH 展示只使用 Manager 公开地址和公开 host key 信息，command、host、port 与 `cs-{完整 UUID}` 用户名一致；响应不包含 internal SSH、upstream 或 token。
- 非创建者没有对象详情响应；治理列表只返回当前状态可提交的 stop/delete，站点管理员额外获得 force delete，任何非创建者都没有 configure auto-stop、open、SSH、continue 或 resume。
- 完整详情页和状态片段对相同身份与对象使用相同 `allowed_actions`；只有存在 `public=false` 的普通 Endpoint 时才有 `open_endpoint`，只有 SSH 展示字段和内部就绪条件都完整时才有 `ssh`。queued idle stop 仍允许认证打开、SSH 和 continue；公共链接暂时禁用，领取后的 stop 只保留创建者设置和 delete。
- 创建者详情中的 workspace 和普通 Endpoint 都带服务端派生 URL；workspace 固定需要认证，普通 Endpoint 的 `public` 标记与 Runtime Metadata 一致。页面对公共入口使用直接链接，对需要认证的入口使用 POST 打开动作。
- `display_status` 与 `allowed_actions` 分工明确：前者产生正在创建、停止、恢复或删除的禁用进度按钮，后者只产生可以提交的操作。

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

ManagerService 是服务间接口，不返回 CORS 允许头，也不处理浏览器预检。它不使用 Gitea Session Cookie、浏览器 Origin 或转发头认证；注册只接受 registration token，注册后的调用只接受 Manager ID 与 Manager Secret。这样 Endpoint 页面不能通过浏览器环境取得一条控制面认证路径。

Manager 认证 header：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，其余 RPC 使用 Manager header。每个 request 还必须携带当前 ManagerService 主版本；版本字段属于逐请求协议前置条件，不由最近一次 Declare 或数据库记录代替。

完整 proto 定义和消息结构见 [RPC 接口定义](rpc-spec.md)。

### 统一失败分类

ManagerService 和访问判定使用以下稳定字符串。handler 选择表中最具体的分类，日志可以附带内部错误正文，协议只返回分类；Manager/Gateway 按分类和 Connect code 的固定组合处理重试、清理和用户提示。

| 分类 | Connect code / 处理方式 | 使用场景 |
| --- | --- | --- |
| `invalid_argument` | `InvalidArgument`，修正请求 | 字段格式、枚举、数量、request 大小、JSON 或 Runtime Metadata schema 不合法 |
| `unauthenticated` | `Unauthenticated`，停止使用当前凭据 | registration token 或现有 Manager secret 无效 |
| `invalid_credentials` | `PermissionDenied`，拒绝访问 | Gateway 用户 SSH 公钥或一次性 open code 未通过访问判定 |
| `permission_denied`、`login_restricted` | `PermissionDenied`，拒绝访问 | 当前身份不再允许该动作 |
| `repo_permission_denied`、`repo_binding_mismatch`、`unsupported_resource` | `PermissionDenied`，拒绝请求 | repository 原有权限、Codespace 单仓库绑定或资源类型不允许访问 |
| `repository_archived`、`repository_empty`、`repository_unavailable`、`source_repository_deleted` | `FailedPrecondition`，修正来源后重试 | create 来源 repository 当前不能形成 workspace |
| `ref_not_found` | `NotFound`，修正目标后重试 | create 目标 ref/commit 无法解析 |
| `manager_unregistered` | `Unauthenticated`，停止该身份的 RPC | request 中的 Manager ID 已注销、随 owner 删除或从未注册 |
| `protocol_mismatch` | `FailedPrecondition`，升级 Gitea 或 Manager 后重新启动 | 任一 request 提交的 ManagerService 主版本不是当前版本 1 |
| `gateway_url_conflict` | `FailedPrecondition`，修改配置 | 规范化 Gateway URL 已由另一个 Manager 使用 |
| `gateway_cookie_scope_conflict` | `FailedPrecondition`，修改域名或 Gitea session 配置 | Gateway 用户内容域与 Gitea 处于同一可注册域、覆盖 Gitea host/wildcard，或与 session Cookie Domain 冲突 |
| `gateway_ssh_addr_conflict` | `FailedPrecondition`，修改配置 | 规范化 Gateway SSH 地址已由另一个 Manager 使用 |
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

create 的 repository archived/empty/unavailable、ref not found 和 repo permission 等分类继续使用权限模型中定义的稳定名称；它们都属于 create 前置结果，不改变既有 codespace 的生命周期。访问判定 RPC 在 `denied` outcome 中使用同一分类字符串，不把正常拒绝转换成 Connect error。`FinalizeOperation` 也使用自身 response oneof 表达 `stale_operation` 和 `resource_absent`；表中的 Connect `stale_operation` 只用于 `UpdateLog`、`ReportRuntimeTransition` 等其他 command RPC，避免同一 handler 在正常 outcome 与 Connect error 之间随机选择。

请求格式不合法、未知字段和 metadata schema 错误统一使用 `invalid_argument`；create/resume final 尚未取得当前 ready 快照使用 `metadata_required`，交互入口 cache 暂时缺失使用 `metadata_rebuilding`。active create/resume 的阶段进度仍由 Runtime Metadata 表达，进入 running 后 ready 不再回退，因此无需为 running 增加另一个未就绪分类。Manager 的 declared runtime state 与 heartbeat 分别映射为 `manager_recovering` 和 `manager_offline`。

`CONTROL_PLANE_TIMEOUT` 到期返回 Connect `DeadlineExceeded`，caller 取消返回 Connect `Canceled`；两者是传输执行边界，不附 `FailureDetail`。Manager 对除 `RegisterManager` 外的可重放 RPC 使用已有 operation/generation/offset 幂等规则恢复；`RegisterManager` 的不确定结果继续按注册章节人工确认。这样业务拒绝使用稳定 category，传输终止使用 Connect 标准 code，不把 timeout 伪装成内部业务错误。

实现验收点：

- 同一失败条件在不同 handler 中返回同一 category 和 Connect code，调用方按表中处理方式执行。
- final 缺少当前 ready 快照、Token 行与交互 cache miss 分别返回 `metadata_required`、`gitea_token_required` 和 `metadata_rebuilding`；running 没有独立的未就绪分类。
- FinalizeOperation 的 final-accepted、idempotent、stale 和 resource-absent 都通过 response outcome 返回；其他 command rejection 才使用 Connect error detail。
- `stale_generation` 携带当前 generation；`generation_conflict` 和 `state_history_conflict` 不携带 stale detail 且不可重试；历史冲突不触发 Gitea 状态写入或本地清理指令。日志 offset 冲突携带当前 offset，Manager 不解析 message 文本恢复。
- 非法 metadata 使用 `invalid_argument`；final 缺少当前 ready 快照和交互 cache miss 使用上文两个明确分类。
- 未知内部错误统一为 `internal_error`，不会把数据库或 token 正文暴露给 caller。
- control-plane deadline 和 caller cancel 分别返回 `DeadlineExceeded`、`Canceled` 且不附业务 detail；已提交事务由幂等重试读取当前结果。

### RegisterManager

本节定义 Gitea handler 的凭据兑换、事务与并发结果；CLI 的本地凭据保存、结果未知时的处理和进程启动顺序见 [Manager 注册与认证](manager-gateway.md#注册与认证)。两处分别覆盖服务端和调用端，共用同一个 `RegisterManager` 协议。

- 将 registration token 兑换为 Manager identity 和 manager secret。
- 在取得 Codespace owner relation lock 和创建身份前要求 `protocol_version=1`；版本不匹配返回 `protocol_mismatch`，不查询或消耗 registration token，也不创建 Manager 记录。
- 先按唯一 token 索引只读取候选 `owner_id`，该读取不构成认证成功；随后取得对应 Codespace owner relation lock（包括 `owner_id=0` 的 `codespace_owner_0`），在锁内按 token 重新读取当前行。复读仍存在且明文匹配时才有效，期间已重置或 owner 删除则返回 `unauthenticated`。
- Manager 的 `owner_id` 继承 registration token 的 `owner_id`；`owner_id=0` 表示 global，非 0 表示 Gitea owner 的 `user.id`。
- 数据库保存 manager secret 的 `secret_hash / secret_salt`。
- 只返回一次明文 manager secret。
- registration token 可复用，因此请求超时不能判断 Gitea 是否已创建 Manager。CLI 对 `RegisterManager` 的不确定超时不自动重试，而是提示管理员先在对应设置页检查 `last_online_unix=0`、即从未成功 Declare 的注册记录；确认后删除该记录，再重新执行注册。这样不增加 registration nonce 或幂等表，也不会因盲目重试产生多个身份。

实现验收点：

- 明确失败的注册不创建 Manager；成功注册只在响应中返回一次明文 secret。
- 注册响应超时后 CLI 不自动重试，管理页可以识别并删除从未 Declare 的注册记录。
- 注册与同 scope token 的 GetOrCreate、重置使用同一 Codespace owner relation lock；并发结果由取得锁的顺序决定：注册先完成时创建 Manager，重置先完成时旧 token 的注册返回未认证。
- RegisterManager 的锁前 token 查询只用于定位 owner；只有锁内复读并验证当前 token 成功后才创建 Manager。
- RegisterManager 协议版本不匹配时不进入 token 定位和 Codespace owner relation lock，不创建 Manager 记录。

### DeclareManager

- `DeclareManager` 提交 Manager 客户端当前配置和运行能力的完整快照，不是注册后不可修改的配置。客户端可修改并重新声明名称、版本、Gateway/SSH 地址、tags、SSH host key 信息、容量快照和 `manager_runtime_state`。
- Declare 与所有其他 request 一样必须提交 `protocol_version=1`。统一入口先认证 Manager，再在更新 heartbeat、取得声明写锁或校验其余快照字段前完成协议版本检查；不匹配时返回 `protocol_mismatch`，现有 Manager 记录、地址、容量和在线时间全部保持原值。
- 每次请求都携带完整字段；Gitea 校验成功后在同一事务整体覆盖 `name`、`tags_json`、`runtime_state`、规范化 `meta_json` 和两条 `codespace_manager_address`。字段缺失或空值只按该字段自身规则校验，不表示“保持旧值”，因此不需要 PATCH、字段掩码或 declaration version。
- `manager_id`、`owner_id`、secret verifier、inventory generation 和已有 Codespace binding 不由 Declare 修改。Manager secret 从注册成功起保持有效，删除 Manager 记录时失效。
- 更新 `last_online_unix`。
- `DeclareManager` 同时作为 heartbeat。
- Declare 要么完整接受，要么完整拒绝；任一字段格式或地址唯一性校验失败时，不更新任何声明字段或 `last_online_unix`。其他 RPC 认证成功也不隐式恢复 online。超过 offline timeout 的 Manager 必须先 Declare recovering，完成完整 inventory、Runtime 映射和 worker 上下文分类后再 Declare online，才能领取新的 create/resume。
- response 确认完整快照已经接受，并返回服务端选定的心跳周期、Runtime Metadata 刷新周期、控制面消息大小上限和规范 `gitea_web_url`。前三项控制运行周期与传输，`gitea_web_url` 来自 Gitea `ROOT_URL`，供 Gateway 把缺少本地 session 的浏览器导航带回 Gitea 登录确认页；控制面 `gitea_url` 可能是内网地址，不能承担该职责。这些响应字段不增加新的持久状态。
- 设 `MANAGER_OFFLINE_TIMEOUT` 的毫秒值为 `O`。Gitea 返回 `heartbeat_interval_milliseconds=floor(O/4)`、`runtime_metadata_refresh_interval_milliseconds=floor(O/2)`；Runtime Metadata TTL 保持 `O*2`。Manager 启动后立即以 recovering Declare，成功取得三个正数和合法 `gitea_web_url` 后才启动周期任务和领取流程，后续成功响应原子替换当前值。
- Manager 使用本地单调时钟维持单个进行中的 Declare，请求完成后在返回的心跳周期内发起下一次；临时错误的退避也不超过该周期。心跳不使用正抖动，使服务端选定的周期就是最晚重试边界。
- Manager 重启恢复期间通过 `DeclareManager` 上报 `manager_runtime_state=recovering`，必要 listener、完整 inventory、Runtime 映射和 worker 上下文分类完成后上报 `manager_runtime_state=online`。
- `codespace_manager.runtime_state` 只保存 Manager 声明的 `online|recovering`；offline 根据 `last_online_unix + MANAGER_OFFLINE_TIMEOUT` 实时派生，不回写该字段。

服务端统一计算周期，是因为 Manager 无法读取 Gitea 配置，分别配置会产生健康 Manager 被判离线或 metadata 提前过期的组合。四分之一离线超时允许一次短暂网络抖动或单次 heartbeat 延迟，二分之一离线超时等于 metadata TTL 的四分之一，允许多次刷新失败后再过期。`recovering` 运行态让 Gitea 区分“Manager 正在恢复本地控制能力”和“Manager 完全不可达”，从而保留已有 codespace 主状态并暂停新的 create/resume 领取。它不暂停或延长 active operation lease，operation 始终使用自身 deadline。

**设计理由：Manager 的全局恢复和单个 Codespace 的交互恢复使用不同边界。**完整 inventory、Runtime 映射和 worker 上下文分类完成后，Manager 可以 Declare online，并按真实容量领取其他 operation；上下文完整的旧 operation 只有在 Fetch 成功续租并返回新的相对有效时长后才能继续，上下文缺失的 operation 等待正常超时。Runtime Metadata、凭据、内部 SSH、路由和本地 `pending_runtime_transition` 由 online 后的逐 Codespace 任务恢复，单个对象完成当前 ready 上报前保持本地 session 准入关闭。这样对象级故障不会阻塞其他工作，外部 cache 中保留的旧 ready 快照也不能提前建立连接。

Declare 校验：

- `gateway_url` 使用 absolute `http://` 或 `https://` URL，只包含 ASCII DNS base domain 和可选 port，不接受 IP literal、userinfo、query、fragment 或非根 path。根 path `/` 在规范化后移除。base domain 转小写后不能有末尾点，每个 label 长度为 1..63 且只使用字母、数字和内部连字符；使用最长普通 Endpoint label 派生出的完整 Host 不能超过 253 字节。站点可通过 `GATEWAY_REQUIRE_HTTPS` 要求 HTTPS；默认允许 HTTP，便于受信内网和开发环境部署。
- Gitea 使用公共后缀规则计算 `ROOT_URL` host 和 `probe.{gateway_domain}` 的可注册域，两者必须不同；任一 DNS host 无法得到稳定结果或结果相同时返回 `gateway_cookie_scope_conflict`。Gitea `ROOT_URL` 使用 IP literal 时，它与 DNS Gateway 天然分属不同站点，继续执行其余冲突检查。**设计如此：Runtime 用户内容必须与 Gitea 登录站点分离，不能只依赖不同完整 Host；普通 Gateway 域下的兄弟 Endpoint 仍可能共享应用 Cookie 站点，这一兼容性边界由 Gateway 文档明确说明。**
- `gateway_url` 的 base domain 不能等于 Gitea `ROOT_URL` host，Gitea host 也不能是它的子域；否则精确记录与 wildcard DNS 会把 Gitea 路由落入 Gateway。`[session].DOMAIN` 非空时，base domain 不能等于该 Cookie Domain 或位于其子域。比较时 host 和 Cookie Domain 转小写、移除 Cookie Domain 的前导点，并按完整 DNS label 判断；冲突返回 `gateway_cookie_scope_conflict`，不更新 heartbeat。
- 规范化 `gateway_url` 按 `scheme + lower-case host + effective port` 写入 `codespace_manager_address(kind=gateway)`，由 `(kind,address)` 数据库唯一约束保证在全部 Manager 中唯一。Endpoint host 不包含 `manager_id`，唯一 origin 保证 DNS 请求只到达持有对应 Runtime 映射的 Manager deployment。
- Gitea 从该 base domain 派生 `{uuid32}.{domain}` 和 `{endpoint_id}-{uuid32}.{domain}`，因此部署需要把 base domain 与单层 wildcard DNS 都指向 Gateway；HTTPS 证书需要同时覆盖 base domain 和单层 wildcard。
- `gateway_ssh_addr` 来自 Manager 当前配置，固定格式为 `host:port`；DNS host 转为小写，port 规范化为十进制且范围为 1-65535。规范化结果写入 `codespace_manager_address(kind=ssh)`，由 `(kind,address)` 唯一约束保证在 Manager 间唯一；同 host 不同 port 可以分别使用。当前架构没有共享 SSH 路由层，唯一地址保证用户连接进入持有该 Codespace Runtime 映射的 Manager deployment。
- 两类规范化地址编码后的长度上限均为 512 bytes；超限返回 `invalid_argument`。服务层在写入前完成长度检查，数据库唯一约束比较完整地址。
- `gateway_ssh_host_key_algorithm` 非空，例如 `ssh-ed25519`。
- `gateway_ssh_host_key_fingerprint_sha256` 使用 OpenSSH SHA256 fingerprint 格式，例如 `SHA256:...`。
- `gateway_ssh_host_key_updated_unix` 是 Unix 时间戳。
- `name` trim 后长度为 1-255，`version` trim 后长度为 1-64；二者用于展示和诊断，不参与生命周期推进。
- [x] `protocol_version` 固定等于当前 ManagerService 主版本 1，不保存到 `meta_json`、Manager 行，也不参与 Manager matching。软件 `version` 和最近一次 Declare 都不能替代当前 request 的检查。
- tags 最多 64 个，每项 lower-case 后使用 `[a-z0-9_-]+`、长度为 1-64，并在规范化后去重。
- `0 < capacity_total <= 10000` 且 `0 <= capacity_available <= capacity_total`。10000 与完整 inventory/observed operation 的协议上限一致。

SSH 是 Manager 的必备能力。Web Endpoint 和 SSH 都属于 codespace 的交互入口，统一要求 Manager 声明 SSH 地址和 Gateway SSH host key 指纹，可以让 UI、权限判定、用户首次连接核对和 Gateway 部署健康检查有稳定能力基线。

实现验收点：

- Manager 修改可声明字段后，下一次成功 Declare 用当前完整快照覆盖原值；Gitea 不保存声明历史。
- [x] Declare 协议版本不匹配时不更新声明字段、地址或 `last_online_unix`；协议不匹配的 Manager 不能保持 online。
- tags 修改只影响之后尚未领取的 create；已有 binding、已领取 operation 和 stop/resume/delete 不重新匹配。
- 相同 Manager 的地址未变化 heartbeat 正常更新在线时间；地址冲突分别返回 `gateway_url_conflict` 或 `gateway_ssh_addr_conflict`，且不更新声明字段或在线时间。
- Gateway 基础域名与 Gitea 派生 Endpoint 处于同一可注册域、覆盖 Gitea host/wildcard，或与 session Cookie Domain 冲突时返回 `gateway_cookie_scope_conflict`；修改 `ROOT_URL` 或 `[session].DOMAIN` 后，Gitea 启动扫描已有 Gateway 地址并执行相同校验。
- Gateway base domain、最长派生 Host、label、末尾点和端口规范化使用同一校验器；Declare、启动扫描和页面 URL 派生不会接受不同的 Host 语法。
- Declare 在 Manager lock 内通过数据库唯一约束整体写入 Gateway/SSH 地址和声明快照；冲突时事务全部回滚，与 Manager 删除并发时只产生完整声明或记录不存在两种结果。
- 容量或 Runtime 总数超过 10000 时不进入 online 可领取状态。
- recovering heartbeat 只更新声明快照和 `last_online_unix`，不读写 active operation deadline。
- Declare 响应中的三个数值参数都为正数，心跳周期等于离线超时毫秒值的四分之一向下取整，metadata 刷新周期等于二分之一向下取整，消息上限等于当前有效配置；`gitea_web_url` 是包含 AppSubURL、path 以 `/` 结尾且不含 userinfo/query/fragment 的规范 HTTP(S) `ROOT_URL`。修改 Gitea 配置不要求同步修改 Manager 配置。
- Manager 在 operation deadline 之后才 Declare recovering 时，Fetch 和 final 均按普通超时结果处理。
- Manager 恢复完整 inventory、Runtime 映射并完成 worker 上下文分类后可以 Declare online，再逐 Codespace 恢复 metadata、credential、内部 SSH 和本地 `health_stop_pending`、`pending_runtime_transition`、`cleanup_pending`。单个 Codespace 在本地验证完成前保持 session 准入关闭，但不阻塞 Manager 领取其他 operation；stopped Runtime 只在后续 resume 的 activate 阶段安装当前内部公钥。
- Manager online 后的 Fetch 使用真实 `capacity_available`、`cleanup_capacity_available` 和当前 `accepted_operation_types`；只有全局 Incus、listener 或控制面能力不可用时才以 recovering 或两类零容量暂停新任务领取。

### FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。认证完成后，handler 取得调用方 `codespace_manager_{manager_id}` lock，并在整个请求期间持有；随后在锁内重新读取 Manager 的 runtime state、heartbeat、tags 和 owner scope，再处理版本预检、running operation、queued claim 与 payload 构造。Manager 身份删除取得同一 Manager lock，因此能与该 Manager 的 claim 和上报形成明确先后。账户删除逐条取得 Codespace lock 并依靠数据库复检裁决，不阻塞该 Manager 对其他 Codespace 的处理。

`FetchOperations` request：

| 字段 | 说明 |
| --- | --- |
| `capacity_available` | Manager 可立即承接的新 create/resume 数量（仅用于本次领取判断，不写入数据库） |
| `accepted_operation_types` | 本次接受的新建类型：`create|resume`；stop/delete 不依赖该字段 |
| `max_operations` | 本次最多返回 operation 数量 |
| `observed_operations` | Manager 已持有完整 active operation 上下文的 `codespace_uuid + operation_rversion` |
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
| `create` | 功能启用，未绑定 Manager，主状态为 `creating`，`operation_type=create`，`operation_status=queued`，owner scope 匹配，tag 匹配，本次声明接受 create，容量可用，caller 声明 `runtime_state=online` 且未按 heartbeat timeout 派生为 offline |

create、resume、delete 和用户 stop 的 `operation_trigger` 为 `user`；自动暂停 stop 为 `idle`。来源只在 Gitea 中区分领取前是否可被用户交互取消，Manager 对两类 stop 执行同一命令，因此 operation envelope 不返回 trigger。queued idle stop 在 claim 条件更新前可被用户交互或设置事务取消；claim 成功把 `operation_status` 写为 running 后，后到交互按 stopping 处理。

领取成功后返回 `operations[]`：

- `operation_rversion`
- `codespace_uuid`
- `lease_valid_for_milliseconds`
- `log_offset`
- create 所需 repository/ref/commit 字段；resume 不包含 repository payload
- `repo_id=0` 的 running create 在 Manager 已观察到相同版本时只续租；Manager 缺少上下文时等待原 deadline
- 站点排空后，已领取且 deadline 未到期的 running create/resume 只返回对应 abort 命令，用于本地清理和 `final failed`

observed-only 续租返回 `renewed_leases[]`，每项只包含 `codespace_uuid + operation_rversion + lease_valid_for_milliseconds`。同一 UUID 在一次响应中只能进入 `operations` 或 `renewed_leases` 之一；abort 不续租，因此只进入 `operations` 且相对有效时长为 0。

`operation_deadline_unix` 是 Gitea 写入数据库并用于 Fetch、FinalizeOperation 和 Cron 竞态判定的绝对截止边界。首次领取固定 `operation_started_unix`，总执行期限由 `operation_started_unix + OPERATION_MAX_DURATION` 推导。每次领取或批量续租在事务内读取一次 `grant_time`，把向未来取整的 `grant_time + OPERATION_LEASE_TIMEOUT` 与固定总期限取较早值写入数据库。`lease_valid_for_milliseconds` 通常等于配置 lease；最后一段授权返回从 `grant_time` 到总期限向下取整的实际正整数毫秒数，剩余不足 1 毫秒时直接 timeout。绝对 deadline 只属于 Gitea，不通过 RPC 回传；Manager 只用本次实际相对时长和本地单调时钟限制 Incus 执行。

delete 和 stop 是资源回收动作，使用 Manager 独立的清理容量；resume 和 create 使用启动容量。优先级只在仍有对应容量的候选之间生效：清理容量为 0 时跳过 delete/stop 并继续检查 resume/create，启动容量为 0 时仍可领取 delete/stop。这样资源回收不与 Runtime 启动争用执行槽，也不会在本地清理 worker 全部繁忙时提前开始新的 operation deadline。resume 基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository。`operation_rversion` 绑定本次 Gitea 下发的 operation 版本，Manager 后续 operation-bound RPC 都用它校验归属。

Manager matching 沿用 Actions `runs-on` 的分层方式。Gitea 从认证后的当前 `codespace_manager.tags_json` 解析规范化标量列表，Fetch request 不重复提交 tags；create 候选查询按 operation 字段、`repo_tag IN manager.tags` 和 repository 当前 owner scope 筛选，global Manager 不加 owner 限制。`accepted_operation_types`、capacity 和最终状态在 Go 中判断。

**设计理由：global Manager 与 owner-scoped Manager 同时匹配时采用同等竞争。**满足当前 owner scope、tag、online 和 capacity 条件的 Manager 都参与同一条件 UPDATE，首个更新成功者取得 create；绑定成立后保持不变。global Manager 表示可服务所有 owner 的站点容量，owner-scoped Manager 表示限定 owner 的容量，两者均没有等待优先级。一次数据库竞争即可完成 claim，无需等待窗口或容量预留。

最终 create claim 使用单条条件更新，按 UUID、`status=creating`、当前 `operation_rversion`、`manager_id=0`、`operation_type=create`、`operation_status=queued` 和 `operation_trigger=user` 匹配目标，同时重新确认功能启用、Manager 记录仍存在且 online、`repo_tag` 仍属于最新 tags、`repo_id>0` 且 repository 记录仍存在；owner-scoped Manager 还要求该 repository 当前 `owner_id` 等于 Manager owner，global Manager 不限制 owner。affected rows 为 1 才表示 claim 成功。并发 repository transfer 与 claim 以该语句看到的数据库顺序为准：claim 先成立时 binding 固定，transfer 先成立时旧 owner Manager affected rows 为 0。普通未绑定 delete 或账户删除先提交物理删除时，claim 同样影响 0 行。Fetch 已持有调用方 Manager lock，完整条件更新已经给出唯一提交结果，因此 claim 不需要 repository 或 Codespace lock；`CreateCodespace` 记录插入事务使用 Codespace owner relation lock 与 repository lock，repository 删除和 transfer 只使用 repository lock。

`capacity_available` 范围为 `0..DeclareManager.capacity_total`，`cleanup_capacity_available` 范围为 `0..256`。Manager 修改总容量时先成功提交完整 Declare，再用新上限 Fetch，因此 Fetch 不重复提交总容量；Gitea 不保存清理 worker 总数，只校验单次可用值。`max_operations` 范围为 `1..256`，只限制 `operations`；`renewed_leases` 最多与 request 的 observed 数量相同，不占 payload 名额。已有 running operation 的当前 payload、续租和 abort 都不扣减两类新领取容量。两个容量都为 0 时，Fetch 仍处理 observed operation 和 timeout，但不领取 queued operation。`observed_operations` 最多 10000 条，每个 UUID 在一次请求中唯一。每种优先级使用 `operation_created_unix, uuid` keyset 分页，按升序处理；单次 Fetch 在稳定 scope/tag 筛选后合计最多检查 1024 个 queued 候选。Manager 调用 Fetch 的周期不超过 `OPERATION_LEASE_TIMEOUT / 3`。站点排空时不领取 queued create/resume，queued stop/delete 仅按清理容量领取，running operation 继续正常处理。abort create/resume 不续租；create 的 `final failed` 写为 failed，resume 的 `final failed` 在确认启动回滚后写为 stopped。

Fetch 在处理每条 running operation 时，于 Codespace lock 内先检查 `operation_deadline_unix`，再决定 observed 续租、返回当前 payload 或 abort。deadline 未到期时按普通规则处理，但新 deadline 不能越过固定总执行期限；已经到期时执行 timeout State Finalization，不返回 payload、续租回执或 abort，也不计入 `max_operations`。站点排空的 create/resume 只在 deadline 未到期时返回一次性 abort 命令且不写新 deadline。这与 FinalizeOperation 和 Cron 使用同一条件更新边界，observed 批量续租不能恢复已经超时或达到总期限的 operation。

Fetch 对每个 queued 候选在 claim 前检查 `operation_created_unix + QUEUE_TIMEOUT`。已到硬截止时间的候选由处理函数在 Codespace lock 内按 `codespace_uuid + operation_rversion + operation_status=queued` 条件执行 timeout State Finalization，然后继续本批其他候选。该项不计入 `max_operations`，未被 Fetch 遇到的过期记录由 reconciliation Cron 处理。

timeout State Finalization 使用固定映射：queued create/delete 进入 failed，queued resume/stop 分别保持 stopped/running；running create/delete 进入 failed，running resume/stop 写为 stopped。所有分支清空 active operation；failed 结果删除 Token 与 Git SSH Key，stopped 结果删除 Token 并保留 Git SSH Key，保持 running 的 queued stop 保留现有开发凭据。该映射保留已经初始化的 workspace 和恢复所需 SSH 私钥配对关系，并使停止目标在 Manager 恢复后可由 inventory 的 `stop_local_runtime` 继续完成；详细原因见[状态机超时处理](state-machine.md#超时处理)。

单次 Fetch 不持有覆盖整批操作的事务。running lease 刷新和每条 queued claim 都在各自短事务中条件更新；claim 提交后再构造 payload。payload 加入响应前重新读取同一 UUID，并确认 `operation_rversion`、`manager_id`、`operation_type`、`operation_trigger` 和 `operation_status=running` 与本次 claim 一致；账户清理已经删除记录或其他流程已经替换 operation 时跳过该候选。create repository/user 数据加载或 payload 构造失败时，服务在仍持有 Manager lock 的情况下，以单独短事务按当前 `codespace_uuid + operation_rversion + manager_id + operation_status=running` 条件释放尚未下发的 claim：恢复 queued 和 operation 时间字段，create 同时恢复 `manager_id=0`，来源保持不变。该候选失败会写服务端日志并继续处理同批后续候选。数据库连接等系统性错误、RPC 响应失败或响应丢失保留已经提交的 claim；它保持 running 并等待原 deadline。每条 claim 独立提交，无法确认 payload 已被 Manager 持久化时不会再次启动动作。

实现验收点：

- Fetch 在租约、timeout 和 claim 前批量预检 observed operation；任一版本高于已存在且绑定当前 Manager 的 Codespace 当前版本时，整次请求返回 `state_history_conflict` 且没有业务写入。无记录或 binding 不匹配不续租，等待完整 inventory 收敛。
- 单次 `FetchOperations` 可返回多个 operation。
- 总返回数量不超过 `max_operations`。
- 本次新领取的 queued create/resume 数量不超过 `capacity_available`；已有上下文的 running operation 和 abort 不占新容量。
- 本次新领取的 queued stop/delete 数量不超过 `cleanup_capacity_available`；清理容量耗尽时跳过该类并继续处理具有启动容量的 resume/create。
- running operation 的当前 payload 因 observed 版本较低而返回时不占 create/resume capacity，但计入 `max_operations`。
- 功能启用时，以及站点排空下的 stop/delete 已上报相同 `observed_operations` 版本时，不重复下发完整 payload，而是返回 `renewed_leases` 回执。
- 上述仍在 deadline 内的已观察 operation 由 Fetch 刷新 lease，续租回执不计入 `max_operations`；站点排空下的 create/resume 在 deadline 未到期时返回 abort 并计入 `operations`，到期时直接 timeout。
- 普通 payload 和续租回执返回与本次服务端授予一致的正数相对有效时长；abort 返回 0，且不写新 deadline。
- 普通领取、当前 payload 和批量续租把向未来取整的 `grant_time + OPERATION_LEASE_TIMEOUT` 与 `operation_started_unix + OPERATION_MAX_DURATION` 取较早值作为 Gitea deadline；响应返回本次实际授予的正整数毫秒数，只有最后一段授权可以短于标准 lease。
- Fetch 不提交 `capacity_total`；服务端使用最近成功 Declare 的总容量校验本次 `capacity_available`。
- timeout、当前 payload 和 abort 都不进入 `renewed_leases`；Manager 不能把缺少续租回执解释为 operation 已清除。
- running operation 在 observed 续租或返回当前 payload 前检查 deadline；过期项直接 timeout，不进入 response。
- 领取通过数据库条件更新完成；affected rows 为 0 时继续尝试下一个候选。
- 遇到过期 queued 候选时条件写入 timeout 结果，不领取、不计入 `max_operations`，且不阻断同批其他候选。
- timeout 按 operation 类型写入稳定主状态；resume/stop timeout 不进入 failed 或触发破坏性 workspace cleanup。
- Fetch tags 只来自认证 Manager 最新 `tags_json`；客户端修改 tags 并成功 Declare 后，下一次候选查询和 claim 使用新值。
- create claim 条件更新重新确认 repository 存在和当前 owner；与 transfer 并发时只产生 transfer 前成功绑定或 transfer 后旧 scope 领取失败两种结果。
- global 与 owner-scoped Manager 同时匹配时允许任一合格 Manager 领取，但只有一个条件更新成功；成功 binding 不自动迁移。
- 每条领取在自己的短事务中写入 `operation_status=running`、`operation_started_unix`、`operation_deadline_unix`；create 领取额外写入 `manager_id`。
- 领取不递增 `operation_rversion`。
- observed 版本较低的 running operation 返回当前 payload 时不执行 claim、不递增版本，但刷新 `operation_deadline_unix`；abort 不刷新。
- 站点排空后的 create/resume 在 deadline 未到期时返回 abort 命令且不刷新 lease；到期后不再返回命令。
- stop/delete 不占 create/resume 容量，并且只在本次存在清理容量时领取；两个容量都为 0 时仍可完成 observed 续租。
- 并发领取时只有一个 Manager 成功。
- Fetch 从重新读取 Manager 到完成 claim、payload 构造或条件释放始终持有调用方 Manager lock；Manager 身份删除取得同一 lock 后重新查询，因此删除提交后不会遗留指向已删除 Manager 的 binding。账户删除只锁定目标 Codespace 并通过事务复检清理关系，不取得外部或全局 Manager lock。
- create claim 与未绑定 delete 都包含 UUID、当前版本、binding 和 operation 条件；只有一方 affected rows 为 1。claim 后 payload 复检失败的候选不进入响应。
- payload 构造失败的 operation 会被条件释放，且不会覆盖已经被替换的 operation；系统故障留下的 running claim 等待原 deadline。
- 单条候选构造失败不会丢弃同批其他成功 operation；系统性事务错误不会返回部分未知结果。
- 系统性错误不返回 response；已提交 claim 和事务提交后响应丢失都保留 running，并由普通 timeout 收敛。
- 同类型 FIFO、request 上限、10000 条 observed 上限和单次合计候选扫描上限得到校验。

### FinalizeOperation

`FinalizeOperation` 只上报当前 operation 的 `final done` 或 `final failed`。运行中 operation 的续租统一由 `FetchOperations.observed_operations` 批量完成，使每个 lease 只有一条更新路径，也避免每个 worker 额外发送独立续租 RPC。

Gitea 校验：

```text
codespace_uuid
operation_rversion
manager_id
operation_status=running
```

首次 final 在写入前直接检查 `operation_deadline_unix`。该字段已由固定总执行期限封顶；handler 发现当前版本 `now >= deadline` 且 Cron 尚未处理，就在 Codespace lock 内按 operation 类型执行 timeout State Finalization，随后按请求 final 的目标主状态与 timeout 结果是否一致返回 `idempotent_done` 或 `stale_operation`。该判断与 Fetch 批量续租和 Cron 使用相同条件更新，先成功的 final、续租或 timeout 生效，后到请求不覆盖当前状态。Manager 的 online、recovering 或 offline 状态不改变该 deadline 判断。

功能启用时按正常规则接受 final。站点在 operation 领取后进入排空时，stop/delete 仍按正常规则完成；create/resume 只允许追加清理日志和提交 `final failed`，Fetch 不再续租而是返回 abort。create 删除本轮新建的 Incus 实例后进入 failed；resume 确认本轮启动的实例已经停止后回到 stopped，保留实例根存储。该规则停止站点新增运行工作，同时不把可恢复 workspace 误标为破坏性失败，也不阻塞已有实例的 stop/delete。

final 必须携带 Manager 本地保存的原始 `operation_type`。active operation 仍存在时该类型必须与数据库一致；当前版本匹配但有效类型不同时返回 `outcome.stale_operation`。Manager 停止该 worker 的新 Incus 变更和 operation RPC，从 observed 集合省略这份上下文并保留 Runtime；Gitea 保持 active operation 到原 deadline，再按普通 timeout 和 inventory 规则收敛。`UNSPECIFIED` 和未知枚举返回 `invalid_argument`。active operation 已清空后，Gitea 只能按相同版本和请求映射出的目标主状态判断幂等，不能再证明原类型。create/resume done 映射 running，resume failed 和 stop done 映射 stopped，create/stop/delete failed 映射 failed；该目标状态幂等语义使设计不需要保存 operation 历史。abort create/resume 仍分别携带本地原始类型。

create/resume final done 都要求当前 operation 版本的 Runtime Metadata 已为 `ready` 且 Codespace Token 行完整。Manager 在 ready 前校验实际 workspace remote 的本地配置：HTTP(S) helper 必须读取当前 Token 文件，SSH 必须已经通过 `EnsureCodespaceGitSSHKey` 确认同一公钥并写入可信 known_hosts。Gitea 不保存实际 remote 的第二份字段，也不根据首选 `git_protocol` 猜测，因此 final 不重复检查协议或 SSH Key；SSH 命令只有存在有效公钥关系时才能进入专用鉴权。任一步失败都仍由 active operation 的 lease、重试和 final failed 处理。这样 final done 提交后即可清除 operation，`running` 同时表示本次启动的本地凭据配置和交互入口已经就绪，不需要另一个跨重启的后置任务。

状态写入：

| operation | done | failed |
| --- | --- | --- |
| `create` | `status=running`，保留当前开发凭据并清空 active operation | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |
| `resume` | `status=running, last_active_unix=now`，保留 Token 与 Git SSH Key 并清空 active operation，`stopped_unix` 不清零 | `status=stopped`，物理删除 Token、保留 Git SSH Key 并清空 active operation |
| `stop` | `status=stopped, stopped_unix=now`，物理删除 Token、保留 Git SSH Key 并清空 active operation | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |
| `delete` | 物理删除 Codespace、Token、Git SSH Key、日志和绑定数据 | `status=failed`，物理删除 Token 与 Git SSH Key 并清空 active operation |

resume failed 只在 Manager 已确认本轮启动的 Incus 实例停止后上报，因此 operation 事务先保留实例根存储并写回 stopped。主状态事务提交后，Gitea 尽力清除本次 resume 的 Runtime Metadata；Manager 清除本轮 boot 发布上下文，不恢复历史 ready。普通可恢复失败允许下一次 resume 使用更高 operation 版本重建；实例根存储损坏、Git SSH 密钥材料矛盾或 Gitea 公钥绑定冲突时，Manager 已持久化的 `unrecoverable_failed` boot 终态会在 final failed 后驱动现有 `ReportRuntimeTransition(failed)`。进程重启继续该报告；如果新 resume 已先创建，Manager 领取后直接 final failed，再次上报 failed。详细原因仍留在 Manager 日志，final 协议保持现有 done/failed 两值。

Manager 负责报告 Gitea-issued operation 的动作结果，Gitea 负责把结果写成主状态、开发凭据生命周期绑定和日志追加窗口。State Finalization 在同一事务内完成这些写入，保证用户看到一致的生命周期结果。operation 完成后不保留 `done|failed` 状态，失败诊断从 Codespace 日志读取。

State Finalization 首次完成 final、timeout、missing 或 transition 处理时写 `updated_unix=now`；queued resume/stop timeout 或 queued idle stop 取消即使保持原稳定主状态，也因 active operation 首次结束而更新时间。创建或替换 active operation 同样更新该字段。claim、lease 续租、日志、Runtime Metadata、token 读取或修复、未取消 operation 的 open/SSH/继续运行/设置变更和相同结果的幂等重试不更新它，repository 删除仅把 `repo_id` 写为 0 时也不更新。这样 `updated_unix` 可以稳定表达生命周期变化，并作为 failed retention 起点，而不会被调度或普通交互活动延后。

State Finalization 主事务提交后，仍保留 Codespace 记录的结果在释放该 Codespace keyed lock 前尽力追加内部状态摘要。摘要由独立的 DBFS 追加事务保证内容与日志元数据共同提交；摘要失败只记录服务端日志，不回滚主状态。delete done 已经物理删除记录和日志，直接跳过摘要；force/account/Manager delete 与 retention 清理同样不能重新创建日志。

实现验收点：

- lease 只由 Fetch observed 批量续租；FinalizeOperation 不包含续租分支。boot stage 由 Runtime Metadata 和日志表达。
- final result 触发一次 State Finalization。
- 首次 final 返回 `outcome.final_accepted`。
- final 的有效 operation 类型与当前同版本 active operation 不一致时返回 stale outcome，Manager 省略该旧上下文且不以 stale 重新取得 payload；非法枚举返回 invalid argument。active 已清空时按相同版本和请求目标主状态稳定返回幂等或 stale outcome，不声称恢复原类型。
- 重复 final 同一 `operation_rversion` 且主状态已匹配目标结果，返回 `outcome.idempotent_done`。
- 过期 `operation_rversion` 或主状态不匹配，返回 `outcome.stale_operation`，当前主状态保持稳定。
- State Finalization 同事务处理主状态、包括来源在内的 active operation 清空，以及彼此独立的 Codespace Token 与 Git SSH Key 生命周期；active operation 清空后日志追加窗口关闭。
- create/resume 的 final done 在当前 operation 版本 ready metadata 或 Token 行缺失时被拒绝，active operation 保持可重试；实际 remote 的本地凭据配置由 Manager 在 ready 前验证，Gitea final 不增加协议分支，成功后不再存在凭据刷新任务。
- resume failed、timeout 和 abort 在状态结果成立后尽力清除本次启动 metadata；迟到的同版本上报不能在无 active resume 时重新写入。
- `updated_unix` 在创建记录、创建或替换 active operation，以及首次 final/timeout/missing/transition/queued idle stop 取消时更新；未改变 active operation 的交互或设置、claim、续租、metadata、日志、token 修复、幂等结果和 `repo_id` 置 0 不刷新该字段。
- 保留 Codespace 记录的结果在主事务提交后、释放 Codespace lock 前单独追加内部摘要；物理删除跳过摘要，摘要失败不回滚已经接受的 final。
- deadline 到期后的 final 在请求路径立即触发按 operation 类型定义的 timeout；请求目标与 timeout 目标相同返回幂等，否则返回 stale。Manager runtime state 不延长 deadline，且与 Fetch/Cron 并发时只有一个条件更新生效。
- codespace 已物理删除时返回 `outcome.resource_absent`；worker 清除本地 operation 上下文、结束该 operation 的上报并触发完整 inventory。`resource_absent` 本身不授权删除 Runtime；当前 inventory 查询明确无记录时再返回 `cleanup_local_runtime`。UUID 不复用，也不保存 operation 历史或 tombstone。
- 站点排空后已领取的 create/resume 只能 final failed，已领取或新领取的 stop/delete 可以正常完成。

### UpdateLog

- 写入 DBFS 路径 `codespace_log/{codespace_uuid}.log`。
- Gitea 服务层可为完整 failed 对象和 operation 最终状态通过内部入口写入失败或 warning 摘要；Manager operation payload 携带当前 `log_offset`。
- request 使用结构化 `LogLine(timestamp_unix_nano, message)`；Gitea 脱敏后统一编码为 UTF-8 `[RFC3339Nano] message\n`，offset 按编码后的完整字节计算。
- 校验 `codespace_uuid + operation_rversion + manager_id` 匹配当前 running operation。
- offset 等于当前日志大小时追加。
- offset 小于当前日志大小时，只有规范化后的完整请求段已经全部存在且逐字节相同时才是幂等重放；请求段只与文件尾部分重叠时返回 offset conflict 和当前文件末尾，不追加剩余部分。
- offset 大于当前日志大小时返回 offset gap 分类，保持日志文件连续。
- 校验 `codespace.operation_status == running && codespace.manager_id == caller`。
- 只允许当前 `operation_rversion` 对应的 running operation 追加日志。
- active operation 清空后，日志进入封闭状态。
- 单行最大长度由 `LOG_MAX_LINE_SIZE` 控制。
- 日志总大小由 `LOG_MAX_SIZE` 控制。普通日志可用上限为 `LOG_MAX_SIZE-LOG_FINAL_SUMMARY_RESERVE`，超过后返回 log size exceeded 分类并写入明确截断摘要。
- 服务端固定预留 `LOG_FINAL_SUMMARY_RESERVE`；达到普通日志上限后拒绝原始行，但内部最终摘要仍可写入预留空间。
- keyed lock 内发现普通 batch 将使当前文件首次跨过普通日志上限时，只写一条截断摘要；文件已经达到上限后的普通行直接返回 `log_size_exceeded`，不再写摘要。截断摘要和最终摘要共同受 `LOG_MAX_SIZE` 硬上限约束。
- Manager 在 final 前先上传 operation 最终摘要。对于仍保留 Codespace 记录的结果，Gitea 在 State Finalization 主事务提交后、释放 Codespace keyed lock 前使用剩余预留空间尽力追加内部状态摘要；该 DBFS 追加事务失败或预留耗尽时只记录服务端日志，不回滚生命周期状态。物理删除路径跳过摘要并删除整份日志。
- 成功追加和内容一致的幂等重放都返回服务端当前 `next_offset`；该值是脱敏和规范化编码后的真实文件末尾。
- offset conflict/gap 返回 `FailureDetail` 和 `LogOffsetDetail(current_offset)`；Manager 从服务端位置恢复，不根据本地原始 message 估算 offset。

日志使用 byte offset 而不是行号作为写入幂等键，是因为 DBFS 提供 seek/write 能力，Manager 重试时可以精确重放同一段内容。offset gap 分类可以保证 UI tail、下载和后续清理都面对连续文件，不需要处理缺失片段。

实现验收点：

- 成功追加和相同内容幂等重放都返回真实 `next_offset`。
- 服务端脱敏改变字节数时，Manager 下一次追加仍使用 response offset 并成功连续写入。
- offset conflict/gap 携带 `LogOffsetDetail.current_offset`，且不产生不连续文件。
- 达到普通日志上限后只写一条截断摘要，重复请求不消耗最终摘要预留空间。
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
- `boot` 上下文按当前状态校验：active create/resume 使用当前 operation 版本并按适用的 `prepare-runtime|initialize-system|prepare-workspace|start-environment|publish-runtime|ready` 顺序前进；running 只接受 boot 版本不大于当前 operation 版本的 `ready`；stopped 且无 active operation 时拒绝 metadata。同一 boot 版本的 stage 只能前进，已经接受 `ready` 后保持 `ready`。
- `stopped` 状态下只接受 active resume 的当前启动进度；没有 active operation 时不周期发布 Runtime Metadata，也不提供面向用户的 open 或 Gateway SSH。active resume 在 `init.sh` 成功并写入当前凭据后、final done 前即可使用开发凭据配置实际 remote 和恢复用户服务。
- metadata 顶层和 `boot` 使用固定字段；`boot.operation_rversion` 必填。未知字段被拒绝。`endpoints` 始终存在，没有声明时为空数组；`internal_ssh` 在 `boot.stage=ready` 时必须完整。
- Gitea 对每个 Endpoint label 独立执行 Runtime Metadata 统一校验：合法 UTF-8、去除首尾 Unicode 空白后保存、按 Unicode 字符数为 1 到 64，并且不包含控制字符、`<` 或 `>`。Gitea 不依赖 Manager 的校验结果，也不执行 Unicode 归一化、替换或自动清洗；内容 hash 使用校验后的规范值。
- create/resume operation 只有在当前 metadata 的 boot 版本等于当前 operation 且 `stage=ready` 时可 final done。resume 还要求当前 Token 行完整；旧 operation 版本的 `ready` 不能完成本次恢复。stopped 状态下即使 active resume 已上报 ready，面向用户的 open/Gateway SSH 仍按主状态拒绝，直到 final done 原子写入 running；该限制不阻断初始化阶段的仓库开发凭据。
- Manager 启动后为 active create、active resume 和 running Codespace 启动发布任务并重建 Runtime Metadata cache。稳定 stopped 不发布 metadata；Manager 本地保留最新 boot 终态，用于重启后恢复失败收敛目标，下一次合法 resume 从保留的 Incus 实例重建更高 generation 的完整快照。
- Manager 运行期间周期刷新 active create/resume 和 running Codespace 的 Runtime Metadata cache，避免 cache miss 后长期失去交互能力。
- Gitea 信任 Runtime Metadata cache 仅用于 open/SSH 的 ready、普通 Endpoint existence、internal SSH 和 UI 展示。resume 不读取该 cache；主状态校验基于数据库 `codespace.status`，与 cache 信任无关。

每个 Codespace 的完整 metadata 只由 Manager 的一个发布任务串行发送。boot、Endpoint、internal SSH 和恢复流程先更新同一份本地当前快照，再唤醒该任务；内容没有变化时保留 generation 并只刷新 TTL。每个成功请求都按该请求实际携带的 boot 更新 ready 接受记录：只要 Gitea 接受过当前 create/resume operation 的 `ready`，operation worker 就可以提交 final；本地之后出现的更高 Endpoint generation 继续由发布任务异步发送，不撤销 ready，也不阻塞 final。该单一写入顺序使阶段单调、Endpoint 更新和周期刷新共享同一个 generation 基线，不需要在 Gitea 保存待发布队列。

Runtime Metadata 是运行时信息，变化频繁，也可以由 Manager 重建，因此放在 cache 中。主状态和权限判断继续使用数据库字段。

实现验收点：

- Runtime Metadata 成功写入 cache。
- `running` 交互入口同时依据主状态、Manager 在线态和 Runtime Metadata。
- Gitea cache 丢失后由 Manager 重建 Runtime Metadata。
- 稳定 stopped 不周期发布 metadata；resume 不依赖 cache，并以更高 generation 重建当前启动快照。
- 相同 generation、不同内容被拒绝，相同内容的重试和周期刷新幂等延长 TTL。
- metadata generation stale 按服务端当前值升代并重读当前完整快照；同代冲突和版本无法递增分别返回不可重试的 `generation_conflict` 与 `version_exhausted`，不提交部分结果，Manager 按单 Codespace 持久状态损坏流程清理该 UUID。
- 错误 Manager、旧 operation、站点排空、offline、低 generation 和同 generation 不同内容分别稳定返回 `manager_mismatch`、`stale_operation`、`state_unavailable`、`manager_offline`、`stale_generation` 和 `generation_conflict`。
- ready 快照缺失完整 internal SSH、固定 boot 字段或包含未知字段时被拒绝，且 create/resume 都不能提前 final done。
- label 非法 UTF-8、去除首尾 Unicode 空白后为空、超过 64 个 Unicode 字符或包含控制字符、`<`、`>` 时被拒绝且不写 cache；合法中文和其他普通展示文本在 Manager 与 Gitea 得到相同规范值。
- resume 在 active operation 内依次完成系统初始化、Token 写入、prepare/activate、实际 remote 的本地 Git 凭据配置和当前版本 ready 上报；任一前置缺失时不提交 final done，主状态保持 stopped。repository 可达性和普通 Endpoint 不参与 ready 判定。
- active create/resume 和 running 执行固定 boot 版本与阶段矩阵；无 active operation 的 stopped 拒绝 metadata，同版本 ready 不回退，已结束 resume 的迟到快照返回 stale。
- boot、Endpoint、internal SSH、恢复重建和周期刷新都通过同一发布任务串行发送当前完整快照；final 等待任一实际携带当前 operation ready 的成功请求，不等待更高 Endpoint generation 完成同步。

### ReportRuntimeTransition

`ReportRuntimeTransition` 用于 Manager 在没有 Gitea-issued active operation 时上报本地主动 stopped 或不可恢复的 failed 状态。stopped 包括 Incus 外部停止、运行健康检查确认基础交互持续失败后由 Manager 主动停止，以及凭据恢复无法继续但根存储仍可保留；running 只能由 Gitea 下发的 create/resume operation 通过 final done 建立。

request 字段：

| 字段 | 说明 |
| --- | --- |
| `codespace_uuid` | Runtime 对应 codespace UUID |
| `runtime_generation` | Manager 对该 codespace 主动运行状态报告的单调版本 |
| `observed_operation_rversion` | Manager 生成该状态报告时观察到的最新 Gitea operation 版本 |
| `runtime_state` | 只接受 `stopped|failed`；状态报告不携带原因、时间或 Runtime Metadata |

接受规则：

| 当前状态 | Manager 状态报告 | 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped`、写 `stopped_unix=now`、物理删除 Token 并保留 Git SSH Key |
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

Manager 主动 transition 不更新 `last_active_unix`；该字段只尽力记录用户 resume final、成功签发或消费 Open Code、成功 SSH 认证和继续运行。failed 状态报告不表示 Runtime 已停止，因此从 running 进入 failed 时不写 `stopped_unix`。

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

### RequestGiteaToken

- 允许绑定 Manager 为 active create、active resume 或无 active operation 的 running Codespace 申请当前 Gitea 开发凭据。
- 调用方 Manager 必须与 `codespace.manager_id` 匹配，且声明为 online 或 recovering、heartbeat 有效。recovering 允许继续处理本地上下文完整且 lease 有效的已绑定 create/resume，或修复稳定 running 的当前凭据；新的 create/resume 在声明 online 后领取。
- `codespace.user_id` 必须解析到创建用户；正常账户删除流程会先物理删除关联 codespace，若发现悬空引用则按数据库一致性错误拒绝并交由服务端日志排查，不签发 token。
- `creating` 要求 create operation 已被该 Manager 领取，用于首次 clone/checkout。
- `stopped` 只在 resume operation 已被该 Manager 领取且租约未到期时允许。该阶段是恢复初始化，Token 签发后可以直接访问绑定仓库的 Git、LFS 和开发 API；resume final failed、timeout、abort 或后续 delete 都会物理删除该行。
- `running` 只在没有 active operation 时允许，用于本地 credential 文件丢失或损坏后的修复。修复期间现有 boot 快照保持 `ready`；写入成功后继续运行，确认无法安全写入时 Manager 关闭会话并停止 Runtime，再按 workspace 是否可恢复上报 stopped 或 failed。active stop 不需要重新取得 Gitea Token，delete 已把主状态改为 `deleting` 并删除 Token；两者都返回 `state_unavailable`。这样停止和删除只依赖本地 Runtime 与 operation 上下文，不因凭据重新交付增加失败分支。
- active resume 收到站点排空的 `state_unavailable` 时由现有 abort 流程停止本轮 Incus 实例并 final failed；`manager_offline` 要求先 Declare recovering 再重试；`codespace_not_found` 终止当前通信并触发完整 inventory；`manager_unregistered` 关闭全部入口、强制停止 Incus 实例并停止 RPC，同时保留实例根存储；更高 delete operation 由 active operation 接管。
- `status=failed|deleting`，以及没有 active resume 的 `stopped` 返回状态不可用。
- `repo_id=0` 时仍可签发 Token，active create/resume 也可登记公钥；后续 Git HTTP(S)/SSH、LFS 和 repository API 没有任何 repository 能通过 binding，公开只读请求仍按 Gitea 现有公开访问规则处理，当前用户与公共服务信息 API 仍按开发凭据章节的登录限制和入口策略工作。
- 当前 `codespace_gitea_token` 行存在时，Gitea 解密 `token_encrypted`，重新使用行内 salt 计算完整 Token 的 verifier，并以常量时间比较 `token_hash`；全部通过后返回同一 Token。认证请求不需要解密密文。
- Token 行不存在时生成 `gcs_` 加 32 个安全随机字节小写十六进制编码的 Token，写入 salt、hash、末八位、Gitea Secret 密文和创建时间。`codespace_uuid` 主键保证同一 Codespace 只有一个当前 Token；并发插入遇到主键冲突时重新读取现有行。
- 成功响应同时返回非空 `server_url`，取规范化 Gitea `ROOT_URL` 并保留 `AppSubURL`。该地址与 token 一起下发，使 Runtime API 客户端不依赖 Manager 的内部控制面地址，也不从 repository URL 做路径裁剪。
- 密文无法解密、解密结果格式错误或 verifier 不匹配时，在 Codespace lock 内物理删除损坏行；仅在当前仍允许签发的工作状态重新生成。损坏行不能通过认证 resolver，也不能返回未通过 verifier 的明文。
- 同一 `codespace_uuid` 的请求和生命周期删除使用同一个 Codespace lock；锁内重新读取 Codespace，并在短事务中创建、替换或删除 Token 行。stop/delete 与并发签发形成明确先后，状态事务提交后不会残留 Token 行。
- `[codespace] ENABLED=false` 时所有 `RequestGiteaToken` 请求都返回 `state_unavailable`，不读取、签发或修复 Token。排空期间运行侧不能使用该凭据，停止日志需要的精确脱敏值由 Manager 从本地 Runtime credential 文件恢复；无法确认安全的缓冲日志直接丢弃，因此服务端不保留 stop 只读例外。

**设计选择：`RequestGiteaToken` 服务于 create/resume 初始化和稳定 running 凭据修复。**初始化阶段定义为 create 或 resume operation 已被绑定 Manager 领取、`operation_status=running` 且 `operation_deadline_unix > now`；稳定 running 要求没有 active operation。Token 在这两个初始化分支和主状态 running 时都能直接访问绑定仓库；用户 open 与工作区 SSH 仍要求主状态 running，两类访问边界彼此独立。active stop 使用 Runtime 本地已有 credential 文件完成日志脱敏；无法恢复精确 mask 时丢弃相关缓冲日志。站点排空期间开发凭据不可使用，因此该 RPC 返回 `state_unavailable`。

实现验收点：

- 功能启用时，Manager 声明为 online 或 recovering 且 heartbeat 有效、Codespace 为 active create、active resume 或无 active operation 的 running，且创建用户存在的有效请求返回当前 Token 或在行不存在时签发一个新 Token；active stop/delete 不返回 Token。
- active create/resume 的租约有效时 Token 可以通过认证；operation 超时、结束或变成其他类型后，即使 Token 行尚待状态事务清理也会在授权点拒绝。
- 当前 operation 的 ready metadata 和 Token 行缺一时，create/resume final done 被拒绝。
- active resume 的站点排空、offline、记录缺失和更高 delete operation 分别进入 abort、Declare recovering、inventory 或 active operation 接管。
- 悬空 `user_id` 不创建 Token 行；账户删除正常路径不会留下可调用该 RPC 的 Codespace。
- 损坏行修复后旧 verifier 和密文不存在，Codespace 最多存在一个新 Token。
- 并发 Request 与 stop/delete 后，数据库中至多存在一个该 Codespace 的 Token；非 active resume 的 stopped 及 failed/deleting 状态不存在 Token 行。
- 新 Token 使用固定 `gcs_` 前缀和 256 位随机值，数据库只保存 verifier、末八位和 Gitea Secret 密文，不创建普通 PAT。
- 成功响应始终包含非空 token 和规范化 `server_url`。
- 稳定 running 凭据修复不回退 boot ready；本地写入确认失败后关闭入口并停止 Runtime，再上报 stopped 或 failed。
- 密文解密结果必须通过行内 salt/hash verifier；认证热路径只验证提交 Token 的 hash，不解密密文。
- 排空模式下任何请求都不会读取、签发、修复或返回 Token；stop 从本地 Runtime credential 文件恢复脱敏值，无法确认安全的缓冲日志不上传。

### EnsureCodespaceGitSSHKey

`EnsureCodespaceGitSSHKey` 在 create 首次尝试 SSH 或 SSH remote 的 resume 初始化时创建或确认生命周期级公钥。Manager 已通过 Runtime Token、来源 Incus identity 和本地 operation 上下文校验请求，Gitea 再以 Manager 身份、Codespace binding 和当前初始化状态作最终判定。Runtime 和该 RPC 都不提交 operation 版本；Manager 内部仍使用当前版本完成 metadata 和 final。create 后续回退到 HTTP(S) 时允许保留已经登记的公钥，final 仍按实际 remote 的本地配置判断 ready。

handler 取得 Codespace lock，锁内重新读取 Codespace 并按固定顺序处理：

1. 功能启用，调用方 Manager 记录有效、heartbeat 未超时，且与 `codespace.manager_id` 匹配。
2. 主状态和 active operation 为已领取的 `creating/create` 或 `stopped/resume`，`operation_status=running` 且 `operation_deadline_unix > now`。`git_protocol` 只表示 clone 首选项，`http` 和 `ssh` 两种首选项都允许登记实际 SSH 尝试所需公钥。
3. `codespace.user_id` 仍能解析到满足当前登录限制的创建用户。公钥登记不以当前 repository 权限作为完成条件；Git SSH 命令会在实际访问时检查当前 repository、code unit 和用户权限，因此 repository 已删除或权限暂时变化不会阻断 Codespace resume。
4. 公钥为一把规范 Ed25519 Key；Gitea 丢弃 comment，使用 SSH wire bytes 计算现有 SHA256 指纹。
5. 关系与 `PublicKey` 都不存在时准备创建；关系完整且公钥相同时幂等成功。已有不同公钥时返回 `key_conflict`，保持现有绑定。
6. 需要创建时，在 Codespace lock 内按规范指纹摘要取得与普通用户 Key、Deploy Key 创建入口共用的 PublicKey 指纹锁，再开启短事务并重新查询指纹。任意已有 User 或 Codespace PublicKey、已有非 Deploy 类型的 Deploy 创建请求，以及 Codespace 遇到任意已有指纹时返回对应冲突；Deploy 只复用已有 `KeyTypeDeploy`。历史数据中同一指纹存在多条 PublicKey 时返回数据完整性硬错误，不选择或自动合并。Codespace 确认指纹未被使用后插入 `codespace_ssh_key` 与对应 `PublicKey(KeyTypeCodespace)`；关系存在但 PublicKey 缺失等不完整结果返回 `internal_error`。
7. 事务提交并释放 PublicKey 指纹锁后调用 Gitea 现有公钥授权同步入口：内置 SSH 或 `SSH_CREATE_AUTHORIZED_KEYS_FILE=false` 时数据库已经是完整授权来源；使用外部 `authorized_keys` 文件时重写该文件。当前接入面就绪后返回规范化 `known_hosts_lines`；文件同步失败返回 `internal_error`，相同公钥重试会再次同步。

数据库是公钥授权的事实来源。删除事务先移除关系与 `PublicKey`；外部 `authorized_keys` 即使短暂保留旧的 forced-command 行，后续 key ID 查询也会失败。配置使用授权文件时，新增公钥在文件同步成功后才向 Runtime 返回成功，因此 create/resume 会在 lease 内使用同一公钥重试；内置 SSH 和外部 `AuthorizedKeysCommand` 直接使用数据库结果。

`known_hosts_lines` 对应 Gitea 对外 SSH clone URL 的规范 host 和有效端口。内置 SSH 从 `[server] SSH_SERVER_HOST_KEYS` 的当前 Host Key 派生公钥；外部 SSH 使用 `[codespace] GIT_SSH_KNOWN_HOSTS` 的显式配置。响应内容是公开的服务器身份材料，不包含 Runtime 私钥、Gitea Token、内部 SSH 地址或 Manager Gateway Host Key。

**设计理由：公钥绑定属于 Codespace，而不是某次 operation。**create 首次生成密钥，create 重试和 resume 复用；相同公钥请求幂等，不同公钥不能覆盖，因此迟到请求不需要 operation 版本也不会改变当前绑定。只有一个密钥文件、私钥无法导出匹配公钥、Gitea 已绑定不同公钥或返回 `key_conflict` 都表示原 workspace 的 Git 身份无法安全确认：create 失败直接进入 failed，resume 停止本轮实例并 final failed 后继续上报 failed，用户随后删除 Codespace。该结果复用现有状态报告和清理流程，比增加密钥替换协议更容易验证。

**设计如此：三类 PublicKey 创建共享指纹锁，但保留各自现有类型语义和数据库结构。**锁在事务前取得、指纹在事务内复查，使并发创建只有一个提交顺序；当前单活动 Gitea 不需要为这一约束增加唯一索引迁移、历史重复数据合并或新的密钥服务。授权文件同步发生在数据库提交后，失败重试仍以数据库中的同一 Key ID 为准。

实现验收点：

- 非初始化阶段、租约过期和错误 Manager binding 均在写入前返回固定分类；HTTP 首选项不阻止为 SSH fallback 登记公钥。
- [x] 相同规范公钥幂等返回相同 Host Key 集合；不同公钥或指纹冲突不会替换当前 binding。
- [x] User、Deploy 和 Codespace 公钥创建使用同一 PublicKey 指纹锁并在事务内复查；不同 Codespace 和跨类型并发提交同一指纹时只有一个符合类型规则的结果，历史重复指纹返回数据完整性硬错误。
- Runtime 密钥材料矛盾或返回 `key_conflict` 时，create 收敛到 failed；resume 保存不可恢复 boot 终态，在 final failed 后继续通过状态报告收敛到 failed。
- [x] 公钥登记不要求 repository 仍存在或创建者当前仍有仓库权限；实际 Git SSH 命令在每次连接上重新判定，`repo_id=0` 不能匹配任何仓库。
- [x] 数据库事务始终保持一条关系对应一个 `KeyTypeCodespace` PublicKey；配置使用外部授权文件时，同步失败可以通过同一请求重试，内置 SSH 与 `AuthorizedKeysCommand` 模式无需文件同步。
- [x] stop、delete 或初始化结束先提交后，迟到的确保请求因阶段不匹配而拒绝；确保先提交时，stopped 保留但禁用公钥，failed/deleting/delete 状态事务删除公钥。
- [x] response 只返回匹配当前 Gitea SSH host/port 的公开 Host Key 行，不返回私钥、Token 或内部连接信息。

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

Fetch queued claim 延续现有 Manager lock 与数据库条件更新模型，不额外取得 Codespace lock。idle stop claim 的条件包含当前 UUID、版本、`operation_type=stop` 和 `operation_status=queued`；用户交互取消事务同样只在 `operation_status=queued + operation_trigger=idle` 时清空。数据库行的提交顺序决定唯一结果：取消先提交时 Fetch affected rows 为 0，用户继续运行；claim 先提交时取消 affected rows 为 0，交互入口重新读取后返回 stopping。用户 stop 把来源改为 user 先提交时，Fetch 继续领取同一 stop，但 payload 与 idle stop 完全相同；claim 先提交时 operation 已是 running，用户 stop 返回已经停止中，已下发的 idle stop 继续完成。两种顺序都不会取消用户明确接受的停止结果。

自动暂停设置只由创建者在自己 `running` 或 `stopped` 的对象页面修改。handler 取得 Codespace lock，在一个事务中复读创建者身份、状态和规范化持久值；值未变化时直接成功。持久值变化时保存新选择，只有解析后的启用状态或有效超时发生变化，才按当前 UUID、版本、`operation_type=stop`、`operation_status=queued`、`operation_trigger=idle` 条件取消尚未领取的自动 stop。Fetch 已先领取时条件取消影响 0 行，事务保存设置并保留 running stop；设置事务先提交时 Fetch claim 影响 0 行。`never` 只关闭空闲触发，手动 stop/delete、站点排空、failed 状态报告和用户、组织、Manager 删除仍按各自生命周期执行。stopped 对象修改设置后保持 stopped，后续由用户 resume 决定何时再次运行。

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
- response 使用互斥 outcome：成功返回 `allowed(user_id, codespace_uuid, endpoint_id, interaction_generation)`，访问拒绝返回 `denied(category)`。调用方 Manager 已由 RPC 认证且 Gitea 在返回 allowed 前校验 Codespace binding，因此 response 不重复返回 `manager_id`。
- 校验过程遵循 OAuth2 Authorization Code Grant 模式：Gitea 作为 Authorization Server，Gateway 作为 Client（以 Manager 身份认证，代替 OAuth2 标准的 client_id/client_secret）。
- 验证时把 Codespace 功能开关纳入运行时检查，并继续检查 codespace 状态、用户权限和有效 Endpoint，而非仅检查 code 是否有效。无法解析或已经过期的 code 仍按凭据规则清理；可解析且未过期的 code 在功能关闭时返回 `denied(state_unavailable)` 并按原 TTL 失效。无 active operation 或当前只有 queued idle stop 时可以继续，后者在交互事务中取消；running stop 或用户来源 stop 返回 stopping。Runtime Metadata 必须 ready；普通 Endpoint 还必须仍在当前 metadata 中且 `public=false`，`workspace` 不要求 endpoints 数组存在同名项，实际连接 Runtime 同名 Endpoint 还是 Manager 内置 Web SSH 由 Manager 决定。Endpoint 在 code 签发后改为公共访问时，本次交换被拒绝，由浏览器直接使用公共访问路径。
- 成功消费 code 后在 Codespace lock 内推进 `interaction_generation`，取消尚未领取的 idle stop，并把提交后的版本放入 binding；版本事务失败时不返回 allowed。`last_active_unix=now` 仍是提交后的尽力展示更新，失败只记录服务端日志，不撤销已经成立的 binding。

### ValidatePublicEndpoint

Gateway 在普通公共 HTTP 请求没有最多 1 秒的新鲜 allowed 时调用 `ValidatePublicEndpoint(codespace_uuid, endpoint_id)`；相同授权键的并发请求共享一次调用。WebSocket 和持续时间超过复检周期的 HTTP 请求继续按周期调用且不复用普通 HTTP 的短期结果。请求使用已认证的 Manager 身份，不携带用户身份或 Gateway session。response 使用互斥 outcome，明确允许时返回空 `allowed`，其他业务结果返回 `denied(category)`。

Gitea 每次重新读取并检查：Codespace 功能启用；调用方 Manager 与当前 binding 一致、声明 online 且 heartbeat 有效；Codespace 为稳定 `running` 且没有 active operation（包括 queued idle stop）；Runtime Metadata 存在并为当前 boot 的 `ready`；`endpoint_id` 是非 `workspace` 的普通 ID，且当前 metadata 中对应记录的 `public=true`。成功结果不推进 `interaction_generation`，不更新 `last_active_unix`，也不创建或复检 Gateway session。

**设计如此：公共访问由持有 Runtime Token 的工作环境进程明确提交 `public=true`，不要求用户在 Gitea 页面再次确认。**工作环境用户具有 sudo，因此 Runtime 是 Endpoint 声明的授权主体，Gitea 只展示当前 metadata 中的结果。校验不读取 repository 可见性、`repo_id`、创建用户当前登录状态或 repository 权限；这些条件只影响 Gitea 页面管理和开发凭据，不会在 Endpoint 已公开后形成另一套隐式访问开关。生命周期、Manager binding 和 metadata 仍实时校验，使 stop、delete、failed、Manager 离线或访问方式改变能够收敛。Gateway 只有持有最多 1 秒的新鲜 allowed 且本地不可变路由仍为公共访问时才转发，RPC 错误按无法确认处理。

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
| `codespace_uuid` | codespace UUID（Gateway 从 SSH 连接串 `cs-{id}` 解析） |
| `public_key` | SSH 客户端认证请求中的 wire-format 公钥 bytes |

`VerifySSHPublicKeyResponse` 使用互斥 outcome：

| 字段 | 说明 |
| --- | --- |
| `allowed` | 成功 binding，包含 `user_id + interaction_generation`；Codespace UUID 使用经过本次校验的 request 值 |
| `denied` | 拒绝详情，包含稳定 `category` |

Gitea 校验：

- Codespace 功能当前启用。
- `codespace_uuid` 映射到有效 codespace。
- codespace 为 `running`。
- codespace 当前无 active operation，或只有可以在本次成功认证事务中取消的 queued idle stop；running stop、用户 stop 和 delete 均返回停止中或状态不可用分类。
- Runtime Metadata 存在且 `boot.stage=ready`，`internal_ssh` 完整。
- 公钥认证使用 `ssh.ParsePublicKey` 解析 `public_key`，计算 OpenSSH SHA256 fingerprint，以 `OwnerID=codespace.user_id + Fingerprint + KeyTypeUser` 查询 Gitea SSH key，并再次比较数据库 key 规范化后的 wire bytes。二次比较保证认证依据是同一把 key，而不是仅依赖 fingerprint 文本。部署密钥（`KeyTypeDeploy`）和授权主体（`KeyTypePrincipal`）不接受。若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- 创建用户当前允许登录。
- 绑定 Manager 当前在线。
- `public_key` 解析失败、未匹配用户 key 或 wire bytes 不一致均返回 `invalid_credentials`。
- `public_key` 是认证的唯一依据，Gateway 仅在 `VerifySSHPublicKey` 中传递客户端提交的完整公钥 bytes。

成功认证只授权本次新 SSH transport。用户之后删除该公钥会使新的 `VerifySSHPublicKey` 失败；已建立 session 的 `RevalidateGatewaySession` 继续按用户、Codespace、Manager 和 Runtime Metadata binding 复检，不重复查询原公钥。这样现有连接仍有 session TTL、空闲超时和周期复检的明确上限，同时不需要在 session 协议中增加公钥指纹。

SSH 接入的完整流程（Gateway 中转模型、channel 能力、限流退避配置）参见 [Manager 与 Gateway - SSH 接入](manager-gateway.md#ssh-接入)。

Gateway 按 source IP、`codespace_uuid` 做限流和退避。限流和退避由 Gateway 负责。

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

Gateway 使用该接口持续复检已建立的 Endpoint 和 SSH session：普通 HTTP 在相同授权键没有最多 1 秒的新鲜 allowed 时调用，Endpoint WebSocket 和 SSH 按固定周期调用。request 使用 `oneof session`：Endpoint session 携带 `user_id / codespace_uuid / endpoint_id`，SSH session 只携带 `user_id / codespace_uuid`；调用方 Manager 必须与 codespace binding 匹配。

Gitea 重新检查：

- Codespace 功能当前启用；关闭时返回 `denied(state_unavailable)`。
- 创建用户仍允许登录，且 request `user_id` 等于 `codespace.user_id`。
- codespace 为 running 且没有 active stop/delete operation。
- 绑定 Manager online。
- Runtime Metadata 仍存在且 `boot.stage=ready`。
- request 选择普通 `endpoint` binding 时，metadata 中仍存在 `endpoint_id` 且 `public=false`；`endpoint_id=workspace` 时不要求 endpoints 数组存在同名项。
- request 选择 `ssh` binding 时，internal SSH metadata 仍完整可用。

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
| `instances[].codespace_uuid` | 本地 Runtime 对应 codespace UUID |
| `instances[].runtime_state` | `creating|running|stopped|failed` |
| `instances[].observed_operation_rversion` | Manager 看到的本地 operation 版本 |

`ReportInstances` 始终上报 Manager 持有的完整 Runtime 集合，包括 creating 资源和 stopped 的可恢复 Incus 实例。Manager 只在 Incus 实例全量枚举和所有状态读取均成功后分配新 generation 并提交；任一分页、连接或状态读取失败时不生成请求，下一次从头扫描。单个 Manager 最多管理 10000 个带归属字段的 Incus 实例，单次最多 10000 个实例且 UUID 唯一。超限时 Manager 保持 recovering、声明可用容量 0，并等待资源数量恢复到协议上限内。`observed_operation_rversion=0` 固定表示本地没有可继续的完整 active operation 上下文；正数固定表示持有该版本的完整 active operation 上下文，不表示历史最高版本。完整集合是 missing 判定的依据。

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

**设计理由：正常向前运行的 Gitea 数据库记录和 Manager inventory 已经构成完整的期望状态与实际状态比较。**数据库成功确认 UUID 不存在，表示 Gitea 已经通过用户、组织、force delete、retention 或其他物理删除路径结束对该对象的管理；Manager 上报的资源又带有当前不可变 Manager/UUID 归属字段，UUID 永不复用，因此可以返回 `cleanup_local_runtime`，无需重复保存墓碑或清理任务。记录仍存在时，只有 `status=failed` 或 binding 明确指向其他 Manager 才执行完整清理；未绑定 creating、running、stopped 和 resume/stop timeout 按当前记录继续保留资源。

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
- `cleanup_local_runtime` 要求 Manager 先持久化本地清理，再删除归属 Incus 实例、会话、凭据和本地快照；resume/stop timeout 不会把资源变成该指令的目标。
- failed inventory 只在已绑定当前 Manager、持有正版本本地操作上下文且该版本低于 active operation 时返回 refetch；版本相同时由 Manager 直接提交 final failed，无 active operation 时可以返回 transition，observed version 为 0 且 active operation 仍存在时等待原 deadline。未绑定 creating 不取得 payload 或版本。
- missing runtime 按当前主状态处理；deadline 未到期的 active create 不因启动恢复时的空 inventory 提前失败，重启不延长 deadline。
- 旧 inventory generation 不触发 extra/missing 或主状态写入。
- 同一 Manager 的并发 inventory 由 generation 条件写入确定顺序；每个 UUID 只返回一个最高优先级 action。
- 任一 UUID 处理失败时请求不携带部分结果；已经提交的条件状态写入由下一次更高 generation 的完整扫描继续收敛。
- response 与 request 的 reported UUID 一一对应；每个结果至多携带五种互斥 action 之一，metadata cache 缺失和 final ready 前置条件由对应接口处理。
- 仍绑定当前 Manager 的非 cleanup 结果携带当前有效设置；cleanup 结果不携带设置，未绑定 creating 可以同时没有设置和 action。
- Manager 在执行 action 前应用同一结果的设置；延迟设置最多影响本地计时，不能越过 RequestIdleStop 的当前值复检创建错误 stop。

所有 operation-bound RPC 都携带 `codespace_uuid` 和 `operation_rversion`，Gitea 通过 `codespace.operation_rversion`、`codespace.operation_status` 和 `codespace.manager_id` 完成校验。

[Stale Report](glossary.md#stale-report) 被识别后返回 stale 分类，codespace 主状态保持当前值。

stale report 使用分类响应而不是改写主状态，是因为 Manager 上报可能来自旧 lease、重启后的残留任务或已经被 Gitea reconciliation 接管的 operation。保持主状态不变，可以让 Gitea 数据库状态继续作为判断依据，同时给 Manager 明确 cleanup 或停止上报的信号。

### Operation 返回数据

`FetchOperations` 返回 operation envelope，并通过 `oneof command` 表达命令类型：

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `operation_rversion` | 全部 | Gitea 下发 operation 版本 |
| `codespace_uuid` | 全部 | Codespace UUID |
| `lease_valid_for_milliseconds` | 全部 | 普通命令为本次实际授予的正整数毫秒时长，通常等于标准 lease，最后一段受总执行期限截短；abort 为 0 |
| `log_offset` | 全部 | 当前 codespace 单文件日志大小，Manager 从该 byte offset 继续追加 |
| `command.create` | create | create 专属结构 |
| `command.resume/stop/delete` | 对应类型 | 不携带 repository 数据的明确命令分支 |
| `command.abort_create` | 站点排空后 deadline 未到期的 running create | 删除本轮新建的 Incus 实例并 final failed，Gitea 写入 failed |
| `command.abort_resume` | 站点排空后 deadline 未到期的 running resume | 停止本轮启动进程、保留既有 workspace 并 final failed，Gitea 写回 stopped |
| `create.repo_id` | create | base/route repository ID |
| `create.repo_full_name` | create | repository 完整名称 |
| `create.repo_name` | create | repository 名称 |
| `repo_clone_http_url` | create | Gitea 生成的规范 HTTP(S) clone URL |
| `repo_clone_ssh_url` | create | Gitea 生成的规范 SSH clone URL |
| `repo_web_url` | create | 仓库 Web URL |
| `create.owner_id/name/type/display_name` | create | repository owner 信息 |
| `create.codespace_owner_name` | create | codespace 创建用户名称 |
| `start_ref` | create | create 脚本准备 workspace 时使用的 ref 提示 |
| `ref_type` | create | `branch`/`tag`/`commit`/`pull` |
| `ref_name` | create | `branch` → 分支名；`tag` → 标签名；`commit` → commit SHA；`pull` → PR ref 路径 |
| `commit_sha` | create | 锁定 commit SHA |
| `create.repo_tag` | create | Manager 本地 Incus 模板键；只用于选择并持久化本次有效模板 |
| `create.runtime_settings` | create | 当前有效自动暂停设置和交互版本 |
| `create.git_protocol` | create | 创建时固化的 `HTTP` 或 `SSH` 首选协议 |
| `resume.runtime_settings` | resume | 当前有效自动暂停设置和交互版本 |
| `resume.git_protocol` | resume | 与 create 相同的首选协议；恢复以 workspace 实际 remote 为准 |

规则：

- command `oneof` 必须且只能设置一个分支，Manager 使用生成类型做穷尽处理。
- operation 类型由 command 分支唯一表达，envelope 不重复返回独立 `operation_type`。
- Gitea 在领取前保存 operation 来源以处理 queued idle stop 的取消；来源不改变 Manager 命令，因此不进入 envelope。
- `start_ref` 是 create 脚本用于准备 workspace 的输入提示，Manager 最终以 `commit_sha` 校验 HEAD。
- PR 场景使用 base repository clone URL 和 `refs/pull/{index}/head`，不下发 head repository clone URL。
- `resume|stop|delete` 返回数据不包含 create 专属的 repository、owner、ref 或 commit 字段。
- `resume` 完全基于已初始化 workspace 和绑定 Manager 执行，不重新解析 repository，不依赖 repository payload。
- create/resume 的 `git_protocol` 来自 `codespace.git_protocol`，站点默认值变化不会改变已有 Codespace 的首选项；create 同时返回两种 clone URL，首次尝试 SSH 前创建或确认同一公钥绑定，HTTP(S) remote 使用限定路径的 Token helper。SSH 回退到 HTTP(S) 后允许保留已经登记的公钥。
- create/resume payload 让 Manager 在 Runtime 进入 running 前保存当前设置；后续完整快照覆盖本地策略，交互版本只向前更新，RequestIdleStop 继续承担过期策略的最终复检。
- repository 删除后，本地上下文完整的 running create 通过 observed 续租继续；缺少上下文时等待原 deadline，并由 running create timeout 进入 failed。
- `delete` 返回数据使用 `codespace_uuid` 生成，不依赖 repository row。repository DB 记录删除后，Manager 仍可领取并完成 cleanup。
- Codespace delete operation 清理 Runtime 时只依赖 `codespace_uuid` 的本地确定性映射；这与直接删除 Manager 记录是两条独立流程。
- `workspace_dir` 由 Manager 本地决策和管理，`manager_base_url` 由 Manager 创建 Runtime 时注入。
- `create.repo_tag` 必须等于该 Codespace 创建时锁定并用于本次 Manager 匹配的 tag。Manager 用它选择同名 Incus 模板，再把模板有效值持久化到本地 Codespace 快照；后续配置变化不改变已有实例。
- Incus 实例名、实例类型、镜像、profile、资源、通信网卡和 Endpoint port 均由 Manager 对所选模板独立决定；Endpoint host 固定从所属 Runtime identity 的指定通信网卡解析，公开 path/query 原样转发到 upstream 根路径。
- Manager 使用 `codespace_uuid` 在本地生成或查找 Runtime Instance 的确定性映射。
- create 时 Manager 把默认 `CODESPACE_WORKSPACE_DIR` 写入共享环境，并持久化 prepare 脚本提交的最终绝对路径；resume 把本地快照中的同一路径写入共享环境，不从 repository 数据重新推导。`CODESPACE_MANAGER_BASE_URL` 来自 Manager 当前配置，`CODESPACE_RUNTIME_TOKEN` 在每次 create/resume 的 `init.sh` 成功后生成并写入 Runtime。
- Gitea 在数据库保存受固定总执行期限封顶的本次绝对 deadline；Manager 只使用 `lease_valid_for_milliseconds` 和本地单调时钟约束 worker，并通过 Fetch observed 批量取得后续授权。

实现验收点：

- ManagerService 所有命令通过统一认证、binding 和版本校验。
- Fetch、final、日志、metadata、transition、inventory 和 session revalidate 的请求响应与 RPC 文档一致。
- command rejection 携带统一 Connect failure detail，访问判定返回 decision response。
- create payload 的 `repo_tag` 等于记录创建时锁定并用于 claim 的 tag；同一 Manager 声明多个 tag 时可以据此选择唯一的本地模板。
- create/resume payload 的 `git_protocol` 等于记录创建时固化的首选值；create 同时取得两种规范 clone URL，内置 `start.sh` 在受控临时 workspace 中先使用首选地址并在 clone/fetch 失败后尝试另一地址。resume 不取得 repository payload，只按 workspace 实际 remote 恢复本地凭据配置。
- create/resume payload 的有效设置与当前数据库结果一致，Manager 重启后可恢复当前计时策略；stop 的来源不改变运行侧执行路径。
- 普通 operation payload 返回正数相对 lease 时长，abort 返回 0；Gitea 的绝对 deadline 不进入协议。

## 日志读取

`GET /-/codespaces/{uuid}/logs` 使用 byte offset 分页读取：

```text
GET /-/codespaces/{uuid}/logs?offset=<byte_offset>&limit=<max_bytes>
```

成功返回固定 JSON：

```json
{
  "offset": 0,
  "next_offset": 128,
  "eof": false,
  "lines": ["first line\n", "second line\n"],
  "truncated": true
}
```

规则：

- 默认 `offset=0`、`limit=LOG_READ_MAX_BYTES`；`limit` 的有效范围为 `1..LOG_READ_MAX_BYTES`。
- `lines` 是来自同一份已脱敏 DBFS 日志的字符串数组，保留已存物理行的换行符；文件末尾未换行的最后一行不补换行。byte offset 因此始终对应 JSON 解码后各行重新编码为 UTF-8 的原始日志字节位置。
- 服务端只返回完整 UTF-8 物理日志行；`limit` 是软字节上限，加入下一完整行会超过上限时在该行之前停止。
- 负数或非法数字的 `offset`，以及不在有效范围内的 `limit`，返回 HTTP 400 和 `invalid_argument`。非负 offset 必须是 0、文件末尾或 `log_indexes` 中的物理行起点；落在字符或行中间时返回 HTTP 409、`offset_conflict` 和该物理行起点 `current_offset`，超过文件末尾时 `current_offset` 为当前 EOF。
- 如果第一条完整物理行本身超过请求 `limit`，服务端仍单独返回该行并推进 offset，避免客户端无法分页前进；该例外一次只返回这一行，且仍受 `LOG_READ_MAX_BYTES` 约束。
- `next_offset` 是下一次轮询起点。
- `eof=false` 表示仍可继续读取。
- `truncated=true` 表示本次响应达到读取上限，客户端继续使用 `next_offset` 拉取。
- delete done 和其他物理删除路径删除 DBFS 日志；`dbfs.Remove` 返回 `fs.ErrNotExist` 时作为幂等成功，其他错误使当前本地删除事务失败。
- `failed` 状态日志保留到用户 delete，或 `reconcile_codespaces` 按 `OLDER_THAN` 到期清理。
- 日志接口只允许 Codespace 创建者访问；对象不存在和创建者权限不足沿用 Codespace 对象路由既有 404/403 语义，不由日志分页错误覆盖。

日志在 Codespace 存续期间始终保留在 DBFS，并在物理删除时一起清理。尚未产生任何日志的 Codespace 可能没有 DBFS 文件，因此删除不存在文件表示目标结果已经成立。DBFS 已满足运行中追加、页面读取和同事务日志元数据更新，不需要增加归档状态、存储类型字段或传输任务。

**设计理由：物理删除把“日志文件不存在”视为成功，而不是数据损坏。**创建后立即失败、从未被领取或内部摘要写入失败都可能合法地没有日志文件；让该情况阻断 Codespace、owner 或 Manager 删除会把诊断文件错误提升为资源生命周期前置条件。

实现验收点：

- [x] 日志读取按 byte offset 稳定分页，`next_offset` 可直接用于下一次请求。
- [x] `lines` 保留原换行符；非法参数返回 400，非行起点或超过 EOF 的 offset 返回 409 和可恢复的 `current_offset`。
- [x] 超过请求 limit 的单行可单独返回且不会造成无限重试。
- [x] delete 和 failed retention 删除整份单文件日志，不按 operation 历史截断。
- [x] 从未创建 DBFS 日志的 Codespace 仍可物理删除；缺失文件幂等成功，真实 DBFS 错误回滚当前本地删除事务。
- [ ] UI 和下载读取同一份已脱敏内容。
- [x] 组织和站点治理权限不授权日志读取；管理员只有在本人就是创建者时才能通过创建者对象路由读取自己的日志。

## Runtime 开发凭据

### Gitea Token

[Gitea Token](glossary.md#gitea-token) 使用独立的 `codespace_gitea_token` 模型，并接入 Gitea 现有 Basic、Bearer、Query Token、Git HTTP 和 LFS 认证入口。两种 Git 协议都保留该 Token，因为 Runtime 的开发 API 始终使用它；只有 HTTP 协议把它同时作为 Git smart HTTP 凭据。

设计依据：

- Gitea 的 PAT 和 Actions Task Token 都使用“末八位定位候选、带盐 hash 验证、认证后再次读取当前记录”的成熟模式。Codespace 复用这些生成和验证工具，但凭据行独立保存，因为其有效性由 Codespace 工作状态和单仓库 binding 决定。
- Actions 内部 actor 用于自动化任务，不代表发起 Codespace 的真实用户；直接复用会让 commit、Issue、Pull Request、Review 和评论失去正确的用户归属。Codespace resolver 因此返回创建用户作为真实 actor，并附带类型化 Codespace 认证上下文，让 Gitea 现有权限和业务记录保持原语义。
- 普通 PAT scope 只表达权限类别，无法表达单 repository 范围和 Codespace 工作状态。Codespace Token 先按固定权限类别进入 Gitea 现有 API scope 检查，再以 `codespace.repo_id` 限定唯一 repository；两层判定既支持创建用户当前具备的 repository 操作，也保证该凭据始终受 Codespace 和绑定仓库约束。
- repository API 已经由 Gitea 按 owner/name 形式组织在同一层级。Codespace 在该 repository group 上统一准入，后续新增到该层级的 API 自动复用同一套 scope、repo assignment、repo binding 和 handler 权限检查，避免为 Codespace 复制一份容易过期的 API 路由表。

**设计选择：项目统一认证结果与 Token 安全工具，不建立容纳全部凭据的通用认证表。**PAT、OAuth、Actions Task Token、Codespace Token、Registration Token、Manager Secret、Runtime Token、Open Code 和 SSH Key 的主体、可恢复性与吊销条件不同；强行合表会产生多态 subject、无法建立的外键和大量只对某一种凭据有意义的字段。当前只有一种 Codespace Gitea bearer credential，因此使用单一 `codespace_gitea_token` 表和每个 Codespace 一行约束，不预设 `kind` 或多 Token slot。

规则：

- Token 代表 Codespace 创建用户；`codespace_gitea_token` 行通过 `codespace_uuid` 关联当前 Codespace，不复制 `user_id`、`repo_id`、状态或权限。
- Token 固定能力覆盖 repository、Issue 和当前身份查询所需的 category scope，但固定能力不是最终授权。实际操作继续由工作状态、创建用户当前登录限制、repository binding、创建用户当前权限、repository/unit 状态、分支保护及各 handler 原有业务检查共同决定。
- 类型化认证结果向 Gitea 现有 scope middleware 提供派生的固定 category scope `write:issue,write:repository,read:user`，但该值不写入 Token 表。scope 负责进入现有 handler，owner/name repository group 和单 repository binding 继续负责 Codespace 特有限制。
- Token 格式为 `gcs_` 加 32 个安全随机字节的小写十六进制编码。专用前缀只负责选择 resolver，不参与权限判断；前缀匹配后由 Codespace resolver 独占本次凭据处理，验证失败返回未认证。
- 数据库只保存带盐 verifier、末八位和 Gitea Secret 密文。密文只供 `RequestGiteaToken` 向绑定 Manager 重新交付，认证热路径使用 verifier；Web 页面数据、日志、Runtime Metadata 和 Gateway Open Token 使用各自明确的安全字段。
- `codespace.repo_id` 是唯一 repository binding；为 0 时不匹配任何 repository。
- HTTP 协议的 Runtime 使用 Token 完成 Git smart HTTP clone、fetch 和 push；SSH 协议使用专用 Git SSH Key。IDE、CLI 和脚本在两种协议下都使用同一 Token 调用允许的 repository API。
- API 继续使用 Gitea 现有 OAuth2 与 Basic 认证入口选择候选凭据。OAuth2 入口仍按当前规则处理 `token`、`access_token`、Bearer 和 query token，Basic 入口仍按当前规则从用户名或密码选择 Token；它们选中候选值后先识别 `gcs_` 前缀并调用 Codespace resolver，非 `gcs_` 值继续交给原有 PAT、OAuth2 或 Basic 逻辑。这样能复用 Gitea 已有凭据排序和配置，不在 `auth.Group` 外建立第二套认证顺序。
- 被现有入口选中的凭据以 `gcs_` 开头时调用同一个 Codespace resolver。resolver 按末八位执行一次候选查询，每个候选行同时关联 Codespace、创建用户，并取得与 `HasTwoFactorOrWebAuthn` 等价的 TOTP/WebAuthn 配置状态；查询结果还包含判定当前初始化期所需的 operation 类型、状态和截止时间。随后在 Go 中以行内 salt 常量时间校验 verifier，并在同一授权点完成工作状态和登录限制判定。匹配成功后，把真实用户以及包含 `kind=codespace / codespace_uuid / repo_id / scope` 的请求内认证数据写入 request context。
- 凭据不存在、verifier 不匹配、记录损坏，或关联 Codespace/用户不存在时，resolver 返回类型化的“专用凭据已拒绝”错误。当前认证入口只对这个新增错误立即结束，不尝试后续 OAuth、Basic、Session、Reverse Proxy 或 SSPI；其他认证方法原有的错误继续沿用 Gitea 当前回退语义。数据库等基础设施错误按内部错误结束请求。这样只有已经被现有顺序选中的 `gcs_` 取得排他处理权，不改变非 Codespace 凭据的组合行为。
- API query token 服从 Gitea 现有 `DISABLE_QUERY_AUTH_TOKEN` 和候选优先级；配置关闭时 query 参数不会进入 Codespace resolver。Web 认证入口只处理 Authorization header，并在 Session 之前执行相同的 Bearer/Basic 识别。Git HTTP 和 LFS 的现有认证入口复用相同解析函数、resolver 和专用拒绝错误。
- API 入口使用四类请求级策略：`self`、`public_info`、`repository_group` 和 `signed_artifact`。`self` 只用于 `GET /api/v1/user`；`public_info` 只用于版本和全局 signing key；`repository_group` 挂在 owner/name 形式的 `/repos/{username}/{reponame}` group；`signed_artifact` 只用于 Actions artifact raw 签名下载。该策略由路由 group 或显式 route 写入请求上下文，repository API 使用层级策略承接后续新增路由。
- API 统一守卫紧接现有认证，位于通用登录限制、`sudo` 与其他 route middleware 之前。它使用 resolver 写入的同一认证快照校验功能开关、Codespace 工作状态、创建用户登录限制和入口策略，不再查询 Token、Codespace 或用户；`repository_group` 随后由现有 repository assignment 在解析出可见目标后比较快照中的 `repo_id`。Codespace Token 携带非空 `sudo` query 或 `Sudo` header 时返回 `unsupported_resource`；即使创建用户是站点管理员，也保持 `ctx.Doer == codespace.user_id`，不切换执行身份。
- Web Router 在 authentication entrypoint 之后、通用登录限制和 route middleware 之前安装同一权限检查。entrypoint 对 Authorization 中选中的 `gcs_` 执行上述适配器，与具体路由是否安装 `AllowBasic` 或 `AllowOAuth2` 无关；认证成功后，Git Smart HTTP 入口继续执行 repository 权限检查，其他普通 Web、下载或设置入口在处理函数前返回 403。LFS 在自身现有认证与 repository 解析入口调用同一服务判定。集中检查保证所有普通 Web 路由使用相同 Codespace Token 结果，已有 Session 也不会替代已经选中的 `gcs_` 认证结果。
- resolver 的候选查询同时返回 `is_active`、`prohibit_login`、`must_change_password` 以及是否存在 TOTP/WebAuthn 配置；站点强制 2FA 时使用同一结果完成登录限制判定。该查询完成并匹配 verifier 的时刻是本次请求的授权生效点：Token、Codespace 或创建用户不存在时返回现有 401，功能关闭、工作状态或登录限制不允许时由紧随认证的守卫返回 403。stop final、进入 failed/deleting、站点排空或登录限制变化在授权点前成立则拒绝请求，在授权点后成立则当前请求按现有 Gitea 行为完成，后续请求读取新状态并拒绝。
- 授权查询不取得 Codespace lock，也不使用成功认证 cache。生命周期事务物理删除独立 Token 行，因此并发 stop final 与查询只能形成“查询先完成并授权当前请求”或“删除先提交且凭据查询失败”两种结果；专用 `gcs_` resolver 失败后禁止回退，已经删除或损坏的 Codespace Token 不可能降级为普通 PAT。
- repository API 继续复用现有 `repoAssignment` 的 owner/repository 解析、重定向、可见性和创建用户权限逻辑。assignment 取得目标后读取 request context 中的认证快照；读级别公开 repository 按 Gitea 现有公开访问规则继续处理，需要写入、管理、私有或不可见目标时才比较 `target_repo_id == snapshot.repo_id`。repository 不存在或对当前访问方式不可见时保持现有 404，已经解析但不是公开只读且 ID 不等于 binding 时返回 403 repo binding mismatch。该顺序不复制 repository assignment，也不会在身份可见性判定前泄漏 binding 结果。
- Git HTTP 和 LFS 在各自现有认证、repository 解析及权限入口中调用同一 Codespace Token 判定。Codespace 权限检查补充工作状态、固定 scope 和单 repository 绑定；公开只读仓库继续使用 Gitea 现有公开访问规则，unit、reader/writer/admin、分支保护及业务检查继续使用 Gitea 现有实现。

**设计选择：resolver 的候选查询是本次请求唯一的授权读取时点。**该查询在业务副作用前一次取得 Token、Codespace、创建用户、仓库绑定和登录限制，并生成后续权限检查使用的请求内数据。并发状态变化只有两种确定顺序：查询先完成时当前请求按该结果继续，状态变化先提交时当前请求被拒绝。第二次读取既无法撤销已经开始的 Git、LFS 或 API 处理，也会引入同一请求内两份状态，因此后续权限检查复用首次查询结果。

**设计如此：`gcs_` 前缀只对按 Gitea 现有顺序实际选中的凭据具有排他性。**例如启用 query token 时，合法 query 凭据仍先于 Authorization header；非 `gcs_` 的失败是否继续尝试其他方法也保持 Gitea 当前语义。一旦选中的 Basic password、Bearer 或 query token 以 `gcs_` 开头，认证入口只执行 Codespace Token 校验：无效值返回 401，有效值在普通 Web 路由返回 403，在标记的开发路由继续授权，已有 Session 和其他凭据不能替代它。这个边界既防止无效 Codespace Token 降级，又不会重排普通凭据。用户被禁止登录、要求修改密码或尚未满足站点强制 2FA 时，新 Git、LFS 和 API 请求返回 `login_restricted`，现有 Token 行和 Codespace 主状态保持不变；限制解除且 Codespace 仍处于工作状态后，同一 Token 可继续使用。

Codespace Token 的 API 入口策略由 [`codespace-token-routes.yaml`](codespace-token-routes.yaml) 定义为四类：

| 策略 | 入口 |
| --- | --- |
| `self` | `GET /api/v1/user` |
| `public_info` | `GET /api/v1/version`、全局 signing key GET |
| `repository_group` | owner/name 形式的 `/api/v1/repos/{username}/{reponame}` repository API group |
| `signed_artifact` | Actions artifact raw 签名下载 |

`repository_group` 是一个层级准入点。Gitea 已经在该 group 内解析 owner、repository、权限和业务对象；Codespace Token 在进入该层级后，只补充工作状态、创建用户登录限制，以及“绑定仓库身份能力或公开只读”的判定。具体 API 能否成功继续由 Gitea 当前 scope、unit、reader/writer/admin、分支保护、repository 状态和 handler 业务检查决定。

**设计如此：owner/name repository group 下新增 API 自动复用 Codespace Token 准入。**这样后续 Gitea 增加 repository API 时，Codespace 继续使用同一个层级入口。若创建用户当前在绑定 repository 中具备 admin/owner 权限，位于该 group 下的管理 API 也按 Gitea 现有规则处理；访问非绑定仓库时，只有公开读请求可以沿用 Gitea 原有的公开访问结果。这个选择的原因是 Codespace Token 代表创建用户在单个绑定 repository 内工作，同时携带该 Token 不应取消 Gitea 已有的公开只读能力；把 repository API 再拆成一份 Codespace 专用路径表，会随着 Gitea API 演进而过期。

Codespace Token 的 API 入口只来自上表四类策略。`/repositories/{id}`、全局 Issue 搜索、Package、Notification、用户/组织/站点管理、PAT/OAuth/Key 管理、Codespace 管理和普通 Web route 不属于 owner/name repository group；除 `self`、`public_info` 和 `signed_artifact` 明确入口外，它们在副作用前返回 `unsupported_resource`。

本地 `git commit` 不访问 Gitea；Contents/Diff Patch API 创建远端 commit，普通本地 commit 通过允许的 Git push 进入 Gitea。Actions artifact metadata 与下载 URL 创建属于 repository group；raw 签名下载由 `signed_artifact` 独立授权。

- Codespace Token 判定校验当前凭据行和工作状态；绑定仓库请求校验 `target_repo_id == codespace.repo_id` 后继续执行创建用户现有 Git 或 API 权限检查。
- codespace-bound token 的身份能力范围固定为 `codespace.repo_id`；访问绑定 repository 时继续执行 Gitea 现有权限检查。非绑定 repository 只有读级别公开请求可以按 Gitea 现有公开访问规则继续处理；写入、管理、私有或不可见目标仍返回 repo binding mismatch 或保持 Gitea 现有隐藏结果。`repo_id=0` 时没有任何 repository 能通过 binding，但公开只读请求仍可按公开访问规则处理。
- `GET /api/v1/user` 只有在当前身份等于 `codespace.user_id` 时通过 `self` policy；`read:user` 不开放其他用户 API。`GET /api/v1/version` 和全局 signing key GET 只返回公共服务信息，通过 `public_info` policy。
- active create、active resume 和无 active operation 的 `running` 允许持有 Token 行；`creating -> running` 直接复用 create 阶段 Token，resume final done 复用本次 active resume 提前签发的 Token。
- 创建用户记录必须仍存在；账户删除流程物理删除关联 Codespace 及 Token 行，不保留等待补签的工作状态记录。
- 当前 Token 行完整时解密并返回同一明文，不做轮换；行不存在时才签发新 Token，损坏行先物理删除，再按当前状态决定是否签发。
- stop final、failed final 或 delete 请求进入 `deleting` 时在同一状态事务中物理删除 Token 行；物理删除 Codespace 时再次按 `codespace_uuid` 执行幂等删除，覆盖记录已提前缺失的合法情况。
- source repo 删除或创建用户失去 repo 访问权限只影响 Git HTTP(S)/SSH、LFS 和 repository API；已有 Codespace 的 open、SSH、resume、stop、delete 和 logs 继续按 Codespace 自身权限与状态判定。
- repository 删除不单独删除 Token 行；`repo_id=0` 后，现有 Token 不能授权任何绑定仓库能力，公开只读请求仍按 Gitea 现有公开访问规则处理。
- 同一 Codespace 只允许保留一个当前 Gitea Token 行。
- 轮换只由 Token 行被删除后再次请求触发；resume 在 stopped + active operation 阶段重新请求会生成新 Token，final done 后继续使用该行。
- `RequestGiteaToken` 同时返回当前 Token 和 Gitea 对外 `server_url`。Manager 将 Token 写入可原子替换的 Runtime credential 文件；HTTP 协议的 Git helper 按 Gitea host 加完整 repository path 匹配，API 客户端在两种协议下都使用同一 credential 和 `server_url`。resume 在 final done 前申请新 Token 并替换旧 credential。其他公开 repository 可按 Gitea 现有公开只读规则访问；该 Token 不提供这些仓库的写入、管理或私有读取能力。

**设计如此：Codespace Token 采用工作状态有效期。**允许的 create/resume 初始化期或稳定 running 持续使用当前 Token 行，时间经过本身不触发轮换；每个新请求仍重新检查 Token 行、工作状态、repository binding、创建用户登录限制和 Gitea 现有业务权限。stop final、resume 失败或超时、failed、deleting 和物理删除负责删除 Token 行，后续合法 resume 在行不存在时重新签发。该边界让凭据可用性与 Codespace 是否工作保持一致，也避免定时轮换引入旧新凭据重叠、Runtime 文件刷新和进行中 Git 请求协调。

**设计如此：携带 Codespace Token 不取消 Gitea 现有公开只读能力。**Codespace Token 的 binding 只授予绑定 repository 的身份能力；访问其他 repository 时，公开读可以按 Gitea 原有公开规则完成，写入、管理、私有读取和不可见目标仍不能借用创建用户身份。HTTP(S) remote 通过限定仓库路径的 credential helper 减少把该凭据发送给无关 repository；SSH Key 没有匿名公开读模型，仍由 Gitea 在命令入口限制到当前 binding。其他私有 repository 和需要跨仓库认证的 submodule 不由当前 Codespace 凭据授权。

Codespace 仓库绑定检查只约束请求直接寻址的 repository，不截断 Gitea 已经建立的 Issue、Pull Request、commit、fork 和 project 关系。直接 Issue/PR API 路由按 repository group 的同一规则处理：绑定 repository 使用 `codespace.user_id` 的身份能力；非绑定公开 repository 的读请求按 Gitea 公开访问规则处理；写入、管理、私有或不可见目标必须匹配 `codespace.repo_id`。进入业务处理后，继续执行 Gitea 现有 scope、repository/unit 权限、关系校验、站点配置和业务检查：

- Pull Request create 的 base repository 必须是 binding；head 可以是 Gitea 现有规则允许的 fork。compare、读取、Review、merge、update branch 和 merge 后删除 head branch 均沿用 Gitea 对 base/head repository 的现有权限判断。
- 绑定 repository 中的 Issue/PR 可以按 Gitea 现有规则创建跨 repository 引用、dependency/blocking，或被 commit/PR close、reopen。读取结果继续使用现有 permission filtering。
- 绑定 fork 的 `merge-upstream`、向 fork head push 后同步外部 base PR、PR update 写入外部 head、merge 后删除外部 head，以及分支删除对相关 PR 的调整，均由 Gitea 现有关系和创建用户当前权限决定。
- Issue 的 project assignment 可以指向 Gitea 现有规则允许的 repository、用户或组织 project；label、milestone 和其他直接管理对象仍必须属于绑定 repository。
- Actions dispatch 只有在 Gitea 现有 `IsScopedWorkflowSourceEffective` 判定 source 对绑定 repository owner 生效时，才可读取 scoped workflow source；生成的 Action run 始终属于绑定 repository。

这里的“直接目标”特指 API 路由解析出的 `ctx.Repo.Repository`，在 Pull Request 路由中就是 base repository。`headOwner/headRepo`、dependency 的 `owner/name/index`、project ID 等请求字段用于指定 Gitea 既有关系，不要求其 repository ID 等于 binding，而是由对应 handler 按当前用户权限验证。这个区分让外部入口保持单仓库边界，同时不破坏 Gitea 已有协作模型。

这些关联写入保持目标对象原有权限，并继续记录 `codespace.user_id` 作为执行用户。由 Gitea 关系派生的后续处理使用 `pull_service.CheckUserAllowedToUpdate`、`repo_service.DeleteBranchAfterMerge`、Issue dependency 权限检查、`IssueAssignOrRemoveProject` 和 auto-merge 处理函数的现有判断。Codespace Token 只为请求直接寻址的 repository 建立一个绑定；fork 由用户显式创建，parent repository 和临时扩权没有额外规则。

**设计选择：直接 API 路由的身份能力仍只授予绑定 repository，同时保留 Gitea 公开读能力。**例如读取其他公开 repository 的公开 Issue/PR 走原有公开规则；更新 fork PR 的 head、删除 merge 后的 fork branch、创建跨 repository Issue dependency 或由 commit 关闭关联 Issue，只有在绑定 repository 的业务流程和创建用户当前权限允许时才会成功，结果可能落在 binding 之外。这是 Gitea 已有协作关系的结果，不是 Codespace 获得了直接写入其他 repository 的能力。直接调用无关 repository 的写入或管理 API、全局搜索 Issue、私有或不可见目标，或超过创建用户当前权限的请求仍然拒绝。

scheduled auto-merge 在请求创建时经过完整 token、binding 和用户权限检查；创建成功后是 Gitea 持久业务对象。后续执行使用 Gitea 已记录的用户与现有权限规则，不再使用 Codespace token，因此 Codespace stop、failed、delete 或 token 轮换不会取消已经排期的 auto-merge。相同原则适用于已经创建的 Issue、Pull Request 和 Actions run：生命周期变化阻止新请求，但不撤销已提交给 Gitea 的业务对象。

**设计选择：Codespace token 的工作状态生命周期控制的是新请求，不是已经持久化业务对象的生命周期。**否则 stop 必须跨 Issue、PR、Actions 和队列实现补偿撤销，既偏离 Gitea 现有语义，也会使同一用户通过不同凭据创建的对象产生不同生命周期。

Git HTTP 只允许 smart protocol：`GET info/refs` 的 service 必须是 `git-upload-pack|git-receive-pack`，并允许对应 `POST git-upload-pack|git-receive-pack`。绑定 repository 可以按创建用户权限 clone、fetch 和 push；其他公开 repository 只能按 Gitea 现有公开只读规则 clone 或 fetch。dumb HTTP、`git-upload-archive`、Git wiki 和 push-to-create 不属于 Runtime 工作需要。

LFS 的 batch、object transfer、verify 和 lock route 在现有 LFS 认证与 repository 权限检查后、返回 repository 前执行 binding 校验。由 Gitea 处理的每个后续对象请求都会重新经过授权点；对象存储 `ServeDirectURL` 则是由现有存储 adapter 签发的独立短期能力，签发后绕过 Gitea，按 adapter 原有过期时间结束。

Actions artifact metadata 和下载 URL 创建属于 owner/name repository group。最初的 artifact 下载请求完整检查 Codespace Token、工作状态、repository binding、创建用户当前权限和 artifact 后，沿用 Gitea 现有两种结果：存储支持直传时重定向到对象存储签名 URL，否则生成 Gitea raw URL。

raw GET route 使用 `signed_artifact` 策略，并把现有 HMAC、expires、artifact ID 和 artifact 状态校验作为该 route 的完整认证方式。API authentication、严格登录检查、Codespace Token 守卫和普通 scope 检查看到该策略后不解析或使用 Session、PAT、Basic、query token 或 `gcs_` 凭据，直接把请求交给 raw handler。有效、失效或已经随 stop 删除的 Codespace Token header 都不改变签名校验结果。客户端跟随对象存储 302 时仍不转发 PAT，避免把 Gitea 凭据发送给对象存储，并使两类签名 URL 都可以独立使用到原定过期时间。

**设计如此：`signed_artifact` 是独立认证方式，不是无效 Codespace Token 的认证回退。**该 route 从开始就只接受签名能力，因此忽略附带的普通身份凭据；其他所有 API 仍按既定顺序选择凭据，一旦选中 `gcs_` 就保持排他处理。把签名 route 明确分流可以使严格登录配置和同源客户端 header 不改变已经签发 URL 的生命周期，也不会扩大其他 route 的匿名访问面。

**设计理由：stop final 提交 `stopped` 后，尚未通过授权点的新请求不能再签发 LFS 直传 URL 或 Actions artifact 下载 URL；已经通过授权点的请求可以完成，已经签发的短期 URL 也不会被撤销。**这些 URL 与已经传出的响应字节一样，持有者可以在固定期限内直接使用；当前 MinIO/Azure 直传沿用 5 分钟签名，其他存储 adapter 沿用自身期限，artifact raw 沿用 60 分钟签名，不增加签名记录、撤销表或生命周期回调。

Gitea Token resolver 与 Codespace Git SSH 鉴权调用同一个服务层生命周期阶段判断：功能启用，并且 Codespace 为 `running`，或存在已领取、租约未到期且与主状态匹配的 create/resume operation。该判断只回答开发凭据当前能否使用；Token 签发、仓库绑定、创建用户登录限制和 Git 命令权限继续由各自入口判断。active stop 的主状态仍为 running，因此已有 Token 和 Git SSH Key 可以完成已经开始的工作，但 `RequestGiteaToken` 不重新交付明文。共用阶段判断使 HTTP 与 SSH 两种 Git 协议在 create、resume、running、stop 和 stopped 边界得到相同结果。

公共 Codespace token 判定规则：

- 只有 `kind=codespace` 的类型化认证结果进入 Codespace Token 判定；普通 PAT、OAuth2、Actions、session、reverse proxy 和 SSH 身份保持各自现有流程。
- resolver 以一次候选查询读取 `codespace_gitea_token`、Codespace、创建用户及其 TOTP/WebAuthn 配置存在性并校验 verifier；任一记录不存在、关联不完整或 verifier 不匹配时返回现有 401。后续守卫复用该查询生成的认证快照，不按自增凭据 ID 或 UUID 再次读取。
- 认证快照必须处于开发凭据可用阶段：主状态为 `running`，或存在未过期且已经领取的 create/resume operation。create 对应 `status=creating`，resume 对应 `status=stopped`；其他组合返回 `codespace_not_running`。
- 创建用户必须满足统一登录限制；站点强制 2FA 时必须已配置 Gitea 接受的 TOTP 或 WebAuthn。该检查对 Git HTTP、LFS、repository API、`self` 和 `public_info` 策略使用同一结果。
- `[codespace] ENABLED=false` 时，Git/LFS/API 返回 `state_unavailable`，所有 `RequestGiteaToken` 请求也拒绝。专用前缀禁止回退为普通 PAT；排空不会删除稳定工作状态中的 Token 行，重新启用后仍按当前行和主状态授权新请求。
- 需要身份能力的 repository 请求要求 `target_repo_id` 与认证快照中的 `repo_id` 匹配；读级别公开 repository 请求按 Gitea 现有公开访问规则处理。
- 认证快照的 `repo_id=0` 时不存在可匹配的 target repository；写入、管理、私有或不可见目标不能通过 binding，读级别公开目标仍按公开访问规则处理。当前用户和公共服务信息 API 不带 target repository，仍按各自入口策略判定。
- 目标必须是主 repository，Git wiki 和不存在 repository 的 push-to-create 不属于 Runtime 工作需要。
- repo binding 匹配后，以认证快照中的创建用户作为 Doer，继续执行 Gitea 现有 unit、可见性、分支保护和所需 read/write/admin 业务检查；resolver 不把 Doer 改成系统用户。
- API 入口策略只挂载到当前用户、公共服务信息、owner/name repository group 和 signed artifact。repository group 先沿用 Gitea 现有 assignment 与可见性错误，再比较 binding；`self|public_info` 按各自固定目标处理，`signed_artifact` 跳过普通身份认证并由签名 handler 独立授权，其余入口返回 unsupported resource。

Codespace 权限检查补足单 repository 和工作状态范围：category scope 无法表达目标 repository，也无法表达 Codespace 是否处于可使用开发凭据的阶段。用户权限、repository/unit 状态和业务规则继续由 Gitea 现有实现负责，因此 Codespace 只维护自身特有的这两项限制。

Token 生命周期以每个新 Git/LFS/API 请求的授权点为边界。create/resume 初始化期和 `running` 都可直接使用 Token，不区分首次初始化与恢复初始化；这使 `start.sh prepare` 可以在进入最终 `running` 前完成 clone/fetch，`resume.sh prepare` 可以配置实际 remote 的本地 helper。resume failed/timeout、stop final、进入 failed 或 deleting 会在正常事务中删除 Token 行；它们在 resolver 查询前成立时通常返回 401，即使异常残留 Token 行，守卫也会按阶段返回 403。功能关闭同样由紧随认证的守卫拒绝。状态变化在 resolver 查询后成立时，当前请求使用已经生成的快照按现有 Gitea 行为结束，后续请求读取新状态并拒绝。active stop 创建时主状态仍为 `running` 且 Token 行仍存在，现有 Token 可继续使用，但该 stop worker 不能通过 `RequestGiteaToken` 重新取得明文。系统不增加进行中请求表，也不从生命周期事务取消 git subprocess。由 Gitea 处理的 LFS 后续对象传输和 API 调用是新请求；已经签发的对象存储或 artifact 短期 URL 按前述明确例外到期。

有效 Codespace Token 的 `login_restricted`、`repo_binding_mismatch`、`unsupported_resource` 和功能关闭统一返回 HTTP 403；授权点发现 Token 行已不存在时返回现有 401。repository assignment 期间的不存在、不可见和现有权限隐藏保持 404；已解析的非绑定公开仓库只允许读级别公开访问，其他非绑定目标返回 403。绑定通过后的 unit 和业务拒绝保持 Gitea 现有 403/404/409/422 等行为。API 继续使用 Gitea 现有 `{message,url}`，Git 使用 plain text，LFS 使用协议错误对象；服务端以明确错误类型记录分类并用于日志和测试，客户端继续解析 Gitea 现有响应格式。query token 在 `DISABLE_QUERY_AUTH_TOKEN=true` 时不参与认证，也不会进入仓库绑定判定。

**设计选择：Codespace Token 不显示在普通 PAT 页面，也不能通过普通 PAT API 管理。**当前凭据由 Codespace 生命周期独占管理；stop final、进入 failed/deleting 和 Codespace 物理删除在调用者已有事务中按 `codespace_uuid` 物理删除 Token 行。这样普通 PAT 的模型、列表和删除行为保持不变，也不存在用户从 PAT 页面删除运行凭据后留下半个 binding 的状态。

Codespace 创建者详情页只展示当前 Token 是否存在、`created_unix` 和末八位，用于判断 Runtime 是否已取得当前凭据；不返回 `token_hash`、`token_salt`、`token_encrypted` 或明文。展示使用现有 Token 行即可完成，不增加状态、审计或历史字段。组织和站点治理列表不返回这些 Token 展示字段。

实现验收点：

- Codespace Token 在有效 create/resume 初始化期和 `running` 都能使用；凭据行、创建用户登录限制、入口策略、主 repo binding 和创建用户当前权限仍须全部通过。Git SSH 使用后续专用 Key 判定。
- Token resolver 与 Git SSH 鉴权复用同一个开发凭据生命周期阶段判断；active stop 允许使用现有凭据但不允许重新交付 Token，稳定 stopped 的两类新请求均拒绝。
- Basic、Bearer 和 Gitea 当前启用的 query token 都能识别 `gcs_`；现有认证入口对选中的非 `gcs_` 凭据继续走原有 PAT、OAuth2 或 Basic 逻辑，query 关闭时忽略 query 参数，因此 OAuth2、Actions、普通 PAT、session、reverse proxy、SSPI 和 SSH 身份继续使用原有流程。
- API 测试覆盖四类入口策略：`GET /api/v1/user`、版本和全局 signing key、owner/name repository group、signed artifact。repository group 下的普通 route、混合 method 和 `RouterPathGroup` matcher 都能读取同一 group 策略；不属于该 group 的 API 在副作用前稳定拒绝。
- `codespace-token-routes.yaml` 只保存入口策略，不保存完整 Gitea API 路由表。测试确认 owner/name repository group 的代表性读写、PathGroup、Issue/PR、Actions 和管理 API 都经过同一 repo binding 与 Gitea 现有权限检查；新增到该 group 下的 API 不需要修改 YAML。
- resolver 使用一次候选查询读取 Token、Codespace、创建用户和 2FA 配置状态并生成认证快照，不取得 Codespace lock，也不执行第二次授权查询；并发 stop final 在授权点前提交时返回 401，站点排空或登录限制在授权点前成立时返回 403，在授权点后成立时当前请求完成且后续请求拒绝。
- `gcs_` resolver 失败后返回终止式 `rejected`；Token 行缺失、损坏、关联记录缺失或 verifier 不匹配时不会进入普通密码、PAT、OAuth、Actions、Session、Reverse Proxy 或 SSPI 认证。
- 有效 `gcs_` 出现在未安装 `AllowBasic`/`AllowOAuth2` 的普通 Web 路由时仍由凭据分派函数识别，并由 Web 默认权限检查返回 403；无效 `gcs_` 返回 401，已有 Session 不改变两种结果。
- Git smart HTTP clone/fetch/push、LFS，以及 owner/name repository group 下的 Contents/Diff Patch commit、branch/tag/status、Issue、Pull Request/Review/merge、Release、Wiki、Actions 和 repository 管理 API 分别覆盖成功与现有权限拒绝。
- `/repositories/{id}`、全局 Issue 搜索、Package、Notification、PAT/OAuth/Key、用户/组织/站点管理、Codespace 管理和普通 Web route 均返回 403。
- `repo_id=0` 时仍可签发 token；没有任何 repository Git/LFS/API 能通过 binding，公开只读请求按 Gitea 现有公开访问规则处理，写入、管理、私有或不可见目标不能通过。创建用户通过登录限制且对应入口策略允许时，`GET /api/v1/user`、version 和全局 signing key GET 仍可成功。
- 功能关闭时，认证入口仍把 `gcs_` 交给专用 resolver，并在工作状态检查处返回 403；普通 PAT 认证不处理该前缀。Token 吊销对后续新请求生效，已经通过授权读取时点的 Git、LFS 或 API 请求按 Gitea 现有请求生命周期完成。
- `creating -> running` 和 active resume 到 `running` 复用当前 Token；resume failed/timeout、stop final、进入 failed/deleting 在状态事务中物理删除 Token 行，后续 resume 重新签发。
- 普通 PAT 页面和 API 不显示或管理 Codespace Token，普通 PAT 的创建、列表、删除和 scope 行为保持不变；Codespace Token 自身访问 Token 管理 API 稳定返回 403。
- Codespace 创建者详情只展示当前 Token 的存在性、创建时间和末八位；治理列表不返回 Token 展示字段，任何页面和普通响应均不返回 verifier、salt、密文或明文。
- 每个 Codespace 最多一条 Token 行；数据库不保存明文，`RequestGiteaToken` 返回的解密结果必须通过 verifier。
- Codespace Token 的固定 category scope 由认证类型派生，数据库不保存 scope；现有 scope middleware、入口策略和后续业务权限检查均被执行。
- 创建用户的 active、prohibit-login、must-change-password 和站点强制 2FA 结果在 Git、LFS、API、self 与 public-info 策略上一致；登录限制成立时 Token 行和 Codespace 主状态保持不变，新请求返回 403，限制解除后同一工作态 Token 可以继续使用。
- 携带 Codespace Token 的其他公开 repository Git/API 读请求按 Gitea 现有公开访问规则处理；写入、管理、私有或不可见目标保持拒绝。HTTP helper 不向无关 repository 发送该 Token，Git SSH Key 不能通过其他 repository binding。
- 直接 Issue/PR API 路由遵循 repository group 规则：绑定 repository 使用创建用户身份能力；非绑定公开 repository 的读请求按 Gitea 公开访问规则处理；写入、管理、私有或不可见目标不能通过。绑定 repository 已建立的 Gitea 关系中，fork PR update/merge/head branch 删除、跨 repository dependency、cross-reference、commit/PR close/reopen 和 project assignment 按创建用户当前权限成功或返回 Gitea 原有拒绝。
- 对允许的 API 路由使用同一用户、同一对象分别执行普通 PAT 与 Codespace token 的差异测试；绑定和工作状态通过后，两者得到相同的 Gitea 业务权限结果，Issue/PR 角色判断只使用 Gitea 现有实现。
- scheduled auto-merge 创建和取消在请求时校验 token、binding 与当前权限；创建成功后，Codespace stop、failed、delete 或 token 轮换不会取消该业务对象，后续执行沿用 Gitea 现有用户和权限语义。
- 工作状态可通过 `repository_group` 取得 artifact 下载 URL，启用严格登录检查时无 PAT 的有效 raw 签名仍可下载。`signed_artifact` route 不解析 Session、PAT、Basic、query token 或 `gcs_`，有效、失效和已删除 Token header 不改变签名结果；stop final 提交后尚未通过最初授权点的请求不能签发新 URL，已经签发的 artifact 或对象存储 URL 使用到原过期时间。
- 新增到 owner/name repository group 下的 API 自动继承 Codespace Token 的入口准入、repo binding 和 Gitea 现有权限检查；新增到其他 API 层级的 route 需要明确选择 `self`、`public_info` 或 `signed_artifact` 才能接受 Codespace Token。
- 账户分阶段清理完成后，当时仍由创建者、repository owner 或 Manager owner 关联的 Codespace Token 和 Codespace 记录均不存在；中途失败保留 owner，重试只处理剩余项。

### Codespace Git SSH Key

[Codespace Git SSH Key](glossary.md#codespace-git-ssh-key) 由 Runtime 的 `start.sh` 在首次实际尝试 SSH clone 前生成，SSH remote 的 `resume.sh` 校验并复用，Gitea 只保存公钥。`PublicKey.Type=KeyTypeCodespace` 使 Gitea 内置 SSH 和外部 `authorized_keys` 继续使用现有 `serv key-{id}` 强制命令；`serv` 读取 key ID 后，通过 `codespace_ssh_key` 进入 Codespace 专用鉴权，而不是普通用户 Key 或 Deploy Key 分支。

`cmd/serv` 与 private serv handler 在读取 `PublicKey` 后使用穷尽 `switch` 按类型分流。`KeyTypeCodespace` 调用 Codespace 专用服务并返回现有 `ServCommandResults` 所需的 repository、创建用户和 `DeployKeyID=0`；后续 Git subprocess、LFS token 和 hook 环境继续走 Gitea 当前执行路径。`KeyTypeUser`、`KeyTypeDeploy` 和允许进入相应入口的 Principal 保持各自现有服务，未知类型在启动 Git 子进程前返回硬错误。客户端没有提交 Git 命令时，`KeyTypeCodespace` 只返回标准的无 Shell 提示，不进入普通用户 Key 的账户介绍分支。

每个新的 Git SSH 命令按以下规则授权：

- key ID 必须对应完整的 `codespace_ssh_key + codespace + 创建用户` 关系，且 `[codespace] ENABLED=true`。
- Key 关系完整时，有效 create/resume 初始化期和 `running` 都允许当前 Key，包括 queued/running stop 提交完成前仍处于 running 的阶段。稳定 `stopped` 保留 Key，但新 Git SSH 命令在下一次 resume 被领取前拒绝。
- SSH 请求解析出的 repository ID 必须等于当前 `codespace.repo_id`。`repo_id=0`、其他 repository、Git wiki 和 SSH push-to-create 都不能形成有效目标。
- 创建用户在授权点满足当前登录限制，目标 repository 的 code unit 可用，并具有本次 upload-pack、receive-pack 或 LFS 操作所需的当前权限。
- `git-upload-pack` 和 `git-receive-pack` 进入 Gitea 现有读取、写入和保护分支检查；`git-upload-archive` 不属于 Runtime 工作需要。
- 鉴权结果把创建用户写入现有 SSH 命令和 hook 上下文，`DeployKeyID=0`。提交归属、审计、保护分支和业务权限因此与该用户使用普通账户 SSH Key 的结果一致，但 Key 的仓库范围仍由 Codespace binding 限制。
- `git-lfs-authenticate` 和已启用的纯 SSH LFS 复用同一 Codespace Key 判定；后续 HTTP 对象传输继续使用 Gitea 现有短期 LFS 授权和存储规则。

普通用户 Key 会把凭据范围扩大到创建用户可以访问的全部仓库，Deploy Key 则会使用仓库部署身份和专用保护分支规则，因此两者都不能表达本设计。**设计如此：Codespace Key 在鉴权成功后使用创建者业务身份，但仍是一把只绑定单个 Codespace 当前仓库的运行环境凭据。**

一次 SSH 命令的授权读取是该命令的生效点。stop、failed、delete、用户限制或权限变化在授权前提交时拒绝命令；授权已经完成时，本次 Git subprocess 按 Gitea 现有行为执行结束，后续连接重新读取当前状态。该边界与 Git HTTP 请求一致，不增加进行中命令表或跨进程强制终止机制。

Codespace Key 在首次 create 时生成并在后续 resume 中复用。stop final、resume failed/timeout/abort 和稳定 `stopped` 保留 `codespace_ssh_key` 与对应 `PublicKey`，授权服务通过阶段判断使它不可用；进入 failed/deleting 和 Codespace 物理删除才删除两行。repository 删除只把 `repo_id` 写为 0，后续命令立即没有可匹配仓库。用户或组织、Manager、force delete 和 failed retention 的物理删除 helper 都复用同一凭据清理函数，保证删除完成后不留下可用 key ID。

**设计如此：Key 是否存在与 Key 当前是否可用是两个独立事实。**保留 Key 让恢复使用 Runtime 中已有私钥，不需要为每次 resume 设计密钥轮换、旧版本登记或私钥分发；每条 SSH 命令仍实时检查 create/resume 初始化阶段或 `running`，所以稳定 stopped 不会获得仓库访问能力。

Codespace Key 不进入普通用户 Key、Deploy Key、公开用户 Key 导出、签名 Key 的列表、数量限制和管理 API。具体入口使用 [PublicKey 类型矩阵](data-model.md#codespace_ssh_key) 正向选择类型：普通用户 Key 的读取、编辑、验证和按 ID 删除服务只接受 `KeyTypeUser`，Deploy Key 服务只接受 `KeyTypeDeploy`，不能用排除 Principal 的条件代替。即使调用者知道 Codespace key ID，也会在修改数据库前得到资源不存在。创建者详情只展示“Git SSH 凭据是否就绪”和当前登记时间，不展示公钥正文或指纹；治理列表仍不返回凭据细节。该信息用于判断 init 是否完成，运行凭据统一由 Codespace 生命周期管理。

**设计如此：`KeyTypeCodespace` 保留独立类型，并同步修正所有旧枚举假设。**单独建一套公钥表和强制命令编号会重复 Gitea 的指纹、authorized_keys 和 Git SSH 执行路径；复用 `PublicKey` 更直接，但前提是普通入口都正向声明自己接受的类型，任何未知类型默认拒绝。

实现验收点：

- 同一 Runtime Key 只能访问当前 Codespace 的 `repo_id`，访问其他公开或私有仓库均在启动 Git subprocess 前拒绝。
- Git SSH 以 `codespace.user_id` 作为真实用户并保持 `DeployKeyID=0`；代码读取、写入、保护分支和 hook 结果与该用户当前权限一致。
- 有效 create/resume 初始化期和 running 接受当前 Key；稳定 stopped 保留但禁用 Key，进入 failed/deleting 后删除 Key，新连接立即失败。
- Git wiki、upload-archive 和 push-to-create 不进入允许面；upload-pack、receive-pack 和 LFS 覆盖正常成功与当前权限拒绝。
- repository 删除后 `repo_id=0` 使任何 Git SSH 仓库匹配失败，但不改变 Codespace 的 open、resume、stop、delete 和 logs。
- 普通用户 Key、Deploy Key、公开用户 Key 导出、签名 Key 页面和 API 使用正向类型条件，不返回或管理 `KeyTypeCodespace`；Codespace 创建者详情只展示就绪状态和时间。
- `cmd/serv` 和 private serv handler 对 `KeyTypeCodespace` 使用专用鉴权并保持 `DeployKeyID=0`；无 Git 命令时只返回无 Shell 结果，普通用户 Key 的按 ID 管理接口无法修改该类型。
- User、Deploy、Principal、Codespace 和未知值的全部 `serv` 分支都有测试；未知类型在启动 Git subprocess 前硬错误，不能按普通用户处理。
- 进入 failed/deleting、全部物理删除入口和 failed retention 清理关系与 PublicKey；stop 和可恢复的 resume 失败保留关系但由状态拒绝使用。外部授权文件残留的无数据库 key ID 不能通过强制命令。
- 授权点之后已经开始的单次命令可以结束，状态或权限变化后的下一条命令读取新结果。

### Gateway Open Token

[Gateway Open Token](glossary.md#gateway-open-token) 采用 OAuth2 Authorization Code Grant 模式实现：

- Gitea 作为 Authorization Server，在用户请求 open 时签发 authorization code。
- Gateway 作为 Client，以 Manager 身份认证后提交 code 换取 open binding。
- 与 Gitea 现有 `OAuth2AuthorizationCode` 模型（`models/auth/oauth2.go`，`gta_` 前缀，10 分钟有效期）模式一致：code 为 opaque 随机值，单次使用，短期有效。差异仅在于编码方式（hex vs base32）、有效期（60s vs 10min）和存储介质（cache vs DB）。

Authorization code 属性：

- 短期有效（默认 60s）
- 一次性使用（消费后从 cache 删除）
- opaque，非 JWT
- 绑定 `user_id / codespace_uuid / endpoint_id / manager_id`

GET 打开路由使用 Gitea 现有登录中间件并只显示确认页。它读取当前 Codespace、Manager 和 metadata 生成服务端目标信息，但不写 cache、生命周期、交互版本或活跃时间。用户确认后由同路径 POST 执行动作；因此登录跳转和页面预取都不会签发 code，POST 继续使用 Gitea 现有 CSRF 防护。

`POST /-/codespaces/{uuid}/open` 在签发前固定选择 `endpoint_id=workspace`；显式 Endpoint 路由使用 path 中匹配 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$` 的 ID，并拒绝保留值 `workspace`。两种需要认证的入口都要求当前 metadata ready，普通 Endpoint 还需要存在且 `public=false`，`workspace` 不要求同名 Endpoint；active operation 只能为空或是本事务将取消的 queued idle stop。Gitea 在 Codespace lock 内读取当前 binding 和绑定 Manager 最近一次成功 Declare 的 `gateway_url`，把 `manager_id` 写入 code binding，并用该当前地址构造 303 的目标 origin。随后写入 code、推进 `interaction_generation` 并取消 queued idle stop；交互事务失败时尽力删除刚写入的 code 并返回失败。只有 cache 与交互事务都成功才返回带 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer` 的重定向，提交后尽力更新仅供展示的 `last_active_unix`。Manager 用 `endpoint_id=workspace` 在 Runtime workspace 与内置 Web SSH 之间解析当前实际目标。

普通 Endpoint 当前为 `public=true` 时，GET 确认页显示公共标记和服务端派生的直接 URL；无 active operation 时页面使用普通链接。若客户端仍向同一路径 POST，Gitea 按 `ValidatePublicEndpoint` 的相同状态条件复检，通过后直接 303 到该 URL，不写 Open Code，也不推进交互版本。queued idle stop 和其他 active operation 不通过该分支，公共请求不会取消 stop。**设计如此：公共请求不是创建者交互。**该分支与 Gateway 的公共访问计数一致，不会仅因匿名访问延后自动暂停。

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
| Cache TTL | `OPEN_TOKEN_EXPIRE`（60s） | cache 自动淘汰 | 主力过期，自动清理 |
| 显式校验 | `expires_unix` 比对 | `ValidateOpenToken` 中显式判断 | 防御纵深，消除 TTL 淘汰延迟窗口 |

两层机制确保即使在 cache TTL 淘汰延迟（秒级）的时间窗口内，`expires_unix` 显式比对也能拒绝已过期的 code。

Cache 结构：

```text
key = codespace:open-code:{code_hash}
value = required JSON fields: user_id, codespace_uuid, endpoint_id, manager_id, issued_unix, expires_unix
ttl = OPEN_TOKEN_EXPIRE
```

Codespace 通过 `modules/cache.GetCache()` 使用站点现有 cache adapter。memory/twoqueue 重启后可以丢失这些 key，Redis/memcache 可在 TTL 内保留；保留的 Open Code 仍必须执行下面的全部实时校验。

规则：

- code 明文只出现在 no-store/no-referrer 的 `303 Location` query string 中，不落数据库和日志。
- code 签发和消费使用 `globallock.Lock(ctx, "codespace_" + canonicalUUID)` 与生命周期写入串行化。签发在 code 写入和交互事务都成功后才返回重定向。Codespace 停止或删除后，已签发 code 即使在短 TTL 内仍存在，也会在消费时因数据库主状态或记录复检失败而拒绝，因此无需为短期缓存维护反向索引。
- code 使用 `CryptoRandomBytes(32)` 生成，256 位熵值使得 hash 冲突概率可忽略，不需要冲突重试逻辑。

校验步骤（code 交换，映射 OAuth2 Token Endpoint）：

1. 计算 `code_hash = sha256(submitted_code)`。
2. 以 `code_hash` 查询并解析 cache，读取 binding 中的 `codespace_uuid`；Gitea cache API 会把后端读取错误表现为 miss，因此 miss 直接按无效凭据拒绝，无法解析时记录服务端日志、尽力删除后拒绝。
3. 取得 `codespace_{uuid}` global lock，并在锁内重新读取同一 code；等待锁期间 code 已消失或 binding 变化时返回失败。
4. 显式校验 `now < expires_unix`；已经过期时尽力删除 code 后拒绝（防御 TTL 淘汰延迟）。
5. 校验 Codespace 功能启用；关闭时返回 `state_unavailable` 并保留 code 到原 TTL。
6. 校验调用方 Manager 身份等于 `manager_id`（代替 OAuth2 标准的 client 认证）。
7. 重新读取 codespace，校验当前为 `running`。
8. 校验用户仍具备 Interactive Access。
9. 校验 Runtime Metadata 仍为 ready；普通 ID 还必须存在于当前 metadata 且 `public=false`，`workspace` 不要求 endpoints 数组存在同名项。
10. 校验 Manager 仍在线。
11. 全部校验通过后删除 code；删除失败时返回内部错误，不返回 binding。
12. checked increment `interaction_generation`，取消 queued idle stop，并读取提交后的版本；版本无法递增时返回 `version_exhausted`，其他事务失败时返回对应错误，两种结果都不返回 binding。code 已经消费，用户从 Gitea 重新发起 open。
13. 尽力更新 `last_active_unix=now`；更新失败记录日志并仍返回 binding。

步骤 3-10 是运行时安全检查，在 code 签发到验证之间的时间窗口内状态可能已变化。缓存值无法解析或 code 已经过期时已经没有后续成功可能，因此尽力删除；功能关闭、Manager 不匹配、Codespace 暂时查无记录、生命周期状态、用户权限、metadata、Endpoint 或 Manager 在线状态不满足时拒绝本次交换并保留 code，由原 TTL 决定最终失效。全部实时检查通过后必须先成功删除 code，再提交交互事务并返回 binding；删除失败返回内部错误，交互事务随后失败或交互版本耗尽时 code 已消费，用户从 Gitea 重新发起 open。这个顺序同时保证暂时条件失败可重试和成功 binding 的一次性语义。

成功返回：

```text
user_id
codespace_uuid
endpoint_id
interaction_generation
```

Cache miss 时 code 失效，用户重新从 Gitea 发起 open；Redis/memcache 在 TTL 内保留的 code 可以继续交换，但仍执行全部实时校验。codespace 生命周期状态不受 cache 影响。

Gateway 只以 GET 交换恰好一个 code，要求请求 Host 与返回 binding 派生的 host 一致，再创建服务端 session。HTTPS 使用 Secure、不带 Domain、`Path=/`、`HttpOnly/SameSite=Lax` 的 `__Host-gitea_codespace_session`，HTTP 使用对应无前缀名称；多个 Cookie 候选只有恰好一个本地有效 session 匹配当前 Host 与完整 binding 时才成立。Gateway 若持有同 Host 的合法短期恢复路径则 303 回到该路径，否则 303 到 `/`；两种响应都清除恢复 Cookie。带 code 的请求不代理到目标，响应设置 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。Gateway 重启后本地 session 失效，用户直接打开私有 URL 时由 Declare 返回的 `gitea_web_url` 进入 Gitea GET 确认页，也可以从 Gitea 详情页重新打开。

实现验收点：

- Codespace Gitea Token、Gateway open code 和 Manager 凭据使用各自独立的数据模型、生命周期与校验入口。
- open code 单次消费、60 秒过期，并在消费时重新检查当前访问条件。
- code 写入和交互事务全部成功后才签发；缓存值无法解析和显式过期的 code 尽力删除，实时访问条件不满足时保留到原 TTL，成功校验但 code 删除失败时不返回 binding。
- code 成功签发和消费都会推进交互版本并取消 queued idle stop；消费 binding 返回最新版本，Manager 据此重置完整空闲计时。
- code 成功消费后的 `last_active_unix` 更新失败不恢复 code，也不拒绝已经成立的 binding。
- 默认 open 始终签发 `endpoint_id=workspace`；没有 Runtime 同名 Endpoint 时，Gitea 校验仍可通过并由 Manager 使用内置 Web SSH。
- GET 打开路由完成登录和只读确认，POST 才可能签发 code；公共 Endpoint 的 GET 显示直接 URL，POST 只重定向且不生成 code 或用户交互。
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

任务沿用 Gitea 现有 Cron 注册和 `cron_task:reconcile_codespaces` 全局任务锁，不增加调度器或专用任务锁。三个阶段分别使用 100 条固定批次和稳定 keyset：queued 按 `operation_created_unix, uuid`，running 按 `operation_deadline_unix, uuid`，failed 按 `updated_unix, uuid`。每个 Codespace 候选单独取得 Codespace lock 并在短事务中处理。单条业务或数据错误记录服务端日志后继续当前批次，keyset 越过该项并在下一轮重试。某个阶段发生候选查询、数据库连接或事务基础设施错误时结束该阶段并继续其他阶段，任务最后汇总返回错误，使 Cron 状态能够显示本轮失败且一个阶段不会长期阻塞其他阶段。任务响应进程关闭 context，处理完当前短事务后停止。

failed 到期阶段直接执行 Gitea 本地物理删除：取得 Codespace lock 后在本地事务中删除 Codespace Token、Git SSH Key、单文件日志和数据库记录，提交并释放 lock 后尽力清理对应 cache；cache 清理失败只记录服务端日志，不改变删除结果。该阶段不创建 delete operation，不联系 Manager，也不读取 Manager runtime state。failed 已经是不可恢复终态，保留期只用于给用户读取日志和手动 delete；到期后继续等待运行侧确认不会增加 Gitea 数据安全性，反而会让终态记录无限保留。原 Manager 身份仍有效时，下一次成功的完整 inventory 按无数据库记录返回 `cleanup_local_runtime`。

Token 由 `RequestGiteaToken` 创建或修复，Git SSH Key 由 active create/resume 登记；stop final、resume 失败/超时、failed、deleting 和物理删除事务同步删除对应凭据。事务提交或回滚时，主状态与凭据结果保持一致，认证还会检查 Codespace 主状态。周期任务不会扫描或修复开发凭据，只在 operation 超时和 failed 物理删除的既有事务中得到规定的凭据结果。

实现验收点：

- `reconcile_codespaces` 只处理数据库可判断的 queued/running operation 超时和 failed 到期清理，不读取 inventory 快照，也不扫描或改写 Manager 状态。
- 自动暂停由 Manager 的实时连接与单调计时触发，并通过 RequestIdleStop 进入 stop operation；Cron 不从 `last_active_unix` 推算空闲。
- `OLDER_THAN` 必须是正数时长；默认 `8760h`，非正数使服务启动配置校验失败，到期判断使用进入 failed 时稳定写入的 `updated_unix`。
- `ENABLED`、`RUN_AT_START` 和 `SCHEDULE` 统一控制三个阶段；启动执行会处理全部当时已经到期的 operation 和 failed 记录。
- failed 到期阶段在本地事务中清理 Codespace 记录、Token、Git SSH Key 和对应单文件日志，提交后先释放 Codespace lock 再清理 cache；cache 清理失败不恢复记录或权限。
- failed 到期清理不创建 operation 或等待远端确认；原 Manager 后续通过成功的完整 inventory 取得 cleanup。
- Codespace Token、Git SSH Key 和 registration token 都不参与周期修复；前两类开发凭据随 Codespace 生命周期事务维护，registration token 随 owner scope 删除直接物理删除。
- 系统不存在按 operation 历史清理日志的 cron 任务。
- 三个阶段使用各自的 100 条 keyset 批次和单 Codespace 短事务；单条失败不阻塞同批后续记录，阶段级错误不阻塞其他阶段并使本轮任务返回失败。

## 配置

Gitea：

```ini
[codespace]
ENABLED = true
GIT_PROTOCOL = http
GIT_SSH_KNOWN_HOSTS =
CONTROL_PLANE_TIMEOUT = 30s
CONTROL_PLANE_MAX_MESSAGE_SIZE = 8MiB
GATEWAY_REQUIRE_HTTPS = false
MANAGER_OFFLINE_TIMEOUT = 120s
OPERATION_LEASE_TIMEOUT = 300s
OPERATION_MAX_DURATION = 2h
QUEUE_TIMEOUT = 5m
OPEN_TOKEN_EXPIRE = 60s
LOG_MAX_LINE_SIZE = 64KiB
LOG_READ_MAX_BYTES = 512KiB
LOG_MAX_SIZE = 64MiB
LOG_FINAL_SUMMARY_RESERVE = 64KiB
RUNTIME_METADATA_MAX_SIZE = 256KiB
CODESPACE_REPO_CONFIG_MAX_SIZE = 64KiB
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

- `GIT_PROTOCOL=http|ssh` 是新建 Codespace 的首次 clone 首选协议，默认 `http`。创建记录把当时的值固化到 `codespace.git_protocol`；之后修改配置只影响新记录。create payload 始终提供 Gitea 规范 HTTP(S) 和 SSH URL，所选 `start.sh` 可以据此选择实际 remote；内置脚本先使用首选 URL，clone/fetch 非零退出时用另一 URL 重试一次，并把成功 URL 固定为 workspace remote。resume 以实际 remote 为准，不重新选择。
- 启用功能时，全部 setting 和数据库迁移完成后、Codespace Web route、Cron 和 ManagerService 注册前执行首选 Git 协议校验。`GIT_PROTOCOL=http` 要求 `[repository] DISABLE_HTTP_GIT=false`；`GIT_PROTOCOL=ssh` 要求 `[server] DISABLE_SSH=false` 且能够取得可信 Host Key。默认安装使用 HTTP 首选协议，因此未配置外部 SSH known_hosts 不会阻止 Gitea 启动；管理员明确选择 SSH 首选协议时，错误列出不可用协议和相关配置。create payload 仍提供 Gitea 规范 HTTP(S) 和 SSH URL，脚本可以自行选择或回退，但只有首选协议在 Gitea 启动阶段作硬校验。排空模式仍可关闭任一 Git 入口并继续 stop、delete 和管理清理。
- `[server] START_SSH_SERVER=true` 表示使用 Gitea 内置 SSH。`GIT_SSH_KNOWN_HOSTS` 为空时，启动顺序先调用内置 SSH 已有的 Host Key 准备逻辑：读取存在的 `SSH_SERVER_HOST_KEYS`，全部不存在时在既有目录生成默认 Key；随后从实际启用的私钥派生公开 Host Key，并按 `SSH_DOMAIN` 和有效 `SSH_PORT` 构造规范 known_hosts 行。Codespace 校验和内置 SSH 服务使用同一组准备结果，首次启动不会因 Key 尚未生成而误报配置错误。
- `[server] START_SSH_SERVER=false` 表示 SSH 接入由外部服务提供，此时 `GIT_SSH_KNOWN_HOSTS` 必须显式配置一个或多个逗号分隔的规范行。每行的 host pattern 必须精确匹配默认端口的 host 或非默认端口的 `[host]:port`，公钥必须通过 Gitea SSH parser。内置 SSH 也可以显式配置该项，以便在 Host Key 轮换期间同时下发多把可信 Key。
- 全部 setting 和数据库迁移完成后，Gitea 在注册 Codespace Web route、ManagerService 和 session 中间件前扫描现有 `codespace_manager_address(kind=gateway)`。每个基础域名都执行与 Declare 相同的 ASCII DNS、最长派生 Host、可注册域、Gitea host/wildcard 和 `[session].DOMAIN` 检查；任一冲突以包含 Manager ID、地址和冲突配置项的 `gateway_cookie_scope_conflict` 阻止启动。这样修改 `ROOT_URL` 或 Cookie Domain 不能让已有 Gateway 用户内容重新进入 Gitea 登录站点。
- SSH Host Key 轮换先在配置和 SSH 服务中同时保留旧、新 Key，现有 Codespace 通过后续 stop/resume 取得完整集合；全部实例刷新后再移除旧 Key。未按该顺序更换时，现有 Runtime 的严格校验会明确失败，并通过 stop/resume 重新取得当前集合。这里使用已有恢复流程处理低频运维事件，不增加运行中的 Host Key 推送服务。
- `ENABLED=false` 使用排空模式并跳过 Git 传输能力校验。stop、delete、inventory 收敛、failed retention 和管理清理都不依赖 Git HTTP 或 SSH；管理员可以在仓库接入不可用时启动 Gitea 完成缩减和清理，再恢复两种 Git 接入后重新启用。
- Codespace 功能只支持一个活动 Gitea 进程；cache 直接复用 `[cache]` adapter，需要 keyed serialization 的明确写路径直接调用 `[global_lock]` backend 提供的 `globallock.Lock`，Cron 沿用 Gitea 单实例调度。Redis 配置不改变 Codespace 的单进程支持边界。
- `ENABLED=false` 使用排空模式，不删除现有 Codespace/Manager 数据。Web 禁止新 create、resume、open、继续运行和 SSH，但创建者详情、创建者日志、创建者自动暂停设置、stop、普通 delete、站点管理员 force delete 与现有管理页继续可用；`ValidateOpenToken`、`ValidatePublicEndpoint`、`VerifySSHPublicKey` 和 `RevalidateGatewaySession` 都返回 `state_unavailable`。认证和公共普通 HTTP 在下一次请求且最迟已有 allowed 的 1 秒期限结束后拒绝，WebSocket 和 SSH 最迟在一个复检周期内关闭。
- 排空模式拒绝 `RegisterManager`、全部 `RequestGiteaToken`、`EnsureCodespaceGitSSHKey`、新的 idle stop 创建和 Runtime Metadata 写入。`RequestIdleStop` 对已经存在的 idle stop 仍返回 `pending`，对没有 active operation 的 running 对象返回包含 `auto_stop_enabled=false` 的 `observation_changed`；ReportInstances 下发相同关闭设置，使 Manager 清除普通计时。已有 Manager 仍使用注册时签发的 secret 认证，可以 Declare、ReportInstances、上报 stopped/failed transition，并通过 Fetch 领取 stop/delete 或取得已领取 create/resume 的 abort；对应 UpdateLog 和 final failed 继续可用。stop 从本地 Runtime credential 文件恢复日志脱敏值，无法确认安全的缓冲日志不上传。queued create/resume 不再领取，按现有 queue timeout 处理。
- 排空模式继续运行 `reconcile_codespaces`。Codespace Token resolver 和 repo binding 判定不受 `ENABLED` 开关影响，仍会识别并拒绝已有凭据；普通 PAT 行为不需要 Codespace 特判。重新启用后，未进入 stopped/failed/deleting 的现有对象继续按当前状态工作。
- `OPEN_TOKEN_EXPIRE` 同时作为 [Gateway Open Token](glossary.md#gateway-open-token) 的 Gitea cache TTL 和 `expires_unix` 计算时长，因此以正整数秒表示。
- Runtime Metadata 与 Open Code 直接保存在站点 `[cache]` adapter，并使用各自明确 TTL；即使通用 `[cache] ITEM_TTL=-1`，协议条目仍按自身 TTL 写入。需要串行化的写路径直接使用站点 `[global_lock]` backend。
- `CONTROL_PLANE_TIMEOUT` 从 Connect 应用 handler/interceptor 接管已经受大小限制并完成 framing 的请求开始，到响应提交为止，覆盖认证、`globallock` 等待、数据库、cache 和响应构造。HTTP 请求体读取和网络传输继续使用 Gitea 现有 HTTP server timeout；该配置不替代通用读写超时。该 deadline 到期返回 Connect `DeadlineExceeded`，caller 取消返回 `Canceled`，均不附业务 failure detail；请求结束后不把同一个 RPC 转为后台任务继续执行，已经提交的短事务结果保持有效。
- `CONTROL_PLANE_MAX_MESSAGE_SIZE` 是 ManagerService 编码后 protobuf request 和 response 的统一硬上限。Gitea Connect handler 使用它限制请求读取，并在提交响应前检查响应大小；Manager 使用 Declare 返回的同一值限制响应读取和日志分批。统一双向上限可以保证完整 inventory 能提交，其对应设置和差异响应也一定能返回。
- `GATEWAY_REQUIRE_HTTPS=false` 时接受 `http://` 和 `https://` 的 `gateway_url`；设为 true 时只接受 HTTPS。该选项用于部署策略，不改变扁平子域路由或 session 语义。
- SSH 认证限流与退避由 Gateway 配置和管理。
- `OPERATION_LEASE_TIMEOUT` 是 Manager 领取或续租 [Operation](glossary.md#operation) 的标准 lease 时长。`OPERATION_MAX_DURATION` 是同一次 running operation 从首次领取开始计算的总执行时长，默认 2 小时。Gitea 将向未来取整的 `grant_time + lease timeout` 与 `operation_started_unix + max duration` 取较早值作为数据库 deadline；成功响应通常返回完整 lease 毫秒数，最后一段返回到总期限为止向下取整的实际正整数毫秒数，abort 固定返回 0。这样普通 lease 不因秒级数据库时间戳提前结束，持续续租也不能让 active operation 永久存在。
- `MANAGER_OFFLINE_TIMEOUT`、`QUEUE_TIMEOUT` 和 `OPEN_TOKEN_EXPIRE` 以正整数秒表示，分别用于 `last_online_unix`、`operation_created_unix` 和 `expires_unix` 的秒级边界计算。自动暂停的默认值、范围和对象自定义值也以正整数秒下发为 `idle_timeout_seconds`。统一存储精度可以让配置、数据库比较和 RPC 数值之间没有隐式截断。
- `AUTO_STOP_DEFAULT_TIMEOUT` 是 `auto_stop_mode=default` 的有效空闲时长；`AUTO_STOP_MIN_TIMEOUT` 与 `AUTO_STOP_MAX_TIMEOUT` 校验之后提交的新自定义值。范围变化不重写或截断已经保存的正数自定义值，Codespace 创建者可在自己的详情页看到原值并主动修改；这样站点配置调整不会让现有 Codespace 在未操作时突然改变超时。`never` 由模式明确表达，不使用超时 0 表达。站点默认值变化通过下一次 inventory 下发，无需批量更新对象记录。
- `CODESPACE_REPO_CONFIG_MAX_SIZE` 限制 `.gitea/codespace.yaml` 读取大小，避免配置读取变成大 blob 解析路径。
- `LOG_READ_MAX_BYTES` 限制单次日志读取响应大小，便于详情页日志轮询和下载稳定分页。
- `LOG_MAX_LINE_SIZE` 必须小于或等于 `LOG_READ_MAX_BYTES`，保证任何已存物理行都能在服务端硬上限内返回。
- `LOG_MAX_SIZE` 限制单个 codespace 日志总量，避免异常 init 或脚本持续输出导致 DBFS 无限增长。
- `LOG_FINAL_SUMMARY_RESERVE` 从 `LOG_MAX_SIZE` 中预留给截断和最终状态摘要。
- `RUNTIME_METADATA_MAX_SIZE` 限制规范化 Runtime Metadata JSON，避免 Endpoint 声明无限放大 cache 和 RPC。
配置在启动时完成关系校验。timeout、TTL、lease、queue timeout、大小和 retention 都必须大于 0；`OPERATION_LEASE_TIMEOUT` 必须能精确转换为大于 0 的整数毫秒，`OPERATION_MAX_DURATION`、`MANAGER_OFFLINE_TIMEOUT`、`QUEUE_TIMEOUT`、`OPEN_TOKEN_EXPIRE`、`AUTO_STOP_DEFAULT_TIMEOUT`、`AUTO_STOP_MIN_TIMEOUT` 和 `AUTO_STOP_MAX_TIMEOUT` 必须能精确转换为大于 0 的整数秒，并且 `OPERATION_MAX_DURATION > OPERATION_LEASE_TIMEOUT`；`CONTROL_PLANE_TIMEOUT` 必须小于或等于 `floor(MANAGER_OFFLINE_TIMEOUT/4)`，使一次达到处理上限的 Declare 仍能在离线边界内重试；自动暂停满足 `AUTO_STOP_MIN_TIMEOUT <= AUTO_STOP_DEFAULT_TIMEOUT <= AUTO_STOP_MAX_TIMEOUT`；`LOG_MAX_LINE_SIZE <= LOG_READ_MAX_BYTES < LOG_MAX_SIZE`，`0 < LOG_FINAL_SUMMARY_RESERVE < LOG_MAX_SIZE`。

控制面消息下限由协议允许的最大不可拆分消息计算，覆盖 10000 条完整 inventory、10000 条 observed operation、10000 条设置与差异响应、256 条 operation payload、10000 条续租响应、一份最大 Runtime Metadata 和一条最大日志物理行。实现使用生成的 protobuf 类型和 Gitea 现有字段长度上限构造各类最坏合法消息，并以 `proto.Size` 计算所需字节数；测试把该结果与数量和字段上限绑定，`CONTROL_PLANE_MAX_MESSAGE_SIZE` 必须大于或等于其中最大值。`RUNTIME_METADATA_MAX_SIZE` 和 `LOG_MAX_LINE_SIZE` 参与对应 request 计算；`.gitea/codespace.yaml` 只向 create payload 提供规范化 tag，文件正文不进入控制面消息，因此 `CODESPACE_REPO_CONFIG_MAX_SIZE` 只限制 Gitea 读取 repository 配置。`LOG_READ_MAX_BYTES` 只限制 Web 日志 response。非法配置直接阻止 Gitea 启动，错误显示配置值、最低字节数和决定下限的消息类型，使管理员能直接修正配置。

日志是唯一按消息大小拆分的控制面数据，Manager 使用 `proto.Size` 形成不超过 Declare 返回上限的批次；单条最大日志物理行已由启动校验保证可独立提交。inventory、observed operation 和 Runtime Metadata 保持完整提交。超限请求在进入业务 handler 前返回 Connect `ResourceExhausted`；协议字段或本地数据违反既有限制而导致不可拆分消息超限时，Manager 保持 recovering、声明零容量并报告具体消息类型和大小，不截断清单或推测缺失实例。

实现验收点：

- `ENABLED=false` 禁止新增运行与交互，但保留 stop/delete/abort/final、管理清理和 Cron；现有 Codespace Token 始终由专用 resolver 识别并拒绝使用。
- `ENABLED=false` 允许可认证 Manager 提交连续的完整 inventory，并按正常无记录、binding 不匹配、failed 和 missing 规则收敛资源。
- `ENABLED=false` 下 `RequestGiteaToken` 和 `EnsureCodespaceGitSSHKey` 都返回状态不可用，不读取、签发、修复或登记开发凭据。
- `ENABLED=false` 下 RequestIdleStop 不创建新的 operation；已有 idle stop 的幂等请求返回原版本，其余 running 请求取得关闭自动暂停的完整设置。ReportInstances 下发同一设置，Manager 取消本地普通计时并继续恢复已经接受的 stop。
- Gitea 是功能开关的唯一判定来源。**设计如此：**关闭后的访问收敛复用四个访问 RPC，create/resume 收敛复用 Fetch abort，Runtime Metadata 返回 `state_unavailable`；Manager 依据这些结果处理当前工作，协议保持现有字段和调用方向。
- `ENABLED=true` 时，HTTP 与 SSH 两种 Git 接入都在组件注册前通过校验；错误指出协议和配置项。
- SSH 默认或存量 SSH Codespace 在 SSH 服务关闭、Host Key 缺失或 host/port 不匹配时阻止启用；返回 Runtime 的每条 known_hosts 行都能匹配规范 SSH clone URL。
- 内置 SSH 首次启动时，Codespace 校验与 SSH 服务复用同一次 Host Key 准备结果；外部 SSH 不从本机私钥推测服务器身份，使用显式 `GIT_SSH_KNOWN_HOSTS`。
- `ENABLED=false` 时可以关闭 HTTP Git 或 SSH，并继续执行 stop、delete、inventory 收敛和管理清理；再次启用前恢复存量 Codespace 所需的接入面。
- 启用 Codespace 时只有一个活动 Gitea 进程；memory、twoqueue、Redis、memcache cache adapter 和 memory、Redis global lock backend 均沿用 Gitea 现有配置，不据此提供多实例能力。
- 重新启用不迁移或重建数据库状态，现有对象按当前持久状态继续。
- 配置项与实际 cron、lease、queue、open code、日志限制一一对应；非法值或相互矛盾的大小关系在启动时拒绝。
- 消息大小配置同时覆盖 request 和 response；启动测试使用 protobuf 实际编码大小验证全部最大不可拆分消息，低于最低值时错误指出实际值、要求值和消息类型。
- Manager 使用 Declare 返回的消息上限分批日志；完整 inventory、完整 observed operation 和 Runtime Metadata 不分页、不截断，超限输入在业务事务前返回 `ResourceExhausted`。
- lease 配置可精确表示为正整数毫秒，Manager 离线、queue、Open Code 和自动暂停配置可精确表示为正整数秒；其他精度的值在启动时指出对应配置项。
- control plane timeout 不大于服务端心跳周期；Manager 保持单个进行中的 Declare，成功后按新周期调度，临时错误的退避不越过该周期。
- Fetch 领取和 observed 续租使用同一 `grant_time` 规则：数据库 deadline 向未来取整到 Unix 秒，响应相对时长保持精确配置毫秒值；FinalizeOperation 只提交最终结果。
- control plane timeout 包含认证、锁等待、数据库和 cache；deadline/cancel 使用 Connect 标准 code 且不附业务 detail，超时后不在后台继续同一个 RPC，已提交事务不回滚。
- 自动暂停默认值和自定义范围在启动时完成关系校验；功能开关或站点默认值变化后，default 对象通过下一次有效设置下发自然更新，never 对象保持关闭。
- 自定义范围只校验新的设置提交，范围调整不静默截断已有自定义秒数；重新保存时必须满足当前范围。
- 容量快照不作为 Gitea 配置或 quota；领取只使用本次 Fetch request。

Manager 本地配置由 Manager 自己管理，例如：

```text
/etc/gitea-codespace/manager.yaml
/etc/gitea-codespace/manager.json
```

Manager 本地配置包含：

```yaml
state_dir: /var/lib/gitea-codespace
name: manager-01
capacity_total: 100
startup_workers: 4
cleanup_workers: 4
process_shutdown_timeout: 30s
gitea_url: http://gitea.internal:3000
control_plane_require_https: false
control_plane_tls_ca_file: ""
control_plane_tls_server_name: ""
control_plane_tls_insecure_skip_verify: false
fetch_poll_interval: 2s
fetch_poll_jitter: 20%
fetch_error_backoff_max: 30s
inventory_report_interval: 1m
runtime_health_interval: 5m
runtime_health_timeout: 10s
runtime_api_listen: 0.0.0.0:8080
runtime_api_url: http://manager.internal:8080
runtime_api_require_https: false
runtime_api_tls_cert_file: ""
runtime_api_tls_key_file: ""
gateway_listen: 0.0.0.0:8081
gateway_url: http://codespace.example.com
gateway_cookie_secure: auto
gateway_tls_cert_file: ""
gateway_tls_key_file: ""
gateway_session_ttl: 8h
gateway_session_idle_timeout: 30m
gateway_session_revalidate_interval: 5m
gateway_max_sessions_per_codespace: 32
gateway_max_sessions_per_user: 128
gateway_max_inflight_total: 4096
gateway_max_inflight_per_session: 32
gateway_public_max_connections_per_endpoint: 64
gateway_public_max_connections_per_ip: 16
gateway_validation_max_inflight: 128
gateway_ssh_max_channels_per_connection: 32
gateway_ssh_listen: 0.0.0.0:2222
gateway_ssh_addr: ssh.codespace.example.com:22
ssh_auth_max_attempts_per_ip_per_minute: 30
ssh_auth_max_attempts_per_codespace_per_minute: 20
ssh_auth_max_attempts_per_ip_codespace_per_minute: 10
ssh_auth_max_attempts_per_public_key_per_minute: 30
ssh_auth_backoff_base: 1s
ssh_auth_backoff_max: 30s
ssh_auth_failure_window: 10m
upstream_tls_ca_file: ""
upstream_tls_server_name: ""
upstream_tls_insecure_skip_verify: false

scripts:
  init: builtin
  start: builtin
  resume: builtin

incus:
  endpoint: https://incus.internal:8443
  project: gitea-codespaces
  ca_file: /etc/gitea-codespace/incus-ca.crt
  client_cert_file: /etc/gitea-codespace/incus-client.crt
  client_key_file: /etc/gitea-codespace/incus-client.key
  start_timeout: 2m
  shutdown_timeout: 30s

tags:
  default:
    instance_type: virtual-machine
    image: local:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    profiles: [codespace-vm-v1]
    cpu: 4
    memory: 8GiB
    root_disk_size: 60GiB
    communication_nic: codespace
    address_family: ipv4
    address_subnet: 10.80.0.0/16
```

Manager 当前配置是 `name`、tag 模板键、`capacity_total`、`gateway_url`、`gateway_ssh_addr` 和脚本入口的唯一声明来源，修改前五项后通过完整 Declare 快照覆盖 Gitea 中的当前值；脚本入口只作用于 Manager 本地，不向 Gitea 声明。Declare 的 tags 直接从 `tags` 映射键生成；虚拟机或系统容器类型不向 Gitea 上报，因为 Gitea 只按 tag 匹配。`startup_workers` 和 `cleanup_workers` 分别限制启动与资源缩减任务，范围均为 1..256；前者省略时默认为 `min(capacity_total, 4)`，后者省略时默认为 4。Incus 可用时，`capacity_available` 取运行实例剩余名额和空闲启动槽位的较小值，`cleanup_capacity_available` 取空闲清理槽位数；Incus 不可用时两者都为 0。project 配额不足以容纳所有 tag 中最大的一个新建模板时，Manager 从 `accepted_operation_types` 移除 create，但有运行名额时仍可接受 resume。`capacity_total` 范围为 1..10000，且单个 Manager 管理的全部 Incus 实例数同样不能超过 10000。Manager ID、manager secret、inventory generation、operation worker、有效模板快照与 Gateway SSH Host Key 私钥都保存在 `state_dir`，不写入 YAML；Runtime Git SSH 私钥位于对应 Incus 实例内。两处私钥归属不同，同一状态目录由进程锁保证只能被一个 Manager 进程使用。

`scripts.init`、`scripts.start` 和 `scripts.resume` 组成一个脚本套件：三个值必须全部为 `builtin`，或者全部为本地绝对文件路径。Manager 启动时拒绝混合配置，并读取三个自定义普通文件、校验可读性；脚本以 root 执行，因此文件来源属于部署信任边界。同一 active operation 在首次执行前保存三个脚本的内容摘要并原子发布实际内容，重试和 Manager 重启恢复继续使用该组内容，配置变化从之后开始的 create/resume 生效。脚本配置属于整个 Manager，不在 tag 中重复；调用、共享环境、结果契约和 devcontainer 案例见[脚本契约、内置实现与 devcontainer 案例](builtin-scripts.md)。

`incus.project` 是 Manager 的专用 Incus project。证书应只具有管理该 project 实例所需的权限；Manager 启动时验证 project、权限和 Incus 非集群模式。每个 tag 模板完整指定实例类型、固定 image、profiles、资源和通信网卡，缺少任一配置字段时启动失败并指出 tag 与字段。workspace 默认位置、Token 和 Git SSH 文件路径是 Manager 与脚本的固定调用契约，不在 tag 中提供可变副本。`image` 使用 Incus remote 加完整 fingerprint 的固定引用；Manager 在 create 快照中保存 Incus 返回的 fingerprint。`instance_type` 只允许 `virtual-machine` 或 `container`，两者使用相同的 create/resume/stop/delete 和通用脚本流程。Manager 从展开设备中取得唯一的 `type=disk,path=/` 根盘设备，用同名实例设备覆盖 `size`，并通过 `limits.cpu` 和 `limits.memory` 写入资源限制。

`communication_nic` 是展开后 Incus NIC 设备的键。Manager 使用设备明确配置的 `hwaddr`，或实例的 `volatile.<communication_nic>.hwaddr`，与 Instance State 接口关联来宾网卡，再使用 `address_family + address_subnet` 取得唯一通信地址。该地址同时供 Runtime HTTP API 来源校验、Endpoint upstream 和内部 SSH 使用，不作为持久身份保存。`start_timeout` 限制启动后等待 Incus exec、文件 API 和唯一通信地址的时间；`shutdown_timeout` 到期后 Manager 使用 Incus 强制停止并再次确认 stopped。

通信 NIC 所属 managed network 和 ACL 由版本化 profile 维护。实例入站只通过 Gateway，ACL 放行 Manager/Gateway 管理通道并限制实例间横向访问；实例访问 `runtime_api_url` 的路径保留 source IP，使 Manager 能用当前通信地址完成实例绑定。需要保证虚拟机隔离级别的容量使用独立 tag 和 Manager 配置，Gitea 不从实例类型推断安全级别。

`runtime_api_listen`、`gateway_listen` 和 `gateway_ssh_listen` 是本地监听地址；`runtime_api_url`、`gateway_url` 和 `gateway_ssh_addr` 是向 Runtime、Gitea 或用户声明的可达地址，两者可以因反向代理或端口映射而不同。`gitea_url`、`runtime_api_url` 和 `gateway_url` 都允许 HTTP/HTTPS；各 `require_https` 选项用于需要强制 HTTPS 的部署。CA 和 server name 只在对应 HTTPS 连接中使用，`insecure_skip_verify` 默认 false。`gateway_url` 必须使用规范的 ASCII DNS 主机名，不能带尾随点、业务 path 或 IP literal；每个标签为 1..63 字符，最长派生 Endpoint Host 不超过 253 字符。规范化地址在 Manager 间唯一，并与 Gitea `ROOT_URL` 处于不同可注册域；部署为该基础域名和 `*.domain` 配置 DNS。Gateway URL 为 HTTPS 时，监听证书或受信反向代理证书同时覆盖基础域名与单层 wildcard；Cookie Secure 和保留名称按外部 URL 的实际 scheme 决定。Endpoint HTTPS upstream 使用 upstream TLS 配置，Endpoint 请求不能修改信任策略。

`inventory_report_interval` 默认 1 分钟，必须大于 0；Fetch 默认 2 秒并带 20% 正抖动，临时错误最多退避 30 秒。`runtime_health_interval` 默认 5 分钟，`runtime_health_timeout` 默认 10 秒，要求两者为正且 timeout 小于 interval；Manager 按 UUID 分散检查，检查命令、30 秒失败复检、连续 3 次确认、完整健康轮次判定和 `min(capacity_total,32)` 并发上限使用文档固定值。固定这些行为可以让不同 Manager 对同一运行状态作出一致判断，配置只保留部署需要调整的周期和单次超时。`gateway_max_inflight_total` 范围为 1..1000000，默认 4096；`gateway_max_inflight_per_session` 和 `gateway_ssh_max_channels_per_connection` 范围均为 1..1024、默认 32，前者不得大于全进程上限。公共连接的 per-Endpoint 和 per-IP 上限范围均为 1..10000，且 per-IP 不大于 per-Endpoint；默认分别为 64 和 16，并继续受全进程在途上限约束。`gateway_validation_max_inflight` 范围为 1..4096，默认 128，统一限制公共与认证 HTTP 的在途 Gitea 授权校验；相同授权键的并发 miss 只占一个名额。Gateway HTTP listener 固定使用 64 KiB header 上限和 10 秒 read-header timeout，正文保持流式转发。SSH 认证限流状态固定最多 65536 个有期限键。`process_shutdown_timeout` 默认 30 秒，限制 SIGINT/SIGTERM 后关闭准入、暂停 worker、保存本地状态和停止 listener 的总等待时间；它与 `incus.shutdown_timeout` 分别约束 Manager 进程关闭和单个实例停止。心跳周期、Runtime Metadata 刷新周期、控制面消息上限和 Gitea 浏览器根 URL 来自每次成功 Declare 响应，不在 Manager 配置中重复声明，因为这些值由 Gitea 的站点配置决定。

Repository 配置固定为 `.gitea/codespace.yaml`，与 Manager 本地配置不是同一个文件。

实现验收点：

- 控制面、Runtime API 和 Gateway 在 HTTP 配置下可正常工作，启用对应 HTTPS 配置后使用证书和 CA 校验。
- `gateway_cookie_secure=auto` 按规范外部 `gateway_url` 选择 HTTPS `__Host-` 或 HTTP 普通保留 Cookie 名称；显式值与外部 scheme 不一致时启动失败。
- `gateway_url` 的尾随点、非法 DNS 标签、非根 path、IP literal、过长派生 Host 和与 Gitea 相同可注册域都被拒绝；基础域名与单层 wildcard DNS/TLS 可以覆盖所有派生 Endpoint host。
- Gitea 启动和 Declare 都拒绝与 `ROOT_URL` 可注册域、完整 host、Gateway wildcard 或 `[session].DOMAIN` 冲突的 Gateway 基础域名；已有地址冲突时启动错误指出 Manager、地址和配置项。
- 两个 Manager 声明相同的规范化 `gateway_url` 时，数据库唯一约束使后声明者收到 `gateway_url_conflict`；已有 Manager 的未变化 heartbeat 正常提交，无需扫描其他 Manager。
- `gateway_ssh_addr` 完全来自 Manager 配置；两个 Manager 声明相同规范化 `host:port` 时，后声明者收到 `gateway_ssh_addr_conflict`。
- 修改 name、tags、capacity 或 Gateway/SSH 地址后，成功 Declare 整体覆盖旧快照；失败 Declare 不产生部分更新。
- `startup_workers` 和 `cleanup_workers` 使用文中固定默认值和范围；已有任务数量超过调小后的配置时继续执行已有任务，两类新领取容量保持 0 直到占用回落。
- Manager 配置不包含心跳周期、Runtime Metadata 刷新周期、控制面消息上限或 Gitea 浏览器根 URL；首次 Declare 成功后采用完整服务端响应，非法响应保持 recovering 和零容量。
- Runtime 健康周期和单次超时使用配置中的两个正数值且 timeout 小于 interval；检查命令、连续失败阈值、完整轮次共享故障判定和检查并发使用文档固定规则。
- Gateway 进程总在途量、单 session 在途量和每个 SSH transport 的 channel 数使用文中默认值与范围；HTTP/WebSocket/SSH 的取得、拒绝和关闭路径都只释放一次名额，公共请求也受进程总上限约束。
- Gateway HTTP listener 固定拒绝超过 64 KiB 的请求头和超过 10 秒仍未读完的请求头；请求与响应正文按背压流式转发。SSH 认证限流的有期限键最多保留 65536 个；到期键正常清除，容量已满时已有键继续计数，新的未知键在调用 Gitea 前按认证失败处理。
- `process_shutdown_timeout` 与 `incus.shutdown_timeout` 分别限制进程级收尾和实例停止，任一值都不会延长 Gitea operation deadline。
- listener 与对外地址可以不同；Manager 声明值、容量和 SSH 限流均能由上述配置或本地运行状态唯一确定。
- 公共连接的 per-Endpoint 与 per-IP 上限使用文中默认值和范围，任何匿名请求必须同时取得两个本地名额；公共计数不进入认证 session 上限。
- `gateway_validation_max_inflight` 使用文中默认值和范围；公共与认证 HTTP 的相同授权键并发 miss 合并后共同受该上限约束，满载返回 503。
- 一个 Manager 身份与其 `state_dir` 共同组成单一部署；同一状态目录的第二个进程在发送 RPC 前因独占锁失败。并行 Manager 使用各自注册身份和状态目录。
- Endpoint 请求只能选择 `http|https` scheme，不能关闭 HTTPS 证书校验或指定任意 host。
- Declare tags 与配置模板键完全一致；虚拟机与系统容器模板都不会把实例类型写入 Gitea。
- 三个脚本入口在 Manager 启动时按“完整内置套件或完整自定义套件”完成静态校验，混合配置失败；同一 active operation 固定脚本内容与摘要，配置变化只影响之后开始的 create/resume。
- Incus project、证书权限、非集群模式以及 tag 模板字段在领取 create/resume 前完成静态校验；image、展开 profile、根盘、所选脚本发布和通信网卡的运行条件在实例创建或启动后、提交 final 前验证，错误指明对应 tag 与字段。
- Git SSH 私钥、公钥和 known_hosts 使用 Manager 固定路径；私钥只在 Runtime 工作环境内生成，Manager 状态目录不保存该私钥。
- 已有 Codespace 使用 create 时保存的有效模板快照；修改或删除 tag 模板只影响之后的 create，不改变已有实例的 resume、stop 和 delete。共享 profile 通过新版本名称演进。
- `capacity_available` 同时受运行名额和启动 worker 限制，`cleanup_capacity_available` 受清理 worker、Fetch 预留和持久 pending 限制；project 配额只能容纳已有 stopped 实例时，Fetch 接受 resume 而不接受 create，stop/delete 仅在有清理槽位时领取。
- 通信地址按指定设备的配置或 `volatile` MAC、地址族和子网唯一解析，并在实例扫描和启动后重新计算。
- Runtime API 网络路径保留实例 source IP，Gateway 是实例服务的唯一用户入站入口；通信 profile 的 ACL 覆盖管理通道和实例间隔离。
