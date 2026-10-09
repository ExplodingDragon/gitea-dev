# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 继续负责用户、权限和业务状态。

## 控制面与资源

Manager 提供管理 API 和 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略位于其中。

`EnvironmentTemplate` 定义 RuntimeClass、资源、存储、Git SSH 密钥类型和 Dev Container 附加配置。创建时，Manager 把模板内容和平台镜像摘要写入 Codespace CR，确保已有环境恢复时不受模板或平台升级影响。管理 API 使用 Kubernetes UID 与 `resourceVersion` 处理对象身份和并发修改，Secret 使用只写接口。

### 实现验收点

- Manager 只连接一个 Kubernetes API。
- 不同站点的资源、凭据、配额和网络策略相互隔离。
- Manager、Gateway、Cache 和 Runtime 使用同一份摘要固定的平台镜像。
- 模板或平台升级只影响新环境，管理 API 不返回长期 Secret 明文。

## Runtime 与持久数据

Runtime Pod 使用平台镜像，Agent 作为 PID 1 启动专属 Docker、准备工作区、创建 Dev Container、执行生命周期命令并提供访问 RPC。Manager 与 Agent 即使来自同一个平台镜像，也运行在不同 Pod 中；同一镜像用于统一发布和审计，不会合并各自的进程与权限边界。用户镜像运行在该 Docker 中，不直接成为 Kubernetes Pod 容器。

环境模板显式选择 Kata 或 Sysbox RuntimeClass。失败时继续保留原隔离选择，因为自动切换会改变安全边界。仓库配置和命名模板进入同一 Dev Container 解析路径；环境模板可以追加 Web IDE 和标准 Feature。

每个 Codespace 使用独立 PVC 保存工作区、内部 Docker、Git SSH 私钥和 IDE 数据。Token、用户 Secret、Unix socket 与进程状态写入易失目录。Agent 先在 PVC 记录操作阶段和结果，再向 Manager 上报，以便响应丢失后重报结果而不重复副作用。

### 实现验收点

- Runtime 不挂载节点容器运行时套接字，也不持有 Kubernetes API 凭据。
- Kata 与 Sysbox 分别在对应 RuntimeClass 上通过真实启动验证。
- 所有 Dev Container 来源使用同一解析和执行路径。
- Pod 替换后工作区、内部 Docker 和 IDE 数据保持一致。
- ready 只在 Dev Container 与必要访问服务可用后发布。
- Agent 只能通过内部 RPC 接收操作和发布运行事实。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket、SSH 和 SFTP 入口。它从 Manager 获取当前路由，每次建立数据流前复核 Gitea 权限并取得短期 Agent 票据，再通过 mTLS 直连 Agent。Manager 不转发用户数据。

Gateway SSH 主机密钥由 Manager 生成，私钥保存在 Kubernetes Secret 中。轮换时创建新的 Secret 和 Gateway 工作负载，再发布新的公钥指纹。Agent 提供 PTY、命令、SFTP、HTTP Endpoint 和回环端口转发；Dev Container 通过本地 Unix socket 管理 Endpoint。

外部 DNS、TLS 和监听器由 Kubernetes Ingress 或 Gateway API 管理，使应用授权与平台证书分别由对应组件负责。

### 实现验收点

- 每个数据流都需要当前有效的用户授权和 Agent 票据。
- SSH 主机私钥只存在于对应 Secret。
- 每张票据只绑定一种访问能力。
- 本地端口转发只访问当前 Dev Container 的回环地址。
- Pod 或目标版本变化后，旧路由和票据失效。

## Cache

Cache 是独立组件，支持本地文件系统或 S3。它为允许的上游镜像提供代理，并按站点、仓库和用户隔离构建缓存。Runtime 的 Docker 数据保存在 PVC，Cache 只减少重复下载与构建。

Cache 从 Manager 获取配置、短期认证和维护许可。缓存丢失时允许在原授权范围内回源；维护许可保证同一存储同一时刻只有一个垃圾回收执行者。

### 实现验收点

- 私有镜像和构建缓存按站点、仓库与用户范围隔离读取。
- Registry 与仓库组合不会产生缓存键冲突。
- Cache 清空后可以回源，已有 Codespace 仍可从 PVC 恢复。
- 同一存储同一时刻只有一个垃圾回收执行者。

## 高可用与恢复

Manager 多副本通过 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持可接替状态。新 Leader 先核对 Gitea 当前操作与 CR、PVC、Pod 和 Agent，再领取新任务。

恢复不依赖节点本地文件。Kubernetes 无法证明旧 Pod 已停止写入 PVC 时，Manager 撤销其执行权和路由并保留数据，等待管理员针对当前资源身份确认，再把环境收敛到 stopped，通过普通 resume 启动新 Pod。

### 实现验收点

- 同一时刻只有 Leader 推进生命周期操作。
- 新 Leader 完成资源核对前不领取新 create。
- 部分清单、未知归属或失联节点不会触发误删或双写。
- 管理员确认只对当前 CR 和 Pod 身份生效。
