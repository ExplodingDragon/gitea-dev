# Codespace 脚本契约与 Dev Container 生命周期

## 生命周期入口

Manager 使用三个 Bash 入口管理开发环境：

- `init.sh` 在 create 中执行一次，准备实例系统、运行用户、Docker、固定版本的 Dev Container CLI、Git helper，并把仓库克隆到 workspace。
- `start.sh` 在 create 的 init 成功后以及每次 resume 中执行，启动所选 Dev Container，恢复本次凭据，并提交内部容器 ID、实际用户和工作目录。
- `stop.sh` 在 stop operation 中执行，按已保存的容器 ID 停止内部容器；随后 Manager 停止 Incus 实例并保留根存储。

create 使用 `init.sh -> start.sh`，resume 使用 `start.sh`，stop 使用 `stop.sh -> Incus stop`。首次启动和恢复都通过同一个 start 入口，是因为二者都需要把一个已经存在的 workspace 恢复为可交互的 Dev Container；仓库克隆属于一次性初始化，因此只由 init 负责。

内置脚本以独立 `.sh` 文件维护并通过 Go `embed` 打包进 Manager。这样既能直接审阅和执行 Bash 语法检查，也能让部署只发布一个 Manager 二进制。部署者可以在 Manager YAML 中同时指定本地 init、start、stop 文件来替换完整套件；三者使用相同输入和结果协议，并共同负责提交 Dev Container 运行目标。

实现验收点：

- [x] create 只按 `init.sh -> start.sh` 执行，resume 只执行 `start.sh`，stop 先执行 `stop.sh` 再停止 Incus 实例。
- [x] 内置三个脚本以 Bash 编写、通过 Go `embed` 发布，并由 `make test-scripts` 检查真实脚本文件。
- [x] 本地自定义脚本只有在 init、start、stop 三个路径完整时启用，并提交与内置脚本相同的共享环境和结果。
- [x] init 中的 clone 失败在 create 内结束，不会被普通 resume 反复执行。

## Dev Container 配置选择

Dev Container 是仓库级开发环境的唯一配置格式。Gitea 在创建所选提交中发现以下候选位置：

```text
.devcontainer/devcontainer.json
.devcontainer.json
.devcontainer/*/devcontainer.json
```

一级子目录中的多份文件表示多个可选开发环境，每次创建只选择一份，不把多份文件合并。规范根配置存在时默认选中规范根配置；只有子目录配置或仓库没有配置时，平台默认项仍可选。平台默认项由 Gitea 的 `DEVCONTAINER_DEFAULT_IMAGE` 生成一份独立配置，因此没有 Dev Container 文件的仓库也可以创建 Codespace。

仓库文件使用 JSONC。Gitea 使用 `github.com/tailscale/hujson` 标准化后，只读取名称和 `customizations.gitea.repositories` 权限声明；原始文件的路径、创建提交和 SHA256 作为不可变选择保存。Manager clone 后从 workspace 读取文件，并用创建提交中的 blob 校验 SHA256；数据库和 RPC 只保存或传递这些不可变元数据，使配置内容始终以锁定提交中的仓库文件为准。

选中的仓库配置直接交给固定版本的官方 Dev Container CLI。基础镜像 `devcontainer.metadata`、Features、Compose 文件以及 Dev Container 规范定义的其他组合行为由 CLI 处理；Gitea 和 Manager 不再实现第二套配置合并器。平台默认配置只包含站点默认镜像，不与任一仓库文件合并。这样运行结果与通用 Dev Container 工具保持一致，同时权限判断只依赖用户在 Gitea 创建确认页明确选择并审阅的仓库文件。

实现验收点：

- [x] Gitea 发现两个规范根位置和 `.devcontainer` 下一级子目录候选，按稳定顺序展示且每次只选择一份。
- [x] JSONC 注释和尾随逗号由 `tailscale/hujson` 处理；文件大小、候选数量和权限规则数量都有明确上限。
- [x] 无仓库配置时可以选择平台默认项；平台默认配置使用 `DEVCONTAINER_DEFAULT_IMAGE`，不注入仓库配置。
- [x] 创建确认哈希包含所选来源、路径、提交、内容摘要、平台默认镜像和附加权限。
- [x] RPC 只携带来源、路径、提交、摘要或平台默认镜像，不携带原始 JSONC 正文。
- [x] Manager 把仓库配置原样交给固定版本官方 CLI，CLI 负责规范规定的镜像元数据、Feature 与 Compose 组合。

## 初始化与凭据

