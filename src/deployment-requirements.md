# 部署要求

本文面向集群管理员，说明上线 Codespace 所需的平台能力、隔离边界和验收场景。安装命令与 values 见 [Helm chart README](../codespace/charts/gitea-codespace/README.md)，内部控制流程见[运行平台](runtime-platform.md)。

## Kubernetes 平台

Manager 连接一个逻辑 Kubernetes 集群。集群需要支持 CRD、Lease、PVC、NetworkPolicy、RuntimeClass、Service，以及入口所选用的 Ingress 或 Gateway API。Helm chart 安装 CRD、RBAC、Manager、内部 RPC Service、管理 Service、身份和网络策略。

管理 Service 默认为 `ClusterIP`，首次配置通过 `kubectl port-forward` 完成。Manager 多副本使用 Lease 选举；健康的 Leader 和备用副本都保持 Ready，而内部 RPC 与管理 Service 只把流量发给当前 Leader。

**设计如此：**就绪状态表示副本能够参与接替，Leader 标签表示副本当前能够处理有状态请求。分开这两个信号可以在滚动更新时保留接替能力，同时保持单写者。

### 实现验收点

- 启动检查能指出缺失的 API、CRD 或 RBAC 权限。
- 默认安装只提供集群内管理入口，本地端口转发可以完成首次配置。
- 所有健康副本保持 Ready，内部 RPC 与管理 Service 只选择当前 Leader。
- Leader 与 Cache 维护 Lease 只存在于管理命名空间。

## RuntimeClass 与存储

每个环境模板绑定经过验证的 RuntimeClass、StorageClass、资源上限和 Dev Container 注入配置。Kata 需要硬件虚拟化或可用的嵌套虚拟化；Sysbox 需要受支持的内核、容器运行时和存储驱动。设备通过 Kubernetes 扩展资源和设备插件分配。

Kata 按[官方安装说明](https://github.com/kata-containers/kata-containers/blob/main/docs/installation.md)部署。Sysbox 按[官方 Kubernetes 安装说明](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-k8s.md)部署，并在部署前核对其[限制说明](https://github.com/nestybox/sysbox/blob/master/docs/user-guide/limitations.md)。两者都先在专用节点池使用平台镜像和目标 StorageClass 完成真实 Pod 验证，再启用对应环境模板。

Runtime Pod 在隔离环境内运行专属 Docker。节点容器运行时套接字和 Kubernetes 身份不会进入用户环境。每个 Codespace 使用独立 PVC，StorageClass 必须适配所选 RuntimeClass、节点和扩容策略。

### 实现验收点

- 每个启用的模板都有对应 RuntimeClass、StorageClass 和平台镜像的真实验证记录。
- Runtime 内 Docker 可用，且无法使用节点容器运行时或 Kubernetes API 身份。
- CPU、内存、磁盘和设备使用受环境模板限制。
- Pod 替换后 PVC 数据可以由新的 Runtime 恢复。

## 镜像与缓存

Manager、Gateway、Cache 和 Runtime 使用同一个发布镜像，并以摘要固定。不同角色仍作为独立工作负载运行，由命令与安全上下文决定权限。私有仓库凭据通过 Helm 引用现有 Docker Registry Secret；Manager 只向实际需要拉取平台镜像的站点命名空间同步凭据。

Dev Container 镜像由 Runtime 内的 Docker 拉取或构建。Cache 可以使用持久卷或 S3 保存镜像代理与构建缓存，这些内容属于可重新生成的性能数据，不进入 Codespace 业务备份。

### 实现验收点

- Manager 的平台镜像参数与 Helm 部署镜像使用同一摘要。
- 私有仓库凭据只投递给需要拉取平台镜像的工作负载。
- Cache 清空后可以在原授权范围内回源重建。
- 测试环境手工导入镜像时仍能核对预期摘要。

## 网络与身份

每个站点使用独立命名空间和 NetworkPolicy。Runtime 只连接 Manager、Gitea/Git、允许的镜像源与项目依赖；用户流量统一进入 Gateway，再由 Gateway 连接 Agent。Runtime 不创建对外 Service 或 LoadBalancer。

外部 DNS、TLS 和监听器由集群入口管理。Manager 工作负载身份由 cert-manager `ClusterIssuer` 签发。Gitea 注册 Secret、管理员令牌、组件身份、Gateway SSH 主机密钥、对象存储凭据和镜像仓库凭据通过 Kubernetes Secret 投递并纳入轮换。

### 实现验收点

- Runtime 无法访问其他站点的 Runtime 网络。
- HTTP、WebSocket、SSH 和 SFTP 用户流量都经过 Gateway。
- Secret 不出现在 ConfigMap、CR、资源标签或普通日志中。
- 凭据轮换后，旧身份和旧会话在规定时间内失效。

## 容量、升级与恢复

环境模板定义单个 Runtime 的资源请求，Gitea 站点定义总配额。Manager 统计 Kubernetes 实际资源和正在创建的任务，Kubernetes 调度器负责节点放置。

升级先更新 CRD，再用 Helm 更新平台组件。新 Codespace 使用新镜像摘要；已有 Codespace 使用创建时快照，因此镜像仓库要保留仍被引用的旧摘要。备份覆盖 Gitea 数据库和日志、Kubernetes 管理资源、Codespace PVC 以及恢复所需 Secret。

### 实现验收点

- 站点配额统计包含运行中和正在创建的 Runtime。
- 容量不足时任务排队，并在截止时间后给出明确资源原因。
- 滚动升级期间保持单一 Leader，已有 Codespace 仍可拉取其快照镜像。
- 恢复后站点、Runtime UUID、PVC 和 Gitea 记录可以重新关联。

## 上线验收

正式启用前，在目标集群完成以下场景：

1. 从两个隔离站点分别创建和删除 Codespace；
2. 使用每种启用的 RuntimeClass 完成 create、stop、resume 和 delete；
3. 验证 Web IDE、PTY、SSH、SFTP、HTTP Endpoint 和回环端口转发；
4. 替换 Runtime Pod，确认旧访问失效且 PVC 数据恢复；
5. 切换 Manager Leader，确认操作保持唯一执行；
6. 清空 Cache，确认构建能够回源；
7. 审计 NetworkPolicy、RBAC、Secret 和测试资源清理结果。

### 实现验收点

- 验收记录包含组件版本、RuntimeClass、StorageClass、镜像摘要和结果。
- 每个失败场景都能从页面和日志定位到明确阶段。
- 写入者停止确认绑定当前 CR 与 Pod 身份。
- 验收结束后不存在孤立 CR、PVC、Pod、凭据或路由。
