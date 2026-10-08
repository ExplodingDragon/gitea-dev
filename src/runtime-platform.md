# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 仍是用户、权限和生命周期状态的权威来源。

## 控制面与资源

Manager 提供管理页面和 API，并运行 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略位于其中。

`EnvironmentTemplate` 定义用户可选择的环境，包括 RuntimeClass、资源、存储、Git SSH 密钥类型和 Dev Container 附加配置。平台镜像由部署参数统一指定。创建时，Manager 把镜像摘要和模板内容固定在 Codespace CR 中，使已有环境恢复时不受模板或发布版本变化影响。

管理 API 使用 Kubernetes UID 和 `resourceVersion` 处理对象身份与并发修改。Secret 采用只写接口，派生资源通过所有者引用随其配置对象回收。

### 实现验收点

- Manager 只连接一个 Kubernetes API。
- 不同 Gitea 站点的资源、凭据、配额和网络策略相互隔离。
- Manager、Gateway、Cache 和 Runtime 使用同一份摘要固定的平台镜像。
- 修改模板或升级平台只影响新环境，已有环境仍能按快照恢复。
- 管理 API 不返回长期 Secret 明文。

## Runtime 与 Dev Container

Runtime Pod 使用平台镜像，Codespace Agent 是 Pod 的 PID 1。Agent 启动专属 Docker、准备工作区、创建 Dev Container、执行生命周期命令、上传日志并提供访问 RPC。用户镜像运行在该 Docker 中，不直接成为 Kubernetes Pod 容器。

环境模板明确选择 Kata 或 Sysbox RuntimeClass。Kata 提供虚拟机隔离；Sysbox 面向没有硬件虚拟化但需要容器内 Docker 的节点。两者的安全边界和存储要求不同，因此失败时不会自动切换。

仓库配置、个人模板、站点模板和平台默认配置进入同一 Dev Container 解析流程。环境模板可以加入 Web IDE 和其他标准 Feature；平台最后挂载 Endpoint socket、运行材料和访问工具。详细 Dev Container 字段由公共包和规范测试维护。

### 实现验收点

- Runtime 不挂载节点容器运行时套接字，也不持有 Kubernetes API 凭据。
- Kata 与 Sysbox 分别在对应 RuntimeClass 上通过真实启动验证。
- 所有 Dev Container 配置来源使用同一解析和执行路径。
- 管理员注入不会覆盖仓库中无关的 Feature 配置。
- ready 只在开发容器与必要访问服务可用后发布。

## 持久数据与恢复

每个 Codespace 使用独立 PVC，保存工作区、内部 Docker 数据、Git SSH 私钥和 IDE 数据。Token、用户 Secret、Unix socket 和进程状态写入易失目录。Agent 在 PVC 中先记录操作阶段和结果，再向 Manager 上报，因此响应丢失时可以重报结果而不重复副作用。

create 完成用户初始化、仓库检出、Dev Container 构建和首次生命周期命令，然后进入与 resume 相同的 start 流程。stop 删除 Runtime Pod 并保留 CR/PVC；resume 创建新的 Pod 并复用持久数据；delete 才回收 Codespace 的持久资源。

### 实现验收点

- Pod 替换后工作区、内部 Docker 数据和 IDE 设置保持一致。
- PVC 不保存 Gitea Token 或用户 Secret 明文。
- resume 不重新克隆仓库或执行一次性初始化命令。
- 已完成阶段的结果可以重报，但不会再次执行。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket、SSH 和 SFTP 入口。它从 Manager 获取当前路由，每次建立用户数据流前复核 Gitea 权限并取得短期 Agent 票据，再通过 mTLS 直连 Agent。Manager 只参与控制和授权，不转发用户数据。

Gateway SSH 主机密钥由 Manager 生成，私钥保存在不可变 Kubernetes Secret 中。轮换创建新 Secret、切换 Gateway，再发布新的公钥指纹。Agent 支持 PTY、命令、SFTP、HTTP Endpoint 和回环端口转发；Dev Container 通过挂载的 Unix socket 管理 Endpoint。

外部 DNS、TLS 和监听器由 Kubernetes Ingress 或 Gateway API 管理。这样应用权限与平台证书各自只有一个负责方。

### 实现验收点

- Gateway 每次建立数据流都需要当前有效授权和 Agent 票据。
- Gateway 主机私钥只存在于对应 Kubernetes Secret。
- PTY、SFTP、Endpoint 和端口转发的票据不能互相复用。
- 本地端口转发只访问当前开发容器的回环地址。
- Pod 或访问目标版本变化后，旧路由和票据失效。

## Cache

Cache 是独立组件，支持本地文件系统或 S3 存储，为允许的上游镜像提供代理，并为构建提供按站点、仓库和用户隔离的命名空间。Runtime 的 Docker 数据保存在 PVC；Cache 只减少重复下载和构建。

Cache 从 Manager 获取配置、租约和短期认证。缓存可以重新生成，因此 Cache 离线或清空时允许在原授权范围内回源。维护许可确保同一存储同一时刻只有一个实例执行垃圾回收。

### 实现验收点

- 私有镜像和构建缓存不能跨站点、仓库或用户读取。
- 不同 Registry 与仓库不会产生缓存键冲突。
- Cache 清空后可以回源，已有 Codespace 仍可从 PVC 恢复。
- 同一存储同一时刻只有一个垃圾回收执行者。

## 高可用与故障恢复

Manager 多副本使用 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持就绪以便接替。新 Leader 先核对 Gitea 当前操作与集群中的 CR、PVC、Pod 和 Agent，再领取新任务。

恢复不依赖节点本地文件。若 Kubernetes 无法证明旧 Pod 已经停止写入 PVC，Manager 先撤销执行权和路由并保留数据，等待管理员针对当前资源身份确认，再把环境收敛到 stopped 并通过普通 resume 启动新 Pod。

### 实现验收点

- 同一时刻只有 Leader 推进生命周期操作。
- 新 Leader 完成资源核对前不领取新 create。
- 部分清单、未知归属或失联节点不会触发误删或双写。
- 管理员确认只对当前 CR 与 Pod 身份生效。
