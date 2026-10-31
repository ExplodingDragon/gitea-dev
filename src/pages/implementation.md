# 工程入口与验证

本章说明 Gitea 与 Pages 的代码边界、程序入口和验证方式。业务行为由其余章节定义，工程结构把这些行为落实到可以独立构建和测试的模块。

## 仓库、模块与程序入口

Gitea 与 Pages 是两个独立工程。Gitea 负责仓库管理、版本历史、数据库、成品存储和内部接口；Pages 负责同步当前目标、TAR.GZ 展开、本机状态、网站服务和证书。两边只通过[通信协议](communication.md)交换当前事实、当前成品和部署结果。

| 位置 | 作用 |
| --- | --- |
| 顶层工作区 | 使用 `main`，设计文档位于 `src/pages/`。 |
| `gitea/` | Gitea 独立 Git 仓库，Pages 功能分支为 `feat-pages`。 |
| `gitea-page/` | 独立 Go 模块，模块路径为 `gitea.dev/page`，根包为 `page`。 |
| `gitea-page/page.go` | 稳定公共门面，提供配置、服务生命周期、内容和发布接口。 |
| `gitea-page/internal/runtime/` | 同步、etcd、归档、内置 HTTP、TXT、证书与 ACME 实现。 |
| `gitea-page/cmd/main.go` | `gitea-pages` 进程入口，读取 YAML、建立信号上下文并运行公共入口。 |

标准程序使用一个启动形式：

```text
gitea-pages --config /etc/gitea-pages/config.yaml
```

命令使用标准库参数解析。`page.LoadConfig` 严格读取一个 YAML 文档，`page.Run` 组装内置 HTTP 发布器、同步服务和优雅关闭。内置 HTTP 通过配置选择纯 HTTP、前置代理源站或 Pages 自管 HTTPS；这个选择只改变 Web 与证书责任，不改变同步和部署状态机。

Pages 使用 `github.com/go-acme/lego/v5` 实现 ACME，并通过 lego provider 注册表选择默认域名的 DNS 服务商；YAML 直接使用所选 provider 的参数名，使服务商认证和 DNS 行为继续由 lego 维护。Pages 使用 `go.etcd.io/etcd/server/v3/embed` 保存单机运行状态。Gitea 侧遵循仓库 `AGENTS.md` 与测试文档；Pages 侧使用模块 Make 目标完成格式化、静态检查、测试和构建。

### 实现验收点

- Gitea 与 Pages 可以分别解析依赖并构建，版本历史与当前部署通过内部接口连接。
- `go build ./cmd` 生成只有 `--config` 启动参数的 `gitea-pages`。
- YAML 未知字段、额外文档和模式组合错误在启动阶段得到具体错误。
- DNS-01 provider 在 listener 与同步任务启动前完成构造，未知 provider 或无效参数会让标准程序直接返回错误。
- `page.Run` 在 listener 可以接收连接后启动同步，退出信号会关闭同步、HTTP 服务和内嵌 etcd。
- 模块公共门面位于根包，Gitea 协议、同步器、存储和证书细节保持在 `internal/runtime`。

## Pages 内部边界

`Service` 负责实例注册、全量与增量同步、当前 TAR.GZ 下载、摘要检查、归档安全、业务 TXT 和结果上报。`Publisher` 只接收已经展开的不可变 `Content`，负责把 `Deployment` 映射为实际网站入口。标准 `page.Run` 使用包内 HTTP 发布器；外部 Go 程序实现同一接口后使用 `page.NewService`。

同步实现按职责分文件：`store.go` 与 `store_content.go` 保存当前事实和不可变内容；`sync_protocol.go` 处理全量、补查和增量同步；`sync_deploy.go` 处理候选部署事务；`sync_certificates.go` 处理证书维护；`dns_provider.go` 负责从 YAML 参数构造 lego provider；`address.go` 计算所有者 Host 与项目路径；`server.go` 提供内置 HTTP 路由；`config.go` 解析 YAML；`application.go` 组装标准进程。

有界部署队列只保存仓库 ID。工作线程开始时从 etcd 读取最新事实，因此排队期间到达的新摘要、名称或域名会自然生效。同一仓库正在部署时再次更新，当前任务结束后再处理一次最新目标。进程取得数据根目录锁后重建工作目录；已确认内容保存在独立站点目录。

下载和展开先产生候选内容。`Publisher.Publish` 成功后才保存当前安装摘要并清理旧内容；发布器返回错误时先恢复旧入口，核心删除失败候选。关闭和删除先移除入口，再清理内容。部署结果保存前重新核对站点时间、当前摘要和路由事实，迟到任务不能覆盖更新后的站点。结果无法写入 etcd 时继续通过 Gitea 结果接口报告当前故障。

### 实现验收点

- `Service` 与 `Publisher` 的职责可以独立测试，外部发布器无需重复同步和归档安全逻辑。
- `Publisher.Restore` 以迭代器提供本机确认部署，大量站点不需要复制为完整切片。
- 队列项执行时读取最新事实，同一仓库调用串行，不同仓库按配置并行。
- 工作目录在持锁后重建，已确认站点目录保持不变。
- 发布错误保留旧入口；成功发布替代内容后只保留当前摘要目录。
- 结果写入核对当前状态，etcd 写入故障仍会尝试向 Gitea 报告。
- DNS provider 构造与证书维护保持在证书边界内，provider 参数只在构造期间进入进程环境，构造完成后恢复原值。

