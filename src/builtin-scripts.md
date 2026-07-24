# Codespace 脚本契约、内置实现与 devcontainer 案例

## 脚本边界

Manager 使用三个脚本初始化 Runtime：

- `init.sh`：准备基础系统，并给出后续凭据文件使用的非 root 数值身份。
- `start.sh`：只服务 create，`prepare` 准备 workspace，`activate` 恢复交互入口。
- `resume.sh`：只服务 resume，`prepare` 恢复既有 workspace，`activate` 恢复交互入口。

Manager 只理解这三个调用入口、共享环境、阶段结果和最终通用输出。软件包管理器、工作用户名称、内部开发环境、容器工具、挂载、端口转发和 repository lifecycle commands 都属于脚本实现。

**设计如此：devcontainer 能力由完整自定义脚本套件提供，Manager 的 Go 代码只管理 Incus 实例。**Manager 的资源边界始终是 Incus 实例；stop 停止实例，delete 删除实例及其根存储，inventory 也只报告实例。默认内置脚本直接在实例中提供开发环境；管理员显式选择 devcontainer 案例或其他自定义套件时，由脚本自行编排内部环境，并向 Manager 提交同一 workspace、Git 本地配置、internal SSH 和 Endpoint 行为。这个边界证明系统具备使用 devcontainer 的能力，同时让其他自定义开发环境也能通过相同契约接入。

稳定 running 后的周期健康检查由 Manager 使用 activate 已提交的 `internal_ssh` 执行固定 SSH exec 命令。它直接验证所有脚本套件都必须提供的通用交互入口，因此三个脚本入口和 `prepare|activate` 阶段保持不变；内置直接运行和任意自定义实现负责让自己的内部 SSH 持续满足同一契约。

内置脚本随 Manager 发布。三个入口组成一个协作套件，Manager 启动时只接受完整内置套件或三个本地自定义文件：

```yaml
scripts:
  init: builtin
  start: builtin
  resume: builtin
```

```yaml
scripts:
  init: /opt/gitea-codespace/init.sh
  start: /opt/gitea-codespace/start.sh
  resume: /opt/gitea-codespace/resume.sh
```

自定义套件的三个文件由 Manager 启动时读取，必须都是本地普通文件；内置与自定义入口混合时配置校验直接失败。Manager 在领取 create/resume 后、首次执行脚本前，把本次实际使用的三个脚本及内容摘要写入当前 operation 本地快照，再原子发布到 Runtime 固定目录。同一 active operation 的重试和重启恢复继续使用已经发布且摘要相同的脚本；Manager 配置变化从下一次 create/resume 开始生效，不在执行中的 operation 内切换脚本。

**设计如此：内置脚本是一个完整的直接运行套件。**内置 start 依赖内置 init 创建的固定用户和目录，内置 resume 依赖内置 start 保存的 `GITEA_BUILTIN_*` 私有状态；这些实现数据不属于通用 Manager 契约，因此有效配置固定为完整内置套件或完整自定义套件。devcontainer 案例与其他自定义套件使用自己的私有共享变量，只需提供相同的通用输出。

这些脚本由 Manager 以 root 执行，因此自定义来源属于 Manager 部署信任边界。repository 中的 devcontainer 配置只有在管理员显式配置 devcontainer 自定义案例时才由该案例读取；repository 不能提供或替换 `init.sh`、`start.sh`、`resume.sh`。这样 create 在 clone 前就有确定的初始化入口，也不需要增加脚本下载和签名协议。

实现验收点：

