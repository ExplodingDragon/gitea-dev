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

Gitea 接口只表达 Codespace 业务语义；Kubernetes、Pod 和缓存后端留在 Manager 与内部协议。平台使用同一个二进制交付各组件，但 Manager、Agent、Gateway、Cache 和 Runtime 命令运行在不同进程或 Pod 中，仍需要明确的进程间通信。生成代码和调用端统一使用 Connect v2，通过 HTTP 传输适配器承载 Connect/gRPC，复用双向流、取消、背压、消息限制和 mTLS，避免维护额外的自定义传输格式。身份从请求元数据传入认证上下文，协议版本在接收消息时校验，业务方法直接接收和返回 Proto 消息。

### 实现验收点

- 每个请求都能从认证上下文和消息确定调用者与目标。
- 未知协议版本返回明确错误，不进入业务处理。
- Gitea 协议不包含 Kubernetes 调度或容器网络配置。
- Gitea 与 Codespace 使用同一已发布协议版本。
- 公共协议模块只生成 `codespace/v1`，内部协议只能由 Codespace 导入。

## Gitea 控制面

Manager 声明自身、领取和完成操作，上报日志、Runtime 信息与资源清单，并按需请求运行材料。领取、续期、日志和完成请求携带当前操作版本；running 状态的 Runtime 报告携带建立当前实例的 create/resume 版本。Runtime UUID 由 Manager 在领取 create 后生成，Gitea 通过数据库唯一约束完成一次绑定。

没有任务的轮询返回正常空结果。高频成功轮询可以省略普通 HTTP 请求日志，错误仍保留诊断信息。

ManagerService 的请求和响应统一限制为 32 MiB，两端直接使用公共协议包中的常量。传输限制与 Kubernetes 单个持久化对象的大小限制分别生效：前者容纳资源清单等批量消息，后者控制资源保存成本。

### 实现验收点

- Manager 凭据只能操作对应的 Manager 记录。
- 领取、续期、日志、Runtime 报告和完成都校验当前绑定与版本。
- 每个 Runtime UUID 只绑定一个 Codespace，未绑定请求可以正常排队。
- 运行材料按请求时的用户和仓库权限生成。
- create/resume 完成不依赖展示缓存命中，后续 Runtime 报告必须匹配持久化的运行实例版本。
- 两端接受相同大小范围的 RPC 消息，资源保存仍执行自己的对象大小校验。

## 组件与 Agent

Gateway 和 Cache 使用各自身份连接 Manager，并接收版本化配置；发现版本缺口时重新获取完整快照。Gateway 建立用户流前请求业务授权和短期 Agent 票据。Cache 按配置限制上游、缓存范围和维护动作。

Agent 以当前 Codespace CR 和 Pod 身份建立控制流。生命周期命令绑定操作版本，日志使用独立流，避免大量输出阻塞控制命令。Agent 先把阶段和结果原子写入 PVC，再向 Manager 上报，重连时复用已经完成的结果。

块卷挂载前使用 `PrepareVolume` 请求确认。Manager 根据 mTLS 身份读取当前 CR、Pod 和 PVC，并校验操作许可；首次请求持久记录格式化已开始后返回成功，挂载后确认请求把状态更新为就绪。这个独立请求发生在 PVC 日志可用之前，使卷初始化也能获得持久化保护，Agent 仍只访问 Manager 服务。

Cache 控制流用递增序号关联请求和确认。Manager 首次获取或后续续约对应 Lease 成功后返回正的许可时长；后续独立配置推送的许可时长为零。客户端仅消费一次对应发送记录，并用发送时间计算到期，避免响应延迟或重放延长旧执行者的权限。

Gateway 使用按能力签发的短期票据访问 PTY、SFTP、HTTP Endpoint 或回环端口。Dev Container 通过挂载的 Unix socket 管理 Endpoint，不需要访问 Manager 网络端口。

内部 Proto 生成到 `codespace/internal/rpc`，从 Go 包边界上阻止其他仓库依赖运行实现。需要跨越 Gitea 与 Manager 的业务类型由公共协议定义，内部协议直接引用这些类型，避免维护重复消息。

### 实现验收点

- Gateway 与 Cache 分别使用绑定自身角色的身份和能力。
- 控制流重连后可以从完整快照恢复配置。
- 控制流建立失败和运行中断都进入现有重连流程，取消请求会释放连接。
- Agent 票据只适用于一个 Runtime、Pod、目标版本和访问能力。
- 日志背压不会阻止控制命令。
- Dev Container 可以通过本地 socket 增删和查询 Endpoint。
- 公共业务类型在公共协议中只有一份定义。
- `PrepareVolume` 只接受当前身份和操作许可；格式化请求重复调用明确失败，挂载成功确认可重复提交。
- Cache 许可来自一次成功获取或续约租约的对应确认；发送、等待和服务运行均受许可到期控制。

## 错误、重试与关闭

接口使用标准 RPC 状态区分参数、认证、权限、对象、状态冲突和暂时不可用。写操作通过操作版本、资源 UID、Metadata 代数或稳定资源键实现幂等。

请求校验错误明确标记为参数错误，已知业务冲突映射到对应状态。数据库、缓存和其他未分类内部故障返回脱敏的 Internal，服务端记录诊断原因；取消和超时保留各自的状态。FailureDetail 只携带调用端实际使用的分类，代数和日志偏移的一致性由服务端校验以及成功响应共同保证。

所有跨组件连接都具有应用层身份。流式接口限制消息大小、空闲时间和缓冲；组件关闭时先停止接收新请求，再在有限时间内释放已有连接。

### 实现验收点

- 同类失败在不同服务中使用一致的 RPC 状态。
- 客户端错误不暴露内部查询和目标地址，错误与诊断日志均不输出 Token、Secret 或私钥。
- 网络重试不会创建第二个操作、Runtime 或命令执行。
- 慢客户端和关闭中的连接不会无限占用资源。
