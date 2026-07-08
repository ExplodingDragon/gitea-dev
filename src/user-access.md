# 用户接入

## Web 页面

Web 页面只保留三类。

### Repository Codespace 入口页

```text
GET  /{owner}/{repo}/codespace
POST /{owner}/{repo}/codespace
```

作用：

- 基于当前 repository/ref 上下文创建 codespace。
- 展示当前用户在该 repository 下创建的 codespace。
- 组织仓库下展示组织管理员可管理的其他成员 codespace。
- 提供进入用户 codespace 列表页的入口。

Repository 页面可以提供 "Open in Codespace" 入口：

- repository 主页
- branch/tag 下拉菜单
- pull request 页面
- commit 页面

这些入口只提交 git 上下文，不提交 runtime 参数、image、VM/container 类型、Endpoint、SSH 或 backend 选项。

创建输入：

```text
repo_id
ref_type=branch|tag|commit|pull
ref_name
commit_sha
pull_id
```

### 用户 Codespace 列表页

```text
GET /codespace
```

该页面只展示当前用户创建的 codespace。

展示字段：

- repo
- ref
- status
- last active
- 状态摘要
- open / stop / resume / delete

列表页不读取日志文件。

### 单个 Codespace 页面

```text
GET    /codespace/{uuid}
GET    /codespace/{uuid}/logs
POST   /codespace/{uuid}/open
POST   /codespace/{uuid}/resume
POST   /codespace/{uuid}/stop
DELETE /codespace/{uuid}
```

`GET /codespace/{uuid}` 是唯一对象页面，不存在 `/boot` 或 `/create` 子页面。

`GET /codespace/{uuid}/logs` 是日志数据接口，不是独立页面。

路由行为：

- `POST /{owner}/{repo}/codespace` 成功后重定向到 `GET /codespace/{uuid}`。
- 首次 create 期间停留在同一个对象路径，只按状态切换布局。
- stop/resume 后停留在 `GET /codespace/{uuid}`。
- delete 后返回显式 `return_to`；若没有，则 repository 可见时回到 repository codespace 页，否则回到 `/codespace`。

布局：

- `queued|booting|error|首次 create 链路中的 deleting`：中心日志布局；除 deleting 外只允许 delete。
- `running|stopping|stopped|resuming|非首次 create 链路中的 deleting`：左右分栏；左侧日志，右侧控制与信息。
- `running`：按条件展示 Endpoint 与 SSH 区域。
- `stopped`：按条件展示 resume/delete。
- `error`：只展示日志和 delete。

## 权限

所有权限判断复用 Gitea 现有用户、组织、仓库、unit、visibility、blocking、restricted user、login restriction、2FA 和 repository permission 逻辑。

Gitea 登录限制至少包括：

- `is_active`
- `prohibit_login`
- `must_change_password`
- 站点强制 2FA

repository 边界复用 Gitea 现有结果：

- user blocking
- restricted user
- owner visibility
- internal/private repository visibility
- repository code unit 可读性（`CanRead(unit.Code)`）
- archived、mirror、empty、being migrated、pending transfer、broken 等 repository 状态

### Create 要求

| 条件 | 说明 |
| --- | --- |
| 登录 | 当前用户已登录 |
| 登录限制 | 满足 Gitea 登录限制（`is_active`、`prohibit_login`、`must_change_password`、站点强制 2FA） |
| 代码读取 | 拥有 repository code-read 权限（`CanRead(unit.Code)`） |
| 仓库状态 | 不处于 archived、migrating、pending transfer、broken、empty 或无法解析目标 ref/commit |

### Interactive Access 要求

适用于 `open`、SSH、`resume`：

