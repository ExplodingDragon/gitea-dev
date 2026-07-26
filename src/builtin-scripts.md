# Codespace 脚本契约、内置实现与 devcontainer 案例

## 脚本边界

Manager 使用三个脚本管理 Runtime：

- `init.sh`：只在 create 执行，负责把新实例初始化成可启动实例。
- `start.sh`：每次启动执行，create 后首次启动和 stopped 后恢复都走同一个入口。
- `stop.sh`：stop operation 中、Incus 实例停止前执行，用于脚本私有运行环境的有界收尾。

Manager 只理解这三个脚本入口、共享环境、结果文件和最终通用输出。软件包管理器、工作用户名称、内部开发环境、容器工具、挂载、端口转发和 repository lifecycle commands 都属于脚本实现。

**设计如此：首次启动和恢复启动本质相同。**`init.sh` 完成一次性的系统初始化、workspace clone 和 Git identity 写入；`start.sh` 只面对已经存在的 workspace，恢复本次启动需要的凭据、helper、Endpoint 和脚本私有运行入口。因此 create 是 `init.sh -> start.sh`，resume 是 `start.sh`，stop 是 `stop.sh -> Incus stop`。这样 clone 失败只在 init 内闭环，不会被启动恢复路径反复重试；后续用户修改 workspace 也不会被恢复启动覆盖。

内置脚本随 Manager 发布，实现上以独立 `.sh` 文件维护，并通过 Go `embed` 打包进 Manager 二进制。这样设计是为了让脚本可以按普通 shell 文件阅读、做语法检查和审阅变更，同时保持部署时只需要发布一个 Manager 程序。三个入口组成一个协作套件，Manager 启动时只接受完整内置套件或三个本地自定义文件：

```yaml
scripts:
  init: builtin
  start: builtin
  stop: builtin
```

```yaml
scripts:
  init: /opt/gitea-codespace/init.sh
  start: /opt/gitea-codespace/start.sh
  stop: /opt/gitea-codespace/stop.sh
```

自定义套件的三个文件由 Manager 启动时读取，必须都是本地普通文件；内置与自定义入口混合时配置校验直接失败。Manager 在领取 create/resume/stop 后、首次执行脚本前，把本次实际使用的三个脚本及内容摘要写入当前 operation 本地快照，再原子发布到 Runtime 固定目录。同一 active operation 的重试和重启恢复继续使用已经发布且摘要相同的脚本；Manager 配置变化从下一次 operation 开始生效，不在执行中的 operation 内切换脚本。

这些脚本由 Manager 以 root 执行，因此自定义来源属于 Manager 部署信任边界。repository 中的 devcontainer 配置只有在管理员显式配置 devcontainer 自定义案例时才由该案例读取；repository 不能提供或替换 `init.sh`、`start.sh`、`stop.sh`。这样 create 在 clone 前就有确定的初始化入口，也不需要增加脚本下载和签名协议。

实现验收点：

- [x] Manager 配置只接受 `init`、`start`、`stop` 三个入口，三者必须全部为 `builtin` 或全部为本地绝对普通文件。
- [x] 脚本文本和 SHA256 摘要保存到 active operation 本地快照，lease 续租和 Manager 重启后继续使用同一组内容。
- [x] 内置脚本源码以独立 `.sh` 文件维护，并通过 Go `embed` 打包；测试直接读取脚本文本和执行安全分支。
- [x] Manager 核心数据、RPC、配置和 Endpoint API 不包含 devcontainer、Docker、Node.js、CLI、容器标识和容器用户。
- [x] 运行健康检查只使用 Manager 保存的 workspace、UID/GID 和 Incus file/exec backend；健康检查不会调用项目命令或读取脚本私有实现状态。

## 调用与共享环境

Manager 创建或启动 Incus 实例并确认 file/exec API 可用后，把脚本、exec launcher 和通用 helper 原子写入 `/usr/local/libexec/gitea-codespace/`。调用顺序固定为：

