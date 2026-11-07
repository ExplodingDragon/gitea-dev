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

Codespace 仓库的持续集成使用仓库声明的 Go 版本、Node.js 24、pnpm 12.16.1 和固定版本的 Helm。拉取请求执行格式与静态检查、后端测试、管理界面测试、生成文件检查和镜像冒烟验证。这样可以在合并前同时验证源代码、已提交的前端资源、CRD、Helm 模板和最终运行环境。

平台二进制在 GitHub Runner 上交叉编译为 `linux/amd64`，随后作为任务产物交给镜像验证或发布任务。Docker 构建只安装运行时依赖并复制该二进制，因此编译工具链不会进入镜像，验证与发布使用的也是同一份产物。当前已完成真实验证的运行环境为 AMD64；增加其他架构前，需要先完成对应 RuntimeClass 和端到端验证。

`main` 分支更新时发布平台镜像 `ghcr.io/explodingdragon/gitea-codespace:main`。Helm OCI 要求 Chart 标签与 Chart 的语义化版本一致，因此每次运行发布 `0.1.0-main.<run-number>` 形式的预发布版本。镜像标签提供连续开发通道，Chart 预发布版本保留每次部署配置，两者都产生不可变摘要和来源证明，平台镜像还包含软件物料清单。

开发部署使用 Helm 的 `--devel` 选择最新预发布 Chart，并默认使用平台镜像的 `main` 标签。可复现部署使用工作流摘要中的精确 Chart 版本或 Chart 摘要，同时设置平台镜像摘要。正式发布 `0.1.0` 后，源码中的开发版本进入下一版本的预发布序列，保证 `--devel` 仍能选择到比正式版更新的开发 Chart。

Manager 只接受带显式标签或摘要的平台镜像引用。标签引用使用 Kubernetes `Always` 拉取策略，让新建或重建的工作负载取得当前内容；摘要引用使用 `IfNotPresent`，复用节点上完全相同的内容。Chart 的 `appVersion` 和组件 Pod 模板中的平台版本注解使 Manager、Gateway 与 Cache 在新构建发布后滚动更新；正在运行的用户 Runtime 不会仅因标签内容变化而被主动重启。

### 实现验收点

- 拉取请求同时验证 Go、Vue、内部 Proto、CRD、Helm 和最终镜像内容。
- 镜像构建阶段不编译 Go 或前端，验证与发布消费同一份 Runner 构建产物。
- `main` 分支更新平台镜像的 `main` 标签，并发布唯一的 Helm 预发布版本。
- 工作流摘要给出平台镜像摘要、Chart 版本和 Chart 摘要。
- 默认 Chart 渲染标签镜像与 `Always`，设置镜像摘要后渲染摘要引用与 `IfNotPresent`。
- 新平台构建触发 Manager、Gateway 和 Cache 更新，不主动重启正在运行的用户 Runtime。
- 发布镜像包含源码提交、MIT 许可证、软件物料清单和来源证明，Chart 包含源码提交、许可证和来源证明。

## 管理配置与集群投影

管理 API 为站点、环境模板和组件使用各自的请求结构。每类端点只接收自身需要的 Secret 或角色特有字段，因此新增字段时可以在对应资源边界内审阅，不会被一个通用 JSON 包装层静默吞掉。并发更新继续携带 Kubernetes UID 与 `resourceVersion`，写入前核对同名对象仍是用户看到的实例。

管理页面始终使用当前浏览器来源的相对 API 地址，不保存单独的“管理公开地址”。这是因为页面可能通过端口转发、集群内代理或 Ingress 访问，访问地址属于部署入口而不是管理员身份。管理 Token、服务端会话、同站 Cookie 和 CSRF 继续承担鉴权；Cookie 是否带 `Secure` 根据实际 TLS 请求或 HTTPS Origin 决定。站点、环境模板和组件的新资源名由服务端生成，管理员只填写有业务含义的显示名称、Tag 和说明，避免把 Kubernetes 标识误当作可修改配置。

管理 API 从当前集群读取带隔离标签的 RuntimeClass、StorageClass、IngressClass、TLS Secret 和 cert-manager Issuer，管理页面据此提供下拉选择。保存模板或组件时，服务端重新读取被引用资源并核对隔离标签、资源类型和当前身份，因为页面加载后集群资源仍可能被删除或修改。CPU、内存、存储、缓存容量和时长在页面中按“数值 + 单位”编辑，提交后转换为 Kubernetes quantity、字节大小或 duration 字符串；这样既保留 Kubernetes 原生语义，也减少手写单位造成的配置错误。

