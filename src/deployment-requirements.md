# 部署要求

本文面向集群管理员，说明上线所需的平台能力和验收场景。安装命令与 values 由 [Helm chart README](../codespace/charts/gitea-codespace/README.md) 维护。

## Kubernetes 基础能力

Manager 连接一个逻辑 Kubernetes 集群。集群需要提供 CRD、Lease、PVC、NetworkPolicy、RuntimeClass、Service，以及入口使用的 Ingress 或 Gateway API。Helm chart 安装 CRD、RBAC、Manager、内部服务、管理服务和网络策略。

管理服务默认为 `ClusterIP`，首次配置通过 `kubectl port-forward` 完成。Manager 多副本使用 Lease 选举；健康副本保持 Ready，内部 RPC 与管理服务只选择当前 Leader。Ready 表示副本可以参与接替，Leader 标签表示副本可以处理有状态请求，这两个信号分别服务可用性和单写者约束。

### 实现验收点

- 启动检查能指出缺失的 API、CRD 或 RBAC 权限。
- 默认安装只提供集群内管理入口，端口转发可以完成首次配置。
- 内部 RPC 与管理服务只把流量发送给当前 Leader。
- Leader 和 Cache 维护 Lease 位于管理命名空间。

## 隔离、存储与设备

每个环境模板绑定经过验证的 RuntimeClass、StorageClass、资源限制和 Dev Container 附加配置。Kata 需要硬件虚拟化或可用的嵌套虚拟化；Sysbox 需要受支持的内核、容器运行时和存储驱动。设备通过 Kubernetes 扩展资源和设备插件分配。

Kata 与 Sysbox 分别按官方文档安装，并先在专用节点池使用平台镜像和目标 StorageClass 完成真实 Pod 验证。每个 Codespace 使用独立 PVC，StorageClass 需要适配所选 RuntimeClass、节点和扩容策略。

### 实现验收点

- 每个启用模板都有 RuntimeClass、StorageClass 和平台镜像的真实验证记录。
- Runtime 内 Docker 可用，并且无法访问节点容器运行时或 Kubernetes API 身份。
- CPU、内存、磁盘和设备使用受模板限制。
- Pod 替换后 PVC 数据可以由新的 Runtime 恢复。

## 镜像、缓存与网络

Manager、Gateway、Cache 和 Runtime 使用同一个摘要固定的平台镜像，但作为独立工作负载运行。私有仓库凭据通过 Helm 引用现有 Docker Registry Secret；Manager 只向需要拉取镜像的站点命名空间同步凭据。

Dev Container 镜像由 Runtime 内的 Docker 拉取或构建。Cache 可以使用 PVC 或 S3，内容属于可重新生成的性能数据。每个站点使用独立命名空间和 NetworkPolicy；用户流量统一进入 Gateway，再由 Gateway 连接 Agent。外部 DNS、TLS 和监听器由集群入口管理。

### 实现验收点

- 部署镜像与 Manager 固定的工作负载镜像使用同一摘要。
- 私有仓库凭据只投递给需要它的工作负载。
- Runtime 无法访问其他站点的 Runtime 网络。
- HTTP、WebSocket、SSH 和 SFTP 用户流量均经过 Gateway。
- Cache 清空后可以在原授权范围内回源。

## 身份、容量与恢复

Manager 和组件身份由 cert-manager 签发。管理员令牌、Gitea 注册 Secret、组件身份、Gateway SSH 主机密钥、对象存储凭据和镜像凭据通过 Kubernetes Secret 投递并纳入轮换。

环境模板定义单个 Runtime 的资源请求，Gitea 站点定义总配额。Manager 统计实际资源和正在创建的任务，Kubernetes 调度器负责节点放置。备份覆盖 Gitea 数据库和日志、Kubernetes 管理资源、Codespace PVC 以及恢复所需的 Secret。

升级先更新 CRD，再更新平台组件。新环境使用新镜像摘要；已有环境使用创建时保存的摘要，因此镜像仓库需要保留仍被引用的版本。

### 实现验收点

- Secret 不出现在 ConfigMap、CR、标签或普通日志中。
- 凭据轮换后旧身份和旧会话按有效期失效。
- 站点配额包含运行中和正在创建的 Runtime。
- 恢复后站点、Runtime UUID、PVC 与 Gitea 记录能够重新关联。

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
