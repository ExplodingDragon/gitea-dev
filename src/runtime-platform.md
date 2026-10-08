# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 仍是用户、权限和生命周期状态的权威来源。

## 控制面与资源

Manager 提供管理页面和 API，维护 Gitea 站点、环境模板、Gateway 与 Cache 配置，并运行 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略都位于其中。

`EnvironmentTemplate` 定义创建时可选择的环境，包括 RuntimeClass、基础镜像、资源、存储和可用 Cache。一个 Manager 只连接一个 Kubernetes API，因为 Kubernetes 已经提供统一的资源域、调度和高可用语义；跨集群调度需要另一套资源发现与一致性模型，复杂度与收益不匹配。

管理 API 使用对象 UID 和 `resourceVersion` 处理并发修改。Secret 只写，读取接口仅说明是否已配置。控制器通过 Kubernetes 所有者引用管理派生资源，使配置对象、工作负载和身份具有一致生命周期。

### 实现验收点

- Manager 只使用一个 Kubernetes API 配置运行控制器。
- 不同 Gitea 站点的业务资源、凭据、配额和网络策略相互隔离。
- 并发编辑返回冲突，管理 API 不返回长期 Secret 明文。
- 删除配置对象只回收其拥有的资源，不影响其他站点或 Codespace。

## Runtime 与 Dev Container

Runtime Pod 使用平台发布的固定镜像，Codespace Agent 是 Pod 的 PID 1。Agent 启动专属 Docker 守护进程、准备工作区、创建 Dev Container、执行生命周期命令、收集日志并提供访问 RPC。用户镜像和容器运行在该专属 Docker 中，而不是直接成为 Kubernetes Pod 容器。

外层 RuntimeClass 提供隔离：Kata 适用于具备嵌套虚拟化的节点，Sysbox 适用于需要容器内 Docker 但没有虚拟化能力的节点。环境模板明确选择其中一种，不在运行时自动切换，因为两者的隔离边界和存储要求不同。

创建可以使用锁定提交中的 `devcontainer.json`、个人模板、站点模板或平台默认配置。JSONC、Compose 多文件和 Features 由公共 `devcontainer` 包解析；详细字段支持范围由代码和兼容性测试维护，设计文档不复制规范 schema。

### 实现验收点

- Runtime Pod 不挂载节点容器运行时套接字，也不持有 Kubernetes API 凭据。
- Kata 与 Sysbox 环境均在对应 RuntimeClass 上完成真实启动验证。
- 仓库配置、模板和默认配置进入同一解析与执行流程。
- ready 只在主容器、访问服务和当前凭据均可用后发布。

## 持久数据与恢复

每个 Codespace 使用独立 PVC。PVC 保存工作区、内部 Docker 数据、Git SSH 私钥、IDE 数据和可重复提交的操作结果；`/run/codespace` 保存 Token、用户 Secret、socket 和 PID 等易失数据。Agent 先原子记录操作结果再上报，响应丢失时重复提交结果，而不是重放已经完成的副作用。

create 负责用户与目录初始化、仓库检出、Dev Container 构建和首次生命周期命令；start 负责启动已有环境。首次创建在初始化完成后执行 start，resume 只执行同一 start 语义，因此不会重新克隆仓库或运行一次性命令。stop 删除 Runtime Pod 并保留 CR/PVC，delete 才回收持久资源。

Git 和 API 凭据在 create、resume 或稳定环境恢复时从 Gitea 重新取得并写入易失目录。Git SSH 私钥始终留在 PVC，Gitea 只保存公钥关系。日志在离开 Agent 前按当前敏感值脱敏。

### 实现验收点

- Pod 替换后工作区、内部容器数据和 IDE 设置保持一致。
- PVC 不保存 Gitea Token、用户 Secret 或 Cache 临时凭据明文。
- resume 不重新执行仓库克隆、初始化或首次 Dev Container 生命周期命令。
- 操作结果上报重试不会再次执行已经完成的命令。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket 和 SSH 入口。它从 Manager 取得当前路由，在建立每条数据流前由 Gitea 复核用户权限，再取得绑定站点、Runtime UUID、CR UID、Pod UID、访问目标版本和单项能力的短期 Agent 票据。Gateway 通过 mTLS 直连 Agent，Manager 不转发用户数据。

Agent 访问服务支持 PTY、命令、信号、SFTP、HTTP Endpoint 和回环 TCP。SFTP 使用 Codespace 用户的 UID/GID，并以工作区作为初始目录；SSH 本地端口转发只接受 `localhost`、`127.0.0.1` 和 `::1`。Dev Container 通过挂载的 Unix socket 管理 HTTP Endpoint，不需要访问 Manager 网络端口。

外部 DNS、TLS 和入口监听由 Kubernetes Ingress 或 Gateway API 管理。设计如此，是为了让应用认证与平台证书管理各自只有一个负责方。

### 实现验收点

- Gateway 不能只凭路由缓存连接 Agent，每条流都需要当前有效票据。
- PTY、SFTP、Endpoint 和端口转发的票据不能互相复用。
- 端口转发只能访问当前 Dev Container 的回环地址。
- Pod 或访问目标版本变化后，旧身份、路由和票据立即失效。

## Cache

Cache 是独立组件，支持本地文件系统或 S3 存储，为允许的上游镜像提供代理，并为 BuildKit 提供按站点、仓库和用户隔离的缓存命名空间。Runtime 自身的 Docker 数据保存在 PVC，Cache 仅减少重复下载和构建。

Cache 从 Manager 获取配置、租约和短期认证。缓存内容可以重新生成，因此 Cache 离线或被清空时允许在原授权范围内回源，不改变 Codespace 主状态。垃圾回收使用维护许可，避免多个实例同时清理同一存储。

### 实现验收点

- 私有镜像和构建缓存不能跨站点、仓库或用户读取。
- 不同 Registry 和仓库使用不会冲突的缓存键。
- Cache 清空后仍可重新构建，已有 Codespace 可以从 PVC 恢复。
- 同一存储同一时刻只有一个实例执行垃圾回收。

## 高可用与故障恢复

Manager 多副本使用 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持存活并观察资源。新 Leader 先声明 `recovering`，核对 Gitea 当前操作以及集群中的 CR、PVC、Pod 和 Agent，再声明 `online` 并领取新 create。

恢复不依赖节点本地文件。Kubernetes 无法证明旧 Pod 的写入者已经停止时，Manager 撤销执行权和路由并保留 PVC；管理员针对当前 CR UID、`resourceVersion` 和 Pod UID 确认后，环境先收敛到 stopped，再通过普通 resume 创建新 Pod。精确身份确认用于避免同一 PVC 出现两个写入者。

### 实现验收点

- 同一时刻只有 Leader 领取和推进生命周期操作。
- Leader 完成完整资源清单核对前不领取新 create。
- 部分列表、未知归属和失联节点不会触发误删或双写。
- 管理员确认只对当前 CR 和 Pod 身份生效，资源变化后必须重新确认。