```text
create: init.sh -> start.sh
resume: start.sh
stop: stop.sh -> Incus stop
delete: 销毁实例并删除本地状态
```

三个脚本共享同一个 `flock`，每次调用由 launcher 建立独立进程组，并使用 Manager 生成的唯一结果文件。stdout/stderr 写入当前 operation 日志。脚本不接收 `operation_rversion`；Manager 把调用、结果和自己保存的 operation 上下文关联。stop 脚本用于优雅收尾，成功时本次共享环境会保存到 Manager 本地 state，失败会进入日志诊断且不会覆盖旧共享环境，Manager 仍继续执行 Incus stop，使 Gitea 生命周期可以收敛到 stopped。delete 不运行 stop 脚本，它按销毁语义删除 Incus 实例和本地状态；脚本私有状态随根存储一起删除。

凭据和 Git SSH 材料使用固定路径，脚本直接按路径访问：

```text
/var/lib/gitea-codespace/gitea-token
/var/lib/gitea-codespace/git/id_ed25519
/var/lib/gitea-codespace/git/id_ed25519.pub
/var/lib/gitea-codespace/git/known_hosts
```

Manager 通过 Incus exec environment 传递脚本输入。通用输入如下：

| 环境变量 | 可用调用 | 说明 |
| --- | --- | --- |
| `CODESPACE_UUID` | 全部 | Codespace 完整 UUID |
| `CODESPACE_NAME` | 全部 | `cs-{short_uuid}` 派生名称 |
| `CODESPACE_OWNER_NAME` | 全部 | Codespace 创建用户名称 |
| `CODESPACE_OPERATION` | 全部 | `create`、`resume` 或 `stop` |
| `CODESPACE_RESULT` | 全部 | 本次调用唯一的结果文件路径 |
| `CODESPACE_ENV` | 全部 | 三个脚本共享的环境文件 |
| `CODESPACE_WORKSPACES_DIR` | init/start | 默认 workspace 根目录 `/workspaces` |
| `GITEA_SERVER_URL` | start | 本轮 Token 响应中的 Gitea 对外根地址 |
| `GITEA_TOKEN` | start | 从当前 Gitea Token 文件读取的本次进程快照 |

create 的 `init.sh` 取得创建时锁定的 repository 输入；resume 不取得这些字段，因为恢复只使用已有 workspace 和本地快照：

| 环境变量 | 说明 |
| --- | --- |
| `GITEA_REPO_CLONE_HTTP_URL` | Gitea 生成的规范 HTTP(S) clone URL |
| `GITEA_REPO_CLONE_SSH_URL` | Gitea 生成的规范 SSH clone URL |
| `GITEA_GIT_PROTOCOL` | 首次 clone 的首选协议，值为 `http` 或 `ssh` |
| `GITEA_REPO_WEB_URL` | repository Web URL |
| `GITEA_REPO_ID` | repository ID |
| `GITEA_REPO_FULL_NAME` | repository 完整名称 |
| `GITEA_OWNER_ID`、`GITEA_OWNER_NAME` | repository owner 身份 |
| `GITEA_OWNER_TYPE`、`GITEA_OWNER_DISPLAY_NAME` | repository owner 类型与展示名称 |
| `GITEA_REF_TYPE`、`GITEA_REF_NAME` | 创建来源 ref 类型与名称 |
| `GITEA_COMMIT_SHA` | create 必须得到的锁定 commit SHA |
| `CODESPACE_REPO_NAME` | create 时的 repository 名称 |

Manager 在 create/resume 的 start 前写入 root seed：Gitea Token、Git SSH 私钥、公钥和 known_hosts。Git SSH 私钥和公钥先写入 seed，再用同一公钥向 Gitea 确认绑定；Gitea 返回的 known_hosts 和本轮 Token 随后写入同一 seed。`init.sh` 在 create 中安装首次 seed 并上报实际 UID/GID；`start.sh` 每次启动安装当前 seed，并只恢复已有 workspace 的本地凭据和运行入口。这个顺序让 Go 侧统一生成控制面凭据，同时让 Runtime 内用户、权限和首次 workspace 初始化由 init 根据真实系统状态一次性完成；初始化中断后重试也能复用同一把 Git SSH key，避免把一次失败变成公钥冲突。