- [x] Manager 核心数据、RPC、配置和 Endpoint API 只包含通用脚本契约字段；devcontainer、Docker、Node.js、CLI、容器标识和容器用户不进入 Manager RPC 或 Endpoint API。
- [ ] Manager 结果结构只包含通用脚本契约字段；该项随脚本结果文件和阶段解析实现验收。
- [ ] 内置脚本和本地自定义脚本使用同一调用、共享环境、结果和 ready 契约；当前代码只完成脚本来源配置校验，尚未执行自定义脚本套件。
- [x] 配置层要求三个入口全部为 `builtin` 或全部为本地绝对普通文件；混合配置、相对路径和不可访问文件会在 Manager 启动配置校验时报错。
- [ ] 同一 active operation 在响应丢失、lease 续租和 Manager 重启后继续使用相同脚本内容；配置更新只影响之后开始的 create/resume。
- [x] 自定义脚本入口只从 Manager 本地配置读取；配置校验不接受 repository 路径、下载 URL 或相对路径。
- [ ] 脚本发布、内容摘要、同一 active operation 复用相同脚本内容，以及脚本写入 Runtime 固定目录由脚本执行状态机实现。该项不能用配置校验代替，原因是配置只证明入口来源合法，不能证明一次 operation 内使用的脚本内容已经固定并可恢复。
- [ ] 运行健康检查只使用 activate 的通用 internal SSH 输出；脚本套件仍由 init、start、resume 三个入口组成，健康检查不会调用项目命令或读取脚本私有实现状态。
- [ ] 默认内置套件只实现实例内直接运行；devcontainer 案例只有作为完整自定义套件被显式配置时才执行。

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

- [ ] 三个脚本只通过 `CODESPACE_ENV` 共享和覆盖非预定义变量，Manager 在成功阶段后保存规范结果。
- [x] Gitea Token 与 Runtime Token 使用文档定义的固定路径，并由 create/resume 写入实例文件系统；prepare/activate 仍保留环境变量作为本次进程快照。
- [ ] 动态文件路径只使用 `CODESPACE_ENV` 和 `CODESPACE_RESULT`；Git SSH 材料使用文档定义的固定路径。完整脚本契约落地后，Token 文件 owner、共享环境和结果文件也由同一阶段机制校验。
- [ ] init 时固定 Token 路径已经确定但凭据尚未写入；prepare 和 activate 取得当前 Token 环境快照与 Gitea 对外地址。
- [ ] create 取得当前可用协议的 clone URL、首选协议和锁定 ref；禁用协议字段为空。resume 不取得 repository 输入，只使用持久 workspace 与共享环境。
- [ ] 同一变量被多次追加时最后值进入下一阶段；失败或取消调用的追加不生效，成功调用后的规范环境跨 stop/resume 保存。
- [ ] 脚本追加预定义变量时当前调用不受影响，Manager 规范化时移除该行，后续调用仍使用 Manager 当前注入值。
- [ ] Manager 使用解析器读取环境文件，不执行其中的 shell 内容；只读输入在每次调用时覆盖共享同名值。
- [ ] init、prepare、activate 的通用输出缺失、类型错误或校验失败时不能进入下一阶段。
- [ ] 自定义脚本可以保存任意合法私有变量，Manager 本地快照只把它们作为当前环境映射保存。

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

脚本成功结果、规范共享环境和下一本地阶段在一个本地提交边界内保存。进入 `lease_paused` 会终止 launcher 并停止 create/resume 实例；同版本续租后复检持久 workspace 和凭据，再重新执行通用 prepare、activate 与连通校验。脚本自行根据共享环境和 Runtime 文件恢复自己的实现；Manager 按通用脚本阶段恢复内置直接运行、devcontainer 案例或其他自定义环境。旧 ready 快照保持 boot stage 单调，但不能跳过本次实例启动后的校验。

实现验收点：

- [ ] 结果结构只包含 `outcome` 和固定 boot stage；运行方式、容器标识、容器用户、UID/GID 与内部转发信息通过共享环境或脚本私有文件表达。
- [ ] 每次调用只有结果为 done 且共享环境通过校验时才原子推进本地阶段。
- [ ] 非主动取消场景的缺失或损坏结果按可恢复失败处理；不可恢复结果按 create/resume 已定义状态闭环处理。
- [ ] `lease_paused` 恢复调用通用 prepare、activate 与连通校验，devcontainer 案例和其他自定义环境通过同一恢复路径闭环。

