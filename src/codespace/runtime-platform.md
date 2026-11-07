# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 继续负责用户、权限和业务状态。

## 控制面与资源

Manager 提供管理 API 和 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略位于其中。

管理 Service 默认只在集群内提供，管理员可以通过端口转发、反向代理或 Ingress 访问。页面使用当前来源访问 API，因此入口地址变化不会改变认证身份；管理 Token、服务端会话和 CSRF 负责保护写操作。浏览器经 HTTPS 访问时会话 Cookie 使用 `Secure`，经本机 HTTP 端口转发时仍能完成首次配置。

`EnvironmentTemplate` 定义隔离方式、RuntimeClass、资源、StorageClass、Git SSH 密钥类型和 Dev Container 附加配置。它的 Kubernetes `metadata.name` 同时作为 Gitea 环境标签，使用 1 至 63 个小写字母、数字和中划线。一个对象只保留这一份稳定标识，可以避免资源名、站点引用和调度标签分别修改后指向不同环境；Kubernetes 保证名称在创建后不变，管理员需要调整的说明和运行配置仍可继续编辑。模板是集群级资源，因此多个 Gitea 站点可以通过名称和 UID 共同引用同一个模板。

RuntimeClass 使用 `codespace.gitea.dev/isolation=kata|sysbox` 标签声明其隔离语义，管理页面据此列出可选项，保存模板时再次核对标签和资源是否仍然存在。这样管理员选择的是经过集群声明的运行能力，而不是可能拼错或与隔离方式不符的自由文本。模板控制器持续检查 RuntimeClass 与 StorageClass；两项依赖可用时自动写入 `Ready=True`，依赖变化时更新为明确的不可用状态，使页面展示的结论始终与集群中的当前事实一致。

管理页面同时发现 StorageClass、IngressClass、TLS Secret 和 cert-manager Issuer，并始终用下拉框表达这些 Kubernetes 引用。编辑对象引用的资源已经不存在时，页面保留原值并标记为不可用，管理员需要选择当前有效资源后才能保存；这个行为使配置失效可见，也避免静默改用另一个运行环境。资源数量和时长使用数值与单位分开的输入方式，Manager 保存并校验转换后的原生 quantity 和 duration。

站点配额用于限制一个 Gitea 站点能够占用的 Runtime 总量，管理员可以按集群的容量管理方式选择是否启用。启用时，Manager 维护站点命名空间中的 `ResourceQuota`，约束 Pod、PVC、CPU 请求、内存请求和存储请求；关闭时不创建配额，让 Kubernetes 调度器和集群已有的容量策略决定是否接纳工作负载。环境模板始终声明 CPU 和内存请求，使调度器能够规划容量；资源上限可选，适合由平台统一限制或允许开发工作负载临时使用空闲资源的集群。请求与上限分别表达调度保证和最大用量，因此上限启用时必须不低于请求。

隔离方式同时决定 PVC 的接入形式：Kata 使用原始块设备，由来宾内 Agent 挂载 Docker 数据；Sysbox 使用 Kubernetes 文件系统挂载。卷模式属于隔离实现的一部分，因此由 Manager 统一推导，模板只保存隔离方式这个权威事实。创建时，Manager 把模板内容和当前平台镜像引用写入 Codespace CR，使后续恢复继续采用创建时选择的运行配置。平台镜像可以是显式标签或摘要：标签用于持续更新的开发环境，摘要用于内容固定的部署。管理 API 使用 Kubernetes UID 与 `resourceVersion` 处理对象身份和并发修改；S3 密钥等独立业务 Secret 使用只写接口，出站代理作为完整运行配置由声明资源读取和编辑。

管理页面提供英文、简体中文、日文和韩文，浏览器语言用于首次选择，管理员的手动选择保存在本地浏览器。四种语言使用同一组 JSON 词典，Vue 页面直接读取这些词典，Go 管理 API 也从同一目录读取词条并按 `Accept-Language` 返回本地化摘要。管理 API 同时返回稳定错误码和诊断详情：摘要面向管理员展示，诊断详情保留 Kubernetes 返回的具体原因。资源状态也按稳定的 Condition reason 显示本地化摘要，原始 Condition message 只作为可展开的技术详情。共用词典的原因是前后端面对的是同一位管理员，分别维护两套文字会产生词条遗漏和含义不一致。

`CodespaceComponent` 定义一个 Gateway 或 Cache。组件是集群级资源，因为多个站点可以引用同一个平台入口或缓存；它生成的 Pod、Service、NetworkPolicy、身份 Secret 和缓存卷集中在管理命名空间。站点保存组件名称和 UID，Manager 在建立控制流和投影路由时再次核对角色与 UID，因此删除后创建的同名组件不会接管旧站点关系。

Gateway 处理无状态入口和短期连接，可以配置 1 到 64 个主动副本，默认运行两个。Service 把请求分发到任意就绪副本，软反亲和性优先把副本分散到不同节点，PodDisruptionBudget 使计划内维护时至少保留可用入口。Cache 持有镜像缓存的单写租约并可能挂载 ReadWriteOnce 卷，因此固定运行一个副本，并用 Recreate 更新策略先停止旧进程再启动新进程。两类组件采用不同副本策略，是为了让入口获得故障切换能力，同时保持缓存写入边界简单明确。

