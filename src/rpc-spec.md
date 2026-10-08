# RPC 接口

本文说明跨进程接口的职责、安全边界和可靠性语义。服务、方法、消息字段和编号由 `codespace-proto-go` 中的 `.proto` 文件定义，生成的 API 文档不在这里重复维护。

## 服务边界

| 服务 | 调用方向 | 职责 |
| --- | --- | --- |
| `ManagerService` | Manager → Gitea | Manager 身份、生命周期操作、业务凭据、日志、状态和访问判定 |
| `ComponentService` | Gateway/Cache → Manager | 组件配置、Gateway 授权、Agent 票据和 Cache 维护许可 |
| `AgentControlService` | Agent ↔ Manager | Runtime 命令、结果、心跳和日志上传 |
| `AgentAccessService` | Gateway ↔ Agent | PTY、SFTP、HTTP 和回环端口转发 |
| `RuntimeEndpointService` | Dev Container → Agent | 通过本地 Unix socket 管理 HTTP Endpoint |

每个服务只传递调用方完成职责所需的信息。Gitea 协议表达 Codespace 业务语义，Kubernetes、Pod 和缓存后端由 Manager 管理。

### 实现验收点

- 每个远程请求都能从认证上下文和消息确定调用者与目标对象。
- 未知协议版本返回明确错误，并且不进入业务处理。
- Gitea 协议中不包含 Kubernetes 调度和容器网络配置。
- Gitea 与 Codespace 使用同一已发布协议版本。

## Gitea 控制面

Manager 向 Gitea 声明自身、领取并完成生命周期操作，上报日志、Runtime 信息和资源清单，并按需请求 Git/API 材料。操作请求携带当前版本；Runtime 报告同时绑定已经确认的 Runtime 身份。Gitea 负责最终业务权限和用户可见状态。

没有任务的轮询返回正常空结果。高频成功轮询可以从普通 HTTP 请求日志中省略，错误仍保留诊断信息；日志策略不改变 RPC 结果。

### 实现验收点

- Manager 凭据只能操作对应的 Gitea Manager 记录。
- 领取、续期、日志、Runtime 报告和完成都校验当前绑定与版本。
- Gitea 根据请求时的用户和仓库权限生成运行材料。
- 空轮询不会制造大量普通访问日志，失败请求仍可定位。

## 组件控制面

Gateway 和 Cache 使用各自身份建立控制流，从 Manager 获取版本化配置。连接发现版本缺口时重新获取完整快照。Gateway 建立用户数据流前请求业务授权和短期 Agent 票据；Cache 按配置限制上游、缓存命名空间和维护动作。

短时认证缓存同时绑定凭据、资源范围、动作和配置版本。Cache 维护许可确保同一存储同一时刻只有一个清理执行者。

### 实现验收点

- Gateway 身份不能执行 Cache 操作，Cache 身份不能取得用户访问票据。
- 控制流重连后可以从完整快照恢复一致配置。
- Agent 票据只适用于一个当前 Runtime 目标和一种访问能力。
- 配置或凭据变化会使相关认证缓存失效。

## Agent 控制与访问

Agent 以当前 Codespace CR 和 Pod 身份建立控制流。生命周期命令绑定操作版本，日志使用独立上传流，避免构建输出阻塞 stop 或 delete。Agent 先把执行阶段和结果原子写入 PVC，再向 Manager 上报；重连时复用已经完成的结果。

Gateway 使用短期票据建立 PTY、SFTP、HTTP Endpoint 或回环端口转发。Dev Container 通过挂载的 Unix socket 调用 `RuntimeEndpointService`；命令行工具只是本地客户端，容器不需要访问 Manager 网络端口。

### 实现验收点

- Agent 重连不会重复执行已经持久确认的阶段。
- 日志背压不会阻止控制命令传递。
- 访问票据不能跨 Runtime、Pod、目标版本或能力复用。
- Dev Container 无需网络访问 Manager 即可增删和查询 Endpoint。

## 错误与重试

接口使用标准 RPC 状态区分参数、认证、权限、对象、状态冲突和暂时不可用。错误文本说明失败对象与阶段，不维护一套重复的业务错误枚举。写操作通过操作版本、资源 UID、Metadata 代数或稳定资源键实现幂等。

所有跨组件连接都具有应用层身份。流式接口限制消息大小、空闲时间和缓冲；关闭时先停止接收新请求，再在有限时间内释放已有连接。

### 实现验收点

- 同类失败在不同服务中使用一致的 RPC 状态。
- 错误与普通日志不包含 Token、Secret、私钥或内部目标地址。
- 网络重试不会创建第二个操作、Runtime 或命令执行。
- 慢客户端和关闭中的连接不会无限占用资源。
