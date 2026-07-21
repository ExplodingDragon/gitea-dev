# DONE

本文记录当前工作区已经完成并准备提交的事项，便于审阅提交内容和后续验证。这里不把尚未实现的目标写成完成项。

## 设计文档

- 更新 `src` 下 Codespace 目标设计文档，保持为单一整体目标设计，不拆成多版本说明。
- 明确 Gitea、Manager、Gateway、运行时、数据模型、RPC、生命周期、内置脚本之间的职责边界和协作流程。
- 明确 `devcontainer` 是自定义开发环境能力的使用案例，用来说明平台可以承载用户自定义环境，不表示 Go 代码侧要内置 devcontainer 解析或构建能力。
- 明确协议版本字段是所有 ManagerService 请求的第一个字段。该设计用于让 Manager 和 Gitea 在写入状态前先确认协议是否匹配。
- 删除过时表述，补充容易产生歧义的“设计如此”说明和原因，避免后续实现把目标设计退回到旧方案。
- 为设计章节补充“实现验收点”，把设计意图转成可检查、可测试的行为。

## codespace-proto-go

- 更新 `codespace.v1` proto，补齐 ManagerService 目标协议中的请求、响应和错误模型。
- 所有 ManagerService 请求都包含 `protocol_version`，并将该字段固定为字段号 `1`。
- 重新生成 Go 代码和 Connect 客户端/服务端代码。
- 增加协议结构测试，验证服务名和 ManagerService 请求的协议版本字段位置。

## gitea

- 增加 Codespace 数据模型，覆盖实例、运行时状态、操作队列、日志、Manager 注册信息、访问授权和 SSH 相关状态。
- 增加 Codespace 服务层，负责实例生命周期、操作入队、Manager 声明、运行时元数据、日志写入、访问授权、Token 与 SSH 登录校验。
- 增加 ManagerService Connect API，支持 Manager 注册、声明能力、拉取操作、完成操作、写入日志、同步运行时元数据、签发访问 Token、校验 Git SSH、获取实例 SSH 信息、公开端点访问校验、Gateway 打开流程和浏览器会话恢复。
- 在 ManagerService 入口增加协议版本检查，确保协议不匹配时在查询和写入业务状态前返回硬错误。
- 增加 Codespace Web 路由、设置页、管理入口和页面模板，使用户、组织和管理侧能够查看和治理 Codespace 配置。
- 将 Codespace 能力接入 Gitea 路由初始化、导航、仓库转移清理和 SSH 公钥授权流程。
- 增加 Gitea 侧测试，覆盖协议不匹配、模型、服务、Web 路由和 Manager API 的核心行为。

## codespace

- 重构 Manager 进程启动流程，使用配置文件、状态目录、监听器、健康检查和注册流程组成可运行的管理进程。
- 增加状态目录锁、根状态文件、凭据文件、Codespace 状态文件和原子写入能力，确保本地状态可恢复且同一状态目录只能由一个 Manager 使用。
- 增加 Manager Agent，与 Gitea ManagerService 通信，发送协议版本，处理协议不匹配硬错误，并保存 Gitea 返回的 Gateway 和 Web 地址配置。
- 增加 Gateway 控制面、访问缓存、浏览器会话、恢复 Cookie、源站校验、反向代理、响应头规范化和打开入口处理。
- Gateway 支持按主机绑定识别 Codespace 和端点，保留 `/.gitea-codespace/open` 作为打开入口，并通过 Gitea 签发的 code 建立浏览器会话。
- Gateway 对 Service Worker、来源头、保留 Cookie、伪造转发头、响应 `Set-Cookie`、`Location` 和 `Service-Worker-Allowed` 做统一处理，避免代理目标绕过 Gateway 的访问边界。
- 增加 provisioner 抽象和 dummy/incus 实现，使运行时创建、停止、销毁和端点发现由 Manager 统一调度。
- 增加 Manager、Gateway、状态文件、配置、监听器、注册和 provisioner 测试，覆盖当前实现的主要行为。

## 已执行验证

- `codespace-proto-go`: `go test ./codespace/v1`
- `gitea`: `go test ./models/codespace ./services/codespace ./routers/web/codespace ./routers/api/codespace/manager`
- `codespace`: `go test ./...`
- 根项目、`gitea`、`codespace-proto-go`、`codespace`: `git diff --check`