### 实现验收点

- Manager 只连接一个 Kubernetes API。
- 管理页面可经端口转发、HTTP 代理或 HTTPS Ingress 登录和保存，入口地址变化不需要修改 Manager 配置。
- 不同站点的资源、凭据、配额和网络策略相互隔离。
- 环境模板的资源名与 Gitea 环境标签完全一致，创建后名称不可编辑，说明和运行配置仍可更新。
- 多个站点可以按同一名称和 UID 引用一个集群级环境模板。
- Manager、Gateway、Cache 和 Runtime 使用同一份显式标签或摘要镜像引用。
- 模板更新只影响新环境；摘要模式下平台升级也只影响新环境。
- 管理 API 不返回长期 Secret 明文。
- 管理页面只列出带有效隔离标签的 RuntimeClass 和集群中存在的 StorageClass。
- 保存模板时 RuntimeClass 标签需要与隔离方式一致，StorageClass 需要仍然存在。
- 模板保存后由控制器根据当前依赖自动进入就绪状态；依赖失效和恢复会分别更新状态。
- 单个候选资源仍显示为下拉框；已经失效的引用保持可见并阻止保存。
- 资源请求、可选上限、可选站点配额、缓存容量和时长以明确单位编辑；启用上限时 request 不超过 limit。
- 关闭站点配额后不保留 Manager 管理的 `ResourceQuota`，关闭环境资源上限后 Runtime Pod 只带请求值。
- Kata 模板生成块模式 PVC，Sysbox 模板生成文件系统模式 PVC，模板中没有第二个卷模式配置来源。
- 管理页面语言切换同时作用于导航、表单、确认框、资源状态和组件语言，并在刷新后保持。
- 四种 JSON 词典具有相同键集合；前端请求携带当前语言，管理 API 的错误摘要来自同一组词典。
- 管理 API 错误包含稳定代码和诊断详情，页面不依赖英文错误文字判断会话状态；动态集群诊断仍可在技术详情中查看。
- 一个组件声明只选择 Gateway 或 Cache 角色，控制器能从声明恢复对应工作负载。
- Gateway 按声明的副本数运行并在多副本时创建 PDB；Cache 始终以单副本 Recreate 方式运行。
- 站点引用、组件证书和凭据均绑定组件 UID。

## Runtime 与持久数据

Runtime Pod 使用平台镜像，Agent 作为 PID 1 启动专属 Docker、准备工作区、创建 Dev Container、执行生命周期命令并提供访问 RPC。Manager 与 Agent 即使来自同一个平台镜像，也运行在不同 Pod 中；同一镜像用于统一发布和审计，不会合并各自的进程与权限边界。用户镜像运行在该 Docker 中，不直接成为 Kubernetes Pod 容器。

环境模板显式选择 Kata 或 Sysbox RuntimeClass。失败时继续保留原隔离选择，因为自动切换会改变安全边界。仓库配置和环境模板进入同一 Dev Container 解析路径；环境模板可以追加标准 Dev Container Features。Web IDE 使用平台维护的 `ghcr.io/coder/devcontainer-features/code-server:2`，管理员直接填写该 Feature 的 options 对象，因此新版本增加的标准选项不需要同步扩展管理 API。平台最后覆盖内部监听地址、端口、认证、工作区、TLS、遥测和更新检查，因为这些值需要与 Gateway 和 Codespace 生命周期保持一致。仓库 `customizations.vscode` 继续负责项目设置与扩展；Feature options 中的公共扩展在构建时安装，仓库扩展在首次创建时补充，两者使用各自的标准语义。

环境模板还可以提供一份模板生命周期脚本。镜像构建在仓库镜像、Features 和远程用户 UID/GID 调整完成后生成最终派生层，以 root 身份调用脚本的 `build` 分支；脚本随最终镜像保存，使构建缓存自然包含基础镜像和脚本内容。主容器每次进入运行状态后，Agent 在 CA、Git、标准 Dev Container 生命周期和访问入口之前以 root 身份调用 `start`。正常停止则先调用 `stop`，再停止容器。采用单脚本和固定参数是为了让公共准备逻辑只维护一份，同时明确区分环境模板提供的扩展与 Dev Container 规范生命周期。

Dev Container Feature 接受规范定义的对象、布尔值和字符串输入。字符串表示 `version` 选项，对象中的字符串和布尔值会转换为 `install.sh` 的环境变量；`false` 表示不启用该 Feature。解析器递归读取 `dependsOn`，再应用已经存在的 `installsAfter` 关系，并以解析后的内容摘要和最终选项判断是否为同一安装节点。这样相同内容不会重复安装，而同一 Feature 的不同选项仍能得到各自的安装结果。锁文件使用小写 Feature 标识和依赖，确保配置大小写差异不会绕过已经锁定的摘要。平台注入且仓库没有声明的 Feature 不进入仓库锁文件；仓库与平台共同声明同一引用时，仓库继续拥有该锁记录，并锁定合并后的有效选项。这样管理员配置不会创建无关的仓库变更，同时仓库主动声明的依赖仍可复现。

