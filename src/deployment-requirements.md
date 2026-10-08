# 部署要求

本文面向集群管理员，说明运行 Codespace 所需的平台能力、配置边界和上线验收。架构原因见[运行平台](runtime-platform.md)，这里不重复控制器内部流程。

## Kubernetes 平台

Manager 连接一个逻辑 Kubernetes 集群。集群需要提供 CRD、Lease、PVC、NetworkPolicy、RuntimeClass、Service，以及 Ingress 或 Gateway API。每个 Gitea 站点对应一个 `codespace-<site-name>` 命名空间；站点名称使用稳定的 DNS 标签。

Manager 的 ServiceAccount 具有管理 Codespace CRD、站点命名空间资源、环境模板和 Leader Lease 所需的权限。Gateway、Cache 和 Runtime 使用各自身份，其中 Runtime 关闭 ServiceAccount Token 自动挂载。

### 实现验收点

- 启动检查能指出缺失的 API、CRD 或 RBAC 权限。
- 不同站点的资源进入不同命名空间。
- Manager 多副本中只有一个 Leader 推进生命周期操作。
- Gateway、Cache 和 Runtime 的权限审计结果符合各自职责。

## Runtime 环境

每个启用的环境模板绑定经过验证的 RuntimeClass、StorageClass、基础镜像和资源限制。Kata 需要可用的虚拟化设备；Sysbox 需要受支持的内核和存储驱动。设备通过 Kubernetes 扩展资源和设备插件分配。

Runtime Pod 使用专属 Docker 运行 Dev Container。节点容器运行时套接字和 Kubernetes 凭据不进入用户环境。模板中的 CPU、内存、磁盘和设备请求构成用户配置的上限。

### 实现验收点

- Kata 与 Sysbox 模板分别通过真实 RuntimeClass 启动测试。
- Runtime 内 Docker 可用，同时没有节点容器运行时访问能力和可用的 Kubernetes 身份。
- RuntimeClass、StorageClass 或设备缺失时，错误能够指出缺失能力。
- Dev Container 配置不能突破环境模板的资源上限。

## 镜像、存储与缓存

Manager、Gateway、Cache 和 Runtime 镜像在发布阶段构建，并以可追踪摘要部署。项目 Dev Container 镜像由 Runtime 内的专属 Docker 构建；测试集群无法访问镜像仓库时，可以导出镜像并通过 `ctr` 导入 containerd，同时保留原摘要用于核对。

每个 Codespace 使用独立 PVC 保存工作区和 Runtime 数据。StorageClass 需要适配所选 RuntimeClass、节点和扩容策略。Cache 使用独立持久卷或 S3，属于可重新生成的性能数据，不进入业务恢复备份。

### 实现验收点

- 部署清单引用发布镜像及其预期摘要。
- Pod 替换后工作区和 Runtime 持久数据保持一致。
- 删除 Codespace 最终回收对应 PVC，清理失败时保留可诊断状态。
- Cache 清空后可以回源重建，不影响已有 PVC 恢复。

## 网络与身份

Gitea、Manager、Gateway 和 Cache 使用各自 Service。Runtime 连接 Manager、Gitea/Git、镜像源和项目所需外部服务；用户流量统一进入 Gateway，再由 Gateway 连接 Agent。每个 Runtime 不需要公开 Service 或 LoadBalancer。

站点命名空间使用 NetworkPolicy 隔离。外部 DNS、TLS 和监听器由 Ingress 或 Gateway API 管理。Gitea 注册 Secret、组件身份、对象存储凭据和状态加密密钥通过 Kubernetes Secret 投递；开发默认值会产生安全警告，生产部署使用独立高熵值并纳入轮换流程。

### 实现验收点

- Runtime 无法访问其他站点的 Runtime 网络。
- HTTP、WebSocket、SSH 和 SFTP 用户流量都先经过 Gateway。
- Secret 不出现在 ConfigMap、CR、资源标签或普通日志中。
- 凭据轮换后旧身份在规定时间内失效。

## 容量、升级与恢复

`EnvironmentTemplate` 定义单个 Runtime 的资源请求，`GiteaSite` 定义站点配额。Manager 统计 Kubernetes 实际资源和正在创建的任务，Kubernetes 调度器负责最终节点放置；Manager 不复制节点装箱算法。

升级时先应用兼容的新 CRD，再滚动更新 Manager、Gateway 和 Cache，最后更新环境模板镜像。备份覆盖 Gitea 数据库和日志、Kubernetes 管理资源、Codespace PVC 及必要 Secret。Leader 恢复和旧写入者确认遵循[运行平台的故障恢复流程](runtime-platform.md#高可用与故障恢复)。

### 实现验收点

- 站点配额统计包含 running 和正在创建的 Runtime。
- 容量不足时任务排队或在截止时间后给出明确资源原因。
- 滚动升级期间只有一个 Leader，已有会话具有明确重连行为。
- 从备份恢复后，站点、Runtime UUID、PVC 与 Gitea 记录能够重新关联。

## 上线验收

正式启用前，在目标集群完成以下场景：

1. 从两个隔离站点分别创建和删除 Codespace；
2. 使用计划启用的每种 RuntimeClass 完成 create、stop、resume 和 delete；
3. 验证 Web IDE、PTY、SSH、SFTP、HTTP Endpoint 和回环端口转发；
4. 替换 Runtime Pod，确认旧访问失效且 PVC 数据可恢复；
5. 切换 Manager Leader，确认操作不会重复；
6. 清空 Cache，确认构建可以回源；
7. 审计 NetworkPolicy、RBAC、Secret 和测试资源清理结果。

### 实现验收点

- 验收记录包含组件版本、RuntimeClass、StorageClass、镜像摘要和结果。
- 每个失败场景能从页面和日志定位到明确阶段。
- 写入者停止确认使用当前 CR UID、`resourceVersion` 和 Pod UID。
- 验收结束后不存在孤立 CR、PVC、Pod、凭据或路由。
