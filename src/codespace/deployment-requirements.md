# 部署要求

本文面向集群管理员，说明上线所需的平台能力和验收场景。安装命令与 values 由 [Helm chart README](https://github.com/ExplodingDragon/gitea-codespace/blob/main/charts/gitea-codespace/README.md) 维护。

## Kubernetes 基础能力

Manager 连接一个逻辑 Kubernetes 集群。集群需要提供 CRD、Lease、PVC、NetworkPolicy、RuntimeClass 和 Service；使用 Gateway API 暴露 Codespace 时还需要已配置的 Gateway 与监听器。Helm chart 安装 CRD、RBAC、Manager、内部服务、管理服务和网络策略。Gateway 与 Cache 在管理页面创建后由 Manager 部署，因此 Helm 只负责控制面，不需要预先知道组件数量和域名。

管理服务默认为 `ClusterIP`，首次配置通过 `kubectl port-forward` 完成。Manager 多副本使用 Lease 选举；健康副本保持 Ready，内部 RPC 与管理服务只选择当前 Leader。Ready 表示副本可以参与接替，Leader 标签表示副本可以处理有状态请求，这两个信号分别服务可用性和单写者约束。

### 实现验收点

- 启动检查能指出缺失的 API、CRD 或 RBAC 权限。
- 默认安装只提供集群内管理入口，端口转发可以完成首次配置。
- 内部 RPC 与管理服务只把流量发送给当前 Leader。
- Leader 和 Cache 维护 Lease 位于管理命名空间。
- Helm 安装后存在 `GiteaSite`、`EnvironmentTemplate`、`CodespaceComponent` 和 `Codespace` 四类 CRD。
- Manager 可以读取现有 Gateway，并只能创建和维护组件对应的 HTTPRoute 与 TCPRoute。

## 隔离、存储与设备

每个环境模板绑定经过验证的 RuntimeClass、StorageClass、资源限制和 Dev Container 附加配置。RuntimeClass 需要使用 `codespace.gitea.dev/isolation=kata` 或 `codespace.gitea.dev/isolation=sysbox` 标签声明隔离方式，Manager 才会把它作为环境模板选项。标签让集群安装结果与模板选择使用同一份可查询事实，也让保存接口能够在创建工作负载前发现隔离类型不匹配。

Kata 需要硬件虚拟化或可用的嵌套虚拟化；Sysbox 需要受支持的内核、容器运行时和存储驱动。Kata 的工作区卷以块设备进入来宾，Sysbox 的工作区卷以文件系统挂载；Manager 根据隔离标签选择对应形式。设备通过 Kubernetes 扩展资源和设备插件分配。

Kata 与 Sysbox 分别按官方文档安装，并先在专用节点池使用平台镜像和目标 StorageClass 完成真实 Pod 验证。每个 Codespace 使用独立 PVC，StorageClass 需要适配所选 RuntimeClass、节点和扩容策略。

### 实现验收点

- 每个启用模板都有 RuntimeClass、StorageClass 和平台镜像的真实验证记录。
- 每个可选 RuntimeClass 都带有与实际运行方式一致的 `codespace.gitea.dev/isolation` 标签。
- 管理页面中 RuntimeClass 与隔离方式联动，StorageClass 来源于当前集群；不存在的资源无法保存。
- Kata 与 Sysbox 创建的 PVC 分别采用块模式与文件系统模式。
- Runtime 内 Docker 可用，并且无法访问节点容器运行时或 Kubernetes API 身份。
- CPU、内存、磁盘和设备使用受模板限制。
- Pod 替换后 PVC 数据可以由新的 Runtime 恢复。

## 镜像、缓存与网络

Manager、Gateway、Cache 和 Runtime 使用同一个平台镜像引用，但作为独立工作负载运行。Codespace 仓库的 `main` 分支更新平台镜像的 `main` 标签，并发布唯一的 Helm 预发布版本。开发环境可以用 `--devel` 跟随最新 Chart 和镜像；经过验证的部署应使用工作流摘要中的精确 Chart 版本或摘要，并把镜像摘要写入 Helm values。私有仓库凭据通过 Helm 引用现有 Docker Registry Secret；Manager 只向需要拉取镜像的站点命名空间同步凭据。

标签模式在创建 Pod 时检查最新镜像。Manager、Gateway 和 Cache 会随每次平台构建滚动更新，用户 Runtime 保持运行，直到普通生命周期操作需要创建新的 Pod。摘要模式始终引用同一内容，适合生产和故障复现。这样既能让开发集群及时取得更新，也不会为了刷新标签而中断用户会话。

Dev Container 镜像由 Runtime 内的 Docker 拉取或构建。Cache 可以使用 PVC 或 S3，内容属于可重新生成的性能数据。文件系统 Cache 的 PVC 与组件同名并由组件拥有；改用 S3 后控制器回收这块缓存卷。每个站点使用独立命名空间和 NetworkPolicy；用户流量统一进入 Gateway，再由 Gateway 连接 Agent。外部 DNS、TLS 和监听器由集群入口管理，父 Gateway 与监听器在各 Gateway 组件中选择。

### 实现验收点

- Manager 与其创建的工作负载使用同一平台镜像引用。
- Helm Chart 版本、Chart 摘要和平台镜像摘要可以在对应 GitHub Actions 运行摘要中找到。
- 标签模式的新建工作负载获取当前镜像，摘要模式的工作负载保持内容固定。
- 私有仓库凭据只投递给需要它的工作负载。
- Runtime 无法访问其他站点的 Runtime 网络。
- HTTP、WebSocket、SSH 和 SFTP 用户流量均经过 Gateway。
- Cache 清空后可以在原授权范围内回源。
- 文件系统与 S3 缓存使用同一授权流程，切换后只保留当前后端所需的工作负载资源。

## 身份、容量与恢复

Manager 维护安装级内部 CA，并直接为 Manager、Agent、Gateway 和 Cache 签发短期证书。根 CA 代表当前管理命名空间的稳定信任边界，签发 CA 定期轮换，工作负载证书绑定站点、Codespace、Pod 或组件的 Kubernetes UID。内部连接同时验证统一信任链、证书用途和 URI 身份，使同名重建的资源不能沿用旧证书。

根 CA 有效期为 10 年，用于保持安装恢复所需的信任边界；签发 CA 有效期为 1 年并提前 30 天轮换，用于减少长期在线私钥的暴露范围；工作负载证书有效期为 24 小时并提前 8 小时轮换，使短期控制面故障仍有恢复窗口。轮换只更新 Secret 或 Manager 内存中的证书，Pod 模板不包含证书内容摘要，因此普通轮换不会重建正在运行的工作负载。

内部 CA 保存在管理命名空间的 Kubernetes Secret 中。Manager 首次启动时通过 Kubernetes API 原子创建，多个副本读取同一份结果；随后 Manager 使用内存服务器证书启动内部双向 TLS 接口。CA Secret 缺失但已经存在受管资源时，Manager 要求从备份恢复，而不是生成新的信任根。生产集群需要为 Secret 启用静态数据加密，并把内部 CA、管理员令牌、各 Gitea 站点的 Manager 运行密钥、Gateway SSH 主机密钥、对象存储凭据和镜像凭据纳入备份与轮换。Gitea 范围注册令牌保存在 Gitea 数据库，不属于 Kubernetes 备份。

证书 URI 使用同一信任域并直接表达资源身份：Manager 使用 `spiffe://codespace/manager/<management-namespace-uid>`，Agent 使用 `spiffe://codespace/agent/<site-uid>/<codespace-uid>/<pod-uid>`，Gateway 和 Cache 分别使用 `spiffe://codespace/gateway/<component-uid>` 与 `spiffe://codespace/cache/<component-uid>`。管理命名空间、站点、Codespace、Pod 或组件同名重建后会获得新的 Kubernetes UID，因此旧证书不能代表新资源。URI 的构造和解析由同一个身份模块完成，使签发方、Manager、Agent 和 Gateway 使用完全相同的路径结构。

浏览器访问管理页面和 Codespace Endpoint 使用集群入口的外部 HTTPS。Ingress 或 Gateway Listener 引用的 TLS Secret 可以由 cert-manager、云平台证书控制器或集群管理员维护；它不参与内部组件身份。SSH 使用独立的 Gateway 主机密钥。

环境模板定义单个 Runtime 的资源请求，Gitea 站点定义总配额。Manager 统计实际资源和正在创建的任务，Kubernetes 调度器负责节点放置。备份覆盖 Gitea 数据库和日志、Kubernetes 管理资源、Codespace PVC 以及恢复所需的 Secret。

升级先更新 CRD，再更新平台组件。摘要模式的新环境使用新摘要，已有环境继续使用创建时保存的摘要，因此镜像仓库需要保留仍被引用的版本。标签模式更新控制面和平台组件；已有 Runtime 保持运行，在后续重建时获取标签当前指向的镜像。

### 实现验收点

- 长期凭据只保存在对应 Kubernetes Secret 或 Gitea 加密字段中，CR、标签和普通日志只保存非敏感引用。
- Manager 首次启动后生成唯一的安装级内部 CA，多副本不会产生不同信任根。
- 平台证书包含证书、私钥和 CA 信任链，并绑定当前 Kubernetes UID 和正确的客户端或服务器用途。
- Manager、Agent、Gateway 和 Cache 对同一张证书 URI 得到一致的角色与资源 UID，额外或缺失的路径段不能通过身份校验。
- 签发 CA 和工作负载证书轮换时不需要重新安装 Helm Chart，也不需要重启正常运行的工作负载。
- 未安装 cert-manager 的集群可以运行完整内部控制面；启用公开 HTTPS 时只需提供入口引用的 TLS Secret。
- 内部 CA 丢失或损坏时不会被静默替换，恢复原 Secret 后组件能够重新连接。
- 凭据轮换后旧身份和旧会话按有效期失效。
- 站点配额包含运行中和正在创建的 Runtime。
- 恢复后站点、Runtime UUID、PVC 与 Gitea 记录能够重新关联。

## 验证与发布

日常开发测试不依赖 Kubernetes，只覆盖可在进程内或本机完成的逻辑。完整端到端测试通过显式 kubeconfig 连接专用的单节点 k3s 集群，并分别在 Kata 与 Sysbox 环境执行同一套测试入口。这样既能让本地反馈保持快速，也能保证两种隔离方式验证的是同一条产品生命周期，而不是两套逐渐产生差异的脚本。

CI 先在 GitHub 托管 runner 构建平台二进制与镜像归档，再为 Kata 与 Sysbox 分别创建一台全新的 `ubuntu-24.04` runner。每项任务在本机安装固定版本的单节点 k3s 和对应运行时：Kata 通过官方部署 Chart 安装并使用支持块模式的动态存储，Sysbox 通过校验摘要的发行包安装并注册到 k3s containerd。随后导入同一份平台镜像归档。Kata 需要观察到独立来宾内核，Sysbox 需要观察到隔离的用户映射；同一套用例继续验证嵌套 Docker、PVC 恢复、组件身份、Leader 切换、Cache 和完整生命周期。

完整生命周期由测试进程内的协议服务提供 Gitea 对端，真实 Manager、Kubernetes 资源、Runtime Pod、Gateway、Cache、网络和存储仍在 k3s 中运行。这样可以验证 Codespace 平台边界，而不把另一个仓库的部署和凭据变成前置条件；Gitea 服务端的协议适配由 Gitea 仓库集成测试验证。所有拉取请求运行相同的端到端测试，主分支镜像和 Helm Chart 的发布依赖 Kata 与 Sysbox 两项结果。失败任务上传节点、RuntimeClass、StorageClass、Helm 状态、受管资源、事件和 Pod 日志，便于区分基础设施故障与产品故障。

### 实现验收点

- `make test` 不读取 kubeconfig，也不创建 Kubernetes 资源。
- `make test-e2e` 只在提供显式 kubeconfig、不可变平台镜像和运行时参数后执行。
- Kata 与 Sysbox CI 使用同一个测试入口，只改变安装的运行时、RuntimeClass 和 StorageClass。
- 仓库内和外部仓库提交的拉取请求均运行完整端到端测试，且不读取仓库 Secret。
- 主分支发布等待 Kata 与 Sysbox 完整端到端测试成功。
- 运行时名称存在但实际隔离语义不成立时，测试在完整生命周期结束前失败。
- 失败产物包含定位节点、运行时、存储、控制面和工作负载所需的诊断信息。

## 上线验收

正式启用前应在目标集群完成：

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
- 写入者停止确认绑定当前 CR 与 Pod 身份。
- 验收结束后没有孤立的 CR、PVC、Pod、凭据或路由。