镜像元数据、按依赖顺序安装的每个 Feature 和仓库配置分别贡献生命周期命令组。命令组之间顺序执行，因为后一个来源可能依赖前一个来源生成的文件；同一来源使用对象语法时，对象中的命令并行执行，保留规范提供的并发能力。Agent 把命令组直接保存到 Dev Container 状态，并从持久化配置中清理已经分组的容器生命周期字段，使恢复始终读取同一个命令来源；宿主侧 `initializeCommand` 继续保存在配置中，用于每次明确的恢复操作。`${devcontainerId}` 由 Codespace 的稳定身份计算为小写十六进制摘要，同一环境重建时保持不变。

Docker Compose 未声明 `workspaceFolder` 时使用规范默认目录 `/`。Agent 同时保存 Compose 服务与容器的一对一对应关系，使 `forwardPorts` 中的 `db:5432` 能转发到 `db` 服务；普通数字和 localhost 地址仍指向主 Dev Container。跨服务端点需要唯一目标，所以同一服务产生多个容器时在生命周期命令执行前返回明确错误。端点公开信息继续只包含标签、端口和可见性，服务到容器的选择属于 Runtime 内部状态，因此不会把 Compose 实现细节带入 Gitea 协议。

每个 Codespace 使用独立 PVC 保存工作区、内部 Docker、Git SSH 私钥和 IDE 数据。Token、用户 Secret、Unix socket 与进程状态写入易失目录。Agent 把当前 Token 和经过校验的 SSH 凭据副本放入 Pod 的内存卷，并以只读方式映射到主 Dev Container。初始克隆使用 Agent 可见的 `/run/codespace` 路径，容器内 Git 使用 `/var/lib/gitea-codespace` 路径；两边都通过 Git 的 credential helper 命令读取 Token，并通过 `core.sshCommand` 绑定私钥和 `known_hosts`。工作区准备是可重复的：未完成的克隆只使用临时目录，目标目录已存在时核对锁定提交并刷新 Git 凭据。`onCreateCommand`、`updateContentCommand` 和 `postCreateCommand` 只属于首次创建，`initializeCommand` 与 `postStartCommand` 属于每次创建或恢复，`postAttachCommand` 属于每次新连接；启用 Web IDE 时，每次创建或恢复后启动 code-server 计为一次平台连接，未启用时创建和恢复本身不产生连接。平台连接的 Web IDE 启动和 `postAttachCommand` 采用尽力执行，因为这项附加服务不能让已经可通过 SSH 使用的环境创建或恢复失败。Agent 在 PVC 中记录当前操作内的开始和结果，Manager 重连时只重复上报已经完成的结果；结果未知时停止该次操作并提供诊断。这样既保留规范要求的执行时机，也不会在控制流重连后重复运行同一次命令。

启用 Web IDE 时，Agent 在首次创建中写入仓库的 VS Code 设置并安装仓库扩展，后续恢复和 code-server 重启保留用户已经修改的 IDE 数据。容器内现有的 Codespace 运行时二进制负责监督 Feature 提供的 code-server 入口，通过文件锁保证同一 Dev Container 只有一个监督进程；子进程正常或异常退出后按有上限的间隔重启，容器停止时终止整个子进程组。Workspace endpoint 在模板启用 Web IDE 时保持发布，Gateway 建立该端点连接时短暂等待本地监听端口恢复。这样浏览器可以跨越短时间的 IDE 重启，而 Codespace ready、SSH、SFTP 和其他端点不依赖 code-server 的进程健康。

主 Dev Container 的解析后 `workspaceFolder` 与访问目标一起保存在 Codespace 状态，并在 ready Runtime Metadata 中发送给 Gitea。Gitea 使用该容器路径生成 VS Code 和 Zed 的 SSH 打开地址，所以自定义工作目录、Compose 工作目录和变量替换后的结果都能准确进入编辑器。路径作为运行事实保存在 Kubernetes 状态而不是 Gitea 数据库中，使 Manager 接管后可以继续发布同一结果，也避免保存能够从 Dev Container 状态重新得到的业务副本。Web IDE 是否启用只决定 Workspace HTTP Endpoint 是否存在，不影响 SSH 编辑器链接和 Codespace 的 ready 状态。

Agent 建立用户访问时先校验票据、访问类型、命令、终端和目标，再运行 `postAttachCommand` 并创建 Docker Exec。这个顺序使每个有效连接继续获得规范定义的连接阶段环境，同时无效或不完整的请求不会触发仓库命令。输入控制、输出回传和退出状态在同一个 Exec 生命周期内处理，断连关闭对应连接而不改变 Codespace 生命周期状态。

`${localEnv:VAR}` 和 `${env:VAR}` 从 Agent 明确提供的宿主环境解析。Codespace 提供运行用户的 `HOME`、`USER`、`LOGNAME`、进程执行所需的 `PATH`、`SHELL`，以及模板声明的标准代理变量；`initializeCommand` 使用同一组值。采用明确列表是因为 Kubernetes Pod 环境还包含 Manager 地址和资源身份，这些控制面信息与开发命令无关。代理变量属于管理员确认的运行网络入口，需要同时提供给 Git、初始化命令和 Dev Container 构建。

