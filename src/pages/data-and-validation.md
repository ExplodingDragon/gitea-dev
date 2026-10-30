# 数据、Pages 本地架构与验证

本章定义 Gitea 需要持久化的当前事实，以及 Pages 单机实例保存和恢复本地状态的方式。发布流程和归档安全规则见[发布章节](publishing.md)，通信字段和状态语义见[通信章节](communication.md)；本章只保存实现这些行为所需的数据。

## 数据边界

| 位置 | 保存内容 | 原因 |
| --- | --- | --- |
| Gitea SQL | 站点、内容版本、Pages 实例、自定义域名和实例最后结果五张表。 | 管理面需要保存当前内容指针、可恢复的内容历史和各实例当前结果。 |
| Gitea `app.ini` | 归档资源上限、每站点版本保留数、计划任务批量、业务 TXT 要求、Gitea TXT 周期和递归 DNS。 | 这些值属于全局运行策略；归档限额和业务 TXT 要求还会通过同步响应交给实例。 |
| Gitea storage | 仍被内容版本引用的 TAR.GZ 和待清理的无引用对象。 | Gitea 统一保存成品，Pages 不接触后端凭据。 |
| Pages 内嵌 etcd | Gitea 游标、当前站点配置、本机部署结果、证书材料、重试和待确认结果。 | 实例可以在 Gitea 短暂失联时恢复本机服务。 |
| Pages 数据目录 | etcd 数据、工作目录、网站内容、进程锁和运行配置副本。 | 本机部署只使用自己的文件系统。 |

Pages 每个实例是一台机器上的一个进程和一个单成员内嵌 etcd。实例之间不组成集群，Gitea 也不把站点调度到单独实例；所有实例处理全部启用站点。访客请求只读本机已切换的内容目录。

### 实现验收点

- Gitea storage 使用现有存储抽象；Pages 没有存储后端路径或凭据。
- Pages 数据根目录能独立备份、清理和重建，访客请求不访问 Gitea。
- 同一实例只有一个进程使用一个数据根目录，实例之间没有共享 etcd 数据。
- Gitea 失联时已经生效的本机网站继续服务，恢复后可从本地游标继续同步。

## Gitea 数据表

Gitea 使用五张 Pages 业务表。站点表保存当前配置和当前版本指针，版本表保存可恢复的内容事实，实例结果表继续只保存每个实例的最后结果。内容历史与部署结果采用不同生命周期：恢复内容需要版本历史，而仓库页面判断当前是否发布只需要最后结果。

### `pages_site`

每行对应一个曾配置过 Pages 的仓库，`repo_id` 是站点身份。

| 字段 | 含义 |
| --- | --- |
| `repo_id` | 仓库 ID，主键。 |
| `deleted`、`enabled` | 删除标记和当前启用状态。 |
| `source_type`、`source_branch`、`source_path` | 自动发布方式及其配置；`source_type` 只有 `artifact` 和 `branch`。 |
| `source_commit_id`、`source_next_check_unix`、`source_error_code` | 分支来源的已处理提交、下次检查时间和最近错误。 |
| `current_version_id` | 当前内容版本 ID；`0` 表示当前没有选择可部署内容。 |
| `pages_updated_unix_nano` | 站点当前事实更新时间和同步分页依据；切换当前版本会推进此时间。 |

站点只保存版本指针，因为摘要、首次来源和创建时间都能由版本记录取得。删除仓库时把指针清零并保留 `repo_id`、删除标记和更新时间，使实例可以撤销旧路由，也使同名新仓库不会继承旧内容。

### `pages_version`

每行对应一个已经通过 Gitea 检查并完整写入 storage 的 TAR.GZ。版本在同一仓库内按摘要去重，记录创建后保持不变。

| 字段 | 含义 |
| --- | --- |
| `id` | 版本 ID，主键。 |
| `repo_id` | 所属仓库 ID，与摘要组成唯一约束。 |
| `tar_gz_sha256` | 完整 TAR.GZ 的 SHA-256，与 `repo_id` 组成唯一约束。 |
| `origin_type` | 首次创建该版本的 `upload`、`branch` 或 `actions` 来源。 |
| `origin_action_run_id` | 首次来源为 Actions 时的运行 ID，其他来源为 `0`。 |
| `created_unix` | 版本首次创建时间。 |

相同内容再次提交时复用原版本，因此首次来源保持稳定。Actions 的另一次运行提交相同内容时仍会记录该运行的提交标记，但不会复制版本。`[pages] MAX_VERSIONS_PER_SITE` 控制每个站点保留数量，默认 10，允许 1 到 100；每次成功提交或恢复时保留当前版本和其余最新版本，并在数据库事务提交后清理失去引用的对象。用户可以删除任意版本；删除当前版本的事务同时清空当前指针、关闭 Pages 并推进站点更新时间，删除历史版本只移除版本引用。提交后才清理无引用对象。同步裁剪使配置降低后在下一次内容操作自然生效，不需要计划任务。