管理页面把页面级操作、列表行操作和表单提交操作分别放在固定位置。页面级操作位于标题右侧，列表行操作使用右对齐的等高图标按钮，删除操作位于最右侧；编辑表单按业务章节组织，两列字段使用统一网格，URL、证书、JSON 和多行内容占据整行，窄屏下自动变为单列。不同操作采用独立样式，是因为它们的作用范围和使用频率不同；明确的布局边界也避免新增字段后依赖表格末列或 DOM 层级等隐式规则发生错位。

环境模板保存后由控制器重新读取 RuntimeClass 与 StorageClass，并用当前 generation 写入 `Ready` Condition。依赖可用时直接就绪，依赖缺失或隔离标签不匹配时记录明确原因；资源恢复后同一协调流程自动恢复就绪。Condition 只描述 Kubernetes 中可观察的依赖并绑定当前配置版本，因此配置变化后会重新计算结论。

Runtime 的 Git 凭据由 Agent 写入 Pod 内存卷。宿主侧克隆使用 `/run/codespace`，映射进主 Dev Container 后使用 `/var/lib/gitea-codespace`；配置代码分别生成对应路径的 Git credential helper 命令和 SSH 命令。HTTP helper 绑定经过身份检查的 Gitea 基础地址，仅为该地址下的仓库读取 Token；SSH 命令固定使用站点私钥和 `known_hosts`。采用 Git 原生配置可以让 Token 只在对应站点认证时从文件读取，也避免运行用户执行 root 挂载目录中的脚本。站点的运行出站网络同时承担 Gitea 克隆与生命周期访问，页面把它表述为 CIDR 和 TCP 端口列表，便于管理员根据克隆错误中的协议与目标主机定位缺少的规则。

管理页面把初次加载和保存作为两个独立的异步状态。保存时从当前表单创建请求快照，服务端返回写入后的完整资源，页面用该响应更新列表；失败时编辑器、输入值和未保存标记保持不变。这样资源版本冲突或短暂网络错误不会让管理员重新填写配置，也不会因为保存成功后的额外列表请求失败而把成功写入显示成失败。

新建 Gitea 站点时，管理 API 接收显示名称、Gitea 连接地址和注册令牌。服务端先验证可选站点配额以及模板、Gateway、Cache 的名称和 UID，再调用 Gitea 注册接口；成功后由服务端生成站点资源名，把返回的 Manager ID 写入 `GiteaSite`，并把运行密钥写入受管 Secret。这个顺序避免无效的本地配置在 Gitea 留下 Manager。注册令牌仅用于该次远程调用，不进入 CR、Secret 或读取响应。站点编辑保留原 Manager 身份和凭据引用，管理页面无需展示或回传这些内部字段。

站点可以保存一组 PEM 格式的 CA 证书。留空时注册、身份检查和运行协调使用系统信任库；填写时在系统信任库上追加这些证书。所有面向该站点的 HTTP Client 都从同一构造路径取得超时、重定向策略和信任库，因此不同站点的证书不会进入全局进程状态。保存已有站点前会使用原 Manager 凭据和新地址、新 CA 完成身份检查；检查失败时旧资源保持不变，页面继续保留草稿。

站点连接地址用于 Manager 发起控制面请求，适合填写集群能够到达的内部地址。Gitea 返回的规范 Web 地址由控制器在身份检查后写入 Status，供 Gateway 和用户入口使用。两者分别保存是为了支持公开地址与集群网络地址不同的部署，同时保证运行流量不会被意外切换到浏览器入口。

Gitea 注册已经提交而后续 Kubernetes 写入失败时，两个系统之间没有可用的分布式事务。此时 Gitea 会保留一个尚未连接的 Manager，管理员可在 Gitea 的 Manager 页面删除它；管理 API 不自动重试注册，避免一次请求产生多个身份。

Gateway 和 Cache 使用集群级 `CodespaceComponent` 保存声明式配置。组件控制器把配置投影为管理命名空间中的 Deployment、Service、NetworkPolicy、身份 Secret，以及按需创建的 PVC、Ingress 和 SSH LoadBalancer Service。Kubernetes API 因此能直接校验字段和角色，管理页面、控制器与组件控制流也读取同一种类型，配置的结构和生命周期保持一致。