`init.sh` 根据镜像中的包管理器安装 Bash、Git、OpenSSH client、Python、Docker 和下载工具。Debian、Ubuntu、Fedora 和 Arch 的内置路径使用文档中声明的国内镜像源。Dev Containers CLI 使用对应版本仓库中的官方安装脚本安装到平台目录，并使用它自带的 Node.js 20；CLI 版本固定，Node.js 20 的补丁版本由官方安装脚本选择。这样不会受基础镜像中旧版 Node.js 的影响，也不会把 CLI 安装到开发用户的全局 npm 目录。企业镜像、离线源或其他发行版由部署者通过完整自定义脚本套件管理。

运行用户从创建时的 Gitea 用户名派生，init 在实例内确认实际 UID/GID 后上报。Manager 在执行脚本前把本轮 Gitea Token、Codespace Git SSH 私钥、公钥和 known_hosts 写入 root seed。init 负责创建最终目录和 helper；start 每次把当前 seed 安装到固定位置，并把只读凭据和 helper 绑定挂载到 Dev Container。HTTP(S) remote 使用 credential helper 读取当前 Token，SSH remote 使用包装脚本把只读密钥复制到容器用户缓存后启用严格 Host Key 校验。

create 的 clone 使用带 Codespace UUID 的临时目录，校验锁定 commit 后原子移动到 `/workspaces/{repo}`。首选 Git 协议失败且另一种 URL 可用时，只在同一次 init 中清理临时目录并回退一次。start 不 clone、fetch 或 checkout，因此恢复不会覆盖用户当前 HEAD。

实现验收点：

- [x] Runtime 用户不是 root，实际 UID/GID 由 init 在实例内确认并持久化。
- [x] Manager 先写 root seed，再执行脚本；私钥不会写入 Gitea 数据库或 Manager 状态文件。
- [x] HTTP(S) 和 SSH workspace 分别使用固定 helper，SSH 始终启用 known_hosts 严格校验。
- [x] create 在临时目录完成 clone 和 commit 校验后原子提交 workspace；同次协议回退最多一次。
- [x] resume 不修改 workspace HEAD、remote 或用户在 workspace 中调整的 Git identity。
- [x] 生命周期输出按行实时进入 operation 日志，脚本失败同时写明阶段和可恢复性结果。
- [x] 内置脚本使用固定版本的官方 Dev Containers CLI 安装脚本和独立 Node.js 20；基础镜像自带的 Node.js 版本不影响 CLI 启动。

## 启动结果、Web IDE 与 Gateway

`start.sh` 调用 `devcontainer up --workspace-folder ... --config ...`，从 CLI 的结构化成功结果取得 `containerId`、`remoteUser` 和 `remoteWorkspaceFolder`。这三个值与外层 workspace 一起写入 `CODESPACE_ENV`，Manager 持久化后才进入 ready 校验。

`start.sh` 通过固定版本的官方 Coder code-server Dev Container Feature 安装并启动 Web IDE。平台固定 code-server 版本、端口 `13337`、`auth=none`、监听地址 `0.0.0.0`，并关闭遥测和更新检查；打开目录使用 CLI 返回的实际 `remoteWorkspaceFolder`。code-server 不再建立第二层登录，因为所有浏览器请求已经由 Gateway 的 Open Code、Cookie、session 和持续授权复检保护。版本与端口由平台固定，是为了让 Manager 可以用单一健康检查和路由契约判断 ready，不需要为每个仓库增加 Web IDE 配置协议。

平台默认 Dev Container 配置启用特权模式和 host 网络；仓库配置经官方 CLI 合并后的实际容器也必须满足这两个条件。host 网络只发生在当前 Incus Runtime 的网络命名空间内，使 code-server 和开发服务可由 Manager 通过 Runtime 地址直接连接，同时仍由 Incus 隔离不同 Codespace 与宿主机。Manager 在 CLI 成功后读取容器实际配置并校验，而不是仅相信仓库 JSON 字段，因为 Compose、镜像元数据和 Feature 合并都可能改变最终结果。**设计如此：**Web IDE 和开发端口使用统一的 Runtime 网络入口，避免再部署容器内 SSH 或专用转发守护进程；不满足运行契约的配置会在本次 start 中给出明确错误。

新建内部容器时，`start.sh` 使用官方 CLI 的合并配置读取 `customizations.vscode.settings` 和 `customizations.vscode.extensions`。settings 写入 code-server 用户目录；扩展按声明顺序去重安装，单个扩展下载或安装失败写入生命周期警告但不阻止 shell 和 Web IDE 启动。容器 ID 对应的初始化标记使普通 resume 只恢复并检查同一个 code-server，不重复覆盖用户设置或安装扩展；容器被重新创建后使用新的 ID，重新应用该容器的初始化配置。