| 条件 | 说明 |
| --- | --- |
| 身份 | 仅 codespace 创建用户本人 |
| 登录限制 | 创建用户当前仍满足 Gitea 登录限制 |
| 代码读取 | 创建用户当前仍有 repository code-read 权限 |
| 仓库状态 | 仓库当前状态允许交互访问 |
| codespace 状态 | codespace 与 Manager 状态允许该动作 |
| Endpoint | open 时 [Endpoint](glossary.md#endpoint) metadata 必须存在 |

### Administrative Permission

适用于查看最小信息、日志、stop、delete：

| 角色 | 权限范围 |
| --- | --- |
| 创建用户本人 | 始终拥有，除非已被物理删除 |
| 组织管理员 | 组织仓库下额外拥有（`IsOrganizationAdmin(ctx, orgID, userID)` 判定） |
| 普通协作者/repo 管理员 | 不获得他人 codespace 权限 |
| 组织管理员限制 | 不能进入其他用户 workspace |

管理权限不要求创建用户当前仍具备 repo code-read。

### 个人仓库与组织仓库

| 场景 | 规则 |
| --- | --- |
| 个人仓库 | 不存在 owner 代理管理他人 codespace；创建用户被删除后只保留后台清理和日志保留 |
| 组织仓库 | 创建用户失去 repo 访问、被禁用或被删除后，组织管理员仍可 stop/delete 和查看日志/最小信息 |

### Minimal Info

只允许返回：

- `uuid`
- `status`
- `status_message`
- `created_unix`
- `updated_unix`
- `stopped_unix`
- `creator_id`
- `creator_display_name`
- `creator_deleted`
- `repo_id`
- `repo_display_name`
- `repo_deleted`
- `ref_type`
- `ref_name`
- `commit_sha`
- `pull_id`
- `manager_id`
- `manager_display_name`
- `manager_online`
- `log_line_count`
- `log_size`
- `last_log_unix`
- `log_expired`
- `allowed_actions`

禁止返回：

- `gitea_token_id`
- Manager Secret
- Runtime Token
- Gateway Open Token
- `token hash / salt`
- `internal_ssh`
- Endpoint upstream
- 完整 `meta_json`
- 日志正文
- Runtime Instance 内部 host / port / user

## Endpoint 打开流程

`POST /codespace/{uuid}/open` 打开一个 Runtime Metadata Endpoint。

输入：

```text
endpoint_id=<endpoint_id>
```

规则：

- `workspace` 是唯一保留 Endpoint ID，表示默认 Web IDE。
- SSH 不是 Endpoint。
- 预览端口、服务入口和 IDE 入口都通过 Endpoint 打开。
- 除 `workspace` 外，Gitea 不定义 Endpoint 协议或产品类型。
- Gitea 不读取 Endpoint 协议、端口、进程或 upstream。
- Gitea 只校验 `endpoint_id` 存在于当前 Runtime Metadata。
- `endpoint_id` 必须匹配 `[A-Za-z0-9_-]+`。
- 不接受 `path`、任意 `redirect`、upstream、URL 或 port 参数。

Endpoint label：

- 仅供 UI 展示。
- 不参与查找、路由、授权、默认选择或日志身份。
- trim 后长度为 1 到 64。
- 禁止控制字符。
- 禁止 `<` 和 `>`。
- UI 仍必须按普通文本 escape 后展示。

默认 open：

- 当前 Runtime Metadata 存在 `endpoint_id=workspace` 时，列表页/repo 页默认 Open 打开 `workspace`。
- 不存在 `workspace` 时，默认 Open 进入 `GET /codespace/{uuid}`，让用户手动选择 Endpoint。

open 成功响应：

```text
302 Location: {manager.gateway_url}/open?open_token={token}
```

规则：

- `open_token` 是唯一授权凭据。
- Gitea 可以追加只读路由提示参数，但不凭这些参数授权。
- Gateway 调用 `ValidateOpenToken` 校验。
- Gateway 不把 `open_token` 转发给 Runtime Instance。
- Gateway access log 不记录完整 token。

## Gateway Open Token

Gateway Open Token 是：

- 短期有效
- 一次性使用
- opaque bearer token
- 非 JWT
- 不进入数据库
- 以 token hash 写入 Gitea 本地 cache
- 绑定 `user_id / codespace_uuid / generation / endpoint_id / manager_uuid`

签发算法（与现有 access_token 风格一致，使用纯随机 + sha256）：

```text
token = hex(crypto random 32 bytes)
salt = crypto random string
token_hash = sha256(salt + token)
```

设计决策：Gateway Open Token 不持久化到数据库，纯随机 + sha256 满足一次性校验需求，不需要现有 access_token 的 pbkdf2 方案（`HashToken`），也不需要 HMAC 绑定 SECRET_KEY。

规则：

- token 明文只出现在 `302 Location` 中，不落数据库和日志。
- cache 写入时若 `token_hash` 冲突，重新生成。
- hash 比较使用常量时间比较（`subtle.ConstantTimeCompare`）。
- token 校验通过本机锁串行化（get → validate → delete）。

Cache 结构：

```text
key = codespace:open-token:{token_hash}
value = user_id + codespace_uuid + generation + endpoint_id + manager_uuid + issued_unix + expires_unix
ttl = OPEN_TOKEN_EXPIRE
```

校验步骤：

1. 计算提交 token 的 hash。
2. 在本机锁保护下读取并删除 cache 记录。
3. 校验过期时间。
4. 校验调用方 Manager 身份等于 `manager_uuid`。
5. 重新读取 codespace。
6. 校验 generation 仍匹配。
7. 校验 codespace 当前为 `running`。
8. 校验用户仍具备 Interactive Access。
9. 校验 Endpoint 仍存在于当前 Runtime Metadata。
10. 校验 Manager 仍在线。
11. 校验 Manager 未被 disabled。

成功返回：

```text
user_id
codespace_uuid
generation
endpoint_id
manager_uuid
```

Cache 丢失即 token 失效，用户重新从 Gitea 发起 open。

设计决策：

- Token 是一次性跳转凭据，不需要恢复；cache 丢失只影响当次 open，不改变 codespace 生命周期状态。
- 不写数据库，避免短生命周期 token 带来的高频 DB 写入和清理成本。

Gateway session 规则：

- Gateway 维护 `codespace_uuid -> live sessions` 的本地索引。
- Gateway 和 Manager 是同一 deployment 内的一体化组件。
- Manager 执行 stop/delete 前，先通知本地 Gateway 关闭该 `codespace_uuid` 的 HTTP/WebSocket/IDE 会话。
- Manager disabled 后，本地 Gateway 拒绝新 open，并关闭该 Manager 负责的 live sessions。
- repo access lost、user access lost 后，新的 open 由 Gitea `ValidateOpenToken` 拒绝。
- 已建立 session 在下一次 Manager operation、Gateway 周期校验或 Runtime 断开时关闭。
- 不设计 Gitea 到 Gateway 的主动 callback。

## SSH 设计

SSH 是 codespace 自身稳定接入面，不是 Endpoint。

Gitea 在创建 codespace 时生成 `ssh_user`。`ssh_user` 在 codespace 生命周期内保持不变，delete 后失效且不复用。

示例：

```text
dragon+12141qwdada@1.2.3.4
```

规则：

- 只有 `running` 允许 SSH。
- `queued|booting|stopping|stopped|resuming|deleting|error` 均拒绝 SSH。
- SSH 不自动唤醒 stopped codespace。
- `ssh_password_auth_allowed` 由 Gitea 创建服务策略写入。
- `ssh_password_auth_allowed=false` 时拒绝密码认证，但不影响公钥认证。

Manager 确保 Runtime Instance 存在兼容 OpenSSH 的 sshd。

Gateway 模型：

1. 用户连接 `ssh_user@gateway_host`。
2. Gateway 解析 `ssh_user`。
3. Gateway 调用 Gitea 完成密码/TOTP 或公钥认证。
4. Gateway 确认 codespace 为 running。
5. Gateway 作为 SSH client 连接 Runtime Instance 内部 sshd。
6. Gateway 在外部 SSH 连接与内部 SSH 连接之间转发 channel。

Gateway 终止外部 SSH 并重建内部 SSH，不采用纯 TCP forwarding，也不自行实现 shell/sftp/pty。

支持的 SSH channel 能力：

- shell
- exec
- subsystem `sftp`
- `pty-req`
- `window-change`
- `signal`
- `env`
- `exit-status`
- `exit-signal`
- `auth-agent-req`
- `x11-req`
- `direct-tcpip`
- `tcpip-forward`
- `cancel-tcpip-forward`

SSH forwarding 属于 SSH 会话能力，不写入 Runtime Metadata `endpoints`。

## SSH 认证 RPC

Gateway 每次 SSH 认证尝试都调用 Gitea。不跨连接缓存密码或公钥认证成功结果。

`VerifySSHPasswordRequest`：

```text
ssh_user
password
source_ip
user_agent_or_client_version
gateway_session_id
```

若用户启用 TOTP，SSH 标准 password auth 仍只提供一个密码字段。Gateway 使用后缀约定承载 TOTP：

```text
<account_password>:totp=<6-digit-code>
```

Gitea 只在密码字段末尾匹配 `:totp=([0-9]{6})$`。匹配成功时，前缀原样作为账户密码，6 位数字作为 TOTP code。未匹配时，整个字段都作为账户密码。

WebAuthn-only 用户不能使用 SSH 密码认证，只能使用 SSH 公钥认证。

`VerifySSHPasswordResponse`：

```text
allowed
user_id
codespace_uuid
generation
failure_category
failure_retryable
```

`VerifySSHPublicKeyRequest`：

```text
ssh_user
public_key_blob
public_key_fingerprint
public_key_algorithm
source_ip
user_agent_or_client_version
gateway_session_id
```

`VerifySSHPublicKeyResponse`：

```text
allowed
user_id
codespace_uuid
generation
failure_category
failure_retryable
```

失败分类：

| 分类 | 含义 |
| --- | --- |
| `invalid_credentials` | 密码或公钥无效 |
| `login_restricted` | 用户登录受限 |
| `totp_required_or_invalid` | 需要 TOTP 或 TOTP 无效 |
| `codespace_not_found` | codespace 不存在 |
| `codespace_not_running` | codespace 未运行 |
| `ssh_disabled` | SSH 已禁用 |
| `repo_access_lost` | 仓库访问权限丢失 |
| `manager_mismatch` | Manager 不匹配 |
| `permission_denied` | 权限拒绝 |
| `internal_error` | 内部错误 |

Gitea 校验：

- `ssh_user` 映射到有效 codespace。
- codespace 为 `running`。
- 认证者是 codespace 创建用户。
- 创建用户当前允许登录。
- 密码认证满足 password 与 TOTP 要求。
- 公钥认证不要求输入 TOTP；若站点强制 2FA，用户必须已启用符合站点要求的 2FA。
- WebAuthn-only 用户不能使用 SSH 密码认证。
- repository access precondition 仍通过。
- 绑定 Manager 当前在线且未被 disabled。
- 密码认证被该 codespace 允许。
- 本地密码和 TOTP 使用 Gitea 现有校验逻辑（`twofactor.go:ValidateAndConsumeTOTP`）。
- 公钥认证解析 `public_key_blob`，并确认其通过 Gitea 现有 SSH key 模型归属于创建用户（`models/asymkey/ssh_key.go`）。
- 请求中的 `public_key_fingerprint` 和 `public_key_algorithm` 仅用于日志诊断，可以为空，不参与认证判断。
- `public_key_blob` 解析失败返回 `invalid_credentials`。
- Gateway 不单独传 fingerprint 让 Gitea 查 key。

Gateway 按 source IP、`ssh_user`、`codespace_uuid` 做限流和退避。Gitea 不新增通用 rate limiter。

Gitea 可以向 Gateway 返回失败分类用于日志和退避。Gateway 对 SSH client 只返回统一认证失败。

SSH session 规则：

- Gateway 维护 `codespace_uuid -> live SSH sessions` 的本地索引。
- Manager 执行 stop/delete 前，先通知本地 Gateway 关闭该 `codespace_uuid` 的 SSH sessions。
- Manager disabled 后，本地 Gateway 拒绝新 SSH，并关闭该 Manager 负责的 live SSH sessions。
- repo access lost、user access lost 后，新的 SSH auth 由 Gitea `VerifySSHPassword` / `VerifySSHPublicKey` 拒绝。
- 已建立 SSH session 在下一次 Manager operation、Gateway 周期校验或 Runtime 断开时关闭。
- 不设计 Gitea 到 Gateway 的主动 callback。

## 内部 SSH

每条 Manager 注册记录拥有一对固定内部 Gateway SSH key。

规则：

- Manager 声明 `gateway_internal_ssh_public_key`。
- create/resume 时将该公钥写入 Runtime Instance 内部工作用户 `authorized_keys`。
- Gateway 使用对应 private key 连接内部 sshd。
- 内部 host、port、user、host key fingerprint 通过 `POST /boot` 上报。
- 用户密码、用户公钥、TOTP 不在 Runtime Instance 内部校验。
- 内部 SSH metadata 不在普通 UI/API 输出中暴露。
