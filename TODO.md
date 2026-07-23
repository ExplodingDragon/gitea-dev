# Codespace 实施缺口评估

本文件记录按 `src` 目标设计对 `gitea`、`codespace-proto-go`、`codespace` 当前实现的对照结果，供后续审阅和排期使用。本次评估只标记目标设计下尚未闭环的实现项，不降低 `src` 文档中的目标范围。

## 总体结论

当前控制面和协议面完成度较高，主要缺口集中在 `codespace` 的 Manager/Gateway/Runtime 实际数据面。现有代码已经包含 operation worker、本地状态恢复、库存上报、HTTP Gateway 鉴权、基于本地路由的 HTTP/WebSocket 反向代理、Runtime Token verifier、Endpoint CRUD 到本地 Gateway 路由的受控入口、Incus Runtime API 来源地址绑定、ready Runtime Metadata 基准快照持久化、Endpoint 变化后的完整 metadata 一次性上报，以及 Git SSH 公钥 helper 到 Gitea RPC 的转发；脚本契约、内部 SSH 校验、Gateway SSH、Runtime Metadata 后台发布任务和 WebSocket 长连接复检仍未闭环。

`gitea` 侧已经覆盖大部分目标能力，后续重点应放在与 `codespace` 真实链路对接后的边界测试和小范围修正。

## 已基本实现

- `codespace-proto-go` 的 ManagerService RPC 列表与 `src/rpc-spec.md` 对齐，请求里的 `protocol_version` 都位于字段 1，并有协议字段测试覆盖。
- `gitea` 已实现 Manager 注册/声明、Fetch/Finalize/Log/Metadata/Token/Git SSH/Open Token/Public Endpoint/SSH Auth/Session Revalidate/Inventory/Runtime Transition 等服务与 RPC handler。
- `gitea` 已有 codespace 集成测试，覆盖生命周期主流程、token API 策略、inventory 状态机等。
- `codespace` 的 Manager agent 已实现注册后的 declare、inventory、FetchOperations、租约、create/resume/stop/delete/finalize、idle stop、runtime transition、状态文件恢复等核心骨架。
- HTTP Gateway 已实现 open token、session、公开 Endpoint 校验、revalidate、来源校验、Cookie 处理、并发限制，以及认证 workspace / 公共 Endpoint 的 HTTP upstream 代理。
- `codespace` 已实现 Runtime Token 生成、SHA-256 verifier 持久化、create/resume 写入实例内固定 Gitea/Runtime Token 文件、Runtime API Bearer 鉴权、Incus source IP 到当前 codespace 的通信网卡唯一绑定、带 body 请求的 JSON content type 校验、Git SSH 公钥 helper 的 OpenSSH 公钥解析和 `EnsureCodespaceGitSSHKey` RPC 转发；该 helper 只有本地 active create/resume 时继续处理。Endpoint `GET/POST/PUT/DELETE` 已提交到本地快照和 Gateway route store，必填 `public`、固定 JSON schema、拒绝 `upstream_host` 等未知字段、scheme/port 边界、POST 冲突/幂等、PUT missing、DELETE missing、active stop/delete 与 cleanup pending 的 `409 operation_conflict`、单 Codespace 64 个 Endpoint 上限、启动状态文件超限拒绝和 `429 endpoint_limit_exceeded` 已覆盖；create/resume ready 上报时会保存 boot/internal SSH 快照，Endpoint 实际变化后会用该快照和当前 endpoints 构造完整 Runtime Metadata 并调用 `ReportRuntimeMetadata`，Gitea metadata 临时上报失败不阻塞本地成功，metadata generation 到顶时不会提交新的磁盘快照或内存路由。

## 主要未实现或未闭环

1. Runtime Endpoint 路由来源和长连接复检还没有闭环。

   Gateway 已具备本地 route store 和 HTTP reverse proxy，认证 workspace、公共 Endpoint 和公共 WebSocket upgrade 代理路径已有单元测试。Runtime API 已能用 Runtime Token 提交 Endpoint 并持久化后重建到 route store，也会在已有 ready 快照时触发一次完整 Runtime Metadata 上报。缺口是唯一后台发布任务、失败重试、stale/generation conflict 处理与生命周期阶段门禁还没有和 Manager worker 完整合并，WebSocket 和长时间 HTTP 也还缺周期复检与关闭测试。

2. Gateway SSH 只是监听并关闭连接。

   当前 SSH listener 接受连接后直接关闭。目标设计要求外部 SSH 认证、调用 `VerifySSHPublicKey`、连接 Runtime 内部 sshd、转发 channel、定期 revalidate、限流退避。Gitea 侧 RPC 已有，Manager/Gateway 侧数据面还未实现。

