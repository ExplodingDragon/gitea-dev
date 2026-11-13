# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 继续负责用户、权限和业务状态。

## 控制面与资源

Manager 提供管理 API 和 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略位于其中。

管理 Service 默认只在集群内提供，管理员可以通过端口转发、反向代理或 Ingress 访问。页面使用当前来源访问 API，因此入口地址变化不会改变认证身份；管理 Token、服务端会话和 CSRF 负责保护写操作。浏览器经 HTTPS 访问时会话 Cookie 使用 `Secure`，经本机 HTTP 端口转发时仍能完成首次配置。

`EnvironmentTemplate` 定义隔离方式、计算和存储资源、Git SSH 密钥类型和 Dev Container 附加配置；Kata 与 Sysbox 模式还引用对应的 RuntimeClass。它的 Kubernetes `metadata.name` 同时作为 Gitea 环境标签，使用 1 至 63 个小写字母、数字和中划线。一个对象只保留这一份稳定标识，可以避免资源名、站点引用和调度标签分别修改后指向不同环境；Kubernetes 保证名称在创建后不变，管理员需要调整的说明和运行配置仍可继续编辑。模板是集群级资源，因此多个 Gitea 站点可以通过名称和 UID 共同引用同一个模板。

Kata 与 Sysbox RuntimeClass 使用 `codespace.gitea.dev/isolation=kata|sysbox` 标签声明运行语义，管理页面据此列出可选项，保存模板时再次核对标签和资源是否仍然存在。Native 模式使用集群默认 CRI，因此模板不保存 RuntimeClass；这样设备插件、CDI 和节点默认运行时保持在同一条 Kubernetes 原生分配路径，也避免再维护一份等价的 Native RuntimeClass。模板控制器持续检查 RuntimeClass 与 StorageClass；Native 模板还会确认至少一个节点能够同时提供模板声明的全部扩展资源。这个检查用于在发布前发现节点配置缺口，当前占用和最终放置仍由创建 Runtime Pod 时的 Kubernetes 调度器判断。依赖可用时自动写入 `Ready=True`，依赖变化时更新为明确的不可用状态。

管理页面同时发现 StorageClass、Node 可分配的扩展资源、IngressClass、TLS Secret 和 cert-manager Issuer，并始终用下拉框表达这些 Kubernetes 引用。设备资源显示声明该资源的节点数和单节点最大容量，这些值用于识别集群能力，不表示扣除现有工作负载后的实时余量。编辑对象引用的资源已经不存在时，页面保留原值并标记为不可用，管理员需要选择当前有效资源后才能保存；这个行为使配置失效可见，也避免静默改用另一个运行环境。资源数量和时长使用数值与单位分开的输入方式，Manager 保存并校验转换后的原生 quantity 和 duration。

站点配额用于限制一个 Gitea 站点能够占用的 Runtime 总量，管理员可以按集群的容量管理方式选择是否启用。启用时，Manager 维护站点命名空间中的 `ResourceQuota`，约束 Pod、PVC、CPU、内存、存储以及所选模板使用的 Device Plugin 扩展资源请求；关闭时不创建配额，让 Kubernetes 调度器和集群已有的容量策略决定是否接纳工作负载。管理页面从站点选择的模板推导设备配额项，管理员填写的是该站点允许同时占用的设备总量。编辑站点时，已有设备配额会继续保留，即使当前选择的模板已经不再提供该设备；页面会明确标记这类旧配额，只有管理员显式删除时才会移除。这样修改站点名称或模板不会意外改变已经生效的容量边界。环境模板始终声明 CPU 和内存请求，使调度器能够规划容量；资源上限可选，适合由平台统一限制或允许开发工作负载临时使用空闲资源的集群。Manager 在领取创建操作前用 ResourceQuota 的已用量检查单次设备需求，Kubernetes 准入仍是并发情况下的最终权威。

文件系统 Cache 的 PVC 创建后，StorageClass 由该 PVC 的实际值决定。环境配置在 PVC 尚未创建时可以选择 StorageClass；PVC 已经存在后，管理页面展示实际 StorageClass 并将其作为只读运行事实，修改请求会被明确拒绝。Kubernetes 不支持把已有 PVC 换到另一个 StorageClass，自动迁移会引入缓存数据复制、停机和回滚语义，而 Cache 数据本身可以重新生成，因此更换存储时通过创建新的 Cache 并重新绑定站点完成。没有指定 StorageClass 时仍使用集群默认类，控制器不会把 Kubernetes 自动填入的默认类误认为管理员修改。