## Endpoint 与内部 SSH 契约

Endpoint helper 的 `upstream_port` 始终表示 Incus 通信地址上已经可以访问的实际端口。Manager 根据 Runtime Token 和请求来源确定 Codespace，再把该通信地址与端口保存为本地路由。内部容器端口、容器标识或转发描述由脚本保存在自己的实现状态中。

脚本若把服务运行在 Runtime 内的另一层环境中，先在 Incus 实例内建立到通信地址实际端口的转发，再调用 helper 登记该实际端口。脚本负责恢复和删除自己创建的转发；stop 会关闭整个实例，delete 会删除包含这些状态的根存储。Endpoint API 仍只处理 `endpoint_id`、label、`http|https`、实际端口和必填 `public` 布尔值。helper 默认提交 `public=false`，脚本只有明确使用 `--public` 时才公开普通 Endpoint；`workspace` 固定为 false。**设计如此：工作环境进程持有 Runtime Token 并具有同一 Codespace 权限边界，因此它可以声明普通 Endpoint 的公共访问；Gitea 页面只展示当前结果。**

internal SSH 使用同一边界。activate 使用 `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` 在当前脚本实现选择的环境中原子替换授权内容，只保留当前 Manager 公钥，然后使 sshd 能从 Incus 通信地址访问，再通过 `CODESPACE_INTERNAL_SSH_*` 输出实际端口、用户和 Host Key 指纹。Manager 只验证这个通用入口；授权文件、sshd 直接位于实例还是由脚本转发到内部环境，都由脚本处理。

**设计如此：Runtime 内部的进程具有同一个 Codespace 权限边界。**用户在实例内拥有 sudo，容器不是额外授权边界；Runtime Token 与 Incus 来源地址负责防止跨 Codespace 调用，Endpoint 和 internal SSH 的实际连通校验负责防止脚本发布不可达目标。因此 Manager 不需要理解内部容器标识。

实现验收点：

- [x] Endpoint API 对所有脚本实现都只接收 Incus 通信地址上的实际端口；devcontainer 案例先在脚本内完成转发，再提交同一实际端口字段。当前 Runtime API 会从请求 source IP 解析 Incus 通信网卡地址，Endpoint 请求体不能指定 host。
- [ ] 内部环境的端口转发由脚本建立；Manager 只保存并连接实际地址和端口。
- [ ] internal SSH 的用户、端口和 Host Key 来自通用共享输出，并在 ready 前由 Manager 实际连接校验。
- [ ] Manager 不依赖固定授权文件路径；内置直接运行和自定义环境的 activate 都用同一公钥输入替换各自实际入口的授权内容。
- [x] 自定义脚本无法通过 Endpoint 请求指定其他 host，Runtime API 继续按 Runtime Token 和实时来源地址限制到当前 Codespace。设计如此是为了让脚本只声明“本实例通信地址上的端口”，避免脚本把 Gateway 路由指向其他主机。
- [x] 内置与自定义脚本使用相同的 `public` 字段；省略命令行选项得到需要认证的入口，显式 `--public` 得到公共普通 Endpoint，workspace 的公共请求被拒绝。

## 内置脚本实现

内置 `init.sh` 读取 `/etc/os-release`，只选择能够明确归入的 `apt-get`、`dnf` 或 `pacman`。它按缺失命令安装 CA 证书、`curl`、Git、OpenSSH、`sudo`、`util-linux`、账户工具和脚本实际使用的基础工具，安装后逐项确认命令存在。无法识别系统或系统字段与实际包管理器矛盾时返回 `unrecoverable_failed`；下载、软件源或包管理器暂时失败时返回 `recoverable_failed`。

