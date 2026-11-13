# 部署要求

本文面向集群管理员，说明上线所需的平台能力和验收场景。安装命令与 values 由 [Helm chart README](https://github.com/ExplodingDragon/gitea-codespace/blob/main/charts/gitea-codespace/README.md) 维护。

## Kubernetes 基础能力

Manager 连接一个逻辑 Kubernetes 集群。集群需要提供 CRD、Lease、PVC、NetworkPolicy、RuntimeClass 和 Service；由 Manager 发布 HTTP Endpoint 时还需要 Ingress 控制器。Helm chart 安装 CRD、RBAC、Manager、内部服务、管理服务和网络策略。Gateway 与 Cache 在管理页面创建后由 Manager 部署，因此 Helm 只负责控制面，不需要预先知道组件数量和域名。

管理页面从 Kubernetes API 读取 RuntimeClass、StorageClass、IngressClass、TLS Secret 与 cert-manager Issuer 并提供选择，保存时 Manager 再次确认引用仍然存在且类型匹配。资源数量使用数值与单位分离的输入方式，最终保存为 Kubernetes 原生 quantity 或运行时 duration。这样管理员能够直接使用集群已经声明的能力，同时保留 Kubernetes 调度、证书和容量语义。

管理服务默认为 `ClusterIP`，首次配置通过 `kubectl port-forward` 完成。管理页面使用浏览器当前地址，不要求配置固定的公开 URL；启用 Helm Ingress 时 host 与 TLS Secret 可按入口控制器能力分别配置。Manager 多副本使用 Lease 选举；健康副本保持 Ready，内部 RPC 与管理服务只选择当前 Leader。Ready 表示副本可以参与接替，Leader 标签表示副本可以处理有状态请求，这两个信号分别服务可用性和单写者约束。

### 实现验收点

- 启动检查能指出缺失的 API、CRD 或 RBAC 权限。
- 默认安装只提供集群内管理入口，端口转发可以完成首次配置。
- 内部 RPC 与管理服务只把流量发送给当前 Leader。
- Leader 和 Cache 维护 Lease 位于管理命名空间。
- Helm 安装后存在 `GiteaSite`、`EnvironmentTemplate`、`CodespaceComponent` 和 `Codespace` 四类 CRD。
- 每个 Gateway 组件都有同名 ClusterIP Service，固定使用 `80/http` 与 `22/ssh`；Manager 只在选定发布方式时创建组件对应的 Ingress 和独立 SSH LoadBalancer Service。
- RuntimeClass、StorageClass、IngressClass、TLS Secret 与 Issuer 均可从管理页面选择，资源删除后旧引用不能继续保存。
- CPU、内存、存储、缓存容量和时长按明确单位输入并转换为可解析的原生值。

## 隔离、存储与设备

每个环境模板绑定运行方式、StorageClass、资源限制和 Dev Container 附加配置。Kata 与 Sysbox 进一步选择 RuntimeClass，该资源需要使用 `codespace.gitea.dev/isolation=kata` 或 `codespace.gitea.dev/isolation=sysbox` 标签声明隔离方式，Manager 才会把它作为对应模板选项。Native 使用集群默认 CRI，不保存 RuntimeClass，并从 Node 可分配扩展资源中选择 Device Plugin 设备。这样集群安装结果与模板选择使用同一份可查询事实，保存接口也能在创建工作负载前发现运行时、存储或设备能力不匹配。保存成功后，模板控制器依据这些依赖的实际可用性自动维护就绪状态，使依赖变化能够直接反映到管理页面。

Kata 需要硬件虚拟化或可用的嵌套虚拟化；Sysbox 需要受支持的内核、容器运行时和存储驱动。Kata 的工作区卷以块设备进入来宾，Sysbox 与 Native 的工作区卷以文件系统挂载；Manager 根据运行方式选择对应形式。Native 设备通过 Kubernetes 扩展资源、Device Plugin 和 CDI 分配，Manager 把同一设备数量写入 Pod requests 与 limits，让 kubelet 保持唯一的设备分配权威。

需要远程 USB 的 Kata 节点池使用包含 `DEVTMPFS`、`USB`、`USBIP_CORE`、`USBIP_VHCI_HCD` 和目标设备类驱动的来宾内核，并在 Runtime Agent 启动前使 VHCI 控制器处于活动状态。平台从 `/sys/devices/platform/vhci_hcd.*` 发现能力，因此同一控制面可管理普通及支持 USB/IP 的 Kata 节点池。用户通过 Gateway SSH 注册 `usbip.<来源名>:3240`，SSH 客户端连接实际 USB/IP 服务端；多个来源使用各自的 Agent 回环随机端口。主 Dev Container 按发行版启动 udev/eudev，设备规则和非 root 权限随开发镜像交付。

USB/IP 的隔离边界是 Codespace 对应的 Kata 虚拟机。Agent、主 Dev Container 和嵌套 Docker 共享该工作区的来宾设备视图。来源归属于注册它的 SSH 连接，同名注册报错；关闭一个来源只回收该来源，Runtime 停止时全部回收。普通 SSH 反向转发监听在 Dev Container 的实际网络命名空间，USB/IP 特殊绑定监听在 Agent 回环地址；回环地址限制网络范围，认证来自 SSH、Manager 票据和 Agent mTLS。能访问本地 Agent Unix socket 的进程属于工作区信任范围。SSH 认证不能消除恶意 USB 设备或来宾驱动漏洞的风险，工作站也需保护其 USB/IP 服务。

使用需要特权能力的 Kata 配置时，所选 Kata handler 必须启用 `privileged_without_host_devices=true`，把来宾内能力与宿主机设备注入分开。整棵来宾 devtmpfs 的设备节点会在主容器标准 `/dev` 中可见，但能否打开仍受设备 cgroup 和 Linux capability 控制；显式 Dev Container `privileged`、`devices`、`capAdd` 或等效的标准配置可以扩大来宾内部的设备访问范围。部署验证应同时检查实际 RuntimeClass handler、Kata 配置和 Pod 的设备挂载，而不能只检查 RuntimeClass 名称。

Kata 与 Sysbox 分别按官方文档安装，并先在专用节点池使用平台镜像和目标 StorageClass 完成真实 Pod 验证。Native 节点需要验证默认 CRI 能够运行平台所需的嵌套 Docker，并为模板需要的设备安装 Device Plugin 与 CDI 配置。每个 Codespace 使用独立 PVC，StorageClass 需要适配所选运行方式、节点和扩容策略。

三种运行方式都需要让 Agent 读取内部 Docker 容器的进程信息并进入其网络命名空间，以创建正向连接和普通反向监听。部署验证使用平台既有运行权限完成这一操作，同时检查 IPv4、IPv6 及辅助服务容器，才能确认实际运行时提供了完整的容器网络访问能力。socket 使用 Agent 的凭据与 cgroup，整体统计仍归属 Runtime Pod；容器账户权限由 Shell/SFTP 的 Docker exec 保持。

### 实现验收点

- 模板引用的 RuntimeClass、StorageClass 与扩展资源可用时自动就绪，任一适用依赖失效时状态会指出具体资源。
- 每个可选 RuntimeClass 都带有与实际运行方式一致的 `codespace.gitea.dev/isolation` 标签。
- 管理页面中 RuntimeClass 与隔离方式联动，StorageClass 来源于当前集群；不存在的资源无法保存。
- Kata 与 Sysbox 创建的 PVC 分别采用块模式与文件系统模式。
- Native 使用默认 CRI 和文件系统 PVC，申请的扩展资源与 CDI 设备能够进入 Runtime Pod 和主 Dev Container。
- 支持 USB/IP 的 Kata 来宾在 Agent 启动前具有活动 VHCI；普通 Kata 来宾仍能运行，只是不提供远程 USB 能力。
- 完整 USB/IP 验证经过 Manager、Gateway SSH、Agent、Runtime 回环监听和主容器标准 `/dev`，覆盖两个来源的重复 bus ID、独立取消、非 root 设备 I/O、断线重连及停止恢复；普通反向转发在 Native、Sysbox、Kata 中验证容器内动态端口。
- 完整验证确认 Kubernetes 节点设备不会隐式进入 Runtime，关闭一个 USB/IP 来源只释放该来源的桥接连接；停止 Runtime 释放全部监听和连接，旧 Runtime 的票据不能访问新 Runtime。
- 使用特权 Kata 配置时，实际 handler 与 `privileged_without_host_devices=true` 均已核对，工作区设备可见性没有越过 Kata 虚拟机边界。
- Runtime 内 Docker 可用，并且无法访问节点容器运行时或 Kubernetes API 身份。
- Native、Sysbox、Kata 的实际 Pod 都能在授权容器内建立正反向 TCP socket；Agent 同端口服务不会被误访问，容器重建后查询新的网络命名空间。
- Runtime Pod 按模板声明 CPU、内存请求及可选上限，设备数量由 Device Plugin 分配；PVC 按模板申请容量，实际可用空间和容量约束由存储实现提供。
- Pod 替换后 PVC 数据可以由新的 Runtime 恢复。

## 镜像、缓存与网络

Manager、Gateway、Cache 和 Runtime 使用同一个核心平台镜像引用，但作为独立工作负载运行。Web IDE 使用独立发布的多架构提供方镜像，由 Runtime Pod 的 init 容器按环境模板选择；平台与提供方的发布关系见[镜像构建与发布](implementation.md#镜像构建与发布)。管理员保存环境模板时，Manager 只读取提供方镜像的 OCI 配置元数据并把引用固定到 sha256 摘要；Pod 启动时 Kubernetes 再拉取实际镜像层。私有仓库凭据通过 Helm 引用现有 Docker Registry Secret，Manager 使用它解析元数据，并把同一凭据同步到站点命名空间供 Runtime Pod 拉取。

生产环境的 Gateway 建议至少运行两个副本。控制器使用软反亲和性优先分散到不同节点，因此单节点测试集群仍可运行，多节点集群则能降低节点故障影响；PDB 保护计划内驱逐，实际容量仍需要集群为至少一个替代 Pod 保留资源。Cache 固定为一个 Recreate 副本，其 PVC 使用 ReadWriteOnce，升级窗口允许短暂缓存不可用；Runtime 可以在授权范围内回源，因此这不会改变 Codespace 的持久数据。

标签模式在创建 Pod 时检查最新镜像。更新部署版本后，Manager 和 Gateway 滚动更新，Cache 按 Recreate 策略先停后启；用户 Runtime 保持运行，直到普通生命周期操作需要创建新的 Pod。摘要模式始终引用同一内容，适合生产和故障复现。这样既能让开发集群及时取得更新，也不会为了刷新标签而中断用户会话。

Dev Container 镜像由 Runtime 内的 Docker 拉取或构建。Cache 可以使用 PVC 或 S3，内容属于可重新生成的性能数据。文件系统 Cache 的 PVC 与组件同名并由组件拥有；改用 S3 后控制器回收这块缓存卷。每个 Cache 使用同名 ClusterIP Service 的 `443/https` 端口，Manager 根据 Service 名称签发内部服务证书，Runtime Docker 通过安装级内部根证书验证连接。Cache 只在集群网络中提供，多个站点通过短期凭据和独立命名空间共享它。

每个站点使用独立命名空间和 NetworkPolicy；用户流量统一进入 Gateway，再由 Gateway 连接 Agent。外部 DNS 与 TLS 由 Ingress、cert-manager 或集群运维维护，SSH 可以通过 Manager 创建的独立 LoadBalancer Service 发布。外部入口证书与 Cache 内部 HTTPS 证书服务于不同网络边界，分别由入口设施和 Manager 内部 CA 维护。

站点配置中的运行出站网络使用 CIDR 和 TCP 端口放行 Runtime 必需的目标。这里需要包含 Gitea 实际返回的 HTTP 与 SSH 克隆地址，以及 Dev Container 生命周期命令依赖的服务；Manager 控制面能够访问 Gitea 并不代表站点命名空间中的 Runtime 也能访问。使用显式地址段的原因是标准 NetworkPolicy 没有可移植的域名规则，管理员可以先在 Runtime Pod 中解析和验证目标地址，再把稳定的网络范围写入站点配置。

内网部署可以分别为环境模板和 Cache 组件设置 HTTP、HTTPS 或 SOCKS5 出站代理。环境模板适用于该模板创建的 Runtime、Docker 构建和 Dev Container；Cache 代理只用于镜像与对象存储回源。代理使用字面 IP 时，引用模板的每个站点都需要在运行出站网络中放行该 CIDR 和端口，管理 API 会在保存时核对；代理使用域名时，管理员需要按集群 DNS 的实际解析范围放行对应地址段。代理执行 TLS 检查时填写其 CA 证书，Manager 通过固定的只读文件挂载向工作负载提供该证书，避免额外的文件路径环境配置。

Gitea 使用公共 CA 时站点配置留空 CA Bundle。使用内部 CA 时，管理员把 PEM 证书链保存到对应站点；Manager 在系统信任库上追加它，并在保存前验证实际 Manager RPC。Agent 在每次 Runtime 操作开始时把系统 CA、Manager 内部根证书、站点 CA 和代理 CA 合并为唯一完整信任包，供 Docker 拉取镜像、Git、OCI Feature 包下载和主 Dev Container 运行时使用。Dockerfile 的 `RUN` 和 Feature 安装脚本在构建镜像内执行，使用该镜像自身的证书配置，具体见[出站网络与证书](runtime-platform.md#出站网络与证书)。双向 TLS 的组件身份证书、私钥和根集合仍从独立身份 Secret 加载，出站信任包只包含公开证书；浏览器入口证书继续由外部入口维护。

### 实现验收点

- Manager 与其创建的工作负载使用同一平台镜像引用。
- Helm Chart 版本、Chart 摘要和核心平台镜像摘要可以在对应 GitHub Actions 运行摘要中找到；Web IDE 提供方按自身发布记录审计版本和摘要。
- Runtime 节点可以拉取模板选择的提供方镜像；私有仓库凭据同时适用于核心 Runtime 和 Web IDE init 容器。
- Manager 能使用同一私有仓库凭据解析 Web IDE 镜像元数据，模板保存后只保留 sha256 引用。
- 标签模式的新建工作负载获取当前镜像，摘要模式的工作负载保持内容固定。
- 私有仓库凭据只投递给需要它的工作负载。
- Runtime 无法访问其他站点的 Runtime 网络。
- 站点运行出站网络覆盖实际的 Gitea HTTP 或 SSH 克隆目标；未覆盖时克隆错误能够指出协议与目标主机。
- 环境模板代理覆盖 Runtime、内层 Docker、构建和 Dev Container，Cache 代理覆盖 OCI 与 S3 回源；两者的集群内部地址保持直连。
- 字面 IP 代理的 CIDR 和端口已加入所有引用站点的出站规则；域名代理的实际解析范围已由部署验收确认。
- 使用代理 CA 时，唯一完整信任包同时包含系统公共 CA、Manager 内部 CA、站点 CA 和代理 CA，并在 Docker 第一次拉取前生成。
- HTTP、WebSocket、SSH 和 SFTP 用户流量均经过 Gateway。
- Cache 清空后可以在原授权范围内回源。
- 文件系统与 S3 缓存使用同一授权流程，切换后只保留当前后端所需的工作负载资源。
- Cache Service 固定提供集群内 `443/https`，Runtime Docker 和 BuildKit 使用内部根证书完成验证。
- Cache 的每个 Registry 请求都携带 Manager 签发的短期凭据，共享 Cache 仍按站点、仓库和用户隔离。
- 多副本 Gateway 优先分散到不同节点，并在计划内驱逐时由 PDB 保留可用入口。
- Cache 以单副本 Recreate 方式更新；缓存暂时不可用时 Runtime 可以按原授权回源。
- 公共 CA 和自定义 CA 的 Gitea 都能完成注册、仓库克隆、镜像拉取、Feature 下载与容器内访问；更新 Bundle 后恢复环境使用新证书。

## 身份、容量与恢复

Manager 维护安装级内部 CA，并为 Manager、Agent、Gateway 和 Cache 签发短期组件身份证书。根 CA 代表当前管理命名空间的稳定信任边界，签发 CA 定期轮换，工作负载证书绑定站点、Codespace、Pod 或组件的 Kubernetes UID。内部控制连接同时验证统一信任链、证书用途和 URI 身份，使同名重建的资源不能沿用旧证书。

同一内部 CA 也为 Cache Service 签发独立的 HTTPS 证书。服务证书只包含当前 Service DNS 名称与服务端用途，组件身份证书只包含应用 URI 与所需客户端或服务端用途。两类证书分别保存在 `<cache>-registry-tls` 和 `<cache>-identity` Secret 中，因此提供 Registry HTTPS 的私钥不能用于调用 Manager API。内部根证书作为公开信任材料进入 Runtime 和 Dev Container；签发私钥始终留在 Manager 管理的 CA Secret 中。

根 CA 有效期为 10 年，用于保持安装恢复所需的信任边界；签发 CA 有效期为 1 年并提前 30 天轮换，用于减少长期在线私钥的暴露范围；工作负载证书有效期为 24 小时并提前 8 小时轮换，使短期控制面故障仍有恢复窗口。轮换只更新 Secret 或 Manager 内存中的证书，Pod 模板不包含证书内容摘要，因此普通轮换不会重建正在运行的工作负载。

Agent、Gateway 和 Cache 对 Secret 投影的证书使用一分钟内存缓存。构造 TLS 客户端或服务端时先完成首次校验，后续新握手每分钟最多重新读取一次证书文件；刷新失败时，仍在有效期内的上一份完整快照继续服务，过期证书不会继续用于新握手。最终轮换可见时间由 Kubernetes Secret 投影延迟和最多一分钟的进程内检查延迟组成。Manager 的服务器证书直接保存在内存中，轮换后立即供新连接使用。

内部 CA 保存在管理命名空间的 Kubernetes Secret 中。Manager 首次启动时通过 Kubernetes API 原子创建，多个副本读取同一份结果；随后 Manager 使用内存服务器证书启动内部双向 TLS 接口。CA Secret 缺失但已经存在受管资源时，Manager 要求从备份恢复，而不是生成新的信任根。生产集群需要为 Secret 启用静态数据加密，并把内部 CA、管理员令牌、各 Gitea 站点的 Manager 运行密钥、Gateway SSH 主机密钥、对象存储凭据和镜像凭据纳入备份与轮换。Gitea 范围注册令牌保存在 Gitea 数据库，不属于 Kubernetes 备份。

证书 URI 使用同一信任域并直接表达资源身份：Manager 使用 `spiffe://codespace/manager/<management-namespace-uid>`，Agent 使用 `spiffe://codespace/agent/<site-uid>/<codespace-uid>/<pod-uid>`，Gateway 和 Cache 分别使用 `spiffe://codespace/gateway/<component-uid>` 与 `spiffe://codespace/cache/<component-uid>`。管理命名空间、站点、Codespace、Pod 或组件同名重建后会获得新的 Kubernetes UID，因此旧证书不能代表新资源。URI 的构造和解析由同一个身份模块完成，使签发方、Manager、Agent 和 Gateway 使用完全相同的路径结构。

浏览器入口支持 HTTP 和 HTTPS，生产环境应通过集群入口提供 HTTPS。Ingress 引用的 TLS Secret 可以由 cert-manager、云平台证书控制器或集群管理员维护；它不参与内部组件身份。SSH 使用独立的 Gateway 主机密钥。

环境模板定义单个 Runtime 的 CPU 和内存请求，并可以按集群策略增加资源上限。较小但真实的请求值让调度器保留基本容量，同时允许未设置上限的开发环境使用节点空闲资源。Gitea 站点可以启用总配额；关闭时不创建站点 `ResourceQuota`，容量接纳交给 Kubernetes 调度器和集群已有策略。Manager 在启用配额时统计实际资源和正在创建的任务。备份覆盖 Gitea 数据库和日志、Kubernetes 管理资源、Codespace PVC 以及恢复所需的 Secret。

升级先更新 CRD，再更新平台组件。摘要模式的新环境使用新摘要，已有环境继续使用创建时保存的摘要，因此镜像仓库需要保留仍被引用的版本。标签模式更新控制面和平台组件；已有 Runtime 保持运行，在后续重建时获取标签当前指向的镜像。

### 实现验收点

- 平台身份密钥、对象存储凭据、镜像凭据和其他长期平台凭据只保存在对应 Kubernetes Secret 或 Gitea 加密字段中，CR、标签和普通日志只保存非敏感引用。代理认证信息按标准 URL 用户信息保存在模板和运行快照中，属于管理员可见的运行配置；普通日志仍不得输出其中的用户名或密码。
- Manager 首次启动后生成唯一的安装级内部 CA，多副本不会产生不同信任根。
- 平台证书包含证书、私钥和 CA 信任链，并绑定当前 Kubernetes UID 和正确的客户端或服务器用途。
- Cache 服务证书只包含当前 Service DNS 名称，组件身份与 Registry HTTPS 使用独立 Secret。
- Manager、Agent、Gateway 和 Cache 对同一张证书 URI 得到一致的角色与资源 UID，额外或缺失的路径段不能通过身份校验。
- 签发 CA 和工作负载证书轮换时不需要重新安装 Helm Chart，也不需要重启正常运行的工作负载。
- 文件证书源一分钟内不会重复读取 Secret 投影文件；投影内容损坏时保留仍有效的完整快照，证书过期后新握手失败。
- Runtime 和 Dev Container 使用只含公开证书的平台信任包，内部 CA 私钥只存在于管理命名空间的 CA Secret。
- 未安装 cert-manager 的集群可以运行完整内部控制面；启用公开 HTTPS 时只需提供入口引用的 TLS Secret。
- 内部 CA 丢失或损坏时不会被静默替换，恢复原 Secret 后组件能够重新连接。
- 凭据轮换后旧身份和旧会话按有效期失效。
- 启用的站点配额包含运行中和正在创建的 Runtime；关闭配额的站点不依赖 `ResourceQuota` 完成调度。
- 环境模板始终提供 CPU 和内存请求；资源上限关闭时生成的 Runtime Pod 不包含 CPU 和内存 limit。
- 恢复后站点、Runtime UUID、PVC 与 Gitea 记录能够重新关联。

## 上线验收

CI 验证发布产物，目标集群仍需验证自身的运行时、存储和网络配置。测试分层与发布要求见[实施与测试](implementation.md)，专用测试节点的准备、USB/IP 测试内核和执行命令见 [E2E 指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/tests/e2e/README.md)。正式启用前应在目标集群完成：

1. 两个站点分别完成创建和删除，验证资源与网络隔离；
2. 每种启用的 RuntimeClass 完成 create、stop、resume 和 delete；
3. 验证 Web IDE、PTY、SSH、SFTP、HTTP Endpoint 与回环端口转发；
4. 替换 Runtime Pod，验证旧访问失效和 PVC 数据恢复；
5. 切换 Manager Leader，验证操作保持唯一执行；
6. 清空 Cache，验证授权回源；
7. 审计 RBAC、NetworkPolicy、Secret 和测试资源清理结果。

### 实现验收点

- 验收记录包含组件版本、RuntimeClass、StorageClass、镜像摘要和结果。
- 失败能够从页面与日志定位到具体阶段。
- 正常停止先记录已终止 Pod 身份再释放 writer finalizer；Pod 已缺失时环境自动收敛并保留 PVC。
- 验收结束后没有孤立的 CR、PVC、Pod、凭据或路由。
