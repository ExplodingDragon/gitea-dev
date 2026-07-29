# Manager 原生 Dev Container 运行时

## 职责划分

Manager 在 Incus 实例内原生管理 Dev Container，不下载或调用外部 Dev Container 命令行工具。Gitea 固定用户选择的配置来源、提交和摘要，并负责权限、Secret 授权和生命周期状态；Manager 负责 JSONC 解析、镜像或 Dockerfile 构建、Compose、Feature、生命周期命令、Web IDE 和交互连接。这样运行环境只有一套状态和一套恢复入口，SSH、Web IDE 与 Endpoint 不再各自猜测容器目标。

实例首次 create 前只执行平台内置 `bootstrap.sh`。这个脚本负责外层 Linux 用户、Git、证书、Docker 和 workspace clone，不解释 Dev Container 配置，也不负责内部容器的启动、停止或恢复。脚本通过 Go `embed` 随 Manager 发布，不提供部署侧替换入口。**设计如此：**bootstrap 处理的是 Manager 所需的固定主机前置条件；仓库开发环境由类型化 Go 实现处理。把两类职责分开，可以保留简单、可审阅的系统准备步骤，同时避免可替换脚本形成第二套生命周期协议。

Manager 将当前 `gitea-codespace` 可执行文件复制到实例的 root-owned 路径，并通过隐藏的 `runtime` 子命令执行 create、resume、stop、inspect、exec 和 TCP bridge。Manager 与 Incus 实例必须使用相同 CPU 架构；不一致时在复制前返回明确部署错误。该方式让容器和虚拟机使用同一实现，也无需在实例内安装 Node.js 或额外 CLI。

### 实现验收点

- [x] 生产路径只保留一个内置 `bootstrap.sh`，配置文件没有自定义生命周期脚本字段。
- [x] create、resume 和 stop 的 Dev Container 操作由 Go 运行时完成，不下载 Node.js 或外部 Dev Container 命令行工具。
- [x] 实例内运行时使用当前 Manager 可执行文件，复制前校验实例架构。
- [x] bootstrap 输出只包含外层 UID、GID、用户名和 workspace，不保存内部容器状态。

## 配置读取与固定

Dev Container 是仓库开发环境的唯一配置格式。Gitea 从规范位置列出候选，每次创建选择一份；没有仓库配置时选择只包含平台默认镜像的配置。仓库文件使用 JSONC，Gitea 与 Manager 都使用 `github.com/tailscale/hujson` 标准化。Gitea 保存来源、路径、锁定提交和原始文件 SHA256；Manager clone 后从 workspace 解析同一文件并再次核对摘要。

原生运行时支持单镜像、Dockerfile build 和多文件 Docker Compose。Compose 文件按声明顺序交给 `compose-go` 合并，主服务由 `service` 指定，`runServices` 决定一同启动的服务；完整项目名、主服务、主容器和相关容器都进入本地环境状态。配置中的路径在符号链接解析后必须仍位于 workspace，因为这些文件属于本次锁定仓库输入，运行时不能从 workspace 外部悄悄取得另一份构建定义。

变量替换覆盖 `${localWorkspaceFolder}`、`${localWorkspaceFolderBasename}`、`${localEnv:NAME}`、`${localEnv:NAME:default}` 和 `${devcontainerId}`。`${containerWorkspaceFolder}` 与 `${containerEnv:NAME}` 在容器确定后解析。`remoteEnv`、`containerEnv`、mount、用户、capability、安全选项、init、端口和 lifecycle 使用类型化字段进入 Docker API。`build.options` 和 `runArgs` 是未类型化命令行字符串，原生运行时无法在不调用 Docker CLI 解析器的情况下证明其含义与安全边界，因此配置应使用对应的类型化 build、mount、capability、security 和 container 字段；出现这两个字段时返回包含替代方式的配置错误。**设计如此：**明确拒绝无法可靠解释的输入，比静默忽略或只支持部分参数更容易定位，也不会制造看似成功但运行结果不同的环境。

### 实现验收点

- [x] JSONC 注释和尾随逗号可解析，仓库文件摘要与创建选择不一致时 create 失败。
- [x] 平台默认、仓库配置、image、Dockerfile 和 Compose 来源都有唯一且可校验的选择。
- [x] Compose 保存主服务及所有相关容器，stop/resume 覆盖完整环境。
- [x] workspace 外的配置、Compose 文件和本地 build context 被明确拒绝。
- [x] 类型化变量、环境、mount、用户和容器属性进入 Docker API；未类型化参数返回说明原因和替代字段的错误。