控制器更新 CR Status 时重新读取当前 UID 对应的对象，并只合并当前流程负责的观察结果。配置校验结果同时绑定其 generation，Runtime 结果同时绑定操作版本和 Pod UID；Status 冲突重试不会包含远程 Gitea RPC。Deployment、Service、Ingress、PVC 和 PDB 通过补丁提交期望规格，使 Kubernetes 内置控制器并行更新其 Status 时仍能正常收敛。

站点协调器只把已经持久化到 Codespace CR 且持有当前执行许可的普通操作加入 `ObservedOperations`。Gitea 因此可以在 Fetch 响应丢失或 Leader 重启时重新下发当前输入，而 Manager 的幂等校验会复用相同 Runtime UUID 和操作版本并恢复许可。确定性 create/resume 拒绝先撤销许可，再通过 `FinalizeOperation` 提交失败；提交暂时失败时 Gitea 仍会重新下发，成功后局部 CR 复用 Runtime 控制器已有的 delete/stop 恢复动作。暂时性 Kubernetes 与网络错误继续由协调循环重试。未绑定且已进入清理的 CR 不参与身份绑定和完整资源清单，使站点恢复状态只取决于仍可执行的 Runtime。

Gateway 规格保存期望副本数。控制器为多副本 Gateway 配置零不可用滚动更新、一个额外更新副本、跨节点软分散和最多一个不可用的 PDB；状态中至少一个副本就绪表示入口可用，少于期望数表示降级。Cache 没有副本配置，控制器固定生成一个副本和 Recreate 策略；管理状态还需要同时确认其 Kubernetes Lease，避免把只启动但尚未取得单写许可的进程标记为可用。

Manager、Gateway 和 Cache 在各自 Pod 的 `8081` 端口提供独立的明文 HTTP 健康服务，并统一使用 `/healthz` 表示进程存活、`/readyz` 表示可以接收业务流量。这个端口只由 Kubelet 直接探测，不加入 Service、Ingress 和业务 NetworkPolicy 端口，因此健康检查不依赖内部证书，也不会成为公开业务接口。Gateway 在 HTTP 与 SSH 监听成功且运行许可有效时就绪，控制流短暂断开期间继续使用剩余许可；Cache 在取得单写许可、完成存储初始化并启动 mTLS Registry 后就绪。外部控制面暂时不可用只影响就绪状态，进程自身仍然存活，避免无效重启扩大故障。

组件凭据保存在由组件 UID 拥有的 Secret 中。UID 是身份边界的原因在于同名资源可以被删除后重建，而新资源不能继承旧组件的证书、SSH 主机密钥或缓存密钥。S3 访问密钥只通过管理 API 写入 Secret，组件列表和 CR 均不返回明文。

环境模板和 Cache 的出站代理使用同一个结构。管理页面提交并回显完整的代理 URL、直连目标和可选 CA；需要认证时，用户名和密码使用标准 URL 用户信息表示，并按 URL 规则编码。完整 URL 是运行工具最终消费的配置，而且管理员和运行进程都能读取它，因此单独维护“保留、替换、清除”凭据状态不会形成额外的安全边界。服务端从声明生成大小写两套标准代理环境变量，并自动加入 Kubernetes Service、回环地址等平台直连目标。Agent、Dev Container 构建和容器运行使用同一份代理变量名称清单，使新增工具或调整变量时不会在不同执行阶段形成不一致。创建 Codespace 时直接从 Codespace 中已经确认的模板快照生成实例 Secret，随后 Runtime Pod、Agent、内层 Docker 和 Dev Container 只读取这份实例投影；Cache 则把组件声明投影到已有的组件 Secret。这样声明、实例快照和运行环境之间只有一条可重建的数据路径，同时公共 Gitea 协议不需要承载 Kubernetes 或代理实现细节。

Dev Container 引擎把代理环境作为单次平台输入处理。Dockerfile、Feature 和 Compose 构建使用 Docker 预定义代理构建参数，主容器和关联 Compose 服务接收相同环境，仓库声明的直连目标与平台目标合并去重。只有平台配置了代理地址时，引擎才把 Compose 服务名和显式网络别名加入 `NO_PROXY`，使服务间访问继续使用 Compose 内部 DNS，同时不改变未启用代理的容器环境。Compose 的隐式默认网络和短格式网络在解析模型中可以没有额外网络配置；引擎仍保留服务名，并只从存在的配置读取别名，这是标准 Compose 配置能够直接运行所必需的行为。代理输入不合并进 `devcontainer.json` 的解析结果，也不写入 Runtime 的持久状态和镜像缓存标识；恢复时由 Pod Secret 从 Codespace 快照重新投影。这样既符合常见工具读取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 和 `NO_PROXY` 的方式，也不会为同一代理配置维护第二套凭据状态。

