# RPC 接口

本文定义跨进程职责、安全边界和重试语义。Gitea 与 Manager 的公共接口以 `codespace-proto-go` 为准；Manager、Agent、Gateway、Cache 与 Runtime 命令之间的接口由 `codespace/internal/rpc` 维护。两类接口分别归属跨仓库业务边界和 Codespace 内部运行边界，因此可以独立演进。

## 服务边界

| 服务                     | 调用方向                | 协议归属             | 职责                                                   |
| ------------------------ | ----------------------- | -------------------- | ------------------------------------------------------ |
| `ManagerService`         | Manager → Gitea         | `codespace-proto-go` | Manager 身份、生命周期、运行材料、日志、状态和访问判定 |
| `ComponentService`       | Gateway/Cache → Manager | Codespace 内部       | 组件配置、访问授权、Agent 票据和 Cache 维护许可        |
| `AgentControlService`    | Agent ↔ Manager        | Codespace 内部       | Runtime 命令、结果、心跳和日志                         |
| `AgentAccessService`     | Gateway ↔ Agent        | Codespace 内部       | PTY、SFTP、HTTP 和回环端口转发                         |
| `RuntimeEndpointService` | Dev Container → Agent   | Codespace 内部       | 通过本地 Unix socket 管理 HTTP Endpoint                |

Gitea 接口只表达 Codespace 业务语义；Kubernetes、Pod 和缓存后端留在 Manager 与内部协议。平台使用同一个二进制交付各组件，但 Manager、Agent、Gateway、Cache 和 Runtime 命令运行在不同进程或 Pod 中，仍需要明确的进程间通信。统一使用 Connect/gRPC 可以复用双向流、取消、背压、消息限制和 mTLS，避免维护额外的自定义传输格式。

### 实现验收点

- 每个请求都能从认证上下文和消息确定调用者与目标。
- 未知协议版本返回明确错误，不进入业务处理。
- Gitea 协议不包含 Kubernetes 调度或容器网络配置。
- Gitea 与 Codespace 使用同一已发布协议版本。
- 公共协议模块只生成 `codespace/v1`，内部协议只能由 Codespace 导入。

## Gitea 控制面

Manager 声明自身、领取和完成操作，上报日志、Runtime 信息与资源清单，并按需请求运行材料。所有操作请求携带当前版本；Runtime 报告同时绑定 Manager 和 Runtime 身份。Runtime UUID 由 Manager 在领取 create 后生成，Gitea 通过数据库唯一约束完成一次绑定。

没有任务的轮询返回正常空结果。高频成功轮询可以省略普通 HTTP 请求日志，错误仍保留诊断信息。

### 实现验收点

- Manager 凭据只能操作对应的 Manager 记录。
- 领取、续期、日志、Runtime 报告和完成都校验当前绑定与版本。
- 每个 Runtime UUID 只绑定一个 Codespace，未绑定请求可以正常排队。
- 运行材料按请求时的用户和仓库权限生成。

## 组件与 Agent

Gateway 和 Cache 使用各自身份连接 Manager，并接收版本化配置；发现版本缺口时重新获取完整快照。Gateway 建立用户流前请求业务授权和短期 Agent 票据。Cache 按配置限制上游、缓存范围和维护动作。

Agent 以当前 Codespace CR 和 Pod 身份建立控制流。生命周期命令绑定操作版本，日志使用独立流，避免大量输出阻塞控制命令。Agent 先把阶段和结果原子写入 PVC，再向 Manager 上报，重连时复用已经完成的结果。

Gateway 使用按能力签发的短期票据访问 PTY、SFTP、HTTP Endpoint 或回环端口。Dev Container 通过挂载的 Unix socket 管理 Endpoint，不需要访问 Manager 网络端口。

内部 Proto 生成到 `codespace/internal/rpc`，从 Go 包边界上阻止其他仓库依赖运行实现。需要跨越 Gitea 与 Manager 的业务类型由公共协议定义，内部协议直接引用这些类型，避免维护重复消息。

### 实现验收点

- Gateway 与 Cache 分别使用绑定自身角色的身份和能力。
- 控制流重连后可以从完整快照恢复配置。
- Agent 票据只适用于一个 Runtime、Pod、目标版本和访问能力。
- 日志背压不会阻止控制命令。
- Dev Container 可以通过本地 socket 增删和查询 Endpoint。
- 公共业务类型在公共协议中只有一份定义。

## 错误、重试与关闭

接口使用标准 RPC 状态区分参数、认证、权限、对象、状态冲突和暂时不可用，不维护重复的业务错误枚举。写操作通过操作版本、资源 UID、Metadata 代数或稳定资源键实现幂等。

所有跨组件连接都具有应用层身份。流式接口限制消息大小、空闲时间和缓冲；组件关闭时先停止接收新请求，再在有限时间内释放已有连接。

### 实现验收点

- 同类失败在不同服务中使用一致的 RPC 状态。
- 错误和日志不包含 Token、Secret、私钥或内部目标地址。
- 网络重试不会创建第二个操作、Runtime 或命令执行。
- 慢客户端和关闭中的连接不会无限占用资源。