### `pages_instance`

每行对应一个全局管理员登记的 Pages 实例。

| 字段 | 含义 |
| --- | --- |
| `id` | 实例 ID。 |
| `root_url`、`root_updated_unix_nano` | 实例注册的根地址及其 Gitea 更新时间。 |
| `last_communication_unix` | 当前凭据最近一次通过认证访问 Gitea 的时间；`0` 表示尚未通信。 |
| `token_hash` | 实例通信凭据的 SHA-256，Gitea 不保存明文。 |

证书、DNS、Nginx、数据目录和启动模式属于 Pages 本机配置，不进入 Gitea 表。

### `pages_domain`

每行对应一个自定义域名绑定。`host` 规范化后全局唯一；业务 TXT 结果由 Gitea 维护，Pages 进行本机复查。

| 字段 | 含义 |
| --- | --- |
| `id`、`repo_id`、`host` | 绑定身份、所属站点和规范化 Host。 |
| `txt_token`、`txt_result` | 业务 TXT 期望值和最近结果。 |
| `state` | `pending`、`active` 或 `releasing`。 |
| `txt_last_success_unix_nano`、`txt_last_check_unix` | 最近成功时间和最近一次 Gitea 实际查询时间；后者为 `0` 表示等待首次查询。 |
| `created_unix_nano` | 创建时间。 |

ACME 账户、证书、私钥和 DNS provider 凭据只在 Pages 本机保存。

### `pages_instance_site`

每行保存一个实例对一个站点最后一次被 Gitea 接受的结果。这个表用于判断当前网站状态，新的结果覆盖同一实例和站点的旧结果。

Go 模型在 `models/pages` 中命名为 `InstanceResult`，表名继续使用 `pages_instance_site`。类型名称表达它是实例的当前部署结果，固定表名则让迁移、查询和设计字段保持一致。

| 字段 | 含义 |
| --- | --- |
| `instance_id`、`repo_id` | 联合主键。 |
| `applied_pages_updated_unix_nano` | 实例处理的站点时间。 |
| `applied_root_updated_unix_nano` | 实例处理的根地址时间。 |
| `applied_require_gitea_txt_record` | 实例处理自定义域名时使用的业务 TXT 要求。 |
| `config_applied` | 当前站点配置是否已在本机落实。 |
| `actual_tar_gz_sha256` | 本机实际安装的成品摘要。 |
| `default_published`、`custom_published` | 默认地址和自定义地址是否发布。 |
| `error_code` | 当前稳定错误码。 |

Gitea 接收结果时通过 `current_version_id` 解析当前摘要，并核对站点时间、实例根地址时间和适用的业务 TXT 要求。旧结果返回 `state_changed`，使较早部署的结果不会覆盖当前状态。

### Actions 运行标记

现有 `action_run` 表增加 `has_pages_artifact` 布尔字段。Actions 成品接收时，版本创建或复用、当前指针切换和运行标记在同一个数据库事务完成。字段名称表达“该运行提交过 Pages 成品”，因为实例发布成功属于独立结果；这样接口成功时版本与运行标记一定同时可见，事务失败时两者都不生效。

标记表示该 workflow run 至少成功提交过一次 Pages 内容。相同摘要由多个运行提交时只产生一个版本，但每个成功运行都有自己的标记。版本只记录首次 Actions 来源，当前地址仍由实例根地址和仓库名称推导，当前发布结果仍由 `pages_instance_site` 推导，因此 Actions 表无需复制站点状态。

### 实现验收点

- 数据库包含 `pages_site`、`pages_version`、`pages_instance`、`pages_domain` 和 `pages_instance_site` 五张 Pages 业务表。
- 站点使用 `current_version_id` 指向当前内容；版本表按仓库和摘要唯一，并只保存版本身份、首次来源和创建时间。
- 相同内容重复提交复用版本；不同 Actions 运行提交相同内容时都保存运行标记，版本首次来源保持不变。
- Actions 运行标记、版本创建或复用和当前指针切换在一个事务中提交。
- 每次内容提交或恢复后保留当前版本和配置数量内的最新历史版本；对象只在版本引用删除后清理。
- 任意版本都可以删除；删除当前版本同时关闭 Pages、清空当前指针并推进站点时间，删除事务提交后只清理已经没有版本引用的对象。
- 删除仓库保留精简站点记录，清除该仓库全部版本引用，同名新仓库使用新 `repo_id`。
- 自定义域名表只保存业务 TXT 管理事实，ACME 材料保存在 Pages 实例。
- 实例最近通信时间由通过认证的内部接口请求更新，一分钟内连续请求合并写入；重置凭据后恢复为尚未通信。
- 实例结果按站点和实例保存一份，站点时间、根地址时间和适用的业务 TXT 要求共同确认该结果属于当前事实。

