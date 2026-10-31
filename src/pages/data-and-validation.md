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

相同内容再次提交时复用原版本，因此首次来源保持稳定。Actions 的另一次运行提交相同内容时不会复制版本或改变首次来源。`[pages] MAX_VERSIONS_PER_SITE` 控制每个站点保留数量，默认 10，允许 1 到 100；每次成功提交或恢复时保留当前版本和其余最新版本，并在数据库事务提交后清理失去引用的对象。用户可以删除任意版本；删除当前版本的事务同时清空当前指针、关闭 Pages 并推进站点更新时间，删除历史版本只移除版本引用。提交后才清理无引用对象。同步裁剪使配置降低后在下一次内容操作自然生效，不需要计划任务。

### `pages_instance`

每行对应一个全局管理员登记的 Pages 实例。

| 字段 | 含义 |
| --- | --- |
| `id` | 实例 ID。 |
| `root_url`、`root_updated_unix_nano` | 实例注册的根地址及其 Gitea 更新时间。 |
| `last_communication_unix` | 当前凭据最近一次通过认证访问 Gitea 的时间；`0` 表示尚未通信。 |
| `token_hash` | 实例通信凭据的 SHA-256，Gitea 不保存明文。 |

证书、DNS、数据目录和 HTTPS 责任模式属于 Pages 本机配置，不进入 Gitea 表。

### `pages_domain`

每行对应一个自定义域名绑定。`host` 规范化后全局唯一；业务 TXT 结果由 Gitea 维护，Pages 进行本机复查。

| 字段 | 含义 |
| --- | --- |
| `id`、`repo_id`、`host` | 绑定身份、所属站点和规范化 Host。 |
| `txt_token`、`txt_result` | 业务 TXT 期望值和最近结果。 |
| `state` | `pending`、`active` 或 `releasing`。 |
| `txt_last_success_unix_nano`、`txt_last_check_unix` | 最近成功时间和最近一次 Gitea 实际查询时间；后者为 `0` 表示等待首次查询。 |
| `created_unix_nano` | 创建时间。 |

ACME 账户、证书、私钥和 DNS 服务商凭据由 Pages 本机管理。

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

### 实现验收点

- 数据库包含 `pages_site`、`pages_version`、`pages_instance`、`pages_domain` 和 `pages_instance_site` 五张 Pages 业务表。
- 站点使用 `current_version_id` 指向当前内容；版本表按仓库和摘要唯一，并只保存版本身份、首次来源和创建时间。
- 相同内容重复提交复用版本，版本首次来源保持不变。
- 版本创建或复用和当前指针切换在一个事务中提交。
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

Pages 使用 `go.etcd.io/etcd/server/v3/embed` 启动独立单成员 etcd。客户端、Peer 和指标服务只在进程内使用，不绑定外部端口。YAML 中的 `pages.data_root` 指定唯一数据根目录，进程锁保证同一目录只有一个 Pages 进程。

etcd 保存 Gitea 查询游标、最近确认的归档限额和业务 TXT 要求、当前站点事实、实际安装摘要、地址开放状态、证书与 ACME 当前材料、有限重试信息、全量同步恢复标记以及每个站点一份待确认结果。错误码属于部署结果，TXT 本地状态只保存最近检查和最近成功时间，当前有效性在读取时按固定宽限期推导。前缀读取使用固定大小分页，完整前缀清理使用 etcd 范围删除，使站点数量增加时单次响应仍保持有界。

网站内容位于 `sites/`，临时下载和展开位于 `work/`。进程取得数据根目录锁后重建 `work/`，清理异常退出遗留的半成品；已经确认的不可变内容位于独立站点目录，不受启动清理影响。

收到当前站点后先保存事实，再把仓库 ID 放入有界部署队列。工作线程开始处理时重新读取该仓库的最新事实，因此排队期间发生的摘要、名称或域名变化会自然生效。同一仓库正在部署时再次更新，会在当前任务结束后再处理一次。队列满时，扫描协程在出现空位后继续填充；启动时执行恢复扫描，运行期间每五分钟扫描仍未落实的目标。

部署主动下载当前 TAR.GZ，完成摘要和归档检查后展开为不可变候选，再交给发布器。发布器确认入口后保存安装摘要并清理旧目录；发布器返回错误时恢复旧入口并删除失败候选。embedded etcd 无法保存部署结果时，实例仍直接尝试上报当前失败，使仓库页面能看到本地存储故障。