`CODESPACE_ENV` 指向当前 Codespace 的共享环境文件。脚本使用追加方式发布后续调用需要的变量：

```sh
printf '%s\n' 'NAME=value' >> "$CODESPACE_ENV"
```

共享规则如下：

1. Manager 在每次调用前把上一次成功阶段的规范环境写入 `CODESPACE_ENV`，并保存调用前内容。
2. 脚本只追加完整的 `NAME=value` 行；同名变量以最后一行生效。
3. Manager 预定义变量由当前 operation 和 Manager 本地快照生成；脚本向共享环境追加同名变量时，Manager 忽略这些行且不保存。
4. 脚本结果为 `done` 后，Manager 解析完整文件，拒绝 NUL、换行值和非法变量名，移除预定义变量，按最后值合并其余重复项，再在 Runtime 内通过临时文件和 rename 写回规范结果。
5. 脚本失败、结果缺失或被取消时，Manager 恢复调用前环境；本次未完成的追加不会进入下一次调用。
6. 成功环境跨 init、start、stop 和后续 resume 保留，物理删除 Runtime 时随本地快照和实例一起删除。

脚本在对应成功阶段写入以下通用共享输出：

| 调用 | 输出变量 | 说明 |
| --- | --- | --- |
| init | `CODESPACE_CREDENTIAL_UID`、`CODESPACE_CREDENTIAL_GID`、`CODESPACE_USER` | 已安装最终凭据文件的非 root 运行身份 |
| init | `CODESPACE_WORKSPACE_DIR` | create 已克隆并锁定 commit 的绝对 workspace 路径 |
| start | `CODESPACE_WORKSPACE_DIR` | 本次启动使用的绝对 workspace 路径 |

Manager 在 init 成功后校验凭据 UID/GID 为有效非 root 身份，并校验最终 Gitea Token、Git SSH key、known_hosts 和 runtime 目录已经可由该身份使用。create 还要求 init 提交绝对 workspace 路径，并校验 Git HEAD 等于 payload 锁定 SHA；resume 从共享环境读取已有 workspace。start 成功后，Manager 通过 Incus file/exec API 以保存的 UID/GID 和 workspace 做 ready 校验，并重建当前 Endpoint 的 proxy route。脚本私有变量不能替代这些通用校验。

实现验收点：

- [x] create 执行 `init.sh -> start.sh`；resume 只执行 `start.sh`；stop 执行 `stop.sh` 后继续 Incus stop。
- [x] start 不 clone、fetch、checkout，不读取 repository payload，不覆盖 workspace 当前 HEAD 和用户后续可能修改的 Git identity。
- [x] Gitea Token、Git SSH 私钥、公钥和 known_hosts 由 Manager 写入 root seed；Git SSH 私钥和公钥在 `EnsureCodespaceGitSSHKey` 前先落到 seed，init 和 start 都能把当前 seed 安装到固定最终路径。
- [x] 共享环境由结构化解析，不作为 shell 源文件执行；预定义变量同名追加被忽略。
- [x] create 缺少 init 提交的 workspace 时不能进入 start；resume 缺少已保存 workspace 时不能启动。

## 结果与恢复

每次 init、start 和 stop 调用都取得唯一的 `CODESPACE_RESULT`。脚本在同目录写临时文件、`fsync` 并 rename，最终文件固定为 `root:root 0600`。成功结果只包含：

```json
{"outcome":"done","stage":"initialize-system"}
```

`stage` 按调用固定为：

- `initialize-system`：`init.sh`
- `start-environment`：`start.sh`
- `stop-environment`：`stop.sh`