## Feature 与 Web IDE

Manager 使用 ORAS Go 客户端读取 OCI Dev Container Feature。每个 Feature 校验媒体类型、单一 layer、`devcontainer-feature.json`、`install.sh`、选项和依赖，按依赖与 `overrideFeatureInstallOrder` 生成构建层。最终 OCI digest 写入环境状态，使恢复和诊断可以确认首次创建实际使用的内容。Feature 元数据中的用户、环境、mount、capability、生命周期和 customization 与仓库配置合并；仓库配置在同名标量和环境变量上具有最终选择权。

平台始终加入固定版本的 Coder code-server Feature，并固定端口 `13337`、`auth=none`、监听 `0.0.0.0`，关闭遥测和自动更新。`customizations.vscode.settings` 写入 code-server 用户目录，扩展按配置安装；单个扩展安装失败记录警告，不阻止 shell 和已有 Web IDE 启动。code-server 不建立第二层登录，因为 Gateway 已负责 Open Code、Cookie、会话和持续权限复检。

### 实现验收点

- [x] Feature 通过 OCI API 拉取，依赖顺序、用户选项和摘要进入同一创建结果。
- [x] 多个 Feature 的 lifecycle 命令合并为可执行的同级命令集合，不产生嵌套命令对象。
- [x] Web IDE 使用固定 Feature、端口和认证模式，并打开环境状态中的实际 workspace。
- [x] Manager 在发布 ready 前通过 Dev Container 内的 localhost 连接检查 code-server `/healthz`。

## 生命周期与状态

create 顺序为：创建并启动 Incus 实例、写入 root seed、执行 bootstrap、写入当前 Secret、解析固定配置、准备镜像和 Feature、创建单容器或 Compose 环境、执行 `onCreateCommand`、`updateContentCommand`、`postCreateCommand`、`postStartCommand`，配置 Git，启动 Web IDE并发布 ready。workspace clone 只属于 bootstrap；Dev Container create 重试会按 Codespace 标签清理本次未完成的 Docker 对象后重新创建，不接管其他对象。

stop 先停止环境状态中的主容器和相关容器，再清理易失 Secret，最后停止 Incus 实例。resume 启动同一组容器，执行 `postStartCommand`，重新写入本次 Secret，恢复 Web IDE并完成 ready 检查；它不重新解析仓库配置、不 clone、不 checkout，也不根据后来变化的分支重建环境。delete 以 Incus 实例为资源边界直接删除实例，Docker 资源随实例一同删除。

`postAttachCommand` 在平台 Web IDE附着以及每次 Gateway SSH shell/exec 附着前执行。`initializeCommand` 在外层 workspace、以实际运行用户执行；其他 lifecycle 在主 Dev Container 的 remote user 和 remote workspace 中执行。对象形式的 lifecycle 命令按规范并行执行，字符串和数组保持各自的 shell或 argv 语义。

完整环境状态保存格式版本、环境 ID、Codespace UUID、配置路径和摘要、workspace、Compose identity、全部容器 ID、合并后的配置、remote user/workdir/env、Feature digest、lifecycle 完成标记和 Web IDE 端口。请求、结果和环境 JSON 使用严格字段校验并位于 `/var/lib/gitea-codespace/state`；Secret 不进入该状态。旧格式直接报错，因为这是全新设计，读取旧状态只会让恢复目标产生歧义。

### 实现验收点

- [x] create、stop、resume 和 delete 分别覆盖完整 Dev Container 环境和外层 Incus 资源。
- [x] resume 使用已保存环境，不重新解析仓库文件或修改 workspace HEAD。
- [x] `postAttachCommand` 跟随 Web IDE 和 Gateway SSH 附着执行。
- [x] 环境状态包含恢复和 Gateway 所需的全部目标，且不包含 Secret 明文。
- [x] 请求和结果控制文件在每次调用后删除，格式或环境身份不一致时拒绝继续。

## 凭据与 Secret