内置 init 幂等创建 `codespace` 用户和组，UID/GID 为 `1000:1000`，home 为 `/home/codespace`，shell 为 `/bin/bash`，workspace 根为 `/workspaces`。同名身份字段冲突或数值身份已被占用时失败。它锁定密码，写入经过 `visudo -cf` 校验的 `NOPASSWD` sudoers，准备 host key、helper、Token、Git SSH、共享环境和结果目录，并把以下内容追加到 `CODESPACE_ENV`：

```text
CODESPACE_CREDENTIAL_UID=1000
CODESPACE_CREDENTIAL_GID=1000
```

内置 `start.sh prepare` 以 `codespace` 用户使用 `/workspaces/.gitea-create-{codespace_uuid}`。初始化标记记录 UUID、repo ID、锁定 SHA 和本次 payload 中非空的 clone URL。首选协议的 clone/fetch 非零退出且另一种 URL 非空时，只清理带当前标记的临时目录并重试一次；本地前置错误、没有备用 URL 和 HEAD 校验失败不切换协议。HEAD 等于锁定 SHA 后，脚本原子 rename 到默认 `/workspaces/{repo_name}`，并把最终绝对路径追加到 `CODESPACE_ENV`。已有无匹配标记的目标目录返回 workspace 冲突。

HTTP(S) remote 使用读取当前 Token 文件的 credential helper。payload 提供非空 SSH URL 且脚本实际尝试 SSH 前，内置脚本原子生成 Ed25519 密钥对，通过 Git SSH Key helper 登记公钥并写入可信 known_hosts。SSH 失败后回退到 HTTP(S) 成功时允许保留已经登记的公钥。SSH URL 为空表示 Gitea 当前没有启用 Codespace SSH clone，脚本不生成 Git SSH Key，也不调用 Git SSH Key helper。`resume.sh prepare` 读取共享 workspace 路径，保留用户当前 HEAD，并只恢复实际 remote 的本地凭据配置，不 clone、fetch、checkout 或探测 repository 可达性。

内置 `start.sh activate` 始终在 Incus 实例中启动内部 sshd，交互用户为 `codespace`，使用本次 `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` 原子替换授权内容，并把实际端口、用户和 Host Key 指纹追加到 `CODESPACE_ENV`。内置 `resume.sh` 读取已经提交的 `CODESPACE_WORKSPACE_DIR`，恢复当前实际 Git remote 的本地凭据和实例内 sshd，不重新探测 repository 配置，也不引入第二层容器环境。

内置脚本只安装直接运行需要的系统工具。使用内置套件时，repository 中的 `.devcontainer/devcontainer.json` 或 `.devcontainer.json` 按普通 workspace 文件保留；Docker、Node.js、devcontainer CLI 和容器端口转发工具由选择该案例的自定义脚本准备。

内置 create/resume 确认固定用户、workspace、Git remote 或实例根存储无法形成可信结果时返回 `unrecoverable_failed`；临时包安装、网络或 sshd 启动错误返回 `recoverable_failed`。内置私有状态缺失但通用 workspace 和固定直接运行结构仍可验证时由脚本重建；无法验证时按对应失败分类返回，不由 Manager 猜测恢复。

**设计如此：默认内置实现只有一种直接运行行为。**内置脚本的输入完全来自 Manager 下发的 operation payload 和共享环境，因此 create 与 resume 使用同一套可验证的依赖和恢复结果。需要 devcontainer 时，由管理员显式选择下一节的完整自定义套件，由该套件解释 repository 中的 devcontainer 配置。

实现验收点：

- [ ] apt/dnf/pacman 探测、固定 `codespace` 用户、sudo、基于非空 clone URL 的回退、实例内 sshd 和直接运行恢复全部在内置脚本测试中覆盖，不进入 Manager 核心测试。
- [ ] SSH URL 为空时内置脚本只配置 HTTP(S) remote 和 credential helper，不创建 Git SSH Key、不写 Git known_hosts、不调用 Git SSH Key helper。
- [ ] 内置脚本测试确认 repository 中的 devcontainer 文件按普通 workspace 内容保留，直接运行路径只准备固定用户、workspace、Git 凭据、internal SSH 和实际 Endpoint 端口。
- [ ] resume 保留 workspace HEAD，只恢复当前 remote 的凭据和实例内 sshd，不依赖 repository payload 或网络可达性。
- [ ] 完整自定义套件可以替换内置直接运行行为，只要通过通用结果、共享环境和 ready 校验。