恢复状态使用单一的当前格式，并在读取时完整校验身份、路径、容器和 Compose 服务映射。状态格式变化的版本发布前先排空并删除旧 Codespace，使新 Agent 从创建流程写入完整状态；这样恢复代码不需要猜测旧字段含义，也不会用不完整状态启动容器。该发布步骤只影响 Runtime PVC 中的 `environment.json`，Gitea 业务数据和公共协议不随内部状态格式变化。

站点的运行网络配置声明 Runtime Pod 能够访问的 CIDR 与 TCP 端口，其中包括 Gitea 的 HTTP 或 SSH 克隆地址，以及生命周期命令需要访问的其他服务。Kubernetes 标准 NetworkPolicy 以地址段和端口表达出站规则，不能用可移植方式跟随域名解析，因此 Manager 保留显式配置并在页面中说明用途。克隆失败时 Agent 记录尝试的协议和目标主机，管理员可以据此补全网络规则，同时日志不会包含 Token、私钥或带凭据的 URL。

环境模板可以声明 HTTP、HTTPS、SOCKS5 代理和直连目标。需要认证时，代理 URL 使用标准用户信息并在管理页面完整回显；这样管理员编辑的值与 Git、Docker 和语言工具实际使用的值一致，不需要额外的凭据替换状态。Manager 生成大小写两套标准环境变量，使 Git、curl、语言包管理器和 Docker 使用各自惯用的名称；只配置 SOCKS5 时，它作为没有专用地址的 HTTP 与 HTTPS 出站后备。回环地址和 Kubernetes Service 域名始终直连，仓库或 Compose 服务声明的 `NO_PROXY` 与平台规则合并。Dockerfile、Feature 和 Compose 构建使用 Docker 的预定义代理构建参数，主容器和关联服务在运行时继承同一代理。代理输入由 Codespace 快照投影到当前 Pod 和容器环境，不写入 Dev Container 持久状态。

Agent 使用运行时身份 Secret 中的公开根证书建立平台信任包，使 Runtime 内的 Docker 和主 Dev Container 能够验证 Manager 管理的内部 HTTPS 服务。Gitea 站点使用内部或自签名证书时，`GiteaSite` 保存 PEM CA Bundle；代理执行 TLS 检查时，环境模板保存代理 CA。Agent 把站点证书和代理证书追加到平台信任包并按证书内容去重。内部根证书、站点证书和代理证书按固定来源顺序写入，使证书来源和轮换结果可以稳定检查。

Manager 通过内部 Agent 协议下发已验证的站点地址和当前 Bundle。Agent 克隆仓库时只为该地址设置 Git `sslCAInfo`，并把平台信任包只读挂载到主 Dev Container。容器启动和恢复时，Agent 根据 `/etc/os-release` 更新 Debian、Ubuntu、Alpine、RHEL、Fedora、CentOS、Arch 和 SUSE 系列的系统信任库；缺少标准证书工具时使用对应包管理器安装 `ca-certificates`。`CODESPACE_CA_BUNDLE` 与 `NODE_EXTRA_CA_CERTS` 始终指向平台信任包，`GITEA_CA_BUNDLE` 只在站点配置自定义 CA 时设置。这样内部 Cache、Git、curl、Node.js 和 Web IDE 使用同一份当前信任材料，同时站点证书不会获得组件身份认证能力。

Kata 使用原始块卷。Agent 挂载前通过 mTLS 请求 Manager 确认当前 CR、Pod、PVC 和操作许可；首次格式化许可先以 `started` 写入 CR Status，再返回 Agent。文件系统检查和挂载成功后记录 `ready`。已有 ext4 卷经过检查后直接挂载；格式化已开始但无法识别文件系统时，保留卷并报告恢复错误。文件系统探测失败本身不能证明卷为空，这个持久化确认使进程崩溃或响应丢失也不会导致旧卷被重新格式化。

生命周期输出直接流式写入操作日志；需要返回正文的元数据查询分别限制标准输出、错误输出为 1 MiB，超限明确失败。取消生命周期执行时，Agent 关闭 Docker 连接并停止专属 Docker 进程，再退出当前 Pod 的执行循环；后续操作由 Manager 在确认旧 Pod 停止后推进。这样关闭客户端连接不会被误认为容器内命令已经停止。

### 实现验收点