保存 Cache 时，已有同名 PVC 必须属于当前组件，所有权冲突直接返回错误；如果管理员直接修改 CR，使声明的 StorageClass 与已有 PVC 不一致，控制器报告配置漂移。Deployment、Service、Ingress、PVC 和 PDB 使用补丁提交期望规格，使 Kubernetes 内置控制器并行更新 Status 时仍能收敛；CR Status 的身份与并发更新规则见[数据模型](data-model.md#标识并发与清理)。

运行方式同时决定 PVC 的接入形式：Kata 使用原始块设备，由来宾内 Agent 挂载 Docker 数据；Sysbox 和 Native 使用 Kubernetes 文件系统挂载。卷模式属于运行实现的一部分，因此由 Manager 统一推导，模板只保存运行方式这个权威事实。创建时，Manager 把模板内容和当前平台镜像引用写入 Codespace CR，使后续恢复继续采用创建时选择的运行配置。平台镜像可以是显式标签或摘要：标签用于持续更新的开发环境，摘要用于内容固定的部署。管理 API 使用 Kubernetes UID 与 `resourceVersion` 处理对象身份和并发修改；S3 密钥等独立业务 Secret 使用只写接口，出站代理作为完整运行配置由声明资源读取和编辑。

管理页面提供英文、简体中文、日文和韩文，浏览器语言用于首次选择，管理员的手动选择保存在本地浏览器。四种语言使用同一组 JSON 词典，Vue 页面直接读取这些词典，Go 管理 API 也从同一目录读取词条并按 `Accept-Language` 返回本地化摘要。管理 API 同时返回稳定错误码和诊断详情：摘要面向管理员展示，诊断详情保留 Kubernetes 返回的具体原因。资源状态也按稳定的 Condition reason 显示本地化摘要，原始 Condition message 只作为可展开的技术详情。共用词典的原因是前后端面对的是同一位管理员，分别维护两套文字会产生词条遗漏和含义不一致。

`CodespaceComponent` 定义一个 Gateway 或 Cache。组件是集群级资源，因为多个站点可以引用同一个平台入口或缓存；它生成的 Pod、Service、NetworkPolicy、身份 Secret 和缓存卷集中在管理命名空间。站点保存组件名称和 UID，Manager 在建立控制流和投影路由时再次核对角色与 UID，因此删除后创建的同名组件不会接管旧站点关系。

Gateway 提供 HTTP、WebSocket 和 SSH 入口，活动连接由接收它的副本持有，可以配置 1 到 64 个主动副本，默认运行两个。Service 把新连接分发到任意就绪副本，软反亲和性优先把副本分散到不同节点。多副本时，滚动更新允许增加一个副本且保持零不可用，PodDisruptionBudget 允许最多一个副本因计划内维护不可用；至少一个副本就绪时入口可用，少于期望副本数时管理状态显示降级。副本退出会结束其持有的连接，客户端通过可用副本重新连接。Cache 持有镜像缓存的单写租约并可能挂载 ReadWriteOnce 卷，因此固定运行一个副本，并用 Recreate 更新策略先停止旧进程再启动新进程；管理状态同时核对 Deployment 就绪与租约。两类组件采用不同副本策略，是为了让入口获得故障切换能力，同时保持缓存写入边界简单明确。

### 实现验收点

- Manager 只连接一个 Kubernetes API。
- 管理页面可经端口转发、HTTP 代理或 HTTPS Ingress 登录和保存，入口地址变化不需要修改 Manager 配置。
- 不同站点的资源、凭据、配额和网络策略相互隔离。
- 环境模板的资源名与 Gitea 环境标签完全一致，创建后名称不可编辑，说明和运行配置仍可更新。
- 多个站点可以按同一名称和 UID 引用一个集群级环境模板。
- Manager、Gateway、Cache 和 Runtime 使用同一份显式标签或摘要镜像引用。
- 模板更新只影响之后创建的 Codespace；已有 Codespace 的停止、恢复和 Pod 重建继续使用创建时的运行快照。
- 管理 API 对 S3 密钥等独立凭据提供只写接口；完整代理 URL 作为管理员可见的运行配置读取和编辑。
- 管理页面为 Kata 与 Sysbox 只列出带有效隔离标签的 RuntimeClass；Native 显示集群默认运行时；环境模板和尚未创建 PVC 的 Cache 选择当前仍存在的 StorageClass，已有受管 PVC 显示实际使用的 StorageClass。
- 保存 Kata 或 Sysbox 模板时 RuntimeClass 标签需要与隔离方式一致；保存 Native 模板时 RuntimeClass 为空；环境模板和尚未创建 PVC 的 Cache 必须引用仍存在的 StorageClass，已有受管 PVC 即使集群默认类发生变化也继续保持原存储。
- 模板保存后由控制器根据当前依赖自动进入就绪状态；依赖失效和恢复会分别更新状态。
- 环境模板和尚未创建 PVC 的 Cache 的失效资源引用保持可见并阻止保存；已有受管 PVC 的 StorageClass 以实际卷为准，不因默认类消失阻止普通编辑。
- 资源请求、可选上限、可选站点配额、缓存容量和时长以明确单位编辑；站点配额包含所选 Native 模板需要的扩展资源请求。
- 关闭站点配额后不保留 Manager 管理的 `ResourceQuota`，关闭环境资源上限后 Runtime Pod 只带请求值。
- 站点普通编辑保留已有设备配额；只有显式删除设备配额或关闭站点配额时才移除对应的 `ResourceQuota` 项。
- Cache 保存时拒绝已有同名 PVC 的所有权冲突；直接修改 CR 导致的 StorageClass 漂移由控制器报告，原有卷保持不变。
- Kata 模板生成块模式 PVC，Sysbox 模板生成文件系统模式 PVC，模板中没有第二个卷模式配置来源。
- Native 模板生成文件系统模式 PVC 并使用默认 CRI；模板就绪状态会核对单一节点能够同时满足 Device Plugin 扩展资源，而实际放置仍由 Kubernetes 调度器决定。
- 管理页面语言切换同时作用于导航、表单、确认框、资源状态和组件语言，并在刷新后保持。
- 四种 JSON 词典具有相同键集合；前端请求携带当前语言，管理 API 的错误摘要来自同一组词典。
- 管理 API 错误包含稳定代码和诊断详情，页面不依赖英文错误文字判断会话状态；动态集群诊断仍可在技术详情中查看。
- 一个组件声明只选择 Gateway 或 Cache 角色，控制器能从声明恢复对应工作负载。
- Gateway 按声明的副本数运行并在多副本时创建 PDB；Cache 始终以单副本 Recreate 方式运行。
- 站点引用、组件证书和凭据均绑定组件 UID。

## 管理交互与站点接入

管理页面将页面级操作放在标题右侧，列表行操作使用右对齐的等高图标按钮，删除位于最右侧。表单按业务章节组织，宽屏采用两列网格，URL、证书、JSON 和多行内容占整行，窄屏改为单列。按操作范围和字段内容组织布局，可以让列表易于扫描，也避免新增字段导致错位。

初次加载与保存使用独立的异步状态。保存时从当前草稿创建请求快照，成功后用服务端返回的完整资源更新列表；失败时保留编辑器、输入和未保存标记。这样版本冲突或短暂网络错误不会丢失输入，也不会因为成功写入后的额外列表请求失败而误报保存失败。

新建站点时，管理员填写显示名称、Gitea 连接地址和注册令牌。Manager 先校验配额及模板、Gateway、Cache 的名称和 UID，再向 Gitea 注册；成功后生成站点资源名，把 Manager ID 写入 GiteaSite，把运行密钥写入受管 Secret。注册令牌只用于本次调用。站点和组件的 Kubernetes 名称由服务端生成，环境模板则使用管理员填写的不可改名 Tag，原因见[控制面与资源](#控制面与资源)。

Gitea 注册与 Kubernetes 写入分属两个系统。远程注册成功而本地保存失败时，Gitea 会保留尚未连接的 Manager，管理员可在 Gitea 删除该记录；本次管理请求返回保存错误，不自动重新注册，以免产生多个身份。

站点连接地址用于 Manager 控制面请求，可以填写集群可达的内部地址；Gitea 返回的规范 Web 地址经身份检查后写入 Status，供用户入口使用。站点 CA 留空时使用系统信任库，填写时追加 PEM 证书。编辑站点保留 Manager 身份和凭据引用，并先使用原凭据、新地址和新 CA 检查身份，成功后才更新资源，因此连接配置失效不会覆盖仍可用的旧配置。

Manager 按站点复用 Gitea 客户端和 HTTP Transport。构造时核对凭据 Secret 的 UID、所有权、删除状态和密钥内容；缓存身份包含站点 UID、连接地址、规范地址、Manager 身份、凭据引用和 CA。客户端缓存采用一分钟绝对有效期，并合并并发首次读取，降低 Secret 读取与 TLS 建连开销，同时使凭据和 CA 更新在有限时间内生效。注册与管理连通性检查使用独立连接，因为它们需要验证尚未保存的输入。

### 实现验收点

- 页面操作、行操作和表单提交各有固定位置，多行字段占整行，窄屏布局保持单列可读。
- 保存失败后保留表单输入与未保存状态；成功后直接使用写接口返回的资源更新列表。
- 注册前完成本地依赖校验，注册令牌只用于远程调用，运行密钥写入站点拥有的 Secret。
- 站点与组件资源名由服务端生成；模板 Tag 在创建时确定，普通编辑保留现有身份。
- 注册成功而本地保存失败时返回明确错误，Gitea 中的未连接 Manager 可由管理员删除。
- 站点内部连接地址与规范 Web 地址可不同；身份检查失败时旧地址、CA 和凭据引用保持不变。
- 同一有效缓存期内复用站点客户端；身份或连接配置改变时使用新客户端，到期后重新读取 Secret。

## Runtime 与持久数据

### 进程与隔离

Runtime Pod 使用平台镜像，Agent 作为 PID 1 启动专属 Docker、准备工作区、创建 Dev Container、执行生命周期命令并提供访问 RPC。Manager 与 Agent 使用同一镜像统一发布和审计，但分别运行于独立 Pod；用户镜像运行在 Runtime 内的 Docker 中。Agent 通过内部 RPC 取得操作与授权，Kubernetes 资源由 Manager 管理。

环境模板显式选择 Kata、Sysbox 或 Native 隔离方式。Kata 与 Sysbox 绑定已标记的 RuntimeClass，Native 使用集群默认 CRI。运行依赖失效时保留原选择并报告错误，因为自动切换会改变隔离语义和设备可见范围。

Kata 与 Native 在 dockerd 启动前准备 Runtime 私有 cgroup v2 层级：把根组进程移入 `init` 子组，再启用已委托的控制器，使内部容器能够建立有效的 domain 子组并继续受 Runtime 上限约束。Native 先将已有私有挂载设为可写；Sysbox 使用自身提供的进程分组。准备与 Docker 就绪共用有限启动时间，权限或层级错误进入操作失败清理。该流程同时适用于 systemd 与普通 Dev Container 镜像。

#### 实现验收点

- Runtime 使用专属 Docker，并通过内部 RPC 接收操作和发布运行事实；节点容器引擎与 Kubernetes API 的凭据留在各自管理边界。
- Kata、Sysbox 与 Native 分别通过对应 RuntimeClass 或默认 CRI 的真实启动验证，依赖失效时保留已选择的隔离方式。
- Kata 与 Native 在 dockerd 启动前完成 cgroup 嵌套准备，内部 systemd 能创建 domain 子组；Sysbox 使用运行时提供的分组。

### Web IDE 交付与启动

Web IDE 由环境模板中的镜像决定，空镜像表示关闭。管理页面提供 VS Code 与 DeepSeek Harness 镜像建议，也允许填写遵循同一协议的第三方镜像。Manager 读取 OCI 元数据、校验默认选项和管理员输入，并在保存模板时把引用固定到 sha256 摘要；创建和恢复使用该 Codespace 已确认的快照。

官方 Provider 使用独立的多架构 BusyBox 镜像交付，第三方可以选择满足导出协议的载体镜像和支持的架构。Runtime Pod 的 init 容器把程序清单、编辑器及适配器完整导出到磁盘临时卷，主容器再将其只读映射到 Dev Container。init 容器只负责导出程序；其运行权限、可写路径和 Bundle 格式由 [Provider 开发指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/providers/DEVELOPMENT.md)定义。

程序属于 Pod 临时数据，Pod 替换时从固定镜像重新取得；设置、扩展、插件和会话保存在 Codespace PVC。编辑器和适配器随 Provider 独立发布，使编辑器更新与核心平台镜像、仓库 Dev Container 构建缓存分离。

Agent 校验程序清单后，把模板 `options` 与标准 Dev Container 的 `customizations.<provider>` 交给适配器，由它负责合并配置、初始化和管理编辑器进程。镜像拉取或 init 导出失败会阻止 Runtime 主容器启动；此后的清单校验、`prepare` 或启动提交失败只影响 Web IDE，并记录操作日志。清单和 `prepare` 成功且 Docker 接受后台 `serve` 执行后发布 Workspace Endpoint。编辑器尚未监听或正在重启时，当前请求返回暂时不可用，随后可以自然恢复。

#### 实现验收点

- 模板解析展示提供方、版本、平台与摘要，默认选项和保存的选项均通过镜像 Schema 校验；已有 Codespace 沿用自己的镜像摘要和配置。
- 启用 Web IDE 时，init 容器在主容器启动前完成程序导出；Pod 替换后重新导出，PVC 中用户数据保留。
- 清单校验或适配器启动失败只影响本次 Web IDE，SSH 等基础访问按自身启动结果提供服务。
- `prepare` 成功且 Docker 接受后台 `serve` 后发布 Endpoint；请求在编辑器开始监听后成功，Codespace 状态保持独立。
- 官方 Provider 只在首次创建初始化仓库设置，此后保留用户修改；编辑器退出后由 Provider 重启，终止信号结束其进程循环。
- 浏览器访问通过 Gateway 完成身份与来源校验；通用输入、导出和启动行为符合 Provider 开发指南。

### Native 设备与 CDI

Native 用于需要 Kubernetes Device Plugin 资源的开发环境。模板按扩展资源名和正整数数量声明设备，Manager 将相同数量写入 Runtime Pod 的 requests 与 limits，由 kubelet 分配设备。模板还可以标记某项资源满足标准 Dev Container 的 `hostRequirements.gpu`。运维人员需要验证节点默认 CRI 能在非特权 Runtime Pod 中启动 rootful dockerd 和子容器，因为 Native 的运行能力直接来自节点配置。

CDI 是设备进入内部 Docker 的主要路径。Device Plugin 通过模板指定的环境变量提供本次分配的具体设备 ID，并通过 CRI CDI 把设备接入外层 Pod。Agent 从节点 CDI 定义中选取已分配设备，将它们映射为当前 Codespace 内稳定的逻辑名称，再写入专属 CDI 目录。停止恢复后物理设备 ID 可以变化，稳定逻辑名称让已有 Dev Container 能使用新分配继续启动。含 `all`、`none` 或 `void` 等宽泛值的分配不能确定具体设备，因而明确失败。

CDI 环境修改作用于容器初始进程。Agent 另将已选 CDI 规格和模板声明的设备环境加入远程环境，使标准生命周期、模板脚本、SSH 与 Web IDE 的 Docker Exec 取得相同分配。恢复时先重新探测基础环境，再应用当前设备环境，清除旧分配不再提供的变量。平台设备只注入主 Dev Container，Compose 辅助服务按仓库配置运行。

标记为 GPU 的设备资源成为平台设备申请来源：`runArgs`、Compose `gpus` 和设备预留中语义为“全部 GPU”的写法统一指向已分配设备；另选数量或 ID 的请求明确失败。模板的“高级主机访问”用于补充 CDI 未描述的驱动文件、工具和分配环境，设备映射只转发外层 Pod 已获得的设备，并保护平台路径与环境变量。

Native Runtime Pod 以 root 运行，使用 dockerd 所需的固定 capability、`seccomp=Unconfined` 和 `AppArmor=Unconfined`，再追加模板能力。管理页面展示固定能力并锁定为必需项，模板仅保存附加项。主 Dev Container 的 Docker 基础 capability、仓库 `capAdd` 和模板附加项按声明顺序合并去重，具体运行支持由节点内核及容器运行时决定。

#### 实现验收点

- 模板就绪检查确认至少一个节点同时满足全部扩展资源；Runtime Pod 的设备 requests 与 limits 一致，实际分配由 Kubernetes 调度器和 kubelet 完成。
- Native Runtime Pod 使用固定与附加能力并保持非 privileged；设备配额同时参与站点 ResourceQuota 和 Manager 创建容量检查。
- CDI 只包含本次已分配设备，物理 ID 变化后保留稳定逻辑名称，已有 Dev Container 可恢复。
- 当前设备环境同时进入容器初始进程和平台 Docker Exec，恢复后已撤销的分配变量消失。
- Dockerfile 与 Compose 主服务获得相同平台设备配置，辅助服务保留仓库声明。
- GPU 标记满足标准要求并统一“全部 GPU”写法；其他数量或 ID 选择明确失败，未标记时沿用标准 Docker 能力检查。
- 高级主机访问只补充已分配设备的运行条件，平台通信路径与凭据保持有效。

### Kata USB 设备

Agent 在 Kata Runtime 中发现活动的 `vhci_hcd` 控制器时启用 USB/IP，并使用平台镜像中的标准客户端。用户通过已有 SSH 身份建立 `-R usbip.<来源名>:3240:<服务端>:<端口>`，SSH 客户端访问实际服务端。Agent 将每个逻辑来源绑定到独立回环随机端口，使 USB/IP 与 Dev Container 的普通端口分离。来源命名、CLI 和转发协议见 [组件与 Agent](rpc-spec.md#组件与-agent)，用户操作见 [USB 连接指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/docs/usbip.md)。

创建和恢复按当前能力准备平台 USB CLI。VS Code 与 DSH 插件使用同一能力判断显示 USB 视图、命令和对话工具，通过 CLI JSON 查询和修改设备。能力查询失败只影响 USB 界面；转发断开后仍可查询和解绑已导入设备。操作错误保留已有列表，超时后查询实际状态，由用户决定是否重试，避免重复执行结果未知的设备操作。

Agent 显式挂载来宾 devtmpfs，再将其非递归映射到主 Dev Container 的标准 `/dev`，让设备节点随内核热插拔直接出现。外层 Pod 的 `/dev` 通常是独立 tmpfs，不能替代来宾设备树。主容器分别保留 `/dev/pts`、`/dev/shm` 和 `/dev/mqueue`，共享 IPC 与共享内存设置继续采用 Docker 语义。最终创建请求追加原始 USB、USB 串口、CDC ACM 的设备规则和处理 eudev netlink 事件所需的 `NET_ADMIN`；其余仓库运行设置保持原义。`/dev` 或 `/dev/pts` 存在冲突挂载时明确失败，因为两个来源无法同时定义设备树。

`/dev/mqueue` 在容器 PID 1 启动后、生命周期脚本之前完成挂载。设备准备失败时停止本次已恢复的容器；设备树挂载随 Agent 进程存在，单次操作取消后仍可供后续操作使用。Dev Container 自己启动 udev/eudev 并维护规则、组和非 root 权限，来宾内核提供设备类驱动，平台负责标准设备路径和事件可达性。

同一 Codespace 的进程共享附加设备。每个来源有独立监听身份，取消来源只关闭其待接受连接和设备流；SSH 会话结束回收该会话的全部转发，Runtime 停止或主容器更换回收全部连接。重新连接后按当前来源和 bus ID 再次附加，逐设备解绑使用 VHCI 端口。

Kata 虚拟机是宿主机与工作区之间的隔离边界；Agent、主 Dev Container 和嵌套 Docker 共享来宾设备视图。所选 handler 的 `privileged_without_host_devices=true` 将来宾能力与 Kubernetes 节点设备分开。默认设备规则只限定默认访问，仓库显式扩大的权限按来宾内同一信任范围处理。SSH、Manager 票据和 Agent mTLS 承担跨组件授权，本地 Agent socket 属于工作区信任接口。设备服务端和来宾驱动仍需独立的安全审查，因为 SSH 认证不能消除恶意设备或驱动漏洞。

#### 实现验收点

- 活动 VHCI 自动启用 USB/IP；创建、恢复和插件初始化均按当前能力准备命令与界面，USB 查询失败时端口管理仍可用。
- USB 命令和插件共用真实状态；隧道断开后仍可查询和解绑，操作超时后的刷新只查询状态。
- 主 Dev Container 使用来宾 devtmpfs，附加、移除事件可被 udev/eudev 处理，非 root 设备权限符合开发镜像规则。
- Dockerfile 与 Compose 主服务得到相同挂载和设备规则；PTY、共享内存、消息队列和仓库其他运行设置正常，辅助服务保留原配置。
- 操作取消保留 Agent 设备挂载，恢复准备失败停止刚启动的容器，Agent 退出释放挂载。
- 多来源、同名 bus ID、取消与重连都有明确归属；关闭一个来源保留其他来源，主容器更换回收全部监听。
- 实际 Kata handler 采用来宾隔离并启用 `privileged_without_host_devices=true`，工作区得到来宾设备而非隐式注入的节点设备。

### 授权环境与平台命令

启用 Gitea CLI 时，Agent 把平台镜像中与 Runtime 架构一致、已校验的程序只读挂载到主 Dev Container，在创建和恢复的运行时准备阶段安装命令入口和 Bash、Zsh、Fish 补全。入口读取当前授权文件后执行 CLI。站点地址和更新提示设置在容器创建时注入，Token 与用户 Secret 由本次授权文件和命令环境提供，使授权变化、CLI 更新与项目镜像构建缓存分离。

Agent 在首次创建和每次恢复的容器启动前，从同一份授权变量生成 `/var/lib/gitea-codespace/environment/env.sh` 和 `systemd.env`，分别供 shell/CLI 与 systemd `EnvironmentFile` 读取。环境目录只读挂载，文件原子替换后新进程读取本次授权。shell 文件最终由实际远程用户持有，systemd 文件由 root 持有，权限均为 `0600`；只包含文件引用的公共服务配置以 `0644` 单文件挂载到 `/etc/systemd/system/service.d/60-gitea-codespace-environment.conf`，保留镜像其他配置。

systemd 文件使用其原生引号与转义规则，保留多行、末尾换行、空白、特殊字符及空值。非法 UTF-8、NUL、Unicode 非字符和 BOM 在写入前返回只含变量名及原因的错误。系统管理器在切换服务身份前读取文件，因此所有系统级服务，包括设置 `User=` 的服务，都处于工作区授权范围内；服务自身配置的覆盖关系继续遵循 systemd 语义。该文件服务于系统级服务进程，PID 1 自身及独立用户管理器的环境具有不同语义。

SSH、Web IDE 和生命周期命令由 Agent 显式传入授权变量，登录 shell 通过 profile 读取文件。Kata、Sysbox、Native 共用此挂载，Compose 只应用于主服务。更新 Gitea Secret 后停止并恢复环境，会在下一次容器启动前生成当前授权，使系统服务首次启动即可取得相同变量。

#### 实现验收点

- CLI 入口、授权文件和补全在模板 `start` 前可用，平台程序更新保持项目镜像与 Feature 构建输入稳定。
- 首次创建和恢复均在容器启动前准备环境文件及 systemd 公共配置，系统服务首次启动可取得本次授权。
- shell 与 systemd 两种格式保留合法多行值及特殊字符，格式错误只报告变量名和原因；原子刷新移除已撤销变量。
- systemd 文件保持 root 所有且为 `0600`，shell 文件可由实际远程用户读取；系统级服务的授权范围明确，Compose 辅助服务采用仓库环境。
- 独立 CLI、SSH、Web IDE 和生命周期命令使用当前授权，普通镜像保留自己的启动方式。

### Dev Container 配置与生命周期

仓库配置与环境模板使用同一 Dev Container 解析和执行路径，模板可追加标准 Features。Feature 输入、依赖关系及安装提示按规范解析，以内容摘要和最终选项区分安装节点。仓库声明的 Feature 继续由仓库锁文件管理；模板独有的注入由模板快照确定。两者声明同一引用时锁定合并后的有效选项，使管理员扩展和仓库复现各有明确来源。

镜像元数据、依赖排序后的 Features 和仓库配置分别贡献生命周期命令组。组之间按来源顺序执行，同组对象语法中的命令并行执行；恢复状态保存这一组执行顺序。模板生命周期脚本则在最终镜像定制阶段以 root 执行 `build` 并恢复容器用户，基础镜像或脚本内容变化会影响对应构建缓存。单容器与 Compose 主服务共用该流程，辅助服务保留仓库镜像行为。模板 `start`、`stop` 时序和失败清理见 [停止、恢复与自动停止](lifecycle.md#停止恢复与自动停止)。

`onCreateCommand`、`updateContentCommand` 和 `postCreateCommand` 属于首次创建，`initializeCommand` 与 `postStartCommand` 在创建和恢复执行。`postAttachCommand` 用于通过身份、请求和目标检查的有效连接；启用 Web IDE 后，每次创建或恢复启动提供方也计为一次平台连接。Web IDE 和其 `postAttachCommand` 的失败记录日志，基础访问能力独立决定环境是否 ready。Agent 持久化当前操作的开始及结果，使 Manager 重连只重复上报而不重放同一次命令；执行结果未知时报告错误并进入生命周期清理。

`${localEnv:VAR}` 和 `${env:VAR}` 与 `initializeCommand` 共用 Agent 明确提供的宿主环境：`HOME`、`USER`、`LOGNAME`、`PATH`、`SHELL` 和模板标准代理变量。显式选择避免把 Pod 中的控制面身份带入仓库命令。`${devcontainerId}` 从 Codespace 稳定身份生成，重建后保持不变。

Compose 未声明 `workspaceFolder` 时使用 `/`。服务与容器保持一对一映射，使 `db:5432` 指向对应服务，而普通端口和 localhost 指向主容器。映射缺失或目标不唯一时在用户生命周期命令前报错，因为端口转发需要确定目标；该映射属于 Runtime 内部状态。

生命周期输出使用 [操作日志协议](rpc-spec.md#操作日志)规定的脱敏及队列预算。需要返回正文的元数据查询分别限制 stdout、stderr 为 1 MiB。取消生命周期操作会关闭 Docker 连接、停止专属 Docker 并结束当前执行循环，由 Manager 确认旧 Pod 停止后推进后续操作；普通访问断连只结束相应会话。

#### 实现验收点

- 标准配置、Feature 输入、依赖排序和锁定结果保持一致，无法满足的依赖在构建前明确失败。
- 仓库锁文件包含其声明的有效 Feature 依赖，模板独有的注入保持在模板配置范围。
- 生命周期命令按来源分组执行并支持对象内并行，恢复使用同一执行顺序，Manager 重连保留已执行结果。
- 单容器与 Compose 主服务共用最终镜像定制和平台准备；模板脚本的启动、停止及失败行为符合生命周期设计。
- 宿主替换与初始化命令使用同一环境集合，`${devcontainerId}` 在重建后稳定。
- Compose 默认目录为 `/`，跨服务端口定位正确，缺失或歧义目标在生命周期执行前失败并清理。
- 有效连接执行一次 `postAttachCommand`；Web IDE 关闭时创建和恢复只执行对应容器生命周期，启用后的编辑器或连接钩子失败保留基础访问。
- 日志与元数据输出受预算限制；生命周期取消后旧执行环境停止，用户访问断连只关闭自身连接。

### 工作区与持久存储

每个 Codespace 使用独立 PVC 保存工作区、内部 Docker、Git SSH 私钥和 IDE 数据。Token、用户 Secret、Unix socket 与进程状态位于易失目录；当前 Token 和已校验的 SSH 凭据副本通过 Pod 内存卷只读映射给主 Dev Container。Agent 初始克隆使用 `/run/codespace`，容器内 Git 使用 `/var/lib/gitea-codespace`；HTTP credential helper 仅为已验证的 Gitea 地址读取 Token，SSH 命令绑定相应私钥和 `known_hosts`。

克隆按 Gitea 的 `owner/repository` 生成稳定目录，先校验路径，再在临时目录完成克隆后发布工作区。已有目录须匹配锁定提交，并刷新当前 Git 凭据。该流程保证中断后可重试，同时保护已有工作区。

解析后的绝对 `workspaceFolder` 随访问目标保存，并通过 ready Runtime Metadata 发送给 Gitea，用于 VS Code 和 Zed 的 SSH 打开地址。目录是可以从 Dev Container 重建的运行事实，因此保留在 Kubernetes 状态中；Manager 接管和 Endpoint 更新继续使用相同值，SSH 编辑器入口与 Web IDE 开关分别处理。

恢复状态读取时校验身份、路径、容器及 Compose 映射。状态无效时明确报错并保留持久数据；需要重建状态的版本应在升级说明中提供备份和重建步骤。删除 Codespace 会回收整个 PVC，这与修复容器状态是不同操作。

Kata 原始块卷在挂载前通过 mTLS 核对 CR、Pod、PVC 和操作许可。首次格式化许可先以 `started` 写入 CR Status，再交给 Agent；文件系统检查和挂载成功后记录 `ready`。已有 ext4 经检查后直接挂载，格式化已开始但文件系统无法识别时保留数据并报错。这使进程崩溃或响应丢失后仍能区分首次初始化与已有数据。

#### 实现验收点

- 正常停止、恢复和 Pod 替换保留工作区、Docker 及 IDE 数据，短期凭据随当前授权更新。
- 合法仓库名称生成稳定路径；克隆中断可重试，已有工作区只在锁定提交匹配时复用。
- Agent 与容器内 Git 各自通过可见的只读凭据路径完成授权，HTTP Token 范围和 SSH 主机校验保持有效。
- ready Metadata 包含解析后的工作目录，Endpoint 更新及 Manager 接管保持该值，Web IDE 关闭时仍能通过 SSH 编辑器打开项目。
- 无效恢复状态保留数据并报告明确错误；块卷格式化先取得持久化许可，已有 ext4 可恢复，未知文件系统保留数据等待处理。

### 出站网络与证书

站点运行网络显式声明 Runtime 可访问的 CIDR 与 TCP 端口，包括 Gitea 克隆地址和开发所需服务。标准 NetworkPolicy 以地址及端口表达规则，因此域名服务由管理员按实际解析范围配置。访问失败日志给出协议和目标主机，并通过脱敏保护凭据。

环境模板支持 HTTP、HTTPS、SOCKS5 代理及直连目标。代理使用标准 URL，管理页面回显实际配置；大小写标准环境变量覆盖 Agent、Docker 拉取、构建和容器运行。SOCKS5 为未单独配置的 HTTP/HTTPS 提供后备。直连列表合并回环、Kubernetes Service、用户配置及 Compose 服务名和网络别名，使集群与服务间流量保持直连。代理构建使用 Docker 预定义参数，运行配置从 Codespace 快照取得，Dev Container 持久状态只保存非代理执行信息。

Agent 在启动 dockerd 前把 Runtime 系统 CA、公开内部根证书、站点 CA 和代理 CA 合并为 `/run/codespace/ca/bundle.pem`，去重后原子写入。Docker 通过 `SSL_CERT_FILE` 使用该文件，已配置 Registry 取得 `certs.d` 投影；Git 配置 `sslCAInfo`，OCI Feature 客户端从同一文件构造信任池，使首次下载即使用完整信任链。

同一文件只读映射为 `/var/lib/gitea-codespace/ca/bundle.pem`。容器启动和恢复时按发行版更新系统信任库，必要时安装标准证书工具，并提供 `SSL_CERT_FILE`、`NODE_EXTRA_CA_CERTS` 和 Git 固定文件配置。Feature 安装发生在构建阶段，使用构建镜像自身证书；容器运行时再引用已挂载的平台文件。CA 脚本在平台目录创建临时文件并在退出时清理，以避开 systemd 启动期间重新挂载 `/tmp` 的时序。

Manager、Gateway、Cache 和 Agent 的 mTLS 始终从各自身份目录加载证书、私钥与根池。Dev Container 取得的是公开出站信任包，这两类信任材料服务于不同边界，站点或代理 CA 不因此取得内部组件身份授权。

#### 实现验收点

- 放行实际 Gitea 克隆目标后 HTTP/SSH 克隆可完成，失败日志给出目标而不泄露凭据。
- 代理作用于下载、镜像拉取、构建及相关容器；恢复使用实例快照，直连列表包含用户目标、集群服务和有效 Compose 别名。
- 字面 IP 代理保存时核对站点出站 CIDR 和端口；域名代理按实际解析范围放行。代理凭据保留在授权配置中，Dev Container 状态和普通日志采用各自脱敏规则。
- 首次网络请求前生成统一 CA Bundle，Docker、Git 和 OCI Feature 下载使用同一信任；恢复取得当前证书。
- 主容器系统信任与固定证书环境变量采用同一 Bundle，Feature 构建使用构建镜像自身信任，临时文件准备不受 systemd 挂载 `/tmp` 影响。
- 组件身份验证继续使用独立证书、私钥和根池，公开出站 CA 仅服务于相应 TLS 访问。

## 运行资源统计

运行资源统计用于展示当前 Runtime 的使用情况，采集失败只影响统计刷新。Manager 在内存中组合 Kubernetes 与 Agent 的观察结果，仍通过现有 `RuntimeResourceUsage` 上报 CPU、内存、磁盘和一个采样时间。来源选择属于运行平台职责，Gitea 继续消费完整统计结果并按原有规则使过期数据失效。

CPU 和内存使用量优先采用 Metrics API 中当前 Pod 的 `runtime` 容器统计，包括 Agent、内部 Docker 和 Dev Container 的运行开销；初始化容器不参与这一口径。CPU 使用量以 millicores 表示，内存使用量采用 working set。上限优先读取该 Pod 实际的 `resources.limits`，成功读取且未设置上限时报告零，表示未限制。资源请求是调度依据，Node 容量是共享能力，两者都不能代表实例上限。

Agent 为 Kubernetes 指标缺失提供回退。它在启动时根据 cgroup v2 路径和私有挂载信息确定 Runtime 层级根目录；采样与失败诊断复用该范围，使进程迁入 `init` 或 Sysbox 的 `init.scope` 后仍包含内部 Docker 和 Dev Container。CPU 使用量来自相邻两次 `usage_usec` 的差值，首个样本仅建立基线；内存使用量为 `max(memory.current - inactive_file, 0)`，使口径接近 Kubernetes working set。CPU、内存和磁盘分别采样，单项失败保留其他有效结果。上限读取失败表示该项缺失，只有明确的 `max` 才表示未限制。失败与恢复按状态变化记录日志，便于诊断而不重复输出相同错误。

Dev Container 的 `hostRequirements` 接收同一个 Runtime 资源范围，仓库配置检查与 Feature 合并后的检查保持一致。声明 CPU 要求时，同时检查进程可用 CPU 数与 cgroup 配额；声明内存要求时，比较 cgroup 上限和可见系统内存中的较小值，明确未限制时使用可见系统内存。声明了要求但无法读取对应能力时给出明确错误，避免把无法确认的能力当成满足条件。

磁盘统计面向工作区所在的数据文件系统。Agent 用 `statfs` 读取容量 `Blocks * Bsize` 与可用空间 `Bavail * Bsize`；Manager 从 kubelet Summary 读取匹配当前 Pod UID、`data` 卷和当前 PVC 身份的文件系统容量与可用空间。Kata 的原始块卷由来宾内 Agent 挂载，因此该模式使用 Agent 的文件系统观察。

最终磁盘容量优先采用 Agent 的有效容量，Agent 缺失时采用 kubelet 容量；可用空间取两者有效观察的最小值，仅一方有效时采用该方。现有协议继续上报 `disk.limit_bytes = 容量`、`disk.used_bytes = 容量 - 可用空间`，所以显示的是不可供普通用户分配的空间，包含文件系统预留空间，而不是逐文件累加的大小。可用空间为零是有效的磁盘已满结果，缺失值则不参与比较。PVC 申请容量不代表剩余空间；共享文件系统的剩余空间也不代表该实例独享的配额。保留这些区别，才能避免显示比实际可写空间更多的余量。

Manager 每 30 秒批量请求一次 PodMetrics，每 60 秒按相关节点去重请求一次 Summary。请求超时为 10 秒，同时最多执行四个采集请求；上报路径只读取进程内缓存。Metrics API 或 kubelet 卷统计不可用时，仍可用 Agent 数据完成上报，依赖恢复后自然重新采用 Kubernetes 结果。

缓存按来源和指标保留真实采样时间，并绑定 Codespace、站点、Pod、PVC 和操作版本。同一来源只接收时间更新的观察；单项样本、上限和已发布快照都在采样时间达到 120 秒时过期，避免同一数据在组合与发布阶段得到不同的有效性判断。组合时 CPU、内存、磁盘及必要的上限都必须有有效来源，最终 `observed_unix` 取所有参与计算的最早时间。来源切换或不同采集周期使这个时间尚未前进时，继续返回上一份仍有效的完整快照，直到新的完整观察可以发布。因此页面按最慢的有效来源刷新；各站点清理自己的样本，运行身份改变后重新建立统计。

### 实现验收点

- Kubernetes 可用时使用当前 `runtime` 容器的 CPU 和内存统计；缺失时分别回退到有效 Agent 样本。
- 上限来自成功读取的当前 Pod 配置或有效 Agent cgroup 观察；明确未限制与读取失败具有不同结果。
- Agent 首次 CPU 采样只建立基线，内存剔除 inactive file cache，单项读取失败不阻断其他指标。
- Agent 迁入子组后仍统计整个 Runtime；仓库与 Feature 的 `hostRequirements` 按同一范围核对能力，必要观察缺失时返回明确错误。
- 两方磁盘可用空间取最小值，零余量保持为已满；Kata 块卷使用来宾内文件系统观察。
- 多个 Runtime 位于同一节点时，每轮只请求一次该节点 Summary；上报不发起指标采集请求。
- 乱序观察保留较新的同源样本；采样满 120 秒时统一过期，Pod 或 PVC 替换后重新建立统计，不同站点的缓存清理互不影响。
- 发往 Gitea 的统计始终是现有字段组成的完整快照，时间由真实来源决定，采集失败不会改变生命周期状态。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket、SSH 和 SFTP 入口。它从 Manager 获取当前路由，每次建立数据流前复核 Gitea 权限并取得短期 Agent 票据，再通过 mTLS 直连 Agent。Manager 不转发用户数据。

HTTP 与 SSH 服务启动前初始化同一份路由存储。Open Token 兑换、浏览器会话、公开 Endpoint 和 SSH 连接均核对当前路由的站点 UID。HTTP 成功授权缓存 30 秒，并合并同一授权的并发查询。共享查询具有独立的 10 秒预算，每个请求可以取消自己的等待；因此浏览器取消一个资源请求时，其他正在等待同一次授权的请求仍能取得结果。拒绝与查询错误返回给等待者，后续请求重新查询。允许结果、并发查询、用户身份与连接限制都包含站点 UID，因为不同 Gitea 实例可能分配相同数字用户或仓库 ID。

运行中的 HTTP 与 SSH 连接通过定期授权复核收敛权限变化。明确拒绝会结束对应访问；查询暂时失败则记录诊断并在下一周期重试，避免控制面短暂故障中断 Shell、WebSocket 或 USB/IP 连接。新的访问仍需成功授权。站点或 Pod 身份失效、运行许可到期和用户主动关闭分别按各自生命周期结束连接，因此保留已有连接不等于延长 Gateway 的运行许可。

HTTP 按端点子域名选择当前路由，Gateway 的登录兑换入口为 `/.gitea-codespace/open`。其余路径属于应用，原样保留路径编码、重复斜杠和末尾斜杠；这些字符可能参与应用的资源标识和路由匹配。找不到当前端点时返回 `404`，登录兑换成功后回到同源应用路径或根路径。

浏览器打开入口后取得由 Gateway 组件独立的 32 字节会话密钥认证加密的 Cookie。所有副本挂载同一组件密钥，因此任意副本都能校验会话的站点、用户、Codespace、端点和有效期，并在本进程建立连接计数。成功请求只续期空闲期限，绝对有效期保持不变；并发与连接上限继续按副本计算，用于保护单个进程资源，而不作为站点配额。

每个副本使用独立实例标识向 Manager 上报活动。Manager 的控制响应同时授予 30 秒运行许可：控制流短暂中断时，副本在剩余许可期内保持就绪并尝试重连，避免控制连接轮换中断正在使用的工作区。建立新控制流本身不会延长许可，只有收到 Manager 的有效响应才取得新期限；许可到期仍未恢复时退出就绪状态并关闭监听器和现有连接。Manager 在许可有效期内把失联副本的活动视为未知并暂停自动停止判断，许可到期后才移除报告。该顺序保证 Manager 不会把仍在服务但暂时失联的副本误判为空闲，也不会因只建立了半开连接而无限延长服务时间。

活动上报只统计当前控制流最近一次成功路由快照中的实例。Gateway 在实例从无连接变为有连接或反向变化时立即上报，固定心跳继续同步完整活动状态。自动停止只关心是否有活动连接，因此这种上报方式能避免每个浏览器资源请求都触发控制消息和 Kubernetes 查询。

路由快照只包含当前 Gateway UID 关联的已就绪站点，以及这些站点命名空间中绑定有效、Pod 和访问目标可用的实例。Manager 使用组件 UID、站点 Gateway UID 和实例 Site UID 的缓存索引定位候选，避免每个 Gateway 周期扫描整个集群。实例处于停止、恢复或尚未获得地址等状态时，只从快照中排除该实例；身份冲突同时记录诊断，实际读取故障仍返回错误。签发票据前实时核对站点、实例、Pod UID 和目标版本，因此缓存中的旧路由不能授权新的连接。

Gateway SSH 主机密钥由 Manager 生成，私钥保存在 Kubernetes Secret 中。轮换时 Manager 更新当前组件拥有的 Secret，凭据资源版本随 Pod 模板变化并触发 Gateway 滚动更新，再发布新的公钥指纹。会话密钥保持稳定，使已有浏览器会话在主机密钥轮换后仍可验证。使用固定 Secret 名称可以让 Deployment 始终引用当前组件的密钥，组件 UID 与所有者关系则防止同名重建后继承旧密钥。Agent 提供 Shell、命令、SFTP、HTTP Endpoint 和回环端口转发；Dev Container 通过本地 Unix socket 管理 Endpoint。

SSH Shell 请求启动远程用户在容器账户数据库中配置的登录 Shell。PTY 由客户端单独申请：普通终端带 PTY，`ssh -T` 和 VS Code Remote-SSH 的初始化阶段则可以不带 PTY，并把脚本从标准输入发送给登录 Shell。SSH 命令请求继续使用同一个登录 Shell 的 `-c` 语义执行明确命令。保留两种请求的区别，可以让非交互初始化、交互终端和直接命令都使用相同用户环境，同时避免把空命令解释为另一种操作。

SSH 命令正常退出时先有界排空输出再发送退出状态；断连时同时关闭 RPC 与本地管道，释放被慢客户端阻塞的读取和写入，重复关闭保持幂等。TCP 两个方向分别关闭：客户端 EOF 只关闭目标的写入方向，目标 EOF 只关闭 SSH channel 的发送方向。两个方向均结束后释放连接；错误或取消则结束当前 channel。一个 channel 的结束不影响同一 SSH 连接上的其他 channel，因此端口转发与 Shell 可以独立使用。

Agent 使用 CNI `pkg/ns` 在授权容器的实际网络命名空间创建 TCP socket：SSH 本地转发连接主 Dev Container，HTTP Endpoint 连接端点所属容器，普通 SSH 远程转发在主容器内监听。每次查询当前 Docker PID 并打开命名空间句柄，避免容器重建后继续使用旧进程。拨号和监听完成后立即离开命名空间，后续数据读写共用同一 TCP 转发实现。这样每条 TCP 连接只需要 socket 和 Access 流，连接复用继续由 Gateway 的标准 HTTP Transport 负责。

网络命名空间只改变 socket 的网络归属。socket 由 Agent 的进程凭据与 cgroup 创建，并不以 Dev Container 的 `remoteUser` 运行；这是平台代理行为，Runtime Pod 仍是整体资源计量与限制边界。Shell、命令和 SFTP 则通过 Docker exec 使用容器的用户、工作目录和远程环境，因为这些操作依赖容器文件系统与账户权限。IPv4 与 IPv6 回环拨号在同一个命名空间锁定线程中依次尝试字面量地址，防止并行拨号的 goroutine 离开目标网络。

SSH 远程转发使用 OpenSSH 标准请求与 channel。普通 `-R` 默认 localhost，支持 IPv4、IPv6、通配地址和端口零；绑定失败直接返回错误，容器共享网络时按其实际网络命名空间执行。`usbip.<来源名>:3240` 则创建 Agent 回环随机端口上的 USB/IP 来源。这一区分让普通转发具有用户预期的容器内行为，同时把内核 USB/IP 客户端的入口留在 Agent。

HTTP 继续由 Go `httputil.ReverseProxy` 转发，每个有效 Endpoint 复用长期存在的 `http.Transport`，由标准库管理 HTTP keep-alive 和符合条件的重试。Gateway 到同一 Agent 的 HTTP、WebSocket 与 SSH 数据流共享 mTLS HTTP/2 客户端，每个目标连接占用独立 Access 流。上游 TCP 的 EOF 通过内部协议及时传回，让 HTTP Transport 淘汰失效连接；下一次请求可以创建新的目标连接，而其他正在传输的流保持不变。

建立预算覆盖票据、RPC 和对应能力的建立操作，包括网络命名空间查询与 TCP Dial，或 Shell/SFTP 的 exec，最多等待 15 秒。连接成功后移除建立计时器，HTTP 响应头和响应体按应用的处理时长等待，由请求取消、连接关闭或运行身份失效结束相应访问；这样长轮询、SSE、WebSocket 和 SSH 都能保留自身的通信周期。Runtime 停止或执行目标替换时，同时取消尚未完成的拨号和现有 TCP 数据流。Provider 尚未监听时，本次实际连接失败并由 Gateway 返回临时错误，之后的访问独立尝试连接。这使 Provider 的启动速度与 Codespace 的运行状态保持明确分工。

每个 Gateway 组件都有同名 ClusterIP Service：`80/http` 转发到 Gateway 的 HTTP 进程，`22/ssh` 转发到 SSH 进程。这个 Service 是应用访问与 Kubernetes 网络的稳定边界，多个 Gitea 站点可以共享一个 Gateway，而站点身份、授权和连接限制仍在 Gateway 内分别处理。

HTTP 可以由集群运维自行转发同名 Service，也可以由 Manager 为通配端点域名创建 Ingress。HTTPS 使用现有 TLS Secret，或通过 cert-manager Issuer 维护 Manager 自动命名的 Secret；Gateway Pod 只接收 Service 内的 HTTP，不持有外部 HTTPS 私钥。SSH 可以由集群运维转发，也可以通过独立的 `<component>-ssh` LoadBalancer Service 发布端口 22。SSH 主机密钥继续由 Manager 管理，与 HTTPS 证书分别轮换。

Gateway 默认只把 TCP 对端作为客户端地址。只有直接对端属于管理员配置的可信代理 CIDR 时，Gateway 才按从右到左的顺序校验 `X-Forwarded-For`，并选择第一个不可信地址作为客户端。这样 Ingress 后的连接可以保留真实来源，同时外部请求不能用伪造请求头改变日志、限流和授权上下文中的客户端地址。

### 实现验收点

- 每个数据流都需要当前有效的用户授权和 Agent 票据。
- 授权缓存、并发查询与连接限制使用站点 UID 区分身份；成功授权在 30 秒内复用，拒绝和错误由后续请求重新核对。
- 共享授权查询在独立的 10 秒预算内完成并释放容量；取消任一等待请求后，其他请求仍可取得查询结果。
- HTTP 与 SSH 已有连接在授权查询暂时失败后继续运行，明确拒绝时结束访问；运行许可和运行身份变化仍正常关闭连接。
- 应用收到的路径编码、重复斜杠和末尾斜杠与原始请求一致；登录兑换入口继续校验域名和站点绑定，其他路径交给当前端点。
- SSH 主机私钥只存在于对应 Secret。
- 单个实例不可用不影响其他实例的路由，Pod 被替换或目标失效后不能获得访问票据。
- Gateway 快照只读取绑定到自身的站点和实例，站点数量增长不会扩大为全量 Runtime 扫描。
- SSH 正常退出保留输出和退出码；任一方向半关闭后反向仍可传输，关闭一个转发 channel 不影响其他 channel。
- 连续 HTTP 请求复用目标 TCP 连接；上游关闭空闲连接后，后续请求可以重新建立连接。
- 建立失败在预算内释放连接资源；请求取消和 Pod 移除会解除被阻塞的本地管道与 RPC。
- SSH Shell 在有无 PTY 时都使用远程用户的登录 Shell；无 PTY Shell 能从标准输入执行脚本，命令请求只执行明确的非空命令。
- 每张票据只绑定一种访问能力。
- 本地端口转发只访问当前主 Dev Container 的回环地址；HTTP Endpoint 使用各自容器的网络命名空间，支持 IPv4-only 和 IPv6-only 服务。
- Agent 与目标容器的同名回环端口相互独立，拨号只命中授权目标；Runtime 停止或执行目标替换会取消拨号并结束 TCP 连接。
- 普通远程转发在主 Dev Container 内监听，端口零返回实际端口；`forwarded-tcpip` 使用原请求的绑定地址和实际端口，OpenSSH 能匹配对应转发。USB/IP 特殊绑定在 Agent 回环随机端口监听，并保留来源名及逻辑端口 3240 作为 SSH channel 的地址。
- 每个反向 TCP 连接使用独立 Access 流和 SSH channel，复用 Gateway 到 Agent 的 mTLS HTTP/2 连接。取消普通监听后已建立的 channel 继续传输；取消 USB/IP 来源会结束其设备流。取消成功回复前完成新连接接受和 channel 打开的交接；监听控制流失败结束所属 SSH 连接，单个数据 channel 的失败不关闭其他转发。
- Pod、Agent 身份或地址变化后释放旧客户端和活动流；端点移除或可见性变化结束对应 HTTP 访问。展示信息与端点列表更新保留未改变目标的连接，新的票据仍绑定当前目标版本。
- 同名 Service 始终只提供 `80/http` 与 `22/ssh`，切换发布方式不会重建 Gateway Deployment。
- 一个副本签发的浏览器会话可以由同组件的其他副本验证，篡改、过期或资源身份不匹配的会话会被拒绝。
- SSH 主机密钥轮换保留会话密钥；活动状态在连接数跨越零时立即上报，固定心跳同步完整状态，Manager 仅接收当前快照中的实例活动。
- Gateway 控制流失联期间自动停止等待运行许可收敛；许可到期后该副本不再保留监听器或用户连接。
- Ingress 只使用选定的 IngressClass 和通配端点域名；HTTPS 只引用选定的 TLS Secret 或 Issuer。
- SSH LoadBalancer 只发布端口 22 并保留客户端来源地址；改为外部管理后控制器清理自己拥有的发布资源，同名 Service 保持可用。
- 不可信直接对端的 `X-Forwarded-For` 不会改变客户端地址，可信代理链中的无效地址使整条请求头失效。

## Cache

Cache 是独立组件，支持本地文件系统或 S3。它为允许的上游镜像提供代理，并按 GiteaSite UID、仓库 ID 和用户 ID 生成签名缓存目录。每个已配置的上游至少包含一个仓库允许规则，使配置项始终对应明确的回源范围，避免保留永远无法命中的镜像站。站点 UID 区分不同站点以及同名重建的站点，避免 Gitea 各自分配的数字 ID 重合造成跨站点共享。Runtime 的 Docker 数据保存在 PVC，Cache 只减少重复下载与构建。

文件系统 Cache 的最大缓存容量与保留空间之和需要落在 PVC 容量内，使容量声明为正常缓存写入和维护保留可用空间；管理 API 在保存配置时完成这项校验。

每个 Cache 组件都有同名 ClusterIP Service。Service 固定提供 `443/https`，转发到 Cache 容器的 `8443` 端口，集群内地址为 `https://<component>.<management-namespace>.svc`。NetworkPolicy 使用 Cache Pod 声明的 `https` 命名端口，因此 Service 端口、Pod 端口和网络放行规则始终指向同一条 TLS 链路。地址由 Service 身份推导，因此管理页面只展示实际服务地址。Manager 内部 CA 为该 DNS 名称签发独立的服务端证书，并保存到 `<component>-registry-tls` Secret。Cache 启动时加载并校验证书，此后新 TLS 握手从内存快照取证书，每分钟最多检查一次 Secret 投影文件；续期成功后整组快照同时替换，因此短期证书续期无需重建 Pod，也不会让高频连接反复访问文件系统。

Cache 使用 `<component>-identity` 中的组件证书与 Manager 建立双向 TLS 控制连接。Registry 服务证书只包含 Service DNS 名称和服务端用途，不能代表 Cache 调用 Manager。Runtime Agent 在启动内部 Docker 前把完整出站信任包投影到该缓存主机对应的 Docker `certs.d` 目录，Docker 和 BuildKit 使用其中的内部 CA 验证 Cache 的 HTTPS 证书。

Cache 可以单独声明回源代理，因为共享 Cache 所在管理命名空间与站点 Runtime 可能具有不同出口。代理环境同时作用于 OCI 回源、S3 和 Manager 客户端；Kubernetes Service 域名自动直连，因此控制连接和集群内 Registry 请求不会绕到外部代理。代理 CA 在系统根证书池上追加，并在 Cache 启动时完成校验。代理 URL、直连目标或 CA 变化会改变组件 Secret 的资源版本，Cache 使用 Recreate 策略重启后取得一组一致的新配置。

Cache 从 Manager 获取配置、短期 Registry 凭据和维护许可。Registry 使用 HTTPS Basic 认证承载 Manager 签发的短期令牌：固定用户名只标识认证方式，密码字段中的签名令牌携带 Cache、站点命名空间、操作权限和有效期。这样 Docker、Compose 和 BuildKit 都能使用标准 Registry 认证流程，同时由 Cache 对每个请求执行完整授权。上游地址仍作为配置和授权中的真实地址保存；为了让带端口的地址也能组成合法 OCI 路径，Cache 镜像路径使用由完整上游地址计算出的稳定 SHA-256 标识，例如 `/mirror/<upstream-id>/<repository>`。端口参与摘要计算，因此不同端口不会共用路径；这个标识只负责路径编码，回源和允许列表仍通过真实上游配置完成。

Runtime Agent 在创建 Dev Container 前把 Registry 凭据写入 `/run/codespace/docker-config/config.json`。该目录位于内存型 EmptyDir，并通过 `DOCKER_CONFIG` 同时提供给 Agent 中的 Docker CLI 和 Compose 启动的外部 Buildx 进程。构建结束后 Agent 立即删除认证文件，因此凭据不会进入工作区、Runtime 数据卷或恢复状态。使用标准文件而不是进程内配置，是因为 Bake 模式下的 Buildx 是独立进程，无法读取父进程内存中的 Docker 配置。

每个 Registry 请求都验证凭据、Cache 身份、站点命名空间、操作权限和有效期；镜像代理只允许拉取，构建缓存允许拉取和推送。缓存路径用于隔离对象，签名凭据用于授权访问，两者共同防止共享 Cache 中的跨站点读取。缓存丢失时允许在原授权范围内回源；维护许可保证同一存储同一时刻只有一个垃圾回收执行者。

申请清理许可和提交清理完成均等待 Manager 按请求序号确认。等待受超时和调用取消控制，结束后释放请求记录；迟到的响应只对应原请求，连接故障同时结束尚未确认的维护请求。这样“已发送”与“已完成”有明确区别，重连也不会继续持有旧请求的等待资源。

垃圾回收使用现有的 Cache GC Lease 协调凭据发放和清理。一次镜像推送包含 blob 上传、HEAD 复用和 manifest 提交等多个请求，因此仅等待当前 HTTP 请求结束不足以保护完整推送。维护过程按以下顺序执行：

1. Manager 返回新的 Registry 凭据前，先把凭据的最晚有效时间写入 Lease。
2. 开始维护时原子冻结新的凭据发放，并以已登记的最大到期时间确定内部维护许可的 `ReadyAt`。新建操作改用其他 Cache；没有其他 Cache 时继续创建但不使用缓存。
3. 已有凭据在 `ReadyAt` 前继续有效，使客户端可以完成整次推送。到达该时间后，Cache 在固定的 10 分钟窗口内排空活动请求并执行 Distribution 清理，避免仍在传输的请求与垃圾回收交错。
4. Lease 保留未完成许可和最近清理完成时间。控制连接重建或 Manager 重启后，未完成的维护恢复原截止时间；已完成且尚未达到最小清理间隔时返回空许可并继续服务。
5. 清理结束释放持有者、记录完成时间，并保留已登记的凭据到期时间。清理失败也提交完成结果以解除冻结；许可过期后同样恢复凭据发放。

暂时停止新凭据发放的最长时间是现有凭据的剩余有效期加上 10 分钟排空与清理窗口。重连沿用持久化的截止时间，因此不会延长这个窗口；缓存维护也不会改变 Codespace 的运行状态。

Cache 执行许可在 Manager 首次获取 Kubernetes Lease 后生效，后续只由成功续约的对应请求确认延长。Cache 用请求发送时间加许可时长计算到期，并保留一秒余量；后续独立配置推送和重复确认只更新配置或被忽略，不会增加执行时间。独立到期计时器同时取消请求、上传和垃圾回收，即使控制流发送阻塞，旧进程也会停止使用共享存储。

控制流结束后，Manager 保留已有 Lease 直到自然到期。断连无法证明远端进程已经停止，等待现有的 15 秒租期可以让旧进程先按本地许可退出，再允许新进程接管存储。停用后的 Cache 停止获取和续期租约；客户端遇到到期许可时重建连接，以便重新启用后正常恢复。管理面删除 Cache 组件时也检查这段租期：先停用 Cache 并等待租期结束，再删除组件，避免级联回收 Lease 使旧写入者提前失去保护。

Cache Deployment 使用 Recreate 更新策略。新 Pod 只有在旧 Pod 停止并且租约到期后才能取得执行许可，Service 也只会选择通过 Registry 就绪检查的实例。这与 Cache 的单写租约共同覆盖组件更新、节点故障和控制流中断，保持同一存储的单进程写入。

### 实现验收点

- 私有镜像和构建缓存按站点、仓库与用户范围隔离读取。
- 文件系统 Cache 的最大容量与保留空间之和超过 PVC 容量时，保存返回配置错误。
- Cache Service 使用 `443/https`，容器使用 `8443`，管理页面根据实际 Service 展示内部地址。
- Cache NetworkPolicy 使用 Pod 的 `https` 命名端口，Service 的 `443` 到容器 `8443` 的映射与网络放行保持一致。
- Cache Registry 证书只绑定当前 Service DNS 名称；文件证书源一分钟内复用有效快照，续期后的新连接在下一次检查后使用新证书。
- Cache 控制连接身份与 Registry 服务证书使用独立 Secret 和证书用途。
- Runtime Docker 与 BuildKit 使用完整信任包中的内部 CA 验证 Cache 的服务端证书与主机名。
- Cache 的 OCI 与 S3 回源遵循组件代理，Manager 和集群内部地址保持直连；代理 CA 在保留系统根证书的基础上生效。
- Cache 代理 URL、直连目标或 CA 变化后由 Recreate 更新到单一配置版本，不会同时运行使用不同网络配置的两个写入进程。
- Docker CLI 与外部 Buildx 从同一份内存卷配置读取短期 Registry 凭据，构建成功或失败后认证文件均被删除。
- Registry 通过标准 HTTPS Basic challenge 接收 Manager 签发的短期令牌，不需要额外的令牌交换接口。
- 未携带有效短期凭据的 Registry 请求被拒绝；镜像代理只接受拉取，构建缓存按授权接受拉取和推送。
- 每个上游镜像至少保存一个有效仓库允许规则，空规则在资源保存前返回配置错误。
- 上游地址的配置键和授权仍保留原始主机与端口；带端口的地址经过稳定 SHA-256 路径标识后能够通过 OCI 引用校验，不同端口不会产生路径冲突。
- 清理完成在 Manager 确认后才返回成功；取消、超时和控制流关闭均结束等待，并可在后续有效连接上继续维护。
- 新凭据只在 GC Lease 登记到期时间后返回；维护开始后不再发放新凭据，已有凭据在 `ReadyAt` 前可以完成完整多请求推送。
- `ReadyAt` 跨 Cache 控制连接重建和 Manager 重启保持不变，清理完成或许可过期后恢复凭据发放。
- Cache 控制连接轮换不会重置最近清理时间；最小清理间隔内保持服务，未完成清理恢复原截止时间，完成清理释放持有者并保留凭据到期记录。
- Cache 清空后可以回源，已有 Codespace 仍可从 PVC 恢复。
- 同一存储同一时刻只有一个垃圾回收执行者。
- 数字仓库和用户 ID 相同的不同站点仍使用不同缓存目录和授权。
- 控制流单向中断、发送阻塞、迟到响应和重复响应均不能使 Cache 超过已确认的许可期限运行。
- 停用后的 Cache 不再续约，组件在写入租期结束后才可删除。
- Cache Deployment 固定一个副本并使用 Recreate；更新期间不会出现两个同时写入缓存的进程。

## 高可用与恢复

Manager 多副本通过 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持可接替状态。新 Leader 先核对 Gitea 当前操作与 CR、PVC、Pod 和 Agent，再领取新任务。

Manager、Gateway 和 Cache 在各自 Pod 的 `8081` 端口提供独立明文 HTTP 健康服务，`/healthz` 表示进程存活，`/readyz` 表示组件按自身职责就绪。Kubelet 直接访问该端口，Service、Ingress 与业务 NetworkPolicy 不发布它，使健康检查独立于内部证书和业务流量。Gateway 在 HTTP 与 SSH 监听成功且运行许可有效时就绪，控制流短暂中断时使用剩余许可；Cache 在取得单写许可、完成存储初始化并启动 HTTPS Registry 后就绪。Registry 使用服务端 TLS 和短期令牌验证镜像请求，Cache 到 Manager 的控制连接使用 mTLS。外部控制面暂时不可用只影响相关就绪状态，进程保持存活，避免无效重启扩大故障。

恢复不依赖节点本地文件。正常停止时，Runtime Pod 的 writer finalizer 会一直保留到 kubelet 报告容器已经终止；Manager 先把对应 Pod UID 记录为已停止，再释放 finalizer。这样控制器主动发起的停止具有明确的先后顺序。Pod 对象已经不存在时，Manager 立即撤销旧执行权和路由，把未完成的 create 或 resume 记为失败，并将环境自动收敛到 stopped。缺失 Pod 被视为集群管理员或节点控制面已经完成的删除事实，这一选择避免环境永久等待人工确认；集群存储仍需为 Runtime 卷提供与声明访问模式一致的挂载隔离。

Manager 管理页面提供单个 Runtime 的维护停止操作。请求绑定当前 Runtime UID 和 Pod UID：稳定运行的环境记录本地停止意图，正在 create 或 resume 的环境先记录该操作失败，再复用相同的 Pod 停止流程。停止完成后，现有资源清单会把 stopped 状态同步给 Gitea，因此维护操作不需要增加第二套公共生命周期协议。

Gitea 删除 Manager 身份与运行平台清理分别由各自管理员操作。Manager 管理面在站点停用后允许显式删除运行环境数据，请求携带当前 CR UID、资源版本和 Pod UID。控制器复用普通 delete 的终止顺序和资源删除流程，避免失效凭据触发不可撤销的数据删除。

### 实现验收点

- 同一时刻只有 Leader 推进生命周期操作。
- 新 Leader 完成资源核对前不领取新 create。
- Manager、Gateway 和 Cache 的健康检查使用独立 `8081` 端口及 `/healthz`、`/readyz`，组件 Service 与 Ingress 保持业务端口不变。
- Gateway 在控制流短暂中断且许可有效时仍就绪；Cache 在租约有效且 Registry 已启动时就绪，Kubelet 使用独立健康端口。
- 部分清单、未知归属或失联节点不会触发误删或双写。
- 正常停止先持久化已停止的 Pod UID，再释放 writer finalizer；finalizer 意外缺失时会在发起删除前补回。
- Pod 对象缺失时自动撤销旧访问并收敛到 stopped，未完成的 create 或 resume 会得到明确失败结果。
- 管理页面的维护停止只对当前 CR 和 Pod 身份生效，重复请求保持幂等，并通过现有资源清单同步到 Gitea。
- 站点停用后的数据删除仍先确认旧写入者停止，再回收 PVC；同名替换或过期页面不能删除新资源。