### 实现验收点

- 每个实例运行一个不开放网络端口的内嵌 etcd，同一数据根目录只能由一个进程使用。
- etcd 前缀按固定页读取，完整前缀使用范围删除，大量站点不会形成无限响应。
- 启动时重建 `work/`，异常退出遗留的临时内容得到清理，`sites/` 中已确认内容保持不变。
- 初次同步和当前成品变化都会主动部署，访客请求只读取已确认内容。
- 队列只保存仓库 ID，执行时读取最新事实；队列满后扫描协程会随空位继续安排。
- 发布错误保留旧入口和旧内容；没有旧内容时对应地址保持未发布。
- etcd 写入故障仍会通过现有结果接口报告，恢复扫描继续按最新事实处理。

## 内置服务与可嵌入发布器

`gitea.dev/page` 同时提供标准程序和 Go 公共包。`page.Run` 组装内置 HTTP 服务、同步服务和优雅关闭；自定义 Web 端实现 `Publisher` 后使用 `page.NewService`，复用 Gitea 注册、同步、TAR.GZ 检查、业务 TXT 和结果上报。

`Publisher.Restore` 在启动时以迭代器提供已确认部署，避免为大量站点复制完整切片。`Publish` 收到仓库 ID、默认地址、可选自定义地址和已经检查的 `Content`；内容可以通过 `Content.Open` 读取，也可以取得只读目录接入现有 Web 服务。`Publication` 分别说明默认地址与自定义地址是否已经实际可用。发布器返回错误表示入口应用失败，并在返回前恢复原有入口；`Unpublish` 成功后核心再清理内容和保存关闭结果。

同一仓库的发布调用由核心串行，不同仓库按部署并发设置并行。内容目录在下一次成功发布或关闭前保持有效。自定义发布器负责自己的 HTTP、TLS 和入口核验，核心继续负责内容与状态闭环。

标准程序只有一个内置 HTTP 发布器。`server.https.mode` 用来说明公开 HTTPS 的责任归属：

| 模式 | 公开地址 | 本机服务和确认方式 |
| --- | --- | --- |
| `disabled` | HTTP | Pages 监听 HTTP，并通过该监听器确认网站已生效。 |
| `proxy` | HTTPS | Pages 只监听 HTTP 源站；前置代理终止 TLS 并保留原始 Host，Pages 通过本机 HTTP 源站确认网站已生效。 |
| `pages` | HTTPS | Pages 同时监听 HTTP 和 HTTPS，管理证书与 ACME；已知 Host 的普通 HTTP 请求跳转到 HTTPS，HTTP-01 挑战直接响应。 |

`proxy` 模式把外部 TLS、代理健康和转发配置交给部署者，Pages 只确认自己直接控制的 HTTP 源站。这样发布成功表示内容和路由已经在本进程生效，不依赖 Pages 无法可靠观察的代理内部状态。`pages` 模式的 HTTPS 探测使用本机 HTTPS listener、真实 Host 和证书名称，证书与路由同时可用后才确认地址。

归档只要求至少一个普通文件。内置服务在目录存在 `index.html` 时按静态网站处理；没有首页时目录请求返回 404，实际文件仍可按完整路径访问。

### 实现验收点

- `page.Run` 可以运行内置 HTTP 服务，自定义程序可以只依赖公开类型实现 `Publisher` 并运行 `Service`。
- 自定义发布器收到的内容已经完成摘要、路径、大小、条目和符号链接检查。
- 启动恢复使用迭代访问；同一仓库发布串行，不同仓库可以并行。
- 发布器错误恢复旧入口，成功关闭入口后核心再清理内容。
- `disabled` 通过 HTTP 服务和探测，`proxy` 通过本机 HTTP 源站服务和探测，`pages` 通过本机 HTTPS 服务和证书探测。
- `proxy` 向 Gitea 注册 HTTPS 根地址，同时不启动证书、ACME 或 HTTP-01 处理。
- 没有 `index.html` 的有效归档可以发布，实际文件仍可访问。

## Gitea 配置、Pages YAML 与数据根目录

Gitea 从 `app.ini` 的 `[pages]` 读取发布资源限制和域名所有权要求，从 `[storage.pages]` 读取成品存储。资源限制由所有接收入口、分支打包和 Pages 实例部署共同使用；存储复用 Gitea storage 抽象，因此本地、MinIO 和其他已支持后端使用同一套版本代码。