- Runtime 不挂载节点容器运行时套接字，也不持有 Kubernetes API 凭据。
- Kata 与 Sysbox 分别在对应 RuntimeClass 上通过真实启动验证。
- Web IDE 使用平台维护的 code-server Feature；空 options 使用上游默认值，管理员填写的标准 Feature 选项会进入镜像构建。
- 平台始终覆盖 Web IDE 的内部监听、认证、工作区、TLS、遥测和更新检查选项；仓库 `customizations.vscode` 的设置和扩展在首次创建时应用。
- Web IDE 监督进程保持单实例，code-server 退出后按有上限的间隔重启，容器停止时不留下子进程。
- 仓库 IDE 设置只在首次创建时初始化；恢复和进程重启保留用户修改。
- 只有启用 Web IDE 的模板发布内置 Workspace endpoint；短暂重启期间连接等待有明确上限。
- 附加 Features 使用标准 Dev Container `features` 输入形式，并按依赖、安装提示和稳定排序得到确定的安装顺序。
- 模板生命周期脚本的 `build` 在最终镜像层以 root 身份执行；脚本或基础镜像变化会使对应构建缓存失效。
- 首次创建和每次恢复都在标准容器生命周期前执行一次 `start`；正常停止在容器停止前执行一次 `stop`。
- `build` 或 `start` 失败时环境不会发布 ready；`stop` 失败保留失败结果，同时实际资源仍收敛到 stopped。
- 所有 Dev Container 来源使用同一解析和执行路径。
- Feature 字符串简写、字符串布尔选项、依赖去重和锁文件大小写均与规范一致；硬依赖或安装提示形成循环时创建明确失败。
- 仓库与平台共同声明一个 Feature 时，仓库锁文件保留合并后依赖；仅由平台注入的 Feature 不产生仓库锁记录。
- 镜像、Feature 与仓库生命周期命令按来源顺序执行，同一对象中的命令可以并行执行。
- 恢复状态只保存分组生命周期命令，宿主 `initializeCommand` 保持可用，扁平容器命令不会成为第二个执行来源。
- `${devcontainerId}` 在同一 Codespace 重建后保持不变，并且只包含字母和数字。
- Compose 缺省工作目录为 `/`；跨服务端口指向声明的服务容器，缺少对应运行服务时创建明确失败。
- Compose 服务与容器映射不完整或目标不唯一时，在用户生命周期命令执行前创建失败并清理资源。
- Pod 替换后工作区、内部 Docker 和 IDE 数据保持一致。
- 克隆中断不会留下被当作完成工作区的目标目录，已有工作区只在提交匹配时复用。
- Agent 初始克隆和 Dev Container 内的 Git 分别使用自身可见的只读凭据路径；HTTP helper 从 Token 文件返回凭据，SSH 命令固定使用对应私钥和 `known_hosts`。
- 站点运行网络放行实际的 Gitea 克隆地址后 HTTP 或 SSH 克隆可以完成；拒绝时日志能够指出协议和目标主机而不泄露凭据。
- 代理配置同时作用于 Agent 下载、内层 Docker 拉取、Dockerfile 与 Feature 构建、Compose 服务和主 Dev Container；恢复后从实例 Secret 重新取得相同配置。
- 用户配置的直连目标与回环、Kubernetes Service 及仓库配置合并去重，主容器和关联 Compose 服务得到一致结果。
- 字面 IP 代理只有在站点出站规则包含对应 CIDR 和端口时才能保存；域名代理由管理员根据实际解析范围配置站点出站规则。
- 完整代理 URL 保存在模板和 Codespace 运行配置快照中，但不进入 Dev Container 状态、缓存键或普通日志。
- Runtime 内的 Docker 和主 Dev Container 始终信任当前 Manager 内部根证书。
- 配置代理 CA 后，Agent 下载、Docker/BuildKit 和 Dev Container 系统信任同时包含该证书及原有系统与平台根证书。
- 自定义 CA 只作用于对应站点地址；Pod 重建或 Resume 后平台信任包使用当前证书，旧证书文件被清理。
- 站点 CA 只进入平台信任包，不进入 Manager 的组件身份验证根集合。
- 创建、恢复和连接分别执行各自阶段的生命周期命令；Manager 重连不会重复运行同一操作已经开始的命令。
- 无效的访问类型、命令、终端或目标在执行 `postAttachCommand` 前失败；有效连接只执行一次对应的连接阶段命令。
- Web IDE 关闭时创建和恢复不执行 `postAttachCommand`；启用时平台连接的 Web IDE 启动或 `postAttachCommand` 失败只写入日志，不改变 Codespace 状态；终端、命令和 SFTP 仍按实际连接执行。
- 宿主变量替换与 `initializeCommand` 使用同一组非敏感环境值，Agent 的其他进程环境不会进入仓库命令。
- ready 只在 Dev Container 与基础访问能力可用后发布；Web IDE 进程健康不参与 ready 判断。
- ready 访问目标保存解析后的绝对 `workspaceFolder`；Endpoint 动态更新保留该路径，Manager 接管后继续发布相同值。
- Web IDE 关闭时 Codespace 仍保持 running，并可通过 SSH、VS Code 或 Zed 打开已上报的工作目录。
- Agent 只能通过内部 RPC 接收操作和发布运行事实。
- 块卷格式化前已有持久化许可；恢复挂载已有 ext4，未知文件系统保留数据并提供恢复诊断。
- 大量生命周期日志不积累在内存中；元数据输出超限和执行取消都有确定结果。
- 生命周期取消完成后，旧 Docker 执行环境已停止；普通用户访问断连只关闭对应连接。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket、SSH 和 SFTP 入口。它从 Manager 获取当前路由，每次建立数据流前复核 Gitea 权限并取得短期 Agent 票据，再通过 mTLS 直连 Agent。Manager 不转发用户数据。

