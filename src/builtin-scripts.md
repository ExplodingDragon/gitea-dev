# Codespace 脚本契约与内置实现

## 脚本边界

Manager 使用三个脚本初始化 Runtime：

- `init.sh`：准备基础系统，并给出后续凭据文件使用的非 root 数值身份。
- `start.sh`：只服务 create，`prepare` 准备 workspace，`activate` 恢复交互入口。
- `resume.sh`：只服务 resume，`prepare` 恢复既有 workspace，`activate` 恢复交互入口。

Manager 只理解这三个调用入口、共享环境、阶段结果和最终通用输出。软件包管理器、工作用户名称、直接运行方式、devcontainer、Docker、容器标识、容器内用户、挂载、内部端口转发和 repository lifecycle commands 都属于脚本实现。

**设计如此：devcontainer 是内置脚本提供的一种 Runtime 内部实现，不是 Manager 资源模型。**Manager 的资源边界始终是 Incus 实例；stop 停止实例，delete 删除实例及其根存储，inventory 也只报告实例。脚本可以改用其他实现，只要最终提供同一 workspace、Git 本地配置、internal SSH 和 Endpoint 行为。

内置脚本随 Manager 发布。部署方可以在 Manager 本地配置中把三个入口分别设为 `builtin` 或绝对文件路径：

```yaml
scripts:
  init: builtin
  start: builtin
  resume: builtin
```

自定义文件由 Manager 启动时读取，必须是本地普通文件。Manager 在领取 create/resume 后、首次执行脚本前，把本次实际使用的三个脚本及内容摘要写入当前 operation 本地快照，再原子发布到 Runtime 固定目录。同一 active operation 的重试和重启恢复继续使用已经发布且摘要相同的脚本；Manager 配置变化从下一次 create/resume 开始生效，不在执行中的 operation 内切换脚本。

这些脚本由 Manager 以 root 执行，因此自定义来源属于 Manager 部署信任边界。repository 可以通过 devcontainer 配置和 lifecycle commands 自定义自己的开发环境，但不作为 `init.sh`、`start.sh` 或 `resume.sh` 的远程脚本来源。这样 create 在 clone 前就有确定的初始化入口，也不需要增加脚本下载和签名协议。

实现验收点：

- Manager 核心数据、RPC、结果结构和 Endpoint API 都没有直接运行/devcontainer、Docker、容器标识或容器用户字段。
- 内置脚本和本地自定义脚本使用同一调用、共享环境、结果和 ready 契约。
- 同一 active operation 在响应丢失、lease 续租和 Manager 重启后继续使用相同脚本内容；配置更新只影响之后开始的 create/resume。
- 自定义脚本只从 Manager 本地配置读取，脚本发布不依赖 Gitea、repository 或额外下载接口。

## 调用与共享环境

Manager 创建或启动 Incus 实例并确认 file/exec API 可用后，把脚本、exec launcher 和通用 helper 原子写入 `/usr/local/libexec/gitea-codespace/`。每轮 create/resume 依次执行：

```text
init.sh
start.sh prepare | resume.sh prepare
start.sh activate | resume.sh activate
```

三个脚本共享同一个 `flock`，每次调用由 launcher 建立独立进程组，并使用 Manager 生成的唯一结果文件。stdout/stderr 写入当前 operation 日志。脚本不接收 `operation_rversion`；Manager 把调用、结果和自己保存的 operation 上下文关联。

凭据和 Git SSH 材料使用固定路径，脚本直接按路径访问，不再通过环境变量重复传递路径：

