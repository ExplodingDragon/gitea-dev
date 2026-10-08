# RPC 接口

本文只说明跨进程接口的职责、安全边界和可靠性语义。方法、消息字段和编号以 `codespace-proto-go` 中的 `.proto` 文件为准，生成的 API 文档不在本设计中重复维护。

## 协议边界

| 服务 | 调用方向 | 职责 |
| --- | --- | --- |
| `ManagerService` | Manager → Gitea | Manager 身份、操作领取、业务凭据、状态、日志和访问判定 |
| `ComponentService` | Gateway/Cache → Manager | 组件配置流、Gateway 授权、Agent 票据和 Cache 维护 |
| `AgentControlService` | Agent ↔ Manager | Runtime 命令、结果、心跳和日志上传 |
| `AgentAccessService` | Gateway ↔ Agent | PTY、SFTP、HTTP 和 loopback 端口转发 |
| `RuntimeEndpointService` | Dev Container → Agent | 通过本地 Unix socket 管理当前 Runtime 的 HTTP Endpoint |

所有顶层请求把协议版本放在字段 1。服务端依次验证调用身份、对象关系以及该接口自己的版本字段，再执行业务动作。

**设计如此：**Gitea 接口只表达 Codespace 业务语义；Kubernetes、Pod、RuntimeClass 和缓存后端属于 Manager。这样 Gitea 可以独立于运行平台演进。

### 实现验收点

- 未知协议版本返回明确错误，不进入业务处理。
- 每个远程请求能从认证上下文和消息确定调用者及目标对象。
- Gitea 与 Codespace 使用同一已发布协议版本。
- Proto 消息不承载对应服务职责之外的实现细节。

## Gitea 控制面

Manager 使用 `ManagerService` 声明自身、领取和完成生命周期操作，并上报日志、Runtime 信息与完整资源清单。操作请求始终携带当前版本；Runtime 相关报告还携带已绑定的 Runtime UUID。Gitea 在当前权限下签发 Git/API 材料，并负责浏览器打开、公共 Endpoint、SSH 公钥和持续会话的业务授权。

领取响应使用命令分支表达 create、resume、stop 或 delete。最终提交再次携带操作类型和版本，Gitea 将其与当前主状态推导出的操作比较。协议字段用于识别一次远程命令和拒绝错配回报，不要求 Gitea 为操作类型建立重复数据库列。

轮询没有任务时返回正常空结果。高频成功轮询可以从普通 HTTP 请求日志中省略，错误仍进入诊断日志；日志策略不改变 RPC 状态和响应。

### 实现验收点

- Manager 凭据只能访问对应的 Gitea Manager 记录。
- 操作领取、续期、日志和完成均校验绑定与版本。
- 最终提交的操作类型必须与 Gitea 当前主状态推导结果一致。
- Runtime 凭据按请求时的用户和仓库权限生成。
- 普通访问日志省略成功的空轮询，失败请求仍可定位。

## 组件控制面

Gateway 和 Cache 使用各自组件身份建立长期控制流，从 Manager 接收带版本的完整配置或增量更新。版本不连续时重新取得完整快照。Gateway 在建立用户数据流前请求业务授权和一次性 Agent 票据；Cache 按配置限制上游、命名空间和维护动作。

组件凭据按类型授权。短时认证缓存的键包含凭据摘要、资源范围、动作和配置版本，因此只能减少重复校验，不能扩大权限。Cache 维护许可保证同一存储同一时刻只有一个清理执行者。

### 实现验收点

- Gateway 身份不能执行 Cache 操作，Cache 身份不能签发用户访问票据。
- 控制流断线重连后能从版本缺口恢复完整配置。
- Agent 票据绑定站点 UID、CR UID、Runtime UUID、Pod UID、访问目标版本、单项能力和短期有效期。
- 配置或凭据变化会使相关认证缓存失效。

## Agent 控制与访问

Agent 以当前 CR 和 Pod 身份建立控制流。操作版本与持久执行记录共同限定生命周期任务；Agent 在 PVC 中先记录阶段开始，再执行副作用，完成后记录结果。重连时已经成功的阶段直接复用结果；开始后未记录完成的阶段视为结果未知并明确失败，因为盲目重放可能重复修改用户环境。日志使用独立上传接口，使大量构建输出不会阻塞 stop 或 delete 命令。

Gateway 使用一次性票据建立访问流。票据只授权一种能力：PTY、SFTP、HTTP Endpoint 或 loopback TCP。PTY 支持初始尺寸和后续调整；SFTP 以 Codespace 用户的 UID/GID 运行；端口转发只接受 `localhost`、`127.0.0.1` 和 `::1`。

Dev Container 通过挂载的 Unix socket 调用 `RuntimeEndpointService`。CLI 只是该本地接口的客户端，Endpoint 状态由 Agent 维护并随 Metadata 发布，不需要共享文件或容器内 Manager 端口。

### 实现验收点

- 已成功阶段在重连后不重复执行，结果未知的中断阶段明确失败。
- 日志背压不会阻止控制命令传递。
- 一次性票据不能跨 CR、Pod、Runtime、访问目标版本或能力复用。
- Dev Container 无需网络访问 Manager 即可增删和查询 Endpoint。

## 错误、重试与传输

接口使用标准 RPC 状态区分参数、认证、权限、对象、状态冲突和暂时不可用。错误文本说明对象与失败阶段，不在 Proto 中维护一套重复的业务错误枚举。可重试写操作按职责使用操作版本、Metadata 代数、交互代数、Inventory 代数或稳定资源键实现幂等。

所有跨组件连接都具有应用层身份。外部 TLS 可以在 Kubernetes 入口终止，但集群网络可达不代表已经授权。流式接口限制消息大小、空闲时间和缓冲；关闭时先停止接收新请求，再取消控制流并在有限时间内释放连接。

### 实现验收点

- 同类失败在不同服务中使用一致的 RPC 状态。
- 错误和普通日志不包含 Token、Secret、私钥或内部目标地址。
- 网络错误后的重试不会创建第二个操作、Runtime 或命令执行。
- 慢客户端和关闭中的连接不会无限占用内存或阻塞进程退出。