标准 Dev Container 包负责解析配置、安装 Feature、调整远程用户以及创建和控制 Docker 资源。Codespace 的 Gitea CLI、模板脚本和其他平台镜像内容由 `internal/devcontainerruntime` 通过一个最终镜像定制回调写入临时构建上下文。Docker 引擎继续统一负责目标平台探测、缓存、代理、构建标签和临时目录清理，因此单容器和 Compose 使用相同的构建保障；运行时层掌握平台配置及执行顺序，因此平台能力不会与标准 Dev Container 语义混在一起。镜像定制发生在 Feature 和远程用户镜像之后，使管理员的 `build` 脚本仍是最终可配置构建动作。

容器内的运行时子命令负责准备和监督 Web IDE。创建阶段只写一次仓库设置，监督命令以远程用户和工作区环境脱离生命周期请求运行，通过文件锁阻止重复实例，并在 code-server 退出后按有上限的间隔重启。创建和恢复流程把启动错误与平台连接阶段的 `postAttachCommand` 错误写入操作日志后继续，因为 Web IDE 属于附加服务，不能改变 Dev Container 已经可用的事实。Workspace endpoint 是否发布只由环境模板的 Web IDE 开关决定，连接命令仅为这个内置端点提供短时间等待，使重启过程不扩散到其他端口转发。

Cache 控制连接身份、Registry HTTPS 证书和 Registry 签名密钥分别保存。组件控制器根据同名 Service 推导 DNS 地址，签发只含该名称的短期服务证书，并把 `443/https` Service 投影到容器 `8443`。文件型证书源在启动时校验证书、私钥和信任根，随后复用内存中的完整快照；新 TLS 握手每分钟最多检查一次 Secret 投影文件，成功后原子替换快照。这样既能在不重建 Pod 的情况下使用续期证书，也不会把文件读取放入每次握手。Runtime Agent 在启动 Docker 前把内部根证书安装到对应主机的 `certs.d` 目录，证书续期、组件 API 身份和 Registry 数据访问因此保持各自明确的边界，管理 API 也无需保存可推导的缓存地址。

Manager 下发的短期缓存令牌由 Agent 在创建操作期间写入 Runtime 内存卷中的标准 Docker `config.json`。Runtime Pod 的 `DOCKER_CONFIG` 指向该目录，使进程内 Docker CLI 与 Compose Bake 启动的外部 Buildx 使用同一凭据。Agent 在构建返回后删除文件，恢复状态只保存 Dev Container 结构和容器身份。Cache Registry 使用 HTTPS Basic challenge 接收固定用户名和短期令牌，这条标准认证路径已经包含所需的作用域和有效期校验，因此不需要单独的令牌交换协议。

Manager 默认由 Kubernetes API Priority and Fairness 调度 API 请求，不再叠加 client-go 的低吞吐令牌桶；当 kubeconfig 明确提供 QPS 或限流器时仍采用运维配置。控制器工作队列继续负责单对象重试和退避，因此 API Server 负责集群级公平，控制器负责业务级收敛，两层职责不会重复限制同一批请求。

Manager 在进程内按站点复用 Gitea Manager API 客户端和 HTTP Transport。连接构造统一核对 Secret 的 UID、站点所有权、删除状态和密钥内容，随后缓存只保留客户端与 Transport，不保留完整 Kubernetes Secret。连接指纹包含站点 UID、连接地址、规范地址、Manager 身份、凭据引用和 CA Bundle，一分钟绝对有效期结束后重新读取 Secret 并构造连接；并发首次读取合并为一次。这个窗口避免协调、状态上报和访问授权反复读取 Secret 与建立 TLS 连接，同时让凭据或 CA 更新在有限时间内生效。站点注册和管理页面的连通性检查仍使用独立的一次性连接，因为它们需要验证尚未成为当前运行配置的输入。