Gateway 继续负责外部 HTTP/SSH 认证。Gateway SSH shell 和 exec 通过 Incus exec 在外层实例调用 `docker exec`，目标固定为已保存的内部容器、用户和工作目录；内部 Dev Container 不运行平台 sshd。PTY 的 stdin/stdout、窗口尺寸变更、常用信号和退出码沿现有 Incus exec 控制通道传递。SFTP 通过 Incus file API 访问当前 Runtime 实例，初始目录是共享 workspace，新建对象归属 init 确认的 UID/GID，其余路径、链接、元数据和权限使用该 Runtime 的正常文件系统语义。**设计如此：**Runtime 实例是文件访问的隔离边界，workspace 和用户身份分别提供便捷初始位置与多用户文件归属，不需要在 Dev Container 内额外部署 `sftp-server`，也不把 workspace 伪装成文件系统根目录。

ready 和稳定健康检查同时验证外层 workspace/Git 凭据、内部容器仍处于 running，并通过 Runtime 地址请求 code-server `/healthz`。这样外层 Incus 实例仍在线、但开发容器或 Web IDE 已经退出时，Gateway 不会继续公布可用入口。stop 停止内部容器后 code-server 一同结束，resume 通过同一个 `start.sh` 恢复容器、Web IDE 和健康检查。

普通 HTTP Endpoint 使用两部分共同完成：Dev Container 配置通过 `appPort`、Compose `ports` 或等价的运行参数把服务端口发布到外层实例，容器内的 `gitea-codespace-endpoint` 再声明同一个端口的名称、协议和访问范围。Manager 只为已经发布且显式声明的实例端口建立 Gateway 路由。`forwardPorts` 仍由官方 CLI 按 Dev Container 规范解析，但它本身不是 Gitea Gateway 的入口声明。**设计如此：**端口发布属于容器运行配置，外部访问身份和权限属于 Gateway；分开表达后，仓库可以继续使用标准 Dev Container 配置，同时 Gitea 不会把任意配置字段自动变成外部入口。

实现验收点：

- [x] start 成功结果包含非空容器 ID、实际用户和绝对内部工作目录，并在 ready 前持久化。
- [x] start 通过固定 Feature 安装固定版本 code-server，端口、认证模式、监听地址、遥测和更新行为由平台固定，打开目录使用实际内部 workspace。
- [x] 新建内部容器读取官方合并配置并应用 `customizations.vscode.settings/extensions`；单个扩展失败留下可见警告，容器初始化标记避免 resume 重复执行。
- [x] CLI 完成后校验实际容器为 privileged + host network；不符合时以明确的不可恢复脚本结果结束。
- [x] SSH shell 和 exec 的命令目标进入内部 Dev Container；PTY resize 和退出码保持可用。
- [x] Gateway 用户 SSH 公钥认证与 Codespace 出站 Git SSH Key 分别处理，二者不会共用密钥语义。
- [x] SFTP 使用 Incus file API，初始目录是共享 workspace，可访问当前 Runtime 实例文件系统，新建对象使用 init 确认的 UID/GID，不依赖容器内 `sftp-server`。
- [x] ready 与稳定健康检查都验证内部容器运行状态和 code-server `/healthz`；停止或失效后关闭新会话准入。
- [x] stop 使用已保存容器 ID 停止内部容器并保留状态，下一次 resume 仍通过统一 start 入口恢复。
- [x] 普通 HTTP Endpoint 同时具备 Dev Container 端口发布和显式 Endpoint 声明；Gateway 展示与访问范围只来自后者。

## 脚本结果协议

每次脚本调用都有独立的 `CODESPACE_RESULT`，脚本以原子替换写入 `root:root 0600` JSON：

```json
{"outcome":"done","stage":"start-environment"}
```

`outcome` 为 `done`、`recoverable_failed` 或 `unrecoverable_failed`；`stage` 与本次入口固定对应 `initialize-system`、`start-environment`、`stop-environment`。共享环境写入 `CODESPACE_ENV`，每行使用 `NAME=value`，换行、NUL、无效变量名和平台保留名由 Manager 拒绝。operation 版本和 lease 由 Manager launcher 管理，不交给脚本自行判断。

实现验收点：

- [x] 每次调用只消费本次唯一结果文件，旧结果不能使新调用成功。
- [x] 结果 JSON 只接受固定字段和值，写入采用临时文件加原子替换。
- [x] 共享环境只接受合法名称和单行值，平台输入不能被脚本结果覆盖。
- [x] lease 到期或 Manager 取消时终止整个脚本进程组，脚本不能在授权结束后继续修改实例。
