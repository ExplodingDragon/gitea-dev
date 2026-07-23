# Codespace 实施缺口评估

本文件记录按 `src` 目标设计对 `gitea`、`codespace-proto-go`、`codespace` 当前实现的对照结果，供后续审阅和排期使用。本次评估只标记目标设计下尚未闭环的实现项，不降低 `src` 文档中的目标范围。

## 总体结论

当前控制面和协议面完成度较高，主要缺口集中在 `codespace` 的 Manager/Gateway/Runtime 实际数据面。现有代码已经包含 operation worker、本地状态恢复、库存上报、HTTP Gateway 鉴权骨架，但用户 HTTP/WebSocket/SSH 流量还没有真正转发到 Runtime，脚本契约、Runtime Token、Runtime HTTP API helper、内部 SSH 校验也尚未闭环。

`gitea` 侧已经覆盖大部分目标能力，后续重点应放在与 `codespace` 真实链路对接后的边界测试和小范围修正。

## 已基本实现

- `codespace-proto-go` 的 ManagerService RPC 列表与 `src/rpc-spec.md` 对齐，请求里的 `protocol_version` 都位于字段 1，并有协议字段测试覆盖。
- `gitea` 已实现 Manager 注册/声明、Fetch/Finalize/Log/Metadata/Token/Git SSH/Open Token/Public Endpoint/SSH Auth/Session Revalidate/Inventory/Runtime Transition 等服务与 RPC handler。
- `gitea` 已有 codespace 集成测试，覆盖生命周期主流程、token API 策略、inventory 状态机等。
- `codespace` 的 Manager agent 已实现注册后的 declare、inventory、FetchOperations、租约、create/resume/stop/delete/finalize、idle stop、runtime transition、状态文件恢复等核心骨架。
- HTTP Gateway 已实现 open token、session、公开 Endpoint 校验、revalidate、来源校验、Cookie 处理和并发限制。

## 主要未实现或未闭环

1. Gateway HTTP/WebSocket 还没有真正代理到 Runtime。

   设计要求是 Endpoint HTTP 反向代理和 WebSocket 升级到 Runtime。当前 `handleGatewayWorkspace` 和 `handleGatewayPublicEndpoint` 鉴权成功后返回授权 JSON，没有连接 Runtime upstream。这是优先级最高的缺口，因为用户打开 workspace 或 Endpoint 后还不能使用实际服务。

2. Gateway SSH 只是监听并关闭连接。

   当前 SSH listener 接受连接后直接关闭。目标设计要求外部 SSH 认证、调用 `VerifySSHPublicKey`、连接 Runtime 内部 sshd、转发 channel、定期 revalidate、限流退避。Gitea 侧 RPC 已有，Manager/Gateway 侧数据面还未实现。

3. Runtime HTTP API 只提供健康检查，没有 helper 接口。

   当前 Runtime API 只有根路径和 `/api/healthz`。目标设计要求 Runtime Token、来源实例校验、Git SSH Key helper、Endpoint 增删改 helper。现在 Runtime 还不能通过受控 helper 调用 Manager 并间接完成 `EnsureCodespaceGitSSHKey` 或 Endpoint 发布。

4. 脚本契约没有落到代码。

   `src/builtin-scripts.md` 要求 `init/prepare/activate`、共享环境、结果文件、内置直接脚本和 devcontainer 示例。当前 Incus bootstrap 是 Go 内嵌的最小 clone 脚本，可以完成基础仓库准备，但没有脚本阶段、结果读取、ready 校验、Git SSH fallback、devcontainer 示例目录。

5. Runtime Token 与实例来源绑定未实现。

   目标设计要求 Manager 生成 Runtime Token、持久化 verifier、按 Incus source IP 和 instance identity 绑定 Runtime HTTP API。当前本地凭据只有 Manager ID/Secret，未看到 Runtime Token verifier、实例来源校验和 token 文件写入流程。

6. 内部 SSH 与 host key 体系未闭环。

   Gitea 已保存并展示 Gateway SSH host key 字段，Manager config 也有字段，但 `codespace` 还没有生成和持久化对外 host private key、内部 client key，也没有 activate 后的内部 SSH 连通和 host key 指纹校验。示例配置仍需要手工填写 fingerprint。

7. Incus provisioner 仍是最小实现。

   当前固定创建 `images:debian/12`，缺少模板/tag 映射、资源规格、通信网卡/IP 唯一映射、实例 identity、工作目录、实际 remote、路由快照等目标设计要求。现有 provisioner 抽象可以保留，暂时不需要为了未来 backend 做额外扩展，但 Incus 本身还需要补全。

8. 根工作区与三模块目标不一致。

   根 `go.work` 当前只包含 `./gitea`。既然 `codespace-proto-go` 和 `codespace` 已恢复为有效实现目录，根工作区应重新体现三模块联动开发，否则本地开发和验证容易遗漏 Manager/Gateway 与协议模块。

## 测试缺口

- `gitea` 单元和集成测试已经较充分，后续重点是补真实链路边界，而不是重写已有服务层测试。
- `codespace` 目前多是单元测试，缺少能证明“真的打开 Runtime 服务”的端到端测试。
- 需要补 `gitea + codespace manager + dummy/incus` 的端到端测试，覆盖 open 后实际代理、public endpoint、SSH auth/连接、Runtime helper、manager 重启恢复。
- Gitea 测试必须继续参考 `gitea/docs/testing.md` 和现有测试方式，不直接使用 `go test` 绕过仓库规范。

## 建议实现顺序

1. 先补 `codespace` 数据面：HTTP/WebSocket 代理、Runtime Metadata 到本地 upstream 路由、Runtime API helper、Runtime Token。
2. 再补脚本契约：内置脚本、结果文件、ready 校验、Git SSH fallback、devcontainer 示例。
3. 然后补 Gateway SSH：外部认证、内部 sshd 连接、channel 转发、revalidate、限流退避。
4. 最后完善 Incus 模板、资源、通信网卡、实例 identity 和端到端测试。

`gitea` 侧暂时以补边界测试和修对接问题为主，不建议对现有服务层做大范围重构。