Gateway 投影通过 controller-runtime 字段索引按组件 UID 找到配置、按 Gateway UID 找到站点、再按 Site UID 找到站点命名空间中的 Runtime。索引用于缩小候选范围，路由构造复用已经核对的站点并只读取对应 Pod；签发 Agent 访问票据时仍实时读取 Runtime、站点和 Pod，并核对资源 UID、Pod UID 和所有权，因为缓存索引不能替代实时身份校验。

Gateway 和 Cache 可以由多个站点共享。Cache 的授权和存储路径包含站点 UID；Gateway 从 Runtime 快照把站点 UID 保留到每个 Endpoint 路由，Open Token、浏览器会话、公开 Endpoint 和 SSH 授权在连接当前路由前核对该身份。允许结果缓存、并发授权合并和公开 Endpoint 的单实例连接限制也把站点 UID 放入键中。不同 Gitea 实例可能产生相同的数字用户、仓库 ID 或短时间内相同的路由字段，因此共享组件需要把站点身份作为隔离边界；站点变化会替换路由并结束旧连接，旧站点的允许结果也不能用于新站点。

Gateway 启动 HTTP 与 SSH 服务前初始化同一份 Runtime 路由存储。Open Token 兑换、浏览器会话、公开 Endpoint 和 SSH 连接在当前路由存在且站点 UID 一致时进入代理。路由存储因此既提供目标地址，也提供连接时的运行身份事实；远程授权与当前运行时路由共同构成连接前置条件。成功授权缓存 30 秒，拒绝与错误不缓存，使短时间内重复资源请求可以复用业务判定，而权限收回仍由短缓存窗口和运行中会话的定期复核收敛。

Gateway 到 Agent 的连接建立包含票据签发、内部流创建、打开请求和 Agent 接受，整个阶段最多等待 15 秒；接受后移除建立计时器，由原始用户请求控制长连接寿命。HTTP Endpoint 另外使用 30 秒响应头超时，但不限制响应体、WebSocket、SSH 或 SFTP 的总时长。区分建立与传输阶段的原因是不可达目标需要及时释放连接额度，而远程开发会话本身必须能够长期运行。

Gateway 浏览器会话由组件 Secret 中独立的 32 字节密钥认证加密。票据携带稳定会话标识、资源身份、签发时间、绝对期限和空闲期限；副本验证成功后只在本地建立连接计数与活动记录。SSH 主机密钥轮换只替换主机密钥字段，会话密钥保持稳定，因此正常主机密钥维护不会让所有浏览器会话同时失效。

Gateway 控制流按实例汇报活动并获得限时许可。Manager 从同一控制流最近一次成功路由快照取得允许上报的 Runtime 集合，忽略已经离开快照的活动项；Gateway 只在某个 Runtime 从无连接变为有连接或从有连接变为无连接时立即上报，固定心跳继续完成最终收敛。自动停止只关心是否存在活动连接，这种边沿上报可以避免每个浏览器资源请求触发控制消息和 Kubernetes 查询。

断流时 Manager 保留报告到许可期限，Gateway 在相同期限到达时关闭服务；重建流只沿用剩余期限，收到 Manager 的有效响应后才更新许可。自动停止只有在所有仍可能提供服务的副本都完成上报后才开始计算空闲时间。这把网络分区和半开连接时的安全判断收敛到一个明确期限，也避免引入跨副本共享计数服务。

### 实现验收点