## devcontainer 自定义脚本案例

项目随文档提供一套完整、可运行的 devcontainer 自定义脚本案例：

```text
examples/devcontainer/init.sh
examples/devcontainer/start.sh
examples/devcontainer/resume.sh
examples/devcontainer/README.md
```

管理员把三个路径作为完整自定义套件配置后，Manager 按本章通用顺序调用它们，并继续只传递通用脚本输入。案例自行完成以下工作：

1. `init.sh` 安装或校验 Docker、Node.js、固定版本 devcontainer CLI 和实例内端口转发工具。案例 README 列出依赖版本、取得方式和校验值；Go 发布物不携带或解释这些依赖。
2. `start.sh prepare` 使用固定 CLI 从 workspace 解析 devcontainer 配置，创建主容器，把固定 Token 文件、Git SSH、credential helper 和规范共享环境提供给容器，并按 CLI 语义执行 create 适用的 lifecycle commands。
3. `start.sh activate` 在容器中准备非 root 用户、OpenSSH 和当前 Manager 公钥，启动容器 sshd，再在 Incus 实例通信地址上建立实际端口转发；最后通过通用 `CODESPACE_INTERNAL_SSH_*` 输出提交实际端口、用户和 Host Key。
4. 案例 Endpoint helper 先把容器逻辑端口转发为 Incus 通信地址上的实际端口，再调用通用 Runtime Endpoint API。Manager 和 Gitea 只接收实际端口。
5. `resume.sh` 读取案例保存的 workspace、容器 identity、用户、转发和生命周期状态，恢复既有容器和入口；resume 阶段继续使用通用脚本输入和案例私有状态。

案例私有变量使用 `DEVCONTAINER_EXAMPLE_*` 前缀，作为不透明键值保存在 `CODESPACE_ENV`，需要的较大状态保存在 Runtime 根存储内。配置无效、有效用户为 root、用户同步失败、workspace 损坏或容器归属冲突返回 `unrecoverable_failed`；临时容器引擎、构建、包安装或网络错误返回 `recoverable_failed`。缺失或损坏案例私有状态时由案例根据自己能够证明的事实分类，Manager 只消费通用 outcome。

**设计如此：devcontainer 支持由脚本契约提供，Manager Go 代码保持通用资源编排。**案例证明自定义套件可以创建嵌套开发环境、执行 lifecycle commands、转发 internal SSH 和 Endpoint；相同契约也能承载其他容器工具或企业开发环境。Manager 只保存通用输出和不透明共享变量，因此 devcontainer CLI 版本、容器状态和恢复细节都归属于案例自身。

实现验收点：

- [ ] devcontainer 案例作为三个完整自定义脚本路径被显式配置后执行；内置配置把 repository 中的 devcontainer 文件作为普通 workspace 内容处理。
- [ ] Manager 的配置、Go 类型、RPC、本地结构化快照和状态机只表达 Incus 实例、通用脚本输入、通用结果、共享环境、internal SSH 和实际 Endpoint 端口。
- [ ] 案例通过通用结果提交凭据 UID/GID、workspace、internal SSH 和实际 Endpoint 端口；Manager 使用与内置脚本相同的 ready 校验。
- [ ] 案例的 CLI、lifecycle commands、容器恢复和端口转发由案例端到端测试覆盖；Manager 核心测试使用通用模拟自定义脚本覆盖同一契约。
- [x] stop 只停止 Incus 实例，resume 由案例恢复既有容器，delete 删除实例根存储及其中的案例状态；inventory 仍只枚举 Incus 实例。