## Gitea 时间与查询

Gitea 为站点和实例根地址生成更新时间。归档限额和业务 TXT 要求来自启动时加载的 `app.ini`，每个站点查询响应都直接返回当前值；这些配置独立于站点分页游标。Pages 使用 Gitea 返回的站点时间和根地址时间作为查询依据，不用本机时钟计算同步范围。

首次同步按 `(pages_updated_unix_nano, repo_id)` 递增分页，并固定本轮 `until`。Pages 在内存中收集结果，并确认全部分页和补查返回相同的归档限额与业务 TXT 要求；全部成功后才一次持久化并替换本机活动快照。持久化前写入恢复标记，站点和元数据完整写入后清除；进程在这段时间退出时，下次启动忽略未完成快照并重新全部查询。正常运行使用 `since < time <= until` 的增量查询，第一页确认配置，后续分页必须保持一致，分页失败时保留上一轮查询依据。查询依据大于 Gitea 当前范围时返回 `pages_cursor_ahead`，运维按[生命周期](lifecycle.md#失联重建与永久故障)清理本机状态后重新全部同步。

### 实现验收点

- 首次和增量查询都按站点时间、仓库 ID 稳定分页；每轮分页使用一致的归档限额和业务 TXT 要求。
- 全量分页和补查都成功后才替换活动快照，分页期间的更新不会遗漏。
- 全量同步失败时继续使用上一份快照，成功后一次清理快照差集。
- 全量快照持久化中断时保留恢复标记，重启后重新全部查询并在完成前关闭未确认路由。
- 查询依据损坏能通过清空本机数据后重新初始化，时区或本机时间变化不会造成遗漏。

## Pages 本地状态与主动部署

Pages 使用 `go.etcd.io/etcd/server/v3/embed` 启动独立单成员 etcd，客户端、Peer 和指标地址不对外监听。数据根目录由 `GITEA_PAGES_DATA_ROOT` 指定，进程锁保证同一目录只有一个 Pages 进程。

etcd 保存 Gitea 查询依据、最近确认的归档限额和业务 TXT 要求、当前站点配置、实际安装摘要、地址开放状态、证书与 ACME 当前材料、有限重试信息、全量同步恢复标记以及每个站点一份待确认结果。错误码保存在待确认或已确认部署结果中，不在站点记录中复制；归档限额的合法值都大于零，因此零值直接表示尚未同步配置。TXT 本地状态保存最近检查和最近成功时间，有效性按最近成功时间和固定宽限期计算，避免同时保存可能互相矛盾的布尔值。前缀读取使用固定大小分页，完整前缀清理使用 etcd 范围删除，使站点数量增加时不会把全部键装入一个响应。网站目录和 Nginx 输出不作为 etcd 数据，而是本机文件。`etcd/` 目录只允许 Pages 进程读写，`work/` 目录只用于 Pages 的临时文件并采用同样的进程私有权限；`sites/` 和 Nginx 的 route-state 文件需要允许 Nginx 进程遍历和读取，以便 Nginx 模式在 Pages 进程暂时退出时继续服务。

收到当前站点后先保存事实，再放入有界部署队列。队列满时仍保留 etcd 事实，并唤醒一个扫描协程；该协程只暂存待处理的仓库 ID，在工作线程释放队列空间后继续填充。启动时执行一次恢复扫描，运行期间每五分钟扫描一次仍未落实的目标。部署主动从 Gitea 下载当前 TAR.GZ，按[归档检查](publishing.md#targz-目录与安全检查)展开为不可变候选内容，再交给当前发布器。发布器确认后保存安装摘要并清理旧目录；发布器返回硬错误时删除候选并继续保留旧入口。内容安装、配置应用和地址发布分别上报。embedded etcd 写入失败时实例直接尝试上报当前失败并保留本地错误，恢复扫描以后仍按尚未确认的当前事实重试，使故障处理继续由当前站点状态驱动。

### 实现验收点

- 每个实例只运行一个内嵌 etcd，外部没有 etcd API 端口。
- etcd 站点和结果前缀按固定页读取，完整前缀使用范围删除，恢复操作不会依赖单次无限响应。
- 初次同步和成品变化都会主动部署，访客请求不会触发下载或展开。
- 队列满时扫描协程持续填充有界队列；进程重启或部署失败后，etcd 中的当前事实能让启动扫描和五分钟恢复扫描继续处理。
- 内容安装失败时旧目录继续服务；没有旧目录时返回平台 404。
- embedded etcd 写入失败不会阻断当前部署错误上报，恢复后扫描会重新确认最新结果。

## 可嵌入服务与统一发布器

`gitea.dev/page` 可以作为 Go 依赖使用。调用方构造 `Config`，选择内置 `StandalonePublisher`、内置 `NginxPublisher` 或实现自己的 `Publisher`，再以 `NewService` 启动同步。`WithLogger` 和 `WithHTTPClient` 用于接入宿主程序现有的日志与网络配置。命令行仍从环境变量构造相同对象，因此命令模式和库模式使用同一实现。

`Publisher.Restore` 在服务启动时以迭代器提供已确认部署，使大量站点不需要再复制为一个完整切片。`Publish` 收到仓库 ID、默认地址、可选自定义地址和经过检查的 `Content`；`Content` 可以作为 `fs.FS` 打开文件，也可以取得只读目录供现有 Web 服务使用。成功返回的 `Publication` 分别说明默认地址和自定义地址是否已经实际可访问。返回错误表示入口应用失败，发布器需要在返回前恢复该仓库原有入口。`Unpublish` 成功后核心才清理内容和保存关闭结果。

发布器在同一仓库上的调用由核心串行处理，不同仓库可以并发。内容目录在下一次成功发布或成功关闭前保持有效，发布器只读取目录。外部发布器自行管理自己的 HTTP/TLS 生命周期和入口核验；核心继续负责 Gitea 注册与同步、下载、摘要、归档安全、业务 TXT 和结果上报。这个分工使用户可以把已经检查的内容接入自有 Web 服务，同时保留 Pages 的安全与状态闭环。

站点归档只要求至少一个普通文件，不要求 `index.html`。内置入口在目录存在 `index.html` 时按普通静态网站读取；没有首页时根路径返回 404，归档中的实际文件仍可直接访问。这样 Pages 可以提供下载文件、单页资源或由外部 Web 服务解释的内容，而不会把某个文件名当成发布成功条件。

### 实现验收点

- 外部 Go 包可以只依赖公开类型实现 `Publisher`，构造并运行 `Service`。
- 自定义发布器收到的内容已经完成摘要、路径、大小、条目和符号链接检查，可以通过 `Content.Open` 或只读目录读取。
- 启动恢复使用迭代访问；同一仓库发布串行，不同仓库可以按部署并发设置同时处理。
- 发布器硬错误恢复旧入口，核心删除失败候选；成功关闭入口后核心再清理内容。
- 自定义发布器负责自己的 Web 与 TLS 入口，核心仍完成 TXT、同步和结果上报。
- 只有普通文件且没有 `index.html` 的归档可以发布；根路径返回 404 时实际文件仍可访问。

## standalone 与 nginx 启动模式

Pages 命令使用 `gitea-pages standalone` 或 `gitea-pages nginx`。两种模式是统一 `Publisher` 接口的内置实现，共用同步、TAR.GZ、TXT、证书和结果流程，只改变访客入口。

`standalone` 先完成 HTTP/HTTPS 监听，再启动同步和部署，使首次入口探测面对已经能够接收连接的服务。`nginx` 使用 1.19.4 或更高版本，以便默认 HTTPS 服务在没有证书时通过 `ssl_reject_handshake` 拒绝未知 SNI。Pages 生成候选配置、执行固定的配置检查和重载命令，再从本机实际 Host、端口、SNI 和路径探测入口。Nginx 配置预先生成所有启用站点的稳定路由片段，route-state 下的标记文件决定某个站点当前是否开放，因此单个站点发布状态变化只需更新标记，不必为每个站点重新渲染和重载完整配置。涉及证书、Nginx 配置或地址集合的变化仍执行检查和重载。Nginx 已成功加载的配置和网站文件可以在 Pages 进程停止后继续服务；Pages 恢复后会核对输出配置、证书摘要和当前事实，输出文件缺失或证书变化时重新检查并重载。配置命令成功只是应用步骤，实际入口探测成功才算地址发布。

### 实现验收点

- 两种模式使用同一套站点、结果和安全展开逻辑。
- standalone 监听器进入接收状态后才开始部署；nginx 模式只维护 Nginx 所需的配置和路由标记。
- nginx 模式使用 1.19.4 或更高版本，未知 SNI 在默认 HTTPS 服务握手阶段被拒绝。
- Nginx 配置经过检查、重载和实际入口探测后才报告成功。
- Nginx 输出配置缺失或证书内容变化会重新应用，重载失败保留上一份已确认配置并在后续处理重试。
- Pages 停止时 Nginx 保持最后成功配置，恢复后重新同步并按当前条件关闭或恢复入口。
- 每个模式都能区分内容安装成功、入口配置成功和地址可访问。

## Gitea 配置、Pages 环境变量与数据根目录

Gitea 从 `app.ini` 的 `[pages]` 读取发布资源限制和域名所有权要求，从 `[storage.pages]` 读取成品存储。前者决定所有接收入口、分支打包和 Pages 实例部署使用的行为，后者复用 Gitea storage 抽象，因此本地、MinIO 和其他已支持后端采用同一套内容代码。

| `[pages]` 配置 | 默认值 | 作用与原因 |
| --- | --- | --- |
| `MAX_TAR_GZ_SIZE` | `100MiB` | 网页、API、Actions 转换、存储前检查和实例下载共同使用的压缩成品上限。 |
| `MAX_SITE_SIZE` | `512MiB` | TAR 展开后全部普通文件的总大小上限。 |
| `MAX_FILE_SIZE` | `100MiB` | 单个普通文件的上限，必须小于或等于站点总大小。 |
| `MAX_ENTRIES` | `10000` | 一个 TAR 中允许的条目总数。 |
| `MAX_VERSIONS_PER_SITE` | `10` | 每个仓库保留的内容版本数，范围 1 到 100；内容提交和恢复时同步应用。 |
| `BRANCH_SOURCE_BATCH_SIZE` | `50` | 每次分支来源计划任务处理的仓库数，使一次任务耗时保持有界。 |
| `DOMAIN_VERIFICATION_BATCH_SIZE` | `100` | 每次 Gitea 业务 TXT 计划任务处理的域名数。 |
| `DOMAIN_VERIFICATION_INTERVAL` | `15m` | 同一域名两次 Gitea 业务 TXT 查询的最短间隔，允许 `1m` 到 `24h`。 |
| `REQUIRE_GITEA_TXT_RECORD` | `true` | 控制 Gitea 和 Pages 是否要求 `_gitea-pages.<host>` 业务 TXT；ACME 验证仍由 Pages 独立完成。 |
| `DNS_RESOLVER` | 空 | Gitea 业务 TXT 查询使用的递归 DNS，接受 IPv4、IPv6 和可选端口；省略端口时使用 53，空值使用系统解析器。 |

大小使用 Gitea 通用字节格式。大小必须为正数，条目和批量必须为正整数，两个批量上限为 `500`；TXT 查询周期限制在 `1m` 到 `24h`，递归 DNS 只接受 IP 地址和有效端口。关系不成立或格式错误时 Gitea 启动失败并指出配置项。配置在 Gitea 启动时生效，运维修改后通过正常重启统一切换行为。归档限额变化只约束之后的接收和部署，不扫描或重装已经发布的站点；站点以后因内容变化重新部署时使用新限额。

`[storage.pages]` 没有独立配置时继承 `[storage]`，本地默认路径为 `data/pages`，MinIO 默认前缀为 `pages/`。Pages 实例始终从 Gitea 的鉴权下载接口取得 TAR.GZ，不读取这组存储配置。

### 实现验收点

- Gitea 启动时严格校验十个 `[pages]` 配置项，格式或范围错误会直接指出对应配置。
- TXT 到期查询使用配置周期，指定的 IPv4 或 IPv6 递归 DNS 确实用于 Gitea 查询。
- 网页上传、API 上传、Actions 转换、分支打包和接收检查使用同一组当前限额。
- 每个同步响应都携带当前归档限额和业务 TXT 要求，Pages 确认后持久保存并用于新部署。
- 修改限额不会主动重装已发布内容；内容下一次变化时按新限额处理。
- 版本保留数限制在 1 到 100，修改后在下一次内容提交或恢复时应用。
- `[storage.pages]` 可以继承通用 storage，也可以选择 Gitea 已支持的远程后端；Pages 实例不接触后端凭据。

Pages 进程运行参数通过 `GITEA_PAGES_` 环境变量提供。变量按服务模式和证书来源划分，启动时读取并校验。网站归档资源上限和业务 TXT 要求由 Gitea 同步，Pages 持久保存最近确认值，使同一 Gitea 登记的实例使用一致条件。

两种模式共同使用以下变量：

| 变量 | 作用与取值 |
| --- | --- |
| `GITEA_PAGES_GITEA_URL` | Gitea 的 HTTP 或 HTTPS 服务地址，Pages 通过管理接口同步和上报；同机或受控内网可以使用 HTTP，跨越不可信网络时使用 HTTPS。 |
| `GITEA_PAGES_TOKEN` | 当前实例访问 Gitea 的通信凭据，由运维安全注入。 |
| `GITEA_PAGES_ROOT_URL` | 当前实例对外注册的 Pages 根地址，使用 HTTP 或 HTTPS 的标准端口。 |
| `GITEA_PAGES_DATA_ROOT` | 当前实例唯一的数据根目录，必须是绝对路径，包含 `etcd/`、`sites/`、`work/`、`route-state/` 和进程锁。 |
| `GITEA_PAGES_SYNC_INTERVAL` | 周期同步间隔，默认 `1m`，最小值为 `1m`。 |
| `GITEA_PAGES_DNS_RESOLVER` | 本机业务 TXT 查询使用的递归 DNS，接受 IPv4、IPv6 和可选端口；空值使用系统解析器。 |
| `GITEA_PAGES_DNS_REFRESH_INTERVAL` | 本机业务 TXT 查询缓存和主动复查周期，默认 `15m`，允许 `1m` 到 `24h`。 |
| `GITEA_PAGES_DEPLOY_TIMEOUT` | 单个站点下载、检查和部署的最长时间，默认 `10m`。 |
| `GITEA_PAGES_DEPLOY_QUEUE_SIZE` | 部署队列容量，默认 `32`；当前站点事实已保存在 etcd，队列满时由后台扫描协程随可用空间继续安排。 |
| `GITEA_PAGES_DEPLOY_CONCURRENCY` | 并行部署数量，默认 `2`。 |
| `GITEA_PAGES_ETCD_QUOTA_BYTES` | 内嵌 etcd 后端配额，默认 2 GiB，最小值 64 MiB。 |
| `GITEA_PAGES_CUSTOM_ROOT` | 可选的实例级平台资源和 Nginx 模板目录，必须是绝对路径。 |

`standalone` 需要以下变量：

| 变量 | 作用与取值 |
| --- | --- |
| `GITEA_PAGES_HTTP_LISTEN` | Pages HTTP 监听地址。 |
| `GITEA_PAGES_HTTPS_LISTEN` | 当 `GITEA_PAGES_ROOT_URL` 使用 HTTPS 时的 HTTPS 监听地址。 |

`nginx` 需要以下变量。Nginx 目录由运维明确指定，让 Pages 可以与现有 Nginx 目录布局配合：

| 变量 | 作用与取值 |
| --- | --- |
| `GITEA_PAGES_NGINX_ROOT` | Nginx 输出根目录，必须是绝对路径，并与数据根目录分离；Pages 在其中写入 `pages.conf`、配置快照、平台静态资源和 `certs/`。 |
| `GITEA_PAGES_NGINX_HTTP01_ROOT` | HTTPS 实例的 HTTP-01 挑战目录，必须是独立的绝对路径；HTTP 模式可省略。 |
| `GITEA_PAGES_NGINX_HTTP_PROBE_ADDR` | Pages 本机用于 HTTP 地址预检查的 IP 和端口。 |
| `GITEA_PAGES_NGINX_HTTPS_PROBE_ADDR` | HTTPS 实例用于 TLS、SNI 和网站路径预检查的 IP 和端口。 |
| `GITEA_PAGES_NGINX_TEST_COMMAND` | JSON 字符串数组形式的配置检查命令，必须包含一次 `{candidate}`，由运维命令把候选片段放入完整 Nginx 配置后执行检查。 |
| `GITEA_PAGES_NGINX_RELOAD_COMMAND` | JSON 字符串数组形式的重载命令，读取 Nginx 输出根目录下已确认的配置。 |
| `GITEA_PAGES_NGINX_COMMAND_TIMEOUT` | 配置检查和重载命令的最长执行时间，默认 `30s`。 |

HTTPS 和 ACME 使用以下变量：

| 变量 | 作用与取值 |
| --- | --- |
| `GITEA_PAGES_CERT_ROOT` | 可选的运维证书根目录，必须与数据根目录分离，Nginx 模式下也必须与 Nginx 输出根目录分离。Pages 读取 `default/` 和 `hosts/<sha256(host)>/` 下的证书文件并校验；Nginx 模式将当前证书输出到 `GITEA_PAGES_NGINX_ROOT/certs/`。 |
| `GITEA_PAGES_ACME_DIRECTORY_URL` | ACME 服务目录地址；设置后还需要 `GITEA_PAGES_ACME_EMAIL`。留空时只使用运维证书。 |
| `GITEA_PAGES_ACME_EMAIL` | ACME 账户联系邮箱。 |
| `GITEA_PAGES_ACME_EAB_KID`、`GITEA_PAGES_ACME_EAB_HMAC_KEY` | 可选的 ACME 外部账户绑定，两个变量成对提供；密钥使用无填充 base64url 编码。 |
| `GITEA_PAGES_DNS_PROVIDER` | 默认 Pages 域名 DNS-01 provider，取值为 `command`；自定义域名使用 HTTP-01。 |
| `GITEA_PAGES_ACME_DNS_RESOLVER` | lego DNS-01 权威区查找和传播检查使用的递归 DNS；空值继承 `GITEA_PAGES_DNS_RESOLVER`。 |
| `GITEA_PAGES_DNS_PRESENT_COMMAND`、`GITEA_PAGES_DNS_CLEANUP_COMMAND` | 一对 JSON 字符串数组命令，每条都需要各包含一次 `{name}` 和 `{value}`，用于创建和清理 DNS-01 TXT；DNS 服务凭据由服务管理器通过命令环境注入。 |
| `GITEA_PAGES_HTTP01_PROBE_ADDRESSES` | 自定义域名 HTTP-01 预检查的逗号分隔 IP:端口列表；Pages 会逐一访问并确认挑战正文。 |

HTTP 模式不需要证书、ACME 或证书目录；HTTPS 模式必须存在可用的证书来源或完整的 ACME 配置。默认域名的 DNS-01 只由 Pages 维护，Gitea 只维护业务 TXT 校验事实。环境变量配置直接决定实例启动时能否建立相应的服务能力，因此配置错误会在启动阶段报告具体变量和原因。

`GITEA_PAGES_CUSTOM_ROOT` 可选，用于放置实例级平台资源和 Nginx 模板。它只读取以下约定位置：

```text
<custom-root>/public/index.html       standalone 平台首页和 Nginx 首页
<custom-root>/public/errors/404.html 平台 404 页面
<custom-root>/public/assets/**        平台静态资源
<custom-root>/nginx/pages.conf.tmpl   Nginx http 上下文模板
<custom-root>/nginx/server.inc        插入 Pages 管理 server 的片段
<custom-root>/nginx/location.inc      插入网站静态 location 的片段
```

自定义资源统一执行常规文件、路径、数量和总大小检查，符号链接和特殊文件不能进入资源目录。`pages.conf.tmpl` 必须且只能包含一次 `{{ managed_config }}`；Pages 将生成的管理配置插入该位置，`server.inc` 插入每个管理 server，`location.inc` 插入网站静态文件的稳定位置，不改变 HTTP-01、平台资源和内部错误路由。没有自定义模板时使用 Pages 自己生成的 Nginx 配置。Nginx 输出的平台静态资源在启动时与当前资源集合对齐，资源更名或删除后原文件不会继续公开。

数据目录至少包含：

```text
<data-root>/etcd/                         内嵌 etcd
<data-root>/sites/<repo-id>/content-*     不可变已检查内容
<data-root>/sites/<repo-id>/current       Nginx 模式当前内容链接
<data-root>/work/                         下载和展开临时文件
<data-root>/route-state/                  Nginx 路由标记和 config-ready
<data-root>/pages.lock                    进程锁
```

`route-state` 属于 Pages 本地恢复状态，因此与 etcd 和站点目录一起保存在数据根目录；Nginx 进程需要读取网站目录和这些路由标记。`config-ready` 同时记录 Nginx 已接受的配置摘要和证书输出摘要，站点标记只在这份确认状态下开放。Pages 恢复时从同一文件判断当前配置是否仍有效，使无变化的站点只更新标记，配置或证书变化才重新检查并重载。HTTP-01 挑战目录和 Nginx 输出目录独立于 etcd 与网站内容。运维证书目录也与 Pages 可写数据和 Nginx 输出分离，使内容清理、证书导出和运维证书读取不会作用到同一路径。启动时检查路径、权限和命令，错误直接指出变量和原因。

### 实现验收点

- 缺少当前模式必需变量时启动失败并指出具体变量。
- Pages 业务 TXT 和 lego DNS-01 分别使用相应解析器；ACME 解析器空值继承业务 TXT 解析器。
- TXT 刷新周期限制在 `1m` 到 `24h`，同一配置同时控制缓存有效期和主动复查循环。
- Nginx 与 HTTP-01 探测地址在启动时解析为 IP:端口，IPv6 使用带方括号的标准形式，端口范围为 1 到 65535。
- HTTP 模式不要求证书和 ACME；HTTPS 需要证书来源或可用 ACME 配置。
- 自定义根目录只接受约定的平台资源和 Nginx 片段，常规文件、路径、数量和总大小检查在启动时生效。
- Nginx 平台资源输出反映当前内置与自定义资源，重启后旧的自定义静态文件不再可访问。
- Nginx 模板恰好有一个 `{{ managed_config }}`，生成配置、server 片段和网站 location 片段按约定位置合并。
- Nginx 候选配置、证书和 HTTP-01 文件写入指定目录，经过测试后再重载。
- `config-ready` 同时对应当前 Nginx 配置和证书输出；任一摘要变化都会重新检查并重载，站点发布状态变化可以只更新路由标记。
- 网站、路由标记、挑战、etcd、运维证书和 Nginx 输出使用经过重叠检查的目录；Nginx 能读取网站与路由标记，清理一类状态不会删除其他状态。

## 内容目录和归档校验

TAR.GZ 的检查职责和固定资源限制由[发布章节](publishing.md#targz-目录与安全检查)统一定义。Pages 下载后重新计算 SHA-256，在临时目录实际解压并检查路径、条目、大小、深度、符号链接和文件系统结果；通过后成为不可变候选，再由发布器决定入口切换。普通文件执行位清除，允许的站点内相对符号链接保留，链接可以解析到站点根目录，目标尚不存在时也可部署；越界、循环、穿过普通文件、硬链接和特殊文件拒绝，符号链接解析最多 32 层。归档至少包含一个普通文件，文件名和目录位置不受首页约定限制。

Gitea 接收和 Pages 展开使用同步的资源边界，默认是压缩后最多 100 MiB、展开后最多 512 MiB、单个文件最多 100 MiB、最多 10,000 个条目。规范化路径最多 1,024 字节、目录深度最多 32 层、符号链接解析最多 32 层属于格式安全规则并保持一致。两端用相同的 UTF-8 相对路径规则和条目类型规则检查，使成品通过管理面后仍能在实例本地安全展开。

### 实现验收点

- Pages 只安装摘要匹配且完整检查的 TAR.GZ。
- 临时展开失败不会替换当前目录，实际磁盘写入失败保留旧内容。
- 站点内指向未存在目标的相对符号链接可以完成部署，访问时返回网站 404。
- 解析到站点根目录的相对符号链接可以完成部署；越界、循环、穿过普通文件、硬链接和特殊文件得到明确错误。
- 当前目录按 `repo_id` 和成品摘要隔离，同名新仓库不会读取旧目录。
- 资源边界采用最近同步的 Gitea 配置，路径和符号链接安全规则在两端保持一致。
- 归档不依赖 `index.html`；没有首页文件时实际文件仍能按路径访问。

## 证书、TXT 与故障恢复边界

证书、ACME、挑战和私钥由 Pages 维护；Gitea 只保存业务 TXT 结果、实例地址和最终发布错误。业务 TXT 的两端检查见[访问章节](access-and-domains.md#业务-txt-校验与全局配置)，证书细节见[证书章节](certificates.md)。

Gitea 失联时 Pages 使用最后确认的本机状态继续服务，并在本机维护 TXT、证书和清理工作。结果上报失败时 etcd 保留每个站点一份最新待确认结果；etcd 本身无法写入时直接尝试上报当前失败，并由后续扫描重新确认。收到 `state_changed` 后按最新站点事实重新部署。状态损坏时停止 Pages，清理该实例的 `GITEA_PAGES_DATA_ROOT`，再重启实例。空数据根目录会使 Pages 以首次同步方式按 Gitea 提供的时间顺序查询全部站点并重新部署；这条运维恢复路径不需要额外的本地版本状态。

### 实现验收点

- Gitea 不保存 ACME 订单、证书、私钥或 DNS 凭据。
- 失联期间已生效网站继续服务，恢复后从本机状态继续同步。
- 结果上报只有一份待确认内容，旧结果不会覆盖较新的站点事实。
- 本地状态无法写入时使用现有结果接口直接上报错误，恢复后仍按最新事实重试。
- 清理数据根目录并重启后从空状态开始，按 Gitea 时间顺序完成全量同步并重新部署。

## 验证范围

Gitea 使用仓库 Make 入口和 `gitea/docs/testing.md`，Pages 使用 `gitea-page` 的 `make check`。测试重点是行为边界：

| 范围 | 核验内容 |
| --- | --- |
| 数据与查询 | 五张表、时间分页、固定上界、补查和状态重建。 |
| 发布与归档 | 两种自动发布方式、三种版本产生方式、版本恢复与删除、TAR.GZ 完整性、路径安全、链接边界、限额和原子切换。 |
| 服务模式 | standalone、nginx、配置测试、入口探测和旧配置继续服务。 |
| 域名与证书 | TXT、HTTP-01 预检查、默认 DNS-01、运维证书和失败退避。 |
| 故障恢复 | Gitea 失联、Pages 重启、队列满、结果重试和删除清理。 |

### 实现验收点

- 测试分别断言成品已准备、内容已安装、配置已应用和访客入口已发布。
- Gitea 测试遵循仓库 Make 入口；Pages 测试覆盖两种服务模式和内嵌 etcd 恢复。
- 归档测试覆盖路径逃逸、实际展开限额、符号链接、特殊文件、原子切换和旧目录保护。