失败结果只包含当前 stage 和以下 outcome 之一：

- `recoverable_failed`：当前 operation lease 内可以重试；本次共享环境追加不提交。
- `unrecoverable_failed`：继续使用当前 Runtime 无法得到可信结果；create 收敛到 failed，resume final failed 后继续上报 failed。

Manager 主动取消时丢弃结果。其他结果缺失、损坏、owner/mode 错误、出现未知字段或 schema 不匹配时按 `recoverable_failed` 处理。脚本退出码只用于日志诊断，不替代结果文件。stop 脚本成功会提交本次共享环境，供下一次 resume 使用；stop 脚本失败不会阻止 Incus stop，也不会覆盖旧环境。这是为了让用户停止操作优先获得确定的 stopped 结果，同时保留上一次可信恢复输入。

Manager 本地阶段固定表达为启动编排阶段，脚本入口只对应 init、start 和 stop：

```text
lease_paused
-> prepare_runtime
-> write_credentials
-> run_init (create only)
-> run_start
-> validate_runtime
-> publish_ready
-> finalize
-> completed
```

`prepare-workspace` 仍作为 Runtime Metadata boot stage 保留，用于表达 workspace 已经可用于本次启动：create 由 init 提交 workspace 后进入该 stage，resume 从本地共享环境确认 workspace 后进入该 stage。它不是脚本阶段，也不对应 `prepare` 脚本。

实现验收点：

- [x] 结果结构只包含 `outcome` 和固定 stage；运行方式、容器标识、容器用户、UID/GID 与内部转发信息通过共享环境或脚本私有文件表达。
- [x] 每次调用只有结果为 done 且共享环境通过校验时才推进后续 Manager 流程；Incus 侧在失败、损坏结果或共享环境校验失败时恢复调用前环境。
- [x] `lease_paused` 恢复时，create 重新执行 init 并校验已提交 workspace，resume 重新执行 start，随后都执行连通校验；恢复只复用 active operation 快照中的脚本文本和共享环境。
- [x] stop 脚本成功时保存共享环境；stop 脚本失败写入日志后继续 Incus stop 且不覆盖旧环境；Incus stop 成功才提交 stop final done。

## Endpoint 与 Incus 后端契约

Endpoint helper 的 `upstream_port` 始终表示 Runtime 实例内已经可以访问的目标端口。Runtime helper 把 Endpoint 完整列表写入本地 manifest，Manager 在 start 成功后、ready 前和稳定 running 健康检查中读取该文件，为目标端口创建 Manager 本地 Incus proxy listener，并把 listener 保存为 Gateway 路由。内部容器端口、容器标识或转发描述由脚本保存在自己的实现状态中。

脚本若把服务运行在 Runtime 内的另一层环境中，先在实例内把该服务暴露到一个可由 Incus proxy 访问的本地端口，再调用 helper 登记该端口。脚本负责恢复和删除自己创建的内部转发；stop 可以关闭脚本私有服务，delete 会删除包含这些状态的根存储。Endpoint manifest 仍只处理 `endpoint_id`、label、`http|https`、目标端口和必填 `public` 布尔值。

shell、exec 和 SFTP 使用同一实例边界。Manager/Gateway 通过 Incus exec/file/SFTP API 进入 Runtime，执行身份使用 init 输出的非 root UID/GID，默认 cwd 使用 init/start 输出的 workspace。SFTP 使用 Incus 实例文件 SFTP endpoint，由 Gateway 提供用户认证和 workspace 根目录映射，不要求 Runtime 内运行 SSH 服务或 `sftp-server`。自定义脚本若创建内部开发环境，需要把用户希望进入的工作区和命令入口整理到实例可见的 workspace 或脚本私有状态中；Manager 不解析容器标识。

**设计如此：Runtime 内部的进程具有同一个 Codespace 权限边界。**用户在实例内拥有 sudo，容器不是额外授权边界；manifest 文件归属于当前实例，Endpoint proxy 和 Incus exec/file 校验负责防止脚本发布不可达目标。因此 Manager 不需要理解内部容器标识。