- 站点、模板和组件端点拒绝属于其他资源类型的请求字段。
- 端口转发、HTTP 代理和 HTTPS Ingress 使用同一管理页面，不需要修改 Manager 中的公开地址；未认证或 CSRF 无效的写请求仍被拒绝。
- 新建站点在远程注册前完成所有可本地验证的 Kubernetes 引用检查，资源名和 Manager 身份由服务端生成。
- 新建站点、环境模板和组件的请求不携带 Kubernetes 资源名，服务端响应包含生成后的名称、UID 和资源版本。
- 注册令牌不写入 Kubernetes；运行密钥只写入当前站点拥有的 Secret，管理读取接口不返回明文。
- 站点连接地址与 Gitea 返回的规范 Web 地址可以不同；Manager 使用连接地址，控制器把验证后的规范地址写入 Status。
- 站点 CA 留空时使用系统信任库；填写多个有效证书时注册、身份检查和运行协调均能连接，错误证书不会覆盖已有站点配置。
- 编辑站点不改变 Manager ID 和凭据引用，并发修改继续通过 UID 与资源版本冲突收敛。
- `CodespaceComponent` 的角色、资源和运行配置由 CRD 与领域校验共同检查，管理页面与控制器使用同一字段模型。
- 站点、模板、组件和 Runtime 的 Status 更新会保留并发写入的独立字段；配置 generation 或运行身份变化时不会提交旧观察结果。
- Kubernetes 内置控制器更新工作负载 Status 时，Manager 仍能通过规格补丁收敛 Deployment、Service、Ingress、PVC 和 PDB。
- RuntimeClass、StorageClass、IngressClass、TLS Secret 和 Issuer 来自当前集群，下拉框中的引用在保存时再次核验。
- 页面级操作、列表行操作和表单提交操作位于各自固定区域；列表删除按钮保持最右，宽屏字段按两列对齐，URL、证书、JSON 与多行内容占据整行，窄屏自动变为单列。
- 环境模板在依赖可用时自动产生当前 generation 的就绪状态，依赖失效与恢复均由控制器收敛。
- Agent 与主 Dev Container 的 Git 配置使用各自可见的凭据路径，HTTP helper 只匹配当前 Gitea 基础地址，HTTP 和 SSH 克隆均不依赖挂载的可执行 helper。
- 克隆错误记录协议与目标主机，站点运行出站网络可据此配置，错误和配置中均不包含认证材料。
- CPU、内存、存储、缓存容量和时长可以按明确单位编辑，保存结果能够被对应的 Kubernetes 或运行时解析器读取。
- 环境资源上限和站点配额可以关闭；启用上限时 request 不超过 limit，文件系统缓存的最大容量与保留空间之和不超过 PVC 容量。
- 保存失败后表单内容和未保存状态仍然存在；保存成功后列表使用写接口返回的完整资源更新。
- 组件工作负载及凭据绑定当前组件 UID，同名重建不会继承旧身份。
- Cache 地址以同名 Service 为唯一来源，管理 API、CRD、内部协议和页面展示同一推导结果。
- Cache 控制身份、HTTPS 服务证书和 Registry 签名密钥分别存放，证书用途不能互换。
- 文件证书源一分钟内只使用同一份有效内存快照；续期文件投影完成后，新 TLS 连接在下一次检查时加载整组证书材料，不依赖 Pod 重建。
- Runtime 内存卷中的标准 Docker 配置可以被外部 Buildx 读取，创建结束后不再保留 Registry 凭据。
- Cache Registry 的 Basic 认证直接验证 Manager 签发的短期令牌，协议中只有一条认证路径。
- S3 凭据与 Gateway SSH 主机私钥只保存在 Secret，管理读取接口不返回明文。
- 环境模板和 Cache 共用代理字段与校验规则，包含标准用户信息的完整代理 URL 可以提交并原样读取。
- 创建操作从 Codespace 配置快照生成实例代理 Secret，不依赖环境模板 Secret；模板后续修改不会改变已有环境的恢复结果。
- Dockerfile、Feature、Compose 构建及所有运行服务收到同一代理与直连规则，代理认证不会写入 Dev Container 状态、配置摘要或普通日志。
- Agent、构建参数和容器环境使用相同的大小写代理变量集合，调整其中一处支持范围时不会遗漏其他执行阶段。
- Compose 启用代理时，服务名和显式网络别名加入直连列表；隐式默认网络和短格式网络不需要额外配置，未启用代理时容器环境保持原样。
- 标准 Dev Container 包只提供通用镜像定制回调和容器状态操作，Codespace 平台镜像内容由运行时层生成。
- 单容器和 Compose 的主服务在 Feature 与远程用户处理后执行同一最终镜像定制流程，并共用缓存、代理与目标平台信息。
- Gitea CLI 安装和模板 `build`、`start`、`stop` 行为由运行时层按环境模板配置执行，通用 Docker 引擎不解释这些平台字段。
- Web IDE 使用容器内运行时子命令保持单实例并自动重启；初始化和连接错误进入操作日志，但不会删除环境或让 create、resume 失败。
- Workspace endpoint 只随模板开关发布，连接等待只作用于该端点并有固定上限。
- Gateway 快照不会列出绑定其他 Gateway 的站点或其他站点命名空间中的 Runtime。
- Manager 默认依赖 API Priority and Fairness 处理集群请求；kubeconfig 显式配置的客户端限流保持生效。
- 同一站点的一分钟运行请求复用 Gitea 客户端和 HTTP Transport；每次创建连接都核对凭据所有权，缓存不保留完整 Secret，站点身份、凭据引用或 CA 配置变化后创建新连接。
- Gateway 快照复用已经读取的站点，Agent 票据签发仍实时核对 Runtime、站点与 Pod 身份。
- Gateway 会话使用站点 UID 与用户 ID 的组合身份，同一数字用户 ID 在不同站点分别计算并发限制。
- Gateway 的 Open Code、浏览器会话、公开 Endpoint 和 SSH 授权只连接站点 UID 与当前路由一致的 Runtime。
- Gateway 的 HTTP 与 SSH 入口使用同一份已初始化路由存储，每次代理连接都要求当前路由存在且站点 UID 一致。
- Gateway 的允许结果缓存、并发授权合并和公开 Endpoint 单实例连接限制按站点 UID 隔离；路由切换站点后旧连接和旧会话停止使用。
- 成功授权在 30 秒内复用，拒绝和错误实时返回；活动上报只接受当前路由快照中的 Runtime。
- 同一 Runtime 的连接数在正数之间变化不触发即时活动上报，固定心跳仍能同步当前活动状态。
- Agent 流未在 15 秒内接受时释放资源，HTTP 上游未在 30 秒内返回响应头时终止请求；已建立的长连接不受这两个建立超时影响。
- Gateway 副本数、Deployment、PDB 和管理状态使用同一期望值；部分副本就绪时状态为可用但降级。
- Manager、Gateway 和 Cache 使用 `8081`、`/healthz` 和 `/readyz` 提供独立健康检查，组件 Service 与 Ingress 不发布健康端口。
- Gateway 在许可有效的控制流短暂中断期间保持就绪；Cache 只有取得租约并启动 Registry 后才就绪，Kubelet 不探测 mTLS 业务端口。
- 浏览器会话可在同一 Gateway 组件的副本间使用，空闲续期不能超过最初绝对期限。
- 自动停止在失联副本许可到期前保持等待，许可到期时该副本已经关闭用户连接。
- Cache 只生成一个 Recreate 副本，管理状态同时核对 Deployment 就绪与运行租约。
- Fetch 响应丢失后相同 operation 会重新到达，Manager 复用持久化输入；只有持久观察当前版本才获得续租。
- 确定性 create/resume 拒绝在 Gitea 进入稳定状态，局部资源分别通过 delete/stop 收敛；暂时性错误保留重试。
- 未绑定清理 CR 不参与 Gitea 身份绑定和完整资源清单，也不阻塞站点从 recovering 进入 online。
- 缓存索引命中后仍核对当前资源身份，删除或同名重建的资源不能沿用旧授权。