## Gitea 代码边界

Gitea 侧沿用现有分层：`models/pages` 负责五张表和稳定查询，`modules/pages` 负责 TAR.GZ 检查与存储路径，`services/pages` 负责设置、版本提交、恢复、删除、生命周期和结果事务，路由层只完成请求解析、权限检查和响应转换。

`services/pages/address.go` 集中处理所有者 DNS 标签、实例根地址、自定义 Host 规范化和域名命名空间冲突。域名使用 `golang.org/x/net/idna` 查询映射、双向文字和 DNS 长度检查；Pages 服务只补充多标签、IP 地址和平台命名空间规则。仓库设置页、版本页、Actions 摘要、实例登记和域名登记因此使用同一套地址函数。

`settings.go` 处理站点开关和自动发布来源，`publish.go` 处理成品检查、版本提交、恢复、删除和保留。两者复用同一个仓库站点锁和站点更新时间。仓库关闭、改名、转移、所有者改名和删除通过对应服务事务推进站点时间，使仓库变化与 Pages 通知使用同一提交顺序。

`modules/setting` 保存归档大小、条目数、版本保留数、批量大小、TXT 周期和 DNS 地址等启动配置。`services/pages` 把资源字段组装为 `modules/pages.Limits`。内容使用 Gitea storage 抽象，临时上传使用 Gitea Dropzone 和临时上传模型，仓库提交使用现有锁抽象；实例凭据复用安全随机数、HTTP Authorization、SHA-256 和恒定时间比较工具。

Pages 内容 API 和网页共用版本服务。版本列表按 ID 倒序使用 Gitea 标准分页，并批量读取当前页的 Actions 来源。设置页只读取来源、来源错误和域名配置；版本页展示摘要、首次来源、创建时间与 Current 状态，Current 可查看实例详情或删除，历史版本可恢复或删除。全局管理页使用标准管理表格显示实例 ID、公开根地址、最近通信时间和紧凑操作。

实例创建和重置使用 POST 后重定向到 GET。一次性明文令牌暂存在当前管理员会话，首次 GET 显示并消费，刷新不会重复操作。管理页面复制原始令牌，运维把它写入 Pages YAML 的 `gitea.token`。

Actions 成品提交在 Pages 版本事务中把所属 `ActionRun.HasPagesArtifact` 单调设置为真。运行详情只有该标记存在时才查询当前默认 Pages 地址并显示提交事实；实例结果继续表示当前站点，而不解释为历史运行结果。

### 实现验收点

- 模型、通用模块、业务服务和路由保持 Gitea 现有依赖方向。
- 地址规范化、所有者编码、项目路径和命名空间冲突由同一服务模块处理。
- 来源设置与版本操作各有一个事务入口，并复用站点锁与更新时间。
- 仓库生命周期变化和 Pages 状态在同一事务顺序中提交，失败时共同回滚。
- Pages 成品存储、临时上传、锁、凭据和时间工具复用 Gitea 现有实现。
- 设置页与版本页各自只加载所需数据；版本分页批量读取 Actions 来源，没有逐行查询。
- Current、历史版本和最后一个版本都能按页面确认流程删除；Current 详情按实例显示当前结果。
- 实例创建和重置重定向到 GET，一次性令牌只显示一次并可以复制到 YAML。
- Actions 标记、版本创建和当前指针在同一事务中生效，普通运行不增加 Pages 查询。

## 启动、文档与验证

标准程序从 YAML 得到 Gitea 地址、令牌、公开根地址、数据根目录、监听器、同步、DNS 与证书配置。DNS-01 使用一个 provider 名称和一组 lego 参数，标准构建包含完整 provider 注册表；关注依赖体积的自定义构建使用 lego 官方轻量标签选择所需 provider。三种 HTTPS 责任模式的配置和目录见[数据与本地架构](data-and-validation.md)，证书行为见[证书管理](certificates.md)。作为 Go 依赖时，调用方可以直接构造 `page.Config`，注入日志与 HTTP 客户端，并用自定义 `Publisher` 运行 `Service`。

Pages 模块使用以下入口：

```text
make format
make check
```

`make check` 包含格式检查、`go vet ./...`、`go test ./...` 和 `go build ./...`。Gitea 使用仓库 Make 目标；后端与模板修改分别运行对应 lint，集成测试按 `make test-integration#TestName` 执行。根设计文档使用 mdBook 构建，并检查 Markdown 链接和 Mermaid 语法。

验证围绕行为而不是内部字段数量：配置能否明确责任、当前成品能否安全部署、旧内容能否在失败时保留、Gitea 能否看到当前结果，以及清空本地状态后能否全部恢复。这样实现可以在保持外部行为的前提下继续整理内部代码。

### 实现验收点

- `make check` 在 Pages 模块完成格式、静态检查、完整测试和构建。
- Gitea 修改通过对应格式化、模板 lint、后端检查和目标集成测试。
- HTTP、前置代理源站和 Pages 自管 HTTPS 都有发布确认测试。
- DNS-01 测试覆盖 provider 选择、参数隔离、环境恢复、传播解析器和失败退避。
- 归档测试覆盖摘要、限额、路径、相对符号链接、执行位清理和原子替换。
- 同步测试覆盖全量分页、补查、增量游标、迟到结果和本地状态恢复。
- 设计文档的章节验收点可以对应到代码路径或自动化测试，mdBook 能完整构建。