浏览器打开入口后取得由 Gateway 组件会话密钥认证加密的 Cookie。所有副本挂载同一组件密钥，因此任意副本都能校验会话的站点、用户、Codespace、端点和有效期，并在本进程建立连接计数。成功请求只续期空闲期限，绝对有效期保持不变；并发与连接上限继续按副本计算，用于保护单个进程资源，而不作为站点配额。

每个副本使用独立实例标识向 Manager 上报活动。Manager 的控制响应同时授予 30 秒运行许可：控制流中断后副本立即退出就绪状态并尝试重连，建立新控制流本身不会延长许可，只有收到 Manager 的有效响应才取得新期限；许可到期仍未恢复时关闭监听器和现有连接。Manager 在许可有效期内把该副本的活动视为未知并暂停自动停止判断，许可到期后才移除报告。该顺序保证 Manager 不会把仍在服务但暂时失联的副本误判为空闲，也不会因只建立了半开连接而无限延长服务时间。

路由快照只包含当前 Gateway UID 关联的已就绪站点，以及这些站点命名空间中绑定有效、Pod 和访问目标可用的实例。Manager 使用组件 UID、站点 Gateway UID 和实例 Site UID 的缓存索引定位候选，避免每个 Gateway 周期扫描整个集群。实例处于停止、恢复或尚未获得地址等状态时，只从快照中排除该实例；身份冲突同时记录诊断，实际读取故障仍返回错误。签发票据前实时核对站点、实例、Pod UID 和目标版本，因此缓存中的旧路由不能授权新的连接。

Gateway SSH 主机密钥由 Manager 生成，私钥保存在 Kubernetes Secret 中。轮换时 Manager 更新当前组件拥有的 Secret，凭据资源版本随 Pod 模板变化并触发 Gateway 滚动更新，再发布新的公钥指纹。使用固定 Secret 名称可以让 Deployment 始终引用当前组件的密钥，组件 UID 与所有者关系则防止同名重建后继承旧密钥。Agent 提供 Shell、命令、SFTP、HTTP Endpoint 和回环端口转发；Dev Container 通过本地 Unix socket 管理 Endpoint。

SSH Shell 请求启动远程用户在容器账户数据库中配置的登录 Shell。PTY 由客户端单独申请：普通终端带 PTY，`ssh -T` 和 VS Code Remote-SSH 的初始化阶段则可以不带 PTY，并把脚本从标准输入发送给登录 Shell。SSH 命令请求继续使用同一个登录 Shell 的 `-c` 语义执行明确命令。保留两种请求的区别，可以让非交互初始化、交互终端和直接命令都使用相同用户环境，同时避免把空命令解释为另一种操作。

SSH 命令正常退出时先有界排空输出再发送退出状态；断连时同时关闭 RPC 与本地管道，释放被慢客户端阻塞的读取和写入。完成通知可以重复观察，重复关闭保持幂等。TCP 的输入半关闭仍允许读取剩余响应，避免截断请求完成后的数据。

每个 Gateway 组件都有同名 ClusterIP Service：`80/http` 转发到 Gateway 的 HTTP 进程，`22/ssh` 转发到 SSH 进程。这个 Service 是应用访问与 Kubernetes 网络的稳定边界，多个 Gitea 站点可以共享一个 Gateway，而站点身份、授权和连接限制仍在 Gateway 内分别处理。

HTTP 可以由集群运维自行转发同名 Service，也可以由 Manager 为通配端点域名创建 Ingress。HTTPS 使用现有 TLS Secret，或通过 cert-manager Issuer 维护 Manager 自动命名的 Secret；Gateway Pod 只接收 Service 内的 HTTP，不持有外部 HTTPS 私钥。SSH 可以由集群运维转发，也可以通过独立的 `<component>-ssh` LoadBalancer Service 发布端口 22。SSH 主机密钥继续由 Manager 管理，与 HTTPS 证书分别轮换。

Gateway 默认只把 TCP 对端作为客户端地址。只有直接对端属于管理员配置的可信代理 CIDR 时，Gateway 才按从右到左的顺序校验 `X-Forwarded-For`，并选择第一个不可信地址作为客户端。这样 Ingress 后的连接可以保留真实来源，同时外部请求不能用伪造请求头改变日志、限流和授权上下文中的客户端地址。

### 实现验收点

- 每个数据流都需要当前有效的用户授权和 Agent 票据。
- SSH 主机私钥只存在于对应 Secret。
- 单个实例不可用不影响其他实例的路由，Pod 被替换或目标失效后不能获得访问票据。
- Gateway 快照只读取绑定到自身的站点和实例，站点数量增长不会扩大为全量 Runtime 扫描。
- SSH 正常退出保留输出和退出码；断连释放阻塞任务，TCP 半关闭后仍可接收响应。
- SSH Shell 在有无 PTY 时都使用远程用户的登录 Shell；无 PTY Shell 能从标准输入执行脚本，命令请求只执行明确的非空命令。
- 每张票据只绑定一种访问能力。
- 本地端口转发只访问当前 Dev Container 的回环地址。
- Pod 或目标版本变化后，旧路由和票据失效。
- 同名 Service 始终只提供 `80/http` 与 `22/ssh`，切换发布方式不会重建 Gateway Deployment。
- 一个副本签发的浏览器会话可以由同组件的其他副本验证，篡改、过期或资源身份不匹配的会话会被拒绝。
- Gateway 控制流失联期间自动停止等待运行许可收敛；许可到期后该副本不再保留监听器或用户连接。
- Ingress 只使用选定的 IngressClass 和通配端点域名；HTTPS 只引用选定的 TLS Secret 或 Issuer。
- SSH LoadBalancer 只发布端口 22 并保留客户端来源地址；改为外部管理后控制器清理自己拥有的发布资源，同名 Service 保持可用。
- 不可信直接对端的 `X-Forwarded-For` 不会改变客户端地址，可信代理链中的无效地址使整条请求头失效。