| `[pages]` 配置 | 默认值 | 作用与原因 |
| --- | --- | --- |
| `MAX_TAR_GZ_SIZE` | `100MiB` | 成品压缩大小上限。 |
| `MAX_SITE_SIZE` | `512MiB` | 展开后全部普通文件总大小上限。 |
| `MAX_FILE_SIZE` | `100MiB` | 单个普通文件大小上限。 |
| `MAX_ENTRIES` | `10000` | TAR 条目数上限。 |
| `MAX_VERSIONS_PER_SITE` | `10` | 每个仓库保留的版本数，范围 1 到 100。 |
| `BRANCH_SOURCE_BATCH_SIZE` | `50` | 每次分支来源任务处理的仓库数。 |
| `DOMAIN_VERIFICATION_BATCH_SIZE` | `100` | 每次业务 TXT 任务处理的域名数。 |
| `DOMAIN_VERIFICATION_INTERVAL` | `15m` | 同一域名两次 Gitea TXT 查询的最短间隔，范围 `1m` 到 `24h`。 |
| `REQUIRE_GITEA_TXT_RECORD` | `true` | 控制 Gitea 和 Pages 是否要求业务 TXT。 |
| `DNS_RESOLVER` | 空 | Gitea 业务 TXT 使用的递归 DNS；空值使用系统解析器。 |

`[storage.pages]` 没有独立配置时继承 `[storage]`。本地默认路径为 `data/pages`，MinIO 默认前缀为 `pages/`。Pages 实例始终通过 Gitea 的鉴权接口下载 TAR.GZ，不读取存储后端配置或凭据。

Pages 标准程序使用 `gitea-pages --config <path>` 读取一个 YAML 文件。解析器检查未知字段，并要求文件只有一个 YAML 文档。配置按职责分组：

| YAML 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `gitea.url` | 必填 | Gitea HTTP 或 HTTPS 根地址。 |
| `gitea.token` | 必填 | 当前登记实例的通信凭据。 |
| `pages.root_url` | 必填 | 向 Gitea 登记的公开根地址，使用标准 HTTP 或 HTTPS 端口。 |
| `pages.data_root` | 必填 | 内嵌 etcd、网站内容、工作目录和进程锁的绝对根目录。 |
| `pages.custom_root` | 空 | 自定义平台资源绝对目录。 |
| `server.http_listen` | 必填 | 内置 HTTP 监听地址。 |
| `server.https.mode` | 必填 | `disabled`、`proxy` 或 `pages`。 |
| `server.https.listen` | `pages` 模式必填 | 内置 HTTPS 监听地址。 |
| `server.https.certificate_root` | 空 | 运维证书绝对目录，与数据根目录分离。 |
| `server.https.acme.directory_url` | 空 | ACME directory 地址。 |
| `server.https.acme.email` | 空 | ACME 联系邮箱，启用 ACME 时必填。 |
| `server.https.acme.eab.kid`、`hmac_key` | 空 | 成对提供的 EAB 标识与 base64url 密钥。 |
| `server.https.acme.dns01.resolver` | 业务 TXT 解析器 | lego 的权威区查找与传播检查解析器。 |
| `server.https.acme.dns01.provider` | 空 | 为实例默认根域和通配符证书选择的 lego 服务商代码。 |
| `server.https.acme.dns01.parameters` | 空 | 按所选 lego provider 文档命名的字符串参数。 |
| `server.https.acme.http01.probe_addresses` | 空 | 自定义域名 HTTP-01 预检查使用的 IP:端口列表。 |
| `sync.interval` | `1m` | 增量同步周期，最短一分钟。 |
| `sync.deploy_timeout` | `10m` | 单个部署的最长时间。 |
| `sync.queue_size` | `32` | 有界部署队列容量。 |
| `sync.concurrency` | `2` | 部署工作线程数量。 |
| `storage.etcd_quota_bytes` | `2147483648` | 内嵌 etcd 配额，最小 64 MiB。 |
| `domains.resolver` | 系统解析器 | Pages 本机业务 TXT 的递归 DNS。 |
| `domains.refresh_interval` | `15m` | 本机 TXT 缓存与复查周期，范围 `1m` 到 `24h`。 |