实现验收点：

- [x] Endpoint API 对所有脚本实现都只接收 Runtime 实例内目标端口；Endpoint 条目不能指定 host。
- [x] 内部环境的端口转发由脚本建立；Manager 只保存目标端口并创建 Incus proxy。
- [x] shell、exec 和 SFTP 的身份来自 init 输出的 UID/GID，cwd 来自 init/start 输出的 workspace，并在 ready 前由 Manager 通过 Incus file/exec 实际校验；SFTP 使用 Incus 实例文件 SFTP endpoint，不依赖 Runtime 内 SSH 服务。
- [x] 自定义脚本无法通过 Endpoint manifest 指定其他 host。

## 内置脚本实现

内置 `init.sh` 读取 `/etc/os-release`，只选择能够明确归入的 `apt-get`、`dnf` 或 `pacman`。安装包前，内置脚本会把常见 Debian/Ubuntu apt 源、Fedora dnf 源和 Arch pacman 源切到清华 TUNA 国内镜像，并为被修改的源文件保留 `.gitea-codespace.bak` 备份；无法明确识别的 dnf 系发行版保持原有源。这样设计是为了让默认 Debian/Ubuntu/Fedora/Arch 镜像在国内网络下能稳定安装基础工具，同时避免为每个发行版维护一套复杂源模板。生产环境需要企业内网源或离线源时，部署者应使用自定义脚本套件明确管理包源。

内置 init 按 `CODESPACE_USER` 创建或确认运行用户，默认用户名为 `codespace`，不强制 UID/GID 为 `1000:1000`。用户已存在时必须不是 root；用户不存在时由系统分配 UID/GID。它锁定密码，写入经过 `visudo -cf` 校验的 `NOPASSWD` sudoers，准备 Git credential helper 和 Endpoint helper，并把 root seed 安装到最终固定路径。这样设计是因为镜像中 `1000` 可能已经被占用，Manager 在 init 前只指定用户名，最终数值身份由 Runtime 内真实系统状态决定。

内置 `init.sh` 在 create 时以 `CODESPACE_USER` 用户使用 `/workspaces/.gitea-create-{codespace_uuid}` 克隆受控临时 workspace。首选协议的 clone/fetch 非零退出且另一种 URL 非空时，只清理该临时目录并在同一次 init 调用中重试一次；本地前置错误、没有备用 URL和 HEAD 校验失败写入 `unrecoverable_failed`。HEAD 等于锁定 SHA 后，脚本原子 rename 到默认 `/workspaces/{repo_name}`，并把最终绝对路径追加到 `CODESPACE_ENV`。同一 operation 恢复时，如果最终 workspace 已存在、包含 Git 仓库且 HEAD 等于锁定 SHA，脚本只恢复实际 remote 的本地凭据并重新提交同一个 workspace。

内置 `start.sh` 每次启动都会把本轮 root seed 安装到最终固定路径，然后读取共享环境中的 workspace。HTTP(S) remote 使用读取当前 Gitea Token 文件的 credential helper；SSH remote 使用固定私钥和 known_hosts，并启用严格 Host Key 校验。start 不 clone、fetch、checkout，不改写 Git identity，不探测 repository 可达性。**设计如此：**用户改名、修改邮箱或在 workspace 内调整 Git identity 后不触发 Gitea 同步；create 的一次性初始化已经足够，后续启动和恢复不覆盖用户工作区选择。

内置 `stop.sh` 只提交 stop 结果；直接运行模式没有额外守护进程需要收尾。使用内置套件时，repository 中的 `.devcontainer/devcontainer.json` 或 `.devcontainer.json` 按普通 workspace 文件保留；Docker、Node.js、devcontainer CLI 和容器端口转发工具由选择 devcontainer 案例的自定义脚本准备。

实现验收点：

