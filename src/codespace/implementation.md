# 实施与测试

本文面向贡献者，说明代码归属、验证层次和完成标准。业务行为由其他设计章节定义。

## 仓库与代码边界

| 仓库                 | 职责                                                                            |
| -------------------- | ------------------------------------------------------------------------------- |
| `gitea`              | 业务模型、权限、页面、Manager RPC 和后台任务                                    |
| `codespace-proto-go` | Gitea 与 Manager 的公共 Proto 和生成代码                                        |
| `codespace`          | Manager、Gateway、Cache、Agent、内部 Proto、Dev Container、管理 API 与 Vue 前端 |

公共协议先在 Proto 仓库修改、生成、测试并发布，再更新两个实现仓库的远程依赖。Codespace 内部协议随实现一起生成和测试，并从固定的公共协议依赖读取共享业务类型。Gitea 的业务规则放在 model/service，router 负责请求与响应；Codespace 按控制面、Runtime、Gateway、Cache、Dev Container 和管理界面组织。

逻辑优先留在拥有该行为的领域。只有多个流程共享同一不变量时才提取接口或公共包，以免单次调用的小函数和空抽象分散主要流程。

进程入口只依赖对应领域包的启动接口，路由表、会话、认证缓存和后端适配等协作对象留在所属包内。这样命令层只负责参数、信号和进程生命周期，领域实现可以在不扩大跨包依赖的情况下调整。Gateway 因此只向命令层提供运行入口，HTTP、SSH、Agent 和 Manager 之间的内部协作由 Gateway 包完整拥有。

### 实现验收点

- 每项功能有唯一仓库和领域归属。
- Router/Handler 不重复实现状态机、权限或事务。
- 公共与内部 Proto 均可重复生成，Gitea 与 Codespace 使用已发布的公共模块。
- Gitea 只依赖公共业务协议；Agent、Gateway 与 Cache 的内部协议由 Codespace 项目维护。
- 接口对应真实替换边界，较长流程按稳定业务阶段组织。
- 命令层不构造领域内部协作对象；Gateway 的跨包入口只有完整运行流程。

## 镜像构建与发布