3. Runtime HTTP API 仍缺完整生命周期门禁和脚本侧 Git SSH 落地。

   当前 Runtime API 已有 Endpoint 增删改查 helper、Runtime Token Bearer 鉴权，以及 `PUT /git-ssh-key` 到 `EnsureCodespaceGitSSHKey` 的公钥解析和 RPC 转发；Incus 后端会把请求 source IP 解析到配置的通信网卡，并要求唯一匹配同一 Codespace 后才允许 Endpoint 与 Git SSH Key helper 继续处理；active create/resume 与 active stop/delete 的基础门禁已覆盖。缺口是 Git SSH 私钥生成/校验、known_hosts 写入、严格 Host Key 配置、不可恢复失败收敛、stopped/running 阶段矩阵和 metadata 发布任务。

4. 脚本执行契约没有落到代码。

   `src/builtin-scripts.md` 要求 `init/prepare/activate`、共享环境、结果文件、内置直接脚本和 devcontainer 示例。当前配置层已经支持 `scripts.init/start/resume`，并校验三个入口全为 `builtin` 或全为本地绝对普通文件。当前 Incus bootstrap 仍是 Go 内嵌的最小 clone 脚本，可以完成基础仓库准备，但还没有脚本发布、阶段执行、结果读取、共享环境、ready 校验、Git SSH fallback、devcontainer 示例目录。

5. Runtime Token 与实例来源绑定已完成当前 Incus source IP 绑定，重启和文件 owner 仍未闭环。

   Manager 已在 create/resume 生成 Runtime Token、只持久化 SHA-256 verifier，并把当前 Gitea/Runtime Token 写入实例内固定 `0600` 文件；Runtime API 已用 Bearer token 反查 Codespace，并在 Incus 后端按当前实例状态中的指定通信网卡 source IP 唯一映射到同一 Codespace。缺口是 Token 文件 owner 来自 init 输出、普通重启不轮换校验和崩溃边界重放还没有完整实现。

6. 内部 SSH 与 host key 体系未闭环。

   Gitea 已保存并展示 Gateway SSH host key 字段，Manager config 也有字段，但 `codespace` 还没有生成和持久化对外 host private key、内部 client key，也没有 activate 后的内部 SSH 连通和 host key 指纹校验。示例配置仍需要手工填写 fingerprint。

7. Incus provisioner 仍是最小实现。

   当前固定创建 `images:debian/12`，已支持通信网卡/IP 唯一映射用于 Runtime API 来源绑定，也会在 Incus provisioner 初始化时校验服务端可达、trusted、非 public-only、非集群和配置 project 匹配；但仍缺少模板/tag 映射、资源规格、工作目录、实际 remote、路由快照等目标设计要求。现有 provisioner 抽象可以保留，暂时不需要为了未来 backend 做额外扩展，但 Incus 本身还需要补全。

8. 协议仓远程版本同步需要持续核对。

   当前设计不依赖根 `go.work`。`codespace-proto-go` 推送后，`gitea` 和 `codespace` 都应更新到同一个 GitHub 伪版本；这样两个实现仓可以独立测试，也能避免本地工作区覆盖远程依赖导致提交后才发现版本不一致。

## 测试缺口

- `gitea` 单元和集成测试已经较充分，后续重点是补真实链路边界，而不是重写已有服务层测试。
- `codespace` 目前多是单元测试，缺少能证明“真的打开 Runtime 服务”的端到端测试。
- 需要补 `gitea + codespace manager + dummy/incus` 的端到端测试，覆盖 open 后实际代理、public endpoint、SSH auth/连接、Runtime helper、manager 重启恢复。
- Gitea 测试必须继续参考 `gitea/docs/testing.md` 和现有测试方式，不直接使用 `go test` 绕过仓库规范。

## 建议实现顺序

1. 先补 `codespace` 数据面：Runtime Metadata 后台发布任务、长连接周期复检、Runtime API 完整生命周期门禁和 Gateway SSH。
2. 再补脚本契约：内置脚本、结果文件、ready 校验、Git SSH fallback、devcontainer 示例。
3. 然后补 Gateway SSH：外部认证、内部 sshd 连接、channel 转发、revalidate、限流退避。
4. 最后完善 Incus 模板、资源、通信网卡、实例 identity 和端到端测试。

`gitea` 侧暂时以补边界测试和修对接问题为主，不建议对现有服务层做大范围重构。
