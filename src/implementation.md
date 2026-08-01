# 实施

## 代码边界

Gitea 负责用户页面、权限、数据库状态、ManagerService 和审计日志。相关代码按现有 Gitea 分层放在 `routers`、`services/codespace`、`models/codespace` 与 `modules/codespace`，Web handler 和 ManagerService handler 分别位于 Web 与 API/Connect 入口。路由层处理输入、认证和响应，服务层推进事务，模型层保存数据结构与查询。

`codespace` Manager 负责 Incus、原生 Dev Container 运行时、Gateway 和本地恢复。公开的 `devcontainer` 包处理配置、合并、锁文件与结构化环境，`devcontainer/docker` 使用 Docker、Compose 和 Feature API 创建并恢复环境；`internal/devcontainerruntime` 注入 Codespace 的 Git、Web IDE、运行时挂载和 Endpoint 策略；`internal/provisioner` 只处理 Incus 实例与文件/exec API；`internal/runtimecmd` 提供实例内隐藏子命令；`internal/app` 组织控制面 worker、Gateway 与状态持久化。

Runtime Endpoint manifest 是实例内文件协议。Manager 读取并更新本地路由，Runtime 不向 Manager 端口发请求，Gitea 也不解析该文件。这样控制面、运行后端和用户接入各自只有一个数据来源。

### 实现验收点

- [x] Gitea 的 Web、RPC、服务和模型依赖方向与现有项目一致。
- [x] Incus 与 Docker 实现只位于 Manager，Gitea 不包含运行后端驱动。
- [x] Dev Container 公开包只处理通用配置与运行环境；Codespace 请求、Git、Web IDE 和 Gateway 策略集中在内部适配层。
- [x] Runtime manifest 不注册到 Gitea router，也不要求 Runtime 访问 Manager 端口。

## 共享协议

Gitea 与 Manager 共同依赖 `codespace-proto-go` 中的 `codespace.v1.ManagerService` 生成代码。协议仓只保存 `.proto` 和生成的 Go binding，不保存任一侧业务逻辑。协议仓提交并推送后，两个实现模块在各自 `go.mod` 中引用同一个远程版本，使它们在没有根 `go.work` 时也能独立构建。

ManagerService 使用 Connect。`RegisterManager` 只使用 request body 中的 registration token；其他 RPC 使用 Manager ID 与 Secret header。每个 request 的 `protocol_version` 都在认证后的统一入口、业务读写前校验。路由层只负责 Connect 接入、认证、版本与错误映射，状态事务在服务层完成。

Manager 普通配置与注册状态分开。普通配置只包含部署参数；`register` 严格读取显式 YAML，取得状态目录独占锁并确认尚未注册后，把 Gitea URL、Manager ID、Manager Secret 和 inventory generation 一次原子写入 `node.state_dir/manager-state.json`，registration token 不落盘。`serve` 在发送 RPC 前取得同一把锁并读取完整的 Manager 状态。

### 实现验收点

- [x] Gitea 与 Manager 使用同一个已推送协议版本，并可分别在无 `go.work` 环境编译。
- [x] 除注册外的 RPC 先认证 Manager，再校验 `protocol_version=1`，业务层不会收到不匹配请求。
- [x] 注册身份、Secret、inventory generation 和 Gateway SSH Host Key 不属于普通配置。
- [x] 同一状态目录的第二个 Manager 进程在发送 RPC 前因独占锁失败。
- [x] 显式注册配置错误、已有或损坏 Manager 状态都在发送 RPC 前失败；注册成功以一个 `0600` 的 `manager-state.json` 作为本地提交点。

## 实施基线

本文档集描述整体目标设计，当前功能按一套最终模型实施：

- 用户生命周期为 create、open、resume、stop 和 delete；异步动作统一使用 operation。
- 主状态为 creating、running、stopped、deleting 和 failed；排队、启动、停止、恢复与重建是由 operation 和 Manager 运行态派生的展示状态。
- Gitea 固定仓库、提交、Dev Container 配置、权限和 Secret 授权；Manager 固定外层 Incus 环境并原生实现内部 Dev Container。
- 仓库 Dev Container 配置声明项目 Feature，Manager 加入平台 Web IDE Feature；Gitea 只固定仓库配置选择，不维护另一套个人工具配置。
- create 执行一次固定 bootstrap，然后创建完整 Dev Container 环境；stop 停止完整环境与实例；resume 恢复已经保存的环境；delete 删除 Incus 实例。
- Gateway SSH、Web IDE 与 Endpoint 都读取同一份 Manager 本地环境状态。shell/exec 与 TCP bridge 通过 Incus exec 进入隐藏运行时，SFTP 使用 Incus 文件 API。
- 容量由 Manager 按本地实例、Incus project、worker 和待清理状态计算后上报，Gitea 不推测后端剩余资源。

**设计如此：外层实例和内部开发容器是两个清晰层级。**Incus 提供隔离、持久根存储与管理通道，Dev Container 提供仓库声明的工具、用户和生命周期。固定 bootstrap 只准备外层系统，原生 Go 运行时只管理内部环境，避免出现可替换脚本与另一套恢复协议。