- [x] apt/dnf/pacman 探测、国内镜像源配置、运行用户、sudo、init 中基于非空 clone URL 的同次回退、helper 准备和直接运行恢复全部在内置脚本测试中覆盖。
- [x] SSH URL 为空时内置脚本只配置 HTTP(S) remote 和 credential helper，不切换到 SSH remote；Git SSH key 仍由 Manager Go 侧统一生成、登记并作为 seed 安装。
- [x] create 前 Manager 将 repository Codespace 配置正文写入 Runtime 固定文件，并设置 `GITEA_CODESPACE_CONFIG_*` 环境变量；本次环境选择通过 `GITEA_CODESPACE_ENVIRONMENT_TAG` 提供。
- [x] create 写入 Git `user.name` 和 `user.email`；start 只恢复凭据，不覆盖 workspace 现有 Git identity。
- [x] 内置 start 保留 workspace HEAD，只恢复当前 remote 的凭据和 helper，不依赖 repository payload 或网络可达性。

## devcontainer 自定义脚本案例

项目随文档提供一套完整、可运行的 devcontainer 自定义脚本案例：

```text
examples/devcontainer/init.sh
examples/devcontainer/start.sh
examples/devcontainer/stop.sh
examples/devcontainer/README.md
```

管理员把三个路径作为完整自定义套件配置后，Manager 按本章通用顺序调用它们，并继续只传递通用脚本输入。案例自行完成以下工作：

1. `init.sh` 安装或校验 Docker、Node.js、固定版本 devcontainer CLI 和实例内 helper；create 时完成首次 clone、锁定 commit，并提交 workspace。
2. `start.sh` 是统一启动入口。create 后首次启动和 stopped 后恢复都通过它恢复 Git 凭据、启动 Docker、复用已有 devcontainer 或执行 `devcontainer up`，并提交容器 ID。
3. `stop.sh` 在 Incus stop 前尽量停止已知 devcontainer，并保留容器 ID 供下一次 start 复用。
4. 案例 Endpoint helper 先把容器逻辑端口转发为实例内本地端口，再调用通用 Runtime Endpoint API。Manager 和 Gitea 只接收目标端口。

案例私有变量使用 `DEVCONTAINER_EXAMPLE_*` 前缀，作为不透明键值保存在 `CODESPACE_ENV`，需要的较大状态保存在 Runtime 根存储内。配置无效、有效用户为 root、用户同步失败、workspace 损坏或容器归属冲突返回 `unrecoverable_failed`；临时容器引擎、构建、包安装或网络错误返回 `recoverable_failed`。缺失或损坏案例私有状态时由案例根据自己能够证明的事实分类，Manager 只消费通用 outcome。

**设计如此：devcontainer 支持由脚本契约提供，Manager Go 代码保持通用资源编排。**案例证明自定义套件可以创建嵌套开发环境、执行 lifecycle commands，并把工作区和 Endpoint 服务接入 Incus 实例边界；相同契约也能承载其他容器工具或企业开发环境。Manager 只保存通用输出和不透明共享变量，因此 devcontainer CLI 版本、容器状态和恢复细节都归属于案例自身。

实现验收点：

- [x] devcontainer 案例作为三个完整自定义脚本路径被显式配置后执行；内置配置把 repository 中的 devcontainer 文件作为普通 workspace 内容处理。
- [x] Manager 的配置、Go 类型、RPC、本地结构化快照和状态机只表达 Incus 实例、通用脚本输入、通用结果、共享环境、Incus backend 和 Endpoint 目标端口；devcontainer 示例的容器 ID 使用私有共享变量保存。
- [x] 案例通过通用结果提交凭据 UID/GID、workspace 和 Endpoint 目标端口；Manager 使用与内置脚本相同的 Incus file/exec ready 校验。
- [x] stop 先运行案例收尾脚本，再停止 Incus 实例；resume 只运行同一 `start.sh` 恢复既有容器，delete 删除实例根存储及其中的案例状态。