```text
/var/lib/gitea-codespace/gitea-token
/var/lib/gitea-codespace/runtime-token
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
| `CODESPACE_OPERATION` | 全部 | `create` 或 `resume` |
| `CODESPACE_SCRIPT_PHASE` | prepare、activate | `prepare` 或 `activate`；init 不设置 |
| `CODESPACE_RESULT` | 全部 | 本次调用唯一的结果文件路径 |
| `CODESPACE_ENV` | 全部 | 三个脚本共享的环境文件 |
| `CODESPACE_WORKSPACES_DIR` | 全部 | 默认 workspace 根目录 `/workspaces` |
| `CODESPACE_MANAGER_BASE_URL` | 全部 | Runtime HTTP API 基础 URL |
| `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` | 全部 | internal SSH 授权使用的 Manager/Gateway 公钥 |
| `GITEA_SERVER_URL` | prepare、activate | 本轮 Token 响应中的 Gitea 对外根地址 |
| `GITEA_TOKEN` | prepare、activate | 从当前 Gitea Token 文件读取的本次进程快照 |
| `CODESPACE_RUNTIME_TOKEN` | prepare、activate | 从当前 Runtime Token 文件读取的本次进程快照 |

create 的三个调用还取得创建时锁定的 repository 输入；resume 不取得这些字段，因为恢复只使用已有 workspace 和本地快照：

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

Manager 在首次 create 前把默认 `CODESPACE_WORKSPACE_DIR` 写入共享环境；resume 使用当前快照中已经提交的值。它属于可覆盖的共享变量，不属于上表的预定义输入。`init.sh` 先完成系统与数值身份准备，Manager 随后申请并写入两个固定 Token 文件，再执行 prepare 和 activate。这个顺序使 Token 文件 owner 可以使用 init 的通用输出，同时保证准备 workspace 和启动用户服务时已经取得本轮凭据。

`CODESPACE_ENV` 指向当前 Codespace 的共享环境文件。脚本使用追加方式发布后续调用需要的变量：

```sh
printf '%s\n' 'NAME=value' >> "$CODESPACE_ENV"
```

共享规则如下：

1. Manager 在每次调用前把上一次成功阶段的规范环境写入 `CODESPACE_ENV`，并保存调用前内容。
2. 脚本只追加完整的 `NAME=value` 行；同名变量以最后一行生效，值按第一个 `=` 分隔，因此可以包含后续 `=`。
3. 两张表中的全部输入都是 Manager 预定义变量。脚本向共享环境追加同名变量时，Manager 忽略这些行且不保存；当前调用和后续调用始终使用 Manager 注入值。
4. 脚本结果为 `done` 后，Manager 解析完整文件，拒绝 NUL、换行值和非法变量名，移除预定义变量，按最后值合并其余重复项，再通过临时文件、`fsync` 和 rename 原子保存规范结果。
5. 脚本失败、结果缺失或被取消时，Manager 恢复调用前环境；本次未完成的追加不会进入下一次调用。
6. 成功环境跨 prepare、activate、stop 和 resume 保留，物理删除 Runtime 时随本地快照和实例一起删除。

Manager 每次调用都在共享环境之后注入表中适用于本轮调用的预定义变量。这些值始终由当前 operation 和 Manager 本地快照生成。其余合法共享变量按最后值覆盖；内置脚本的私有状态使用 `GITEA_BUILTIN_*` 前缀，Manager 只保存和传递，不解释其内容。环境文件由 Manager 结构化解析，不作为 shell 源文件执行。

脚本在对应成功阶段写入以下通用共享输出：

| 阶段 | 输出变量 | 说明 |
| --- | --- | --- |
| init | `CODESPACE_CREDENTIAL_UID`、`CODESPACE_CREDENTIAL_GID` | 后续两个 Token 文件使用的非 root 数值身份 |
| prepare | `CODESPACE_WORKSPACE_DIR` | 已准备好的绝对 workspace 路径；create 可以覆盖 Manager 提供的默认值 |
| activate | `CODESPACE_INTERNAL_SSH_PORT` | Incus 通信地址上可直接连接的端口 |
| activate | `CODESPACE_INTERNAL_SSH_USER` | 非 root SSH 用户名 |
| activate | `CODESPACE_INTERNAL_SSH_HOST_KEY_FINGERPRINT` | 当前内部 sshd 的 Host Key 指纹 |

Manager 在 init 成功后校验凭据 UID/GID 为有效非 root 身份，再以该身份和 `0600` mode 原子写入 Gitea Token 与 Runtime Token 文件。prepare 成功后校验 workspace 是绝对路径；create 还校验 Git HEAD 等于 payload 锁定 SHA，resume 保留当前 HEAD。activate 成功后，Manager 从 Incus 通信地址连接给出的端口，以内部 client key 登录给出的用户并核对 Host Key。脚本私有变量不能替代这些通用校验。

**设计如此：共享变量可以覆盖，预定义变量覆盖无效。**覆盖能力用于 init、prepare、activate 和后续 resume 之间传递 workspace、通用输出与实现状态；Manager 预定义变量始终以当前 operation 为准。同名追加被直接忽略，使自定义脚本可以组合，同时保持生命周期和凭据归属可验证。

实现验收点：

- 三个脚本只通过 `CODESPACE_ENV` 共享和覆盖非预定义变量，Manager 在成功阶段后保存规范结果。
- 动态文件路径只使用 `CODESPACE_ENV` 和 `CODESPACE_RESULT`；Token 与 Git SSH 材料使用文档定义的固定路径。
- init 时固定 Token 路径已经确定但凭据尚未写入；prepare 和 activate 取得当前 Token 环境快照与 Gitea 对外地址。
- create 取得两种 clone URL、首选协议和锁定 ref；resume 不取得 repository 输入，只使用持久 workspace 与共享环境。
- 同一变量被多次追加时最后值进入下一阶段；失败或取消调用的追加不生效，成功调用后的规范环境跨 stop/resume 保存。
- 脚本追加预定义变量时当前调用不受影响，Manager 规范化时移除该行，后续调用仍使用 Manager 当前注入值。
- Manager 使用解析器读取环境文件，不执行其中的 shell 内容；只读输入在每次调用时覆盖共享同名值。
- init、prepare、activate 的通用输出缺失、类型错误或校验失败时不能进入下一阶段。
- 自定义脚本可以保存任意合法私有变量，Manager 本地快照只把它们作为当前环境映射保存。

## 结果与恢复

每次 init、prepare 和 activate 调用都取得唯一的 `CODESPACE_RESULT`。脚本在同目录写临时文件、`fsync` 并 rename，最终文件固定为 `root:root 0600`。成功结果只包含：

```json
{"outcome":"done","stage":"initialize-system"}
```

`stage` 按调用固定为 `initialize-system`、`prepare-workspace` 或 `start-environment`。失败结果只包含当前 stage 和以下 outcome 之一：

- `recoverable_failed`：当前 operation lease 内可以重试；本次共享环境追加不提交。
- `unrecoverable_failed`：继续使用当前 Runtime 无法得到可信结果；create 收敛到 failed，resume final failed 后继续上报 failed。

Manager 主动取消时丢弃结果。其他结果缺失、损坏、owner/mode 错误、出现未知字段或 schema 不匹配时按 `recoverable_failed` 处理。脚本退出码只用于日志诊断，不替代结果文件。

Manager 本地阶段固定为：

```text
lease_paused
-> prepare_runtime
-> run_init
-> write_credentials
-> run_prepare
-> run_activate
-> validate_runtime
-> publish_ready
-> finalize
-> completed
```

脚本成功结果、规范共享环境和下一本地阶段在一个本地提交边界内保存。进入 `lease_paused` 会终止 launcher 并停止 create/resume 实例；同版本续租后复检持久 workspace 和凭据，再重新执行通用 prepare、activate 与连通校验。脚本自行根据共享环境和 Runtime 文件恢复直接运行、devcontainer 或其他实现。旧 ready 快照保持 boot stage 单调，但不能跳过本次实例启动后的校验。

实现验收点：

- 结果结构不包含运行方式、容器标识、容器用户、UID/GID 或内部转发字段。
- 每次调用只有结果为 done 且共享环境通过校验时才原子推进本地阶段。
- 非主动取消场景的缺失或损坏结果按可恢复失败处理；不可恢复结果按 create/resume 已定义状态闭环处理。
- `lease_paused` 恢复只调用通用脚本阶段，Manager 不执行任何 devcontainer 专用恢复分支。

## Endpoint 与内部 SSH 契约

Endpoint helper 的 `upstream_port` 始终表示 Incus 通信地址上已经可以访问的实际端口。Manager 根据 Runtime Token 和请求来源确定 Codespace，再把该通信地址与端口保存为本地路由。Manager 不接收内部容器端口、容器标识或转发描述。

脚本若把服务运行在 Runtime 内的另一层环境中，先在 Incus 实例内建立到通信地址实际端口的转发，再调用 helper 登记该实际端口。脚本负责恢复和删除自己创建的转发；stop 会关闭整个实例，delete 会删除包含这些状态的根存储。Endpoint API 仍只处理 `endpoint_id`、label、`http|https` 和实际端口。

internal SSH 使用同一边界。activate 必须先使 sshd 能从 Incus 通信地址访问，再通过 `CODESPACE_INTERNAL_SSH_*` 输出实际端口、用户和 Host Key 指纹。Manager 只验证这个通用入口；sshd 直接位于实例还是由脚本转发到内部环境，不影响 Gateway。

**设计如此：Runtime 内部的进程具有同一个 Codespace 权限边界。**用户在实例内拥有 sudo，容器不是额外授权边界；Runtime Token 与 Incus 来源地址负责防止跨 Codespace 调用，Endpoint 和 internal SSH 的实际连通校验负责防止脚本发布不可达目标。因此 Manager 不需要理解内部容器标识。

实现验收点：

- Endpoint API 对所有脚本实现都只接收 Incus 通信地址上的实际端口，没有 devcontainer 条件分支。
- 内部环境的端口转发由脚本建立；Manager 只保存并连接实际地址和端口。
- internal SSH 的用户、端口和 Host Key 来自通用共享输出，并在 ready 前由 Manager 实际连接校验。
- 自定义脚本无法通过 Endpoint 请求指定其他 host，Runtime API 继续按 Runtime Token 和实时来源地址限制到当前 Codespace。

## 内置脚本实现

内置 `init.sh` 读取 `/etc/os-release`，只选择能够明确归入的 `apt-get`、`dnf` 或 `pacman`。它按缺失命令安装 CA 证书、`curl`、Git、OpenSSH、`sudo`、`util-linux`、账户工具和脚本实际使用的基础工具，安装后逐项确认命令存在。无法识别系统或系统字段与实际包管理器矛盾时返回 `unrecoverable_failed`；下载、软件源或包管理器暂时失败时返回 `recoverable_failed`。

内置 init 幂等创建 `codespace` 用户和组，UID/GID 为 `1000:1000`，home 为 `/home/codespace`，shell 为 `/bin/bash`，workspace 根为 `/workspaces`。同名身份字段冲突或数值身份已被占用时失败。它锁定密码，写入经过 `visudo -cf` 校验的 `NOPASSWD` sudoers，准备 host key、helper、Token、Git SSH、共享环境和结果目录，并把以下内容追加到 `CODESPACE_ENV`：

```text
CODESPACE_CREDENTIAL_UID=1000
CODESPACE_CREDENTIAL_GID=1000
```

内置 `start.sh prepare` 以 `codespace` 用户使用 `/workspaces/.gitea-create-{codespace_uuid}`。初始化标记记录 UUID、repo ID、锁定 SHA 和两种 clone URL。首选协议的 clone/fetch 非零退出时只清理带当前标记的临时目录，再用另一协议重试一次；本地前置错误和 HEAD 校验失败不切换协议。HEAD 等于锁定 SHA 后，脚本原子 rename 到默认 `/workspaces/{repo_name}`，并把最终绝对路径追加到 `CODESPACE_ENV`。已有无匹配标记的目标目录返回 workspace 冲突。

HTTP(S) remote 使用读取当前 Token 文件的 credential helper。首次尝试 SSH 前，内置脚本原子生成 Ed25519 密钥对，通过 Git SSH Key helper 登记公钥并写入可信 known_hosts。SSH 失败后回退到 HTTP(S) 成功时允许保留已经登记的公钥。`resume.sh prepare` 读取共享 workspace 路径，保留用户当前 HEAD，并只恢复实际 remote 的本地凭据配置，不 clone、fetch、checkout 或探测 repository 可达性。

create 的内置 `start.sh prepare` 在 workspace 中查找 `.devcontainer/devcontainer.json` 或 `.devcontainer.json`：存在时选择固定版本 devcontainer CLI，否则选择直接运行方式。它把选择结果、配置相对路径、容器标识、有效用户和转发端口写入 `GITEA_BUILTIN_*` 共享变量和 Runtime 文件；内置 `resume.sh` 只读取该状态恢复原方式，不重新探测配置，Manager 也不读取这些值。

- 直接运行：activate 在 Incus 实例中启动内部 sshd，交互用户为 `codespace`，并把实际 internal SSH 输出追加到 `CODESPACE_ENV`。
- devcontainer：prepare 在实例内安装并启动所需 Docker、Node.js、devcontainer CLI 和转发工具，创建或恢复主容器并暂缓 repository lifecycle commands。内置实现把有效非 root 用户同步为 `1000:1000`，并自行把 Token、Git SSH、helper 与持久环境提供给容器。
- devcontainer activate：在容器内补齐 OpenSSH、curl、shell 和 helper，配置用户 authorized_keys，启动容器 sshd，再在 Incus 实例内建立实际 SSH 转发端口。转发建立后写入通用 `CODESPACE_INTERNAL_SSH_*` 变量，然后通过 CLI 的用户命令入口执行适用的 lifecycle commands。
- devcontainer Endpoint helper：先为容器逻辑端口建立实例实际端口转发，再把实际端口提交给通用 Endpoint API。Manager 和 Gitea 只保存实际端口，容器逻辑端口和容器标识保留在脚本状态中。

默认实现把 devcontainer 视为 Runtime 内部开发环境。配置缺失、有效用户为 root、用户同步失败、workspace 根存储损坏或容器归属冲突返回 `unrecoverable_failed`；临时容器引擎、构建、包安装或网络错误返回 `recoverable_failed`。这些分类只属于内置脚本；自定义脚本按自己的实现给出同一通用 outcome。

**设计如此：内置脚本的直接运行/devcontainer 选择在 create 后保存在脚本私有状态中，resume 不重新探测。**这保证已有 workspace 使用同一种内部实现；同时 Manager 不持久化结构化的实现类型，因此替换脚本时由新脚本负责读取或迁移自己的共享变量。

实现验收点：

- apt/dnf/pacman 探测、固定 `codespace` 用户、sudo、clone 回退、直接运行/devcontainer 和 lifecycle commands 全部在内置脚本测试中覆盖，不进入 Manager 核心测试。
- 内置直接运行与 devcontainer 最终都只向 Manager 提交相同的 workspace 路径、internal SSH 和实际 Endpoint 端口。
- devcontainer 容器标识、用户和转发状态只存在于脚本私有环境或 Runtime 文件；Manager 当前快照不含对应结构化字段。
- resume 使用脚本私有状态恢复原实现，保留 workspace HEAD，并且不依赖 repository payload 或网络可达性。
- 自定义脚本可以完全替换内置直接运行/devcontainer 行为，只要通过通用结果、共享环境和 ready 校验。