## 测试层次

| 层次                  | 覆盖重点                                                |
| --------------------- | ------------------------------------------------------- |
| 单元测试              | 解析、权限交集、状态转换、幂等键和纯函数                |
| 数据库测试            | 事务、条件更新、唯一约束和迁移                          |
| 组件集成测试          | RPC 身份、操作领取、Agent 流、Gateway 授权和 Cache 维护 |
| Kubernetes 端到端测试 | CR、PVC、Pod、Leader 切换、RuntimeClass、网络和恢复     |
| 浏览器测试            | 创建确认、列表、详情、日志增量加载和管理界面            |
| Helm 测试             | RBAC、身份、服务、网络策略以及标签和摘要镜像            |

测试选择能覆盖风险的最低层次，并通过生产入口验证用户可观察行为。Gitea 使用其 Makefile 和测试文档规定的入口。Codespace 使用 `make lint` 检查格式、生成文件、Helm、`go vet` 和 `staticcheck`，`make test` 运行后端的非端到端测试，`make test-frontend` 运行管理界面浏览器测试，`make test-e2e` 编排真实 Kubernetes 全链路。静态检查集中在同一入口并固定工具版本，使本地与持续集成得到一致结果；统一测试入口也避免各子系统各自维护一套环境变量、资源和清理脚本。

Dev Container 兼容测试使用官方配置表示验证 Feature 字符串简写和字符串布尔选项，并分别覆盖生命周期来源顺序、依赖循环、锁文件所有权与标准化、Compose 默认工作区、内部代理直连目标与跨服务端点。Compose 代理测试使用真实加载模型验证隐式默认网络和显式别名，使标准的省略网络配置不会只在端到端环境中暴露错误。恢复测试验证宿主初始化可以再次执行、同一操作的替换 Pod 不会重放未知结果，并验证恢复状态只有一个容器生命周期命令来源。选择这些语义测试的原因是它们决定最终运行行为，单纯检查字段或函数是否存在无法发现命令顺序、目标容器或恢复重复执行错误。