Codespace 仓库的工具版本由模块文件、Makefile 和[持续集成配置](https://github.com/ExplodingDragon/gitea-codespace/tree/main/.github/workflows)统一声明。触发核心 CI 的拉取请求执行格式与静态检查、后端测试、管理界面测试、生成文件检查、镜像冒烟验证和真实 Kubernetes 测试。Provider 代码及其构建输入由对应独立工作流验证，共享输入触发相关工作流，使编辑器更新与平台发布保持各自的验证范围。

平台二进制在 GitHub Runner 上交叉编译为 `linux/amd64`，随后作为任务产物交给镜像验证或发布任务。Docker 构建只安装运行时依赖并复制该二进制，因此编译工具链不会进入核心镜像，验证与发布使用的也是同一份产物。仓库在 `providers/vscode` 和 `providers/dsh` 中提供两个官方 Web IDE 工程，每个工程按自身依赖的架构与工具链独立构建和发布；核心代码维护通用 OCI 元数据协议，并使用一个伪提供方完成平台端到端测试。采用仓库内独立发布单元的原因是官方实现可以与平台一起审计，同时编辑器依赖和更新频率不会扩大控制面镜像、核心构建链或核心发布范围。

核心 CI 在 `main` 分支验证成功后发布平台镜像的 `main` 标签。Helm OCI 要求 Chart 标签与 Chart 的语义化版本一致，因此每次运行发布 `0.1.0-main.<run-number>` 形式的预发布版本，`appVersion` 记录 `main-<commit-sha>`。打包时 CI 把本次平台镜像摘要写入 Chart 的 `image.digest`，使每个 Chart 都对应经过验证的镜像内容。核心镜像与 Chart 产生不可变摘要和来源证明，核心镜像还包含软件物料清单。两个官方 Web IDE 工程分别监听自身目录并发布各自的 `main` 多架构镜像，第三方提供方沿用同一协议自行发布；环境模板保存时把所选版本解析为摘要，因此 Chart 无需绑定编辑器发布周期。

部署已发布的 OCI Chart 时，`--devel` 选择最新预发布版本，`--version <chart-version>` 固定某次发布；两种方式都使用 Chart 内置的平台镜像摘要。源码目录中的 Chart 默认保留 `main` 标签和空摘要，适合本地开发，这与 CI 打包后的内容不同。安装和升级命令以 [Helm 指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/charts/gitea-codespace/README.md)为准。

Manager 只接受带显式标签或摘要的平台镜像引用。标签引用使用 Kubernetes `Always` 拉取策略，让新建或重建的工作负载取得当前内容；摘要引用使用 `IfNotPresent`，复用节点上完全相同的内容。部署新版本时，Chart 的 `appVersion` 和组件 Pod 模板中的平台版本注解触发组件按各自策略更新：Manager、Gateway 滚动更新，Cache 使用 Recreate；正在运行的用户 Runtime 不会仅因标签内容变化而被主动重启。

### 实现验收点

- 触发核心 CI 的拉取请求同时验证 Go、Vue、内部 Proto、CRD、Helm 和最终镜像内容；仅涉及 Provider 的修改进入对应的独立验证流程。
- 核心 CI 的仓库内与外部拉取请求都验证 Kata、Sysbox、Native 三种运行方式，测试使用公开输入而非仓库 Secret；主分支平台发布等待三项验证成功。
- 镜像构建阶段不编译 Go 或前端，验证与发布消费同一份 Runner 构建产物。
- `main` 分支更新核心平台镜像的 `main` 标签，并发布唯一的 Helm 预发布版本。
- 工作流摘要给出核心镜像摘要、Chart 版本和 Chart 摘要；核心发布任务不构建或发布真实 Web IDE。
- 仓库内 VS Code 与 DeepSeek Harness 工程分别验证自身改动，并在 `main` 上独立发布 linux/amd64、linux/arm64 的官方 Provider 镜像。
- 端到端测试使用独立构建且不会发布的伪 Web IDE 镜像，覆盖 OCI 元数据、选项、HTTP、WebSocket、重启和恢复。
- 源码 Chart 默认渲染 `main` 标签与 `Always`；发布的 OCI Chart 渲染本次镜像摘要与 `IfNotPresent`，固定 Chart 版本即可同时固定默认平台镜像。
- 新平台构建触发 Manager、Gateway 和 Cache 更新，不主动重启正在运行的用户 Runtime。
- 发布镜像包含源码提交、MIT 许可证、软件物料清单和来源证明，Chart 包含源码提交、许可证和来源证明。

## 实现职责与设计入口

实现按以下职责分工。行为定义和验收点保留在对应设计章节，本章只说明代码归属与协作方式，使接口变化只需更新一处完整设计。

| 代码范围 | 实现职责 | 行为设计 |
| -------- | -------- | -------- |
| `internal/cluster` 管理 API、`web/src` | 按资源类型校验写入、集群资源发现、表单状态与本地化 | [管理交互与站点接入](runtime-platform.md#管理交互与站点接入) |
| `internal/cluster/api`、资源控制器 | CRD、依赖校验、工作负载投影和独立 Status 更新 | [平台数据](data-model.md#平台数据)、[控制面与资源](runtime-platform.md#控制面与资源) |
| `internal/cluster` 站点协调与操作处理 | Gitea 客户端、操作许可、结果提交和恢复 | [生命周期](lifecycle.md)、[Manager RPC](rpc-spec.md#gitea-控制面) |
| `devcontainer`、`internal/devcontainerruntime`、`internal/agent` | 标准配置解析、平台镜像定制、容器生命周期和凭据投递 | [Runtime 与持久数据](runtime-platform.md#runtime-与持久数据) |
| `internal/webide`、`internal/cluster/web_ide.go`、`providers` | 通用提供方协议、OCI 解析和独立编辑器适配 | [Provider 开发指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/providers/DEVELOPMENT.md) |
| `internal/gateway`、`internal/agent`、`internal/runtimecmd` | 路由与连接复用、Docker exec、访问流传输 | [Gateway 与访问](runtime-platform.md#gateway-与访问)、[内部 RPC](rpc-spec.md#组件与-agent) |
| `internal/cache`、组件控制器与控制流 | Registry、凭据授权和单写维护许可 | [Cache](runtime-platform.md#cache) |
| `internal/agent`、`internal/cgroup`、`internal/cluster` 资源采集 | Agent 探测、Kubernetes 采样、来源选择与完整快照上报 | [运行资源统计](runtime-platform.md#运行资源统计) |
| `internal/logbuffer`、Agent 输出与 Manager 诊断 | 共用脱敏与有界日志缓冲、按操作上传 | [操作日志](rpc-spec.md#操作日志) |

管理 API 为站点、环境模板和组件定义各自的请求结构；前端从当前草稿创建请求快照，再使用写接口返回的资源更新列表。资源专有字段和状态归属保持在对应模块内，使新增配置时能够在同一处审阅解析、校验与提交行为。

标准 Dev Container 引擎提供通用镜像定制回调和容器操作，`internal/devcontainerruntime` 负责平台附加输入。Web IDE 的配置合并、参数和持续运行由镜像内的 `prepare`、`serve` 适配器负责；核心只依赖公共运行协议。这样单容器与 Compose 共用构建保障，编辑器更新也不会扩大核心实现范围。

Manager 默认由 Kubernetes API Priority and Fairness 调度 API 请求；当 kubeconfig 明确提供 QPS 或限流器时采用运维配置。控制器工作队列负责单对象重试和退避，因此 API Server 负责集群级公平，控制器负责业务级收敛。

### 实现验收点

- 站点、模板和组件写接口使用各自的请求类型，校验与错误处理位于对应管理 API。
- 控制器、Agent 和站点协调器分别更新自己负责的运行事实，身份与并发规则按[数据模型](data-model.md#标识并发与清理)验证。
- 单容器与 Compose 使用同一个平台镜像定制入口，标准解析器完整保留 Dev Container 字段。
- Provider 专有配置和进程参数由提供方镜像解释，新增提供方通过公共协议接入。
- HTTP、WebSocket 和 SSH 复用同一 Agent 访问实现，按内部 RPC 的确认、EOF 和取消语义测试。
- 资源统计从 Agent 与 Kubernetes 采样合成完整快照，上报路径只读取缓存。
- Manager 采用集群 API 调度或显式限流配置，单对象失败由控制器工作队列退避。

## 测试层次

| 层次                  | 覆盖重点                                                |
| --------------------- | ------------------------------------------------------- |
| 单元测试              | 解析、权限交集、状态转换、幂等键和纯函数                |
| 数据库测试            | 事务、条件更新、唯一约束和迁移                          |
| 组件集成测试          | RPC 身份、操作领取、Agent 流、Gateway 授权和 Cache 维护 |
| Kubernetes 端到端测试 | CR、PVC、Pod、Leader 切换、隔离运行时、设备、网络和恢复 |
| 浏览器测试            | 创建确认、列表、详情、日志增量加载和管理界面            |
| Helm 测试             | RBAC、身份、服务、网络策略以及标签和摘要镜像            |

测试选择能覆盖风险的最低层次，并通过生产入口验证用户可观察行为。Gitea 使用其 Makefile 和测试文档规定的入口；Codespace 的安装步骤、检查命令和生成入口由[开发指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/DEVELOPMENT.md)维护。本地和 CI 使用相同入口与工具版本，使结果可以复现。

Dev Container 测试使用规范配置验证解析、合并、执行顺序和恢复行为，Compose 测试使用实际加载模型确认目标容器与网络设置。测试断言最终行为而不是内部函数结构，使实现整理后仍能发现配置丢失、命令重放和错误路由。

Web IDE 端到端验证使用独立的伪提供方镜像，覆盖镜像解析、配置传递、适配器执行、访问和持久化。伪提供方可控制进程退出并记录输入，因此核心测试可以验证完整协议，而不依赖真实编辑器的发布和外部下载。官方提供方在各自工作流中验证实际适配器与插件。

### 实现验收点

- 状态机覆盖成功、并发更新、过期身份和恢复路径，真实冲突下仍保留各流程负责的事实。
- Dev Container 测试覆盖标准配置的有效语义，创建、恢复和连接按相应生命周期执行，同一操作的重连与 Pod 替换保持确定结果。
- 配置和资源测试覆盖保存、更新与依赖变化，实际生成的工作负载符合已确认配置。
- 访问与 Cache 测试验证传输取消、授权、执行许可和维护边界，失败能够释放对应资源。
- 权限测试覆盖对象 ID 篡改、跨用户、跨站点和凭据重放。
- 前端测试在项目支持的浏览器中稳定，不依赖精确计时。
- 本地和自动化使用相同的公开测试入口。
- 普通测试独立于集群配置；完整端到端测试通过显式配置的统一入口运行，阶段失败会终止并保留诊断。
- Web IDE 端到端测试覆盖受支持选项类型、HTTP、WebSocket、进程重启和恢复持久化；官方提供方验证各自的真实配置与插件行为。

## 真实环境验证

Kubernetes 端到端测试在专用测试集群中使用摘要固定的平台镜像和独立命名空间。一个集群由同一套 Manager 控制面协调集群级 GiteaSite 和 EnvironmentTemplate；独立命名空间用于组织测试资源，其他 Manager 安装需要在测试前停用，以避免两套控制面修改同一资源。Kata、Sysbox 与 Native 通过同一入口分别执行，使结果明确对应实际 RuntimeClass、默认 CRI、Device Plugin、CDI 与 StorageClass。测试在 Runtime Pod 内验证 Docker、Dev Container 和持久卷，而不是借用开发机的容器运行时。CI 为三种运行方式分别准备全新 k3s worker，导入同一份平台镜像产物；节点准备、测试内核缓存和执行步骤由 [E2E 指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/tests/e2e/README.md)维护。

测试开始前检查集群能力、核心镜像、伪 Web IDE OCI 布局和测试协议服务监听地址，随后覆盖组件身份、Leader 切换、访问路径、S3 兼容缓存和完整生命周期。测试进程提供 Gitea 协议对端，使 Kubernetes 平台测试不依赖另一套产品部署；Gitea 对 Manager 的适配由 Gitea 仓库测试验证。Runtime 内执行的测试及时输出场景开始、结果和失败信息，便于区分外部下载缓慢与执行阻塞。成功后清理测试资源；失败时先收集资源状态、事件和组件日志，再执行清理，诊断文件保留用于定位。

官方 Feature 会从外部下载软件包和二进制。真实环境测试为此保留有界的下载时间，并让外层测试期限大于内层执行期限，使慢速网络下仍能完成安装和失败清理；普通测试仍使用原有的快速入口。

### 实现验收点

- 测试开始前检查集群 API、所选 RuntimeClass 或默认 CRI、StorageClass、镜像和凭据；Native 还检查测试设备资源与 CDI 定义。
- 测试集群在执行期间由本轮测试安装的 Manager 控制面协调。
- 每种支持的隔离模式完成 create、stop、resume、delete 和访问验证。
- Leader 切换、Pod 删除与 Cache 丢失具有恢复验证。
- Runtime Pod 内完成 Docker 数据恢复和 Dev Container 官方场景验证。
- Runtime 内的测试结果在场景结束时立即输出，失败信息保留到外层测试日志。
- S3 Cache 使用隔离的 S3 兼容服务完成写入、读取和清理验证。
- 测试协议服务只实现端到端场景需要的 Gitea 行为，Manager 仍通过公开协议和真实网络连接访问它。
- 测试结束后自动确认没有孤立资源。
- Kata 验证首次块卷初始化，以及替换 Pod 后检查并挂载原文件系统的数据恢复行为。
- Sysbox 验证隔离用户映射和文件系统 PVC；Native 验证 FUSE Device Plugin 分配、CDI 设备节点与分配环境能够进入 Dev Container。

## 完成标准

一次变更完成时，设计、协议、实现、配置与测试需要描述同一当前行为。格式化、静态检查、适用测试和安全边界验证使用仓库公开入口执行；真实环境中未执行的部分在变更说明中记录原因与风险。

### 实现验收点

- 审阅者可以从设计验收点定位对应代码和测试。
- 配置示例、管理页面和部署清单随实现更新。
- 工作树没有意外生成物，测试资源和临时凭据已经清理。
- 变更说明列出已执行测试及尚未验证的真实环境场景。