Manager 在 bootstrap 前将本轮 Gitea Token、Codespace Git SSH 私钥、公钥和 known_hosts 写入 root seed。bootstrap 创建最终 helper 和只读凭据目录，Dev Container 只读挂载这些文件；HTTP(S) remote 使用 credential helper，SSH remote 使用包装命令和严格 Host Key 校验。Git 用户名和隐私邮箱只在首次创建时写入 Dev Container 用户的 Git 配置，之后 resume 不根据 Gitea 账户变化覆盖用户设置。

Codespace Secret 只写入运行中的 `/run/gitea-codespace/secrets.json`，owner 是 bootstrap 确认的外层用户。create/resume 从 Gitea 取得当前仓库授权的值并重写文件，stop 删除。lifecycle、Web IDE附着和 SSH exec 将这些值作为环境变量传入具体进程；值不进入 Docker 容器的持久配置、Manager state 或日志。

### 实现验收点

- [x] Token、SSH 私钥和 Secret 明文不进入 Manager 持久状态。
- [x] HTTP(S) 与 SSH Git 使用各自固定 helper，SSH 使用 known_hosts 严格校验。
- [x] create/resume 写入当前 Secret，stop 清理；lifecycle 与交互命令取得相同变量。
- [x] Git identity 只在首次 create 配置，resume 保留用户在 workspace 中的后续调整。

## Gateway 接入

SSH shell/exec 通过 Incus exec 启动隐藏的 `runtime exec`，再由 Docker API进入主 Dev Container；PTY、窗口 resize、signal、退出码和非交互 stdout/stderr 保持独立语义。SFTP 继续使用 Incus 文件 API，以外层 UID/GID和 workspace 作为默认目录，文件系统范围保持 Incus SFTP 的原生能力。

Web IDE、普通 HTTP Endpoint 和 SSH `direct-tcpip` 都通过 Incus exec 启动 `runtime tcp`，再在主 Dev Container 内连接 `localhost`、`127.0.0.1` 或 `::1`。外部请求仍经过 Gateway 的 Gitea认证、会话、限流和持续权限复检；容器不开放 Manager 控制端口，也不需要内部 sshd或 direct 网络地址。Dev Container 的 `forwardPorts` 和 `appPort` 会生成初始 Endpoint manifest，运行进程也可用 `gitea-codespace-endpoint` 更新 manifest。

### 实现验收点

- [x] SSH shell/exec 在主 Dev Container 内执行，并支持 PTY resize、signal 和准确退出码。
- [x] Web IDE 与 Endpoint 通过 Incus exec和 Docker API连接容器 localhost，不依赖容器 IP或 host 网络。
- [x] `localhost`、`127.0.0.1` 和 `::1` 的转发行为一致。
- [x] Runtime 内没有访问 Manager 控制端口的路径，所有外部接入先经过 Gateway认证。

## 部署与测试

Incus 系统容器和虚拟机都需要可用 agent、受支持的 Linux 用户管理工具、Git、证书和 Docker Engine。Manager 可执行文件必须能在实例架构和 libc 环境中运行；推荐发布同架构的静态 Go 二进制。虚拟机强制以 agent 可用作为启动前提，不提供无 agent 的降级路径。

真实 E2E 分别覆盖 system container 和 VM，使用 Manager 构建出的真实可执行文件，不使用测试二进制或脚本替身。测试依次验证 create、stop、resume、Web IDE、SSH/PTY、TCP和 SFTP；单个实例 CPU 为 1、内存上限不超过 1 GiB。完整 Manager 入口要求 `CODESPACE_E2E_REPO_CLONE_HTTP_URL` 指向实例可访问的测试仓库，并由 `CODESPACE_E2E_REPO_COMMIT_SHA` 固定实际提交。普通测试在未检测到 Incus或未显式启用镜像拉取型 E2E 时跳过；required 入口把缺少 Incus、仓库或镜像条件作为失败返回。

### 实现验收点

- [x] container 与 VM 使用同一运行时代码和网络接入方式。
- [x] E2E 使用真实 `gitea-codespace` 可执行文件，覆盖完整环境生命周期。
- [x] 测试实例内存上限不超过 1 GiB，并按部署能力区分可选和 required 入口。
- [x] 完整 Manager E2E 使用调用方明确提供的可达仓库和锁定提交，不使用示例域名或伪提交。
- [x] 架构、agent、Docker或镜像条件不满足时给出可定位的部署错误。