### 实现验收点

- [x] create、stop、resume、delete 在 Gitea operation、Manager state、Incus 与 Docker 环境之间有唯一映射。
- [x] 生产路径只使用原生运行时，不保存可替换生命周期内容或字符串环境状态。
- [x] 单容器与 Compose 使用同一结构化环境模型，Compose 侧车参与 stop/resume。
- [x] SSH、Web IDE 与 Endpoint 不各自解析配置或猜测容器目标。
- [x] 仓库 Feature 随锁定配置解析，平台 Web IDE Feature 随 Manager 配置加入；create payload 不携带用户工具偏好。
- [x] code-server Feature 安装器随 Manager 固定，程序版本由 YAML 配置选择，新建后不自动改变。

## Gitea 测试

Gitea 测试严格使用 `gitea/docs/testing.md` 规定的 Make 入口，不直接执行 `go test`。按变更范围选择：

```bash
cd gitea
make test-backend#<service-or-router-test>
make test-integration#<integration-test>
make fmt
make lint-go
make lint-frontend
```

模型测试覆盖迁移、索引、状态与凭据关系；服务测试覆盖权限、operation 事务、Token、Git SSH、Secret 和删除收敛；RPC 测试覆盖认证、领取、lease、inventory、metadata 与幂等 final；Web 测试覆盖创建、列表、详情、设置和动作；集成测试覆盖 create 到 delete 的跨层闭环。测试写法、fixture、SQLite 初始化和断言风格复用同目录现有代码。

权限测试重点覆盖源仓库和附加仓库 grant、pull request 的目标与来源、Token 和 Git SSH 两条访问路径，以及 stop/resume/delete 后的凭据结果。并发测试只覆盖会影响状态事务与安全边界的提交顺序，不为理论上不存在的分支增加负向测试。

### 实现验收点

- Gitea codespace 变更使用文档规定的 Make 入口完成后端、集成、格式和对应 lint。
- 权限、凭据、状态事务和物理删除都有服务层或集成覆盖。
- 测试使用现有 Gitea fixture 与辅助函数，不为测试写生产临时代码。

## Manager 测试

Manager 普通 Go 测试覆盖 JSONC、配置选择与摘要、变量命名空间、Compose 合并、Feature 顺序、lifecycle、端口属性、环境校验、state 原子持久化、Gateway 认证与路由、operation lease 和恢复。Docker 集成测试覆盖 image、Dockerfile、OCI 与本地 Feature、`runArgs`、`build.options`、Compose 多服务以及 stop/resume；需要镜像下载的测试使用显式入口，普通单元测试不隐式拉取镜像。

Incus 真实 E2E 使用专门入口并串行执行。启动时识别本地 unix socket 或远程 Incus endpoint、信任、project、storage、managed bridge、image、profile 和 agent。可选入口在环境未准备时说明缺失条件并跳过；required 入口把缺失条件作为失败。container 与 VM 都使用真实 `gitea-codespace` 可执行文件和同一原生运行时，按 create、stop、resume、delete 验证实例事实、完整环境、workspace、SSH/PTY、Web IDE、TCP 与 SFTP。Dev Container 运行时另以官方基础镜像、官方 Feature 和 Compose 标准夹具验证 image metadata、UID/GID、lifecycle 与恢复行为；同一夹具同时用于 Docker 直测和 Incus 整链路测试，便于判断问题属于通用 Engine 还是部署集成。

真实测试一次只创建一个实例，CPU 为 1，内存上限为 `1GiB`。镜像包管理、外部仓库和 OCI Feature 可能依赖出网，因此与不拉取镜像的基础 Incus 生命周期入口分开。这样本地快速验证不会受镜像源影响，部署验收仍能覆盖真实网络与安装链路。

### 实现验收点

- [x] 普通 Go 测试覆盖原生运行时的纯逻辑和 Manager 状态边界。
- Docker 集成入口验证单容器、Dockerfile、Compose、Feature、Docker 参数与 stop/resume，不由普通测试隐式拉取镜像。
- container 与 VM 的 Incus E2E 使用真实二进制、同一网络模型和完整生命周期。
- [x] Dev Container 标准夹具由 Docker 与 Incus 两个显式入口共享，并使用官方镜像和官方 Feature。
- [x] 真实 E2E 串行执行并把单实例内存限制为 `1GiB`。

## 完成检查

每次协议变化先生成并发布 `codespace-proto-go`，再更新 Gitea 与 Manager 的远程依赖。每次实现变化同步核对生命周期、状态、RPC、部署与故障排除文档。根工作区文件只用于本地联调，最终验证必须在各模块自身依赖下完成。

### 实现验收点

- 协议生成文件与 `.proto` 一致，两个消费者引用同一个远程版本。
- Gitea 和 Manager 的测试分别使用自身规范入口通过。
- 文档中的配置、状态格式、生命周期与当前代码一致，不保留已删除实现的描述。