## Cache

Cache 是独立组件，支持本地文件系统或 S3。它为允许的上游镜像提供代理，并按 GiteaSite UID、仓库 ID 和用户 ID 生成签名缓存目录。每个已配置的上游至少包含一个仓库允许规则，使配置项始终对应明确的回源范围，避免保留永远无法命中的镜像站。站点 UID 区分不同站点以及同名重建的站点，避免 Gitea 各自分配的数字 ID 重合造成跨站点共享。Runtime 的 Docker 数据保存在 PVC，Cache 只减少重复下载与构建。

每个 Cache 组件都有同名 ClusterIP Service。Service 固定提供 `443/https`，转发到 Cache 容器的 `8443` 端口，集群内地址为 `https://<component>.<management-namespace>.svc`。地址由 Service 身份推导，因此管理页面只展示实际服务地址。Manager 内部 CA 为该 DNS 名称签发独立的服务端证书，并保存到 `<component>-registry-tls` Secret。Cache 启动时加载并校验证书，此后新 TLS 握手从内存快照取证书，每分钟最多检查一次 Secret 投影文件；续期成功后整组快照同时替换，因此短期证书续期无需重建 Pod，也不会让高频连接反复访问文件系统。

Cache 使用 `<component>-identity` 中的组件证书与 Manager 建立双向 TLS 控制连接。Registry 服务证书只包含 Service DNS 名称和服务端用途，不能代表 Cache 调用 Manager。Runtime Agent 在启动内部 Docker 前把内部根证书写入该缓存主机对应的 Docker `certs.d` 目录，BuildKit 使用相同的 HTTPS 地址和标准信任链，因此不需要不安全仓库配置。

Cache 可以单独声明回源代理，因为共享 Cache 所在管理命名空间与站点 Runtime 可能具有不同出口。代理环境同时作用于 OCI 回源、S3 和 Manager 客户端；Kubernetes Service 域名自动直连，因此控制连接和集群内 Registry 请求不会绕到外部代理。代理 CA 在系统根证书池上追加，并在 Cache 启动时完成校验。代理 URL、直连目标或 CA 变化会改变组件 Secret 的资源版本，Cache 使用 Recreate 策略重启后取得一组一致的新配置。

Cache 从 Manager 获取配置、短期 Registry 凭据和维护许可。Registry 使用 HTTPS Basic 认证承载 Manager 签发的短期令牌：固定用户名只标识认证方式，密码字段中的签名令牌携带 Cache、站点命名空间、操作权限和有效期。这样 Docker、Compose 和 BuildKit 都能使用标准 Registry 认证流程，同时由 Cache 对每个请求执行完整授权。

Runtime Agent 在创建 Dev Container 前把 Registry 凭据写入 `/run/codespace/docker-config/config.json`。该目录位于内存型 EmptyDir，并通过 `DOCKER_CONFIG` 同时提供给 Agent 中的 Docker CLI 和 Compose 启动的外部 Buildx 进程。构建结束后 Agent 立即删除认证文件，因此凭据不会进入工作区、Runtime 数据卷或恢复状态。使用标准文件而不是进程内配置，是因为 Bake 模式下的 Buildx 是独立进程，无法读取父进程内存中的 Docker 配置。

每个 Registry 请求都验证凭据、Cache 身份、站点命名空间、操作权限和有效期；镜像代理只允许拉取，构建缓存允许拉取和推送。缓存路径用于隔离对象，签名凭据用于授权访问，两者共同防止共享 Cache 中的跨站点读取。缓存丢失时允许在原授权范围内回源；维护许可保证同一存储同一时刻只有一个垃圾回收执行者。

申请清理许可和提交清理完成均等待 Manager 按请求序号确认。等待受超时和调用取消控制，结束后释放请求记录；迟到的响应只对应原请求，连接故障同时结束尚未确认的维护请求。这样“已发送”与“已完成”有明确区别，重连也不会继续持有旧请求的等待资源。

Cache 执行许可在 Manager 首次获取 Kubernetes Lease 后生效，后续只由成功续约的对应请求确认延长。Cache 用请求发送时间加许可时长计算到期，并保留一秒余量；后续独立配置推送和重复确认只更新配置或被忽略，不会增加执行时间。独立到期计时器同时取消请求、上传和垃圾回收，即使控制流发送阻塞，旧进程也会停止使用共享存储。