`server.https.mode=disabled` 对应 HTTP 根地址；`proxy` 和 `pages` 对应 HTTPS 根地址。证书与 ACME 字段只在 `pages` 模式生效，因此配置组合在启动时即可判断。运维证书目录可以提供默认证书和按 Host 保存的证书；ACME 配置见[证书章节](certificates.md)。

DNS-01 的 `parameters` 使用 lego 各 provider 文档中的原始参数名，值统一写成字符串。带 `_FILE` 后缀的参数引用只读机密文件，适合容器 secret；支持实例角色或工作负载身份的 provider 可以使用自身凭据链。Pages 在启动时一次性构造 provider，随后恢复进程原有环境并复用该实例。标准构建包含 lego provider 注册表；自定义轻量构建可通过 `lego_dnslight` 和需要的 `lego_dns_<code>` 标签选择服务商。

`pages.custom_root` 中的路径直接覆盖内置平台资源：

```text
<custom-root>/index.html
<custom-root>/errors/404.html
<custom-root>/assets/**
```

启动时检查根目录、常规文件、相对路径、文件数量和总大小。自定义资源最多 1,000 个文件、总计 16 MiB。

数据根目录包含：

```text
<data-root>/etcd/                         内嵌 etcd
<data-root>/sites/<repo-id>/content-*     不可变已检查内容
<data-root>/work/                         下载和展开临时文件
<data-root>/pages.lock                    进程锁
```

运维证书目录与数据根目录分离，使内容清理不会作用到证书输入。清空数据根目录是本地状态损坏后的恢复入口；下一次启动没有游标，会全部查询并重新部署当前站点。

### 实现验收点

- Gitea 启动时校验 `[pages]` 大小、数量、周期、批量和 DNS 配置，并指出错误字段。
- `[storage.pages]` 可以继承通用存储或使用 Gitea 已支持的远程后端，Pages 实例只通过鉴权接口下载内容。
- 标准程序只通过 `--config` 读取严格 YAML，未知字段、额外文档和不一致的 HTTPS 模式在启动时返回具体错误。
- Gitea 地址可以使用 HTTP 或 HTTPS；`pages.root_url` 与 HTTPS 责任模式保持一致。
- `proxy` 只要求 HTTP listener；`pages` 同时要求 HTTP 和 HTTPS listener，并加载证书配置。
- Pages 业务 TXT 与 lego DNS-01 可以使用不同解析器，ACME 解析器空值继承业务 TXT 解析器。
- DNS-01 provider 名称和参数来自 YAML，参数构造结束后恢复进程环境，凭据不会进入 etcd 或 Gitea 上报。
- 标准构建可在运行时选择 lego provider，轻量构建选择未编入的 provider 时在启动阶段返回错误。
- 自定义根目录按与内置资源一致的相对路径覆盖首页、404 和 assets，并执行文件数与总大小检查。
- 数据根目录只有 etcd、站点内容、临时工作和进程锁；清空后自然执行全部查询。

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

Gitea 失联时 Pages 使用最后确认的本机状态继续服务，并在本机维护 TXT、证书和清理工作。结果上报失败时 etcd 保留每个站点一份最新待确认结果；etcd 本身无法写入时直接尝试上报当前失败，并由后续扫描重新确认。收到 `state_changed` 后按最新站点事实重新部署。状态损坏时停止 Pages，清理 YAML 中 `pages.data_root` 指定的数据根目录，再重启实例。空数据根目录会使 Pages 以首次同步方式按 Gitea 提供的时间顺序查询全部站点并重新部署；这条运维恢复路径不需要额外的本地版本状态。

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
| Web 服务 | HTTP、反向代理源站、Pages 自管 HTTPS、入口探测和旧内容继续服务。 |
| 域名与证书 | TXT、HTTP-01 预检查、默认 DNS-01、运维证书和失败退避。 |
| 故障恢复 | Gitea 失联、Pages 重启、队列满、结果重试和删除清理。 |

### 实现验收点

- 测试分别断言成品已准备、内容已安装、配置已应用和访客入口已发布。
- Gitea 测试遵循仓库 Make 入口；Pages 测试覆盖三种 HTTPS 责任模式和内嵌 etcd 恢复。
- 归档测试覆盖路径逃逸、实际展开限额、符号链接、特殊文件、原子切换和旧目录保护。
