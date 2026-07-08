# Gitea Codespace 最终设计

## 目标

Codespace 是 Gitea 内置的远程开发环境入口。

| 主体 | 职责 |
| --- | --- |
| Gitea | repository、ref 与 commit 校验；用户身份与权限（复用 `CanRead(unit.Code)` 统一入口）；codespace 生命周期状态；Codespace Manager 注册与认证（参考 Actions runner 注册模式）；Gitea access token 签发、绑定、删除保护与吊销；Gateway Open Token 签发与校验；SSH 认证判定；operation 日志归档（基于 DBFS） |
| Codespace Manager | Runtime Instance 创建、恢复、停止、删除；Runtime Instance 类型、镜像、资源配置；Runtime Token 生成与校验；Runtime HTTP API；Runtime Metadata 上报；Endpoint upstream 解析与代理 |
| Codespace Gateway（Manager deployment 内组件） | 用户 Endpoint 接入；用户 SSH 接入；Gateway session 管理；通过 Manager 身份调用 Gitea 校验 Gateway Open Token 与 SSH 认证；到 Runtime Instance 的 SSH channel 转发 |

Gitea 不参与运行时选型，也不操作 Incus/Docker 等运行后端。运行时专有配置和 Runtime Token 均由 Manager 管理。

## 架构

```mermaid
flowchart LR
    User["User<br/>Browser / SSH client"]

    subgraph Gitea["Gitea"]
        Web["Web UI / Web routes"]
        ManagerRPC["ManagerService<br/>Connect over HTTP"]
        Service["Codespace service<br/>state / permission / token / logs"]
        Cron["Codespace cron jobs"]
        DB[("Database<br/>codespace tables")]
        DBFS[("DBFS<br/>codespace logs")]
    end

    subgraph ManagerDeployment["Codespace Manager deployment"]
        Manager["Codespace Manager<br/>worker / scheduler / Runtime HTTP API"]
        Gateway["Codespace Gateway<br/>Endpoint / SSH ingress"]
    end

    Runtime["Runtime Instance<br/>init.sh / sshd / services"]

    User -->|"create / open / stop / resume / delete"| Web
    User -->|"Endpoint / SSH"| Gateway

    Web --> Service
    Service --> DB
    Service --> DBFS
    Cron --> Service

    Manager -->|"ManagerService RPC"| ManagerRPC
    ManagerRPC --> Service

    Runtime -->|"Runtime HTTP API<br/>CODESPACE_RUNTIME_TOKEN"| Manager
    Manager -->|"create / resume / stop / delete"| Runtime

    Gateway -->|"Open token / SSH auth<br/>via Manager identity"| ManagerRPC
    Gateway -->|"Endpoint proxy / SSH channel"| Runtime
```

架构约束：

**部署边界**
- Codespace 部署模型为 Gitea 单实例。
- Gitea 与 Manager 之间只通过 ManagerService RPC 通信。
- Manager 是运行侧唯一的 Gitea 注册身份。
- Gateway 是 Manager deployment 内部组件，通过 Manager 身份调用 Gitea。

**数据边界**
- Gitea 只保存状态、权限、token 绑定和日志元数据。
- Incus、Docker、镜像、资源规格、网络等均为 Manager 内部实现。
- Runtime HTTP API 只在 Manager 私有网络内开放。

**流量边界**
- 用户 Endpoint / SSH 流量不经过 Gitea，直接到 Gateway。
- Gateway 用户流量仅在鉴权时回到 Gitea。
- Runtime Instance 可访问 Gitea 标准 Git HTTP 和 repository web URL，但不直接调用 codespace 专用内部接口。

**Runtime 边界**
- Runtime Instance 只通过 Runtime HTTP API 调用 Manager。
- Endpoint upstream 只由 Gateway 和 Manager 解析。

用户 Endpoint、WebSocket 和 SSH channel 是长连接流量，不适合让 Gitea Web 进程代理。Manager/Gateway 与 Runtime Instance 在同一部署内，能直接解析 upstream 和内部 SSH 连接，Gitea 保持为短路径鉴权与状态权威。

核心通信流程：

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Gitea
    participant Manager as Codespace Manager
    participant Gateway as Codespace Gateway
    participant Runtime as Runtime Instance

    User->>Gitea: POST /{owner}/{repo}/codespace
    Gitea->>Gitea: validate repo / ref / permission
    Gitea->>Gitea: create codespace + create operation
    Manager->>Gitea: FetchOperation
    Gitea-->>Manager: create operation payload
    Manager->>Gitea: RequestGiteaToken
    Manager->>Runtime: create runtime + inject init env
    Runtime->>Manager: Runtime HTTP API boot / endpoints
    Manager->>Gitea: UpdateLog / ReportRuntimeMetadata / UpdateOperation done
    Gitea-->>User: GET /codespace/{uuid}

    User->>Gitea: POST /codespace/{uuid}/open endpoint_id
    Gitea->>Gitea: validate state / permission / Endpoint metadata
    Gitea-->>User: 302 Gateway URL with open_token
    User->>Gateway: open Endpoint
    Gateway->>Gitea: ValidateOpenToken via Manager identity
    Gitea-->>Gateway: allowed
    Gateway->>Runtime: proxy to resolved upstream
```

## 术语

参见[术语页](glossary.md) 获取完整术语表和命名规则。

## 核心原则

- Gitea 只负责授权、状态、日志、token 绑定和跳转入口。
- Codespace 复用 Gitea 现有用户、组织、仓库、权限（`CanRead(unit.Code)` 统一入口）、access token（`models/auth/access_token.go`）、SSH key、TOTP、登录限制、git、Pull Request 和 Actions task claim 模型。
- 用户拥有 repository code-read 权限就可以创建 codespace。
- codespace 使用创建用户自己的 access token 访问 repository，是用户私有对象而非 repository 共享资源。
- Manager 不能用自己身份访问 repository 内容。
- Runtime git 访问使用基于创建用户当前权限签发的 Gitea access token，只走 Git HTTP(S)。
- create、resume、stop、delete 必须幂等。
- 同一 codespace 同一时刻只能有一个 active operation。
- codespace 复用 Gitea 现有 notifier、rate limiter 和 access token 模型。
- create 失败后不在同一个 codespace 对象上重新创建。失败后 Runtime、token、日志和 generation 可能已部分产生，不在同一对象上重建可避免旧状态与新初始化混淆。
- 失败是终态，除 delete 外不能恢复。
- delete 成功后物理删除 codespace、operation 和日志。
- Manager 的并发容量由 Manager 自行控制并以 `capacity_available` 上报，Gitea 不维护运行容量计数。