控制流结束后，Manager 保留已有 Lease 直到自然到期。断连无法证明远端进程已经停止，等待现有的 15 秒租期可以让旧进程先按本地许可退出，再允许新进程接管存储。停用后的 Cache 停止获取和续期租约；客户端遇到到期许可时重建连接，以便重新启用后正常恢复。管理面删除 Cache 组件时也检查这段租期：先停用 Cache 并等待租期结束，再删除组件，避免级联回收 Lease 使旧写入者提前失去保护。

Cache Deployment 使用 Recreate 更新策略。新 Pod 只有在旧 Pod 停止并且租约到期后才能取得执行许可，Service 也只会选择通过 Registry 就绪检查的实例。这与 Cache 的单写租约共同覆盖滚动更新、节点故障和控制流中断，无需为可重新生成的数据引入多副本一致性协议。

### 实现验收点

- 私有镜像和构建缓存按站点、仓库与用户范围隔离读取。
- Cache Service 使用 `443/https`，容器使用 `8443`，管理页面根据实际 Service 展示内部地址。
- Cache Registry 证书只绑定当前 Service DNS 名称；文件证书源一分钟内复用有效快照，续期后的新连接在下一次检查后使用新证书。
- Cache 控制连接身份与 Registry 服务证书使用独立 Secret 和证书用途。
- Runtime Docker 与 BuildKit 通过内部 CA 验证 Cache，配置中不存在不安全仓库选项。
- Cache 的 OCI 与 S3 回源遵循组件代理，Manager 和集群内部地址保持直连；代理 CA 在保留系统根证书的基础上生效。
- Cache 代理 URL、直连目标或 CA 变化后由 Recreate 更新到单一配置版本，不会同时运行使用不同网络配置的两个写入进程。
- Docker CLI 与外部 Buildx 从同一份内存卷配置读取短期 Registry 凭据，构建成功或失败后认证文件均被删除。
- Registry 通过标准 HTTPS Basic challenge 接收 Manager 签发的短期令牌，不需要额外的令牌交换接口。
- 未携带有效短期凭据的 Registry 请求被拒绝；镜像代理只接受拉取，构建缓存按授权接受拉取和推送。
- 每个上游镜像至少保存一个有效仓库允许规则，空规则在资源保存前返回配置错误。
- Registry 与仓库组合不会产生缓存键冲突。
- 清理完成在 Manager 确认后才返回成功；取消、超时和控制流关闭均结束等待，并可在后续有效连接上继续维护。
- Cache 清空后可以回源，已有 Codespace 仍可从 PVC 恢复。
- 同一存储同一时刻只有一个垃圾回收执行者。
- 数字仓库和用户 ID 相同的不同站点仍使用不同缓存目录和授权。
- 控制流单向中断、发送阻塞、迟到响应和重复响应均不能使 Cache 超过已确认的许可期限运行。
- 停用后的 Cache 不再续约，组件在写入租期结束后才可删除。
- Cache Deployment 固定一个副本并使用 Recreate；更新期间不会出现两个同时写入缓存的进程。

## 高可用与恢复

Manager 多副本通过 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持可接替状态。新 Leader 先核对 Gitea 当前操作与 CR、PVC、Pod 和 Agent，再领取新任务。

恢复不依赖节点本地文件。正常停止时，Runtime Pod 的 writer finalizer 会一直保留到 kubelet 报告容器已经终止；Manager 先把对应 Pod UID 记录为已停止，再释放 finalizer。这样控制器主动发起的停止具有明确的先后顺序。Pod 对象已经不存在时，Manager 立即撤销旧执行权和路由，把未完成的 create 或 resume 记为失败，并将环境自动收敛到 stopped。缺失 Pod 被视为集群管理员或节点控制面已经完成的删除事实，这一选择避免环境永久等待人工确认；集群存储仍需为 Runtime 卷提供与声明访问模式一致的挂载隔离。

Manager 管理页面提供单个 Runtime 的维护停止操作。请求绑定当前 Runtime UID 和 Pod UID：稳定运行的环境记录本地停止意图，正在 create 或 resume 的环境先记录该操作失败，再复用相同的 Pod 停止流程。停止完成后，现有资源清单会把 stopped 状态同步给 Gitea，因此维护操作不需要增加第二套公共生命周期协议。

Gitea 删除 Manager 身份与运行平台清理分别由各自管理员操作。Manager 管理面在站点停用后允许显式删除运行环境数据，请求携带当前 CR UID、资源版本和 Pod UID。控制器复用普通 delete 的终止顺序和资源删除流程，避免失效凭据触发不可撤销的数据删除。

### 实现验收点

- 同一时刻只有 Leader 推进生命周期操作。
- 新 Leader 完成资源核对前不领取新 create。
- 部分清单、未知归属或失联节点不会触发误删或双写。
- 正常停止先持久化已停止的 Pod UID，再释放 writer finalizer；finalizer 意外缺失时会在发起删除前补回。
- Pod 对象缺失时自动撤销旧访问并收敛到 stopped，未完成的 create 或 resume 会得到明确失败结果。
- 管理页面的维护停止只对当前 CR 和 Pod 身份生效，重复请求保持幂等，并通过现有资源清单同步到 Gitea。
- 站点停用后的数据删除仍先确认旧写入者停止，再回收 PVC；同名替换或过期页面不能删除新资源。