### 实现验收点

- 状态机覆盖成功、并发抢占、非当前版本和恢复路径。
- Dev Container 测试验证 Feature 选项、依赖排序、生命周期命令组、Compose 服务端点和恢复初始化的实际语义。
- Compose 代理测试加载隐式默认网络并验证服务名、显式别名与已有直连目标的合并结果。
- Agent 测试验证替换 Pod 不会重放同一操作，宿主命令只接收明确提供的非敏感环境。
- 状态测试真实制造 `resourceVersion` 冲突，并验证控制器、Agent 与站点协调器的独立事实都被保留。
- 权限测试覆盖对象 ID 篡改、跨用户、跨站点和凭据重放。
- 前端测试在项目支持的浏览器中稳定，不依赖精确计时。
- 本地和自动化使用相同的公开测试入口。
- 普通测试不会因为本机存在 kubeconfig 或 Docker 而隐式进入真实环境测试。
- 完整端到端测试由单个入口启动，阶段失败会直接终止并保留诊断。
- 块卷授权、跨站点缓存、无 UUID 记录维护、执行取消和缓存许可到期由行为测试覆盖。

## 真实环境验证

Kubernetes 端到端测试在专用测试集群中使用摘要固定的平台镜像和独立命名空间。一个集群由同一套 Manager 控制面协调集群级 GiteaSite 和 EnvironmentTemplate；独立命名空间用于组织测试资源，其他 Manager 安装需要在测试前停用，以避免两套控制面修改同一资源。Kata 与 Sysbox 通过同一入口分别执行，使结果明确对应实际 RuntimeClass 与 StorageClass。测试在 Runtime Pod 内验证 Docker、Dev Container 和持久卷，而不是借用开发机的容器运行时。

测试开始前检查集群能力、镜像和测试协议服务监听地址，随后覆盖组件身份、Leader 切换、访问路径、S3 兼容缓存和完整生命周期。测试进程提供 Gitea 协议对端，使 Kubernetes 平台测试不依赖另一套产品部署；Gitea 对 Manager 的适配由 Gitea 仓库测试验证。Runtime 内执行的测试及时输出场景开始、结果和失败信息，便于区分外部下载缓慢与执行阻塞。成功后清理测试资源；失败时先收集资源状态、事件和组件日志，再执行清理，诊断文件保留用于定位。

官方 Feature 会从外部下载软件包和二进制。真实环境测试为此保留有界的下载时间，并让外层测试期限大于内层执行期限，使慢速网络下仍能完成安装和失败清理；普通测试仍使用原有的快速入口。

### 实现验收点

- 测试开始前检查集群 API、RuntimeClass、StorageClass、镜像和凭据。
- 测试集群在执行期间由本轮测试安装的 Manager 控制面协调。
- 每种支持的隔离模式完成 create、stop、resume、delete 和访问验证。
- Leader 切换、Pod 删除与 Cache 丢失具有恢复验证。
- Runtime Pod 内完成 Docker 数据恢复和 Dev Container 官方场景验证。
- Runtime 内的测试结果在场景结束时立即输出，失败信息保留到外层测试日志。
- S3 Cache 使用隔离的 S3 兼容服务完成写入、读取和清理验证。
- 测试协议服务只实现端到端场景需要的 Gitea 行为，Manager 仍通过公开协议和真实网络连接访问它。
- 测试结束后自动确认没有孤立资源。
- Kata 验证首次块卷初始化，以及替换 Pod 后检查并挂载原文件系统的数据恢复行为。

## 完成标准

一次变更完成时，设计、协议、实现、配置与测试需要描述同一当前行为。格式化、静态检查、适用测试和安全边界验证使用仓库公开入口执行；真实环境中未执行的部分在变更说明中记录原因与风险。

### 实现验收点

- 审阅者可以从设计验收点定位对应代码和测试。
- 配置示例、管理页面和部署清单随实现更新。
- 工作树没有意外生成物，测试资源和临时凭据已经清理。
- 变更说明列出已执行测试及尚未验证的真实环境场景。
