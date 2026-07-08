# 运行时与凭据

## Runtime HTTP API

`CODESPACE_MANAGER_BASE_URL` 是 Runtime Instance 访问 Manager Runtime HTTP API 的根地址。

Runtime HTTP API 属于 Manager 私有运行网络，不属于 Gitea 路由。

所有请求使用：

```text
Authorization: Bearer <CODESPACE_RUNTIME_TOKEN>
Content-Type: application/json
```

网络规则：

- 只允许 Runtime Instance 私网 source IP 调用。
- source IP 与 Runtime Token 同时校验。
- 禁止公网、浏览器页面或普通用户终端直接调用。

路径前缀：

```text
{CODESPACE_MANAGER_BASE_URL}/api/runtime/v1
```

最小接口：

```text
GET    /api/runtime/v1/boot
POST   /api/runtime/v1/boot
GET    /api/runtime/v1/endpoints/{endpoint_id}
POST   /api/runtime/v1/endpoints/{endpoint_id}
PUT    /api/runtime/v1/endpoints/{endpoint_id}
DELETE /api/runtime/v1/endpoints/{endpoint_id}
```

Runtime Instance 只需要获取初始化信息和声明可打开入口。生命周期状态、Gitea token、日志和 Runtime Metadata 都由 Manager 统一转接到 Gitea，接口面保持在 boot/endpoints 可减少 Runtime 与 Gitea 设计的耦合。

`GET /boot`：

- Runtime Instance 启动后调用，用于查询初始化所需的完整 boot session 信息。
- 返回 Manager 当前 Runtime Token 绑定的信息。
- 不改变 boot 状态。
- 返回内容包含：

```text
codespace_uuid
generation
operation_uuid
operation_type=create|resume
server_time_unix
workspace_dir
runtime_token_bound_source_ip
gitea_repo_clone_url
gitea_repo_web_url
gitea_base_repo_clone_url
gitea_base_repo_web_url
gitea_head_repo_clone_url
gitea_head_repo_web_url
gitea_repo_id
gitea_repo_full_name
gitea_owner_id
gitea_owner_name
gitea_owner_type
gitea_owner_display_name
gitea_ref_type
gitea_ref_name
gitea_commit_sha
gitea_pull_id
gitea_token
codespace_name
codespace_owner_name
codespace_repo_name
codespace_ssh_user
gateway_internal_ssh_public_key
```

`GET /boot` 规则：

- 这些信息由 Manager 根据 Gitea operation payload 和 Manager 本地配置组合生成。
- `workspace_dir` 由 Manager 决定，不来自 Gitea payload。
- `gitea_token` 来自 Gitea `RequestGiteaToken`。
- `codespace_name` 使用 `cs-{short_uuid}` 派生规则。
- `runtime_token_bound_source_ip` 只用于 Runtime 自检，不参与 Gitea 权限判断。

`POST /boot`：

- Runtime 初始化完成后调用一次。
- 成功后 Manager 将 boot 结果作为 create/resume operation 的完成依据之一。
- 重复调用返回 conflict，不覆盖第一次结果。
- 请求内容包含：

```text
success=true|false
stage
message
started_unix
completed_unix
```

`success=true` 时请求内容还包含：

```text
workspace_head_sha
internal_ssh_host
internal_ssh_port
internal_ssh_user
internal_ssh_host_key_fingerprint
```

`POST /boot` 规则：

- `success=true` 时，workspace checkout 到锁定 `commit_sha`。
- `success=true` 时，`workspace_head_sha == commit_sha`。
- `success=true` 时，internal SSH 信息完整，且 internal SSH 可被 Gateway 连通。
- `success=false` 时，Manager 将 create/resume operation 标记 failed。
- `POST /boot` 不上报 Endpoint。
- boot 完成后，Runtime 仍可增删改 Endpoint，但不能再次 `POST /boot`。

Endpoint API：

- `GET /endpoints/{endpoint_id}` 查询单个 Endpoint 当前声明，不存在返回 404。
- `POST /endpoints/{endpoint_id}` 创建 Endpoint，已存在返回 conflict。
- `PUT /endpoints/{endpoint_id}` 更新 Endpoint，不存在返回 404。
- `DELETE /endpoints/{endpoint_id}` 删除 Endpoint；不存在返回 204。
- `endpoint_id` 必须匹配 `[A-Za-z0-9_-]+`。
- `workspace` 是默认 Web IDE 保留 ID。
- 删除 `workspace` 允许；UI 默认 Open 会退回 codespace 详情页。

Endpoint create/update 请求体：

```text
label
upstream_scheme
upstream_host
upstream_port
upstream_path
health
```

Endpoint API 规则：

- `label` 会进入 Gitea Runtime Metadata。
- `upstream_*` 只保存在 Manager/Gateway 内部状态，不上报 Gitea。upstream 是 Manager/Gateway 内部网络细节，可能包含私网地址和本地路径；Gitea 只需要 Endpoint 是否存在、展示 label 和可选 health。
- `health` 可选；若上报 Gitea，只作为 UI 展示，不参与授权。
- 每次 Endpoint create/update/delete 后，Manager 重新生成当前 Runtime Metadata 快照并调用 `ReportRuntimeMetadata`。
- Gitea 不保存 upstream。

## Runtime Metadata

`ReportRuntimeMetadata` 只写当前 Runtime Metadata 快照。

允许的结构：

```json
{
  "runtime": {
    "internal_ssh": {
      "host": "10.0.0.12",
      "port": 2222,
      "user": "coder",
      "auth_mode": "publickey",
      "host_key_fingerprint": "SHA256:..."
    }
  },
  "endpoints": [
    {
      "endpoint_id": "workspace",
      "label": "Workspace"
    },
    {
      "endpoint_id": "app-3000",
      "label": "App 3000"
    }
  ],
  "boot": {
    "stage": "run-init-script",
    "message": "running init script",
    "started_unix": 0,
    "last_update_unix": 0
  },
  "resource_usage": {
    "cpu": "unavailable",
    "memory": "unavailable",
    "disk": "unavailable",
    "network": "unavailable"
  },
  "last_reported_unix": 0
}
```

规则：

- `endpoints` 不建独立表。
- `internal_ssh` 不在普通 UI/API 输出中暴露。
- `endpoint_id` 由 Manager 上报并确保在同一 `codespace_uuid + generation` 内唯一。
- 不同 codespace 或不同 generation 可以使用相同 `endpoint_id`。
- `label` 只用于 UI 展示，可以重复，不是路由键。
- `health` 可以作为 Endpoint 可选展示字段，不参与授权。
- Runtime Metadata 不持久化到数据库，只保存在 Gitea 本地 cache。
- key：`codespace:runtime-meta:{codespace_uuid}:{generation}`
- value：当前 generation 的 `endpoints + internal_ssh + boot + resource_usage + last_reported_unix`
- ttl：`MANAGER_OFFLINE_TIMEOUT * 2`
- 只要所属 Manager 在线，Gitea 即信任当前 cache 中的 Runtime Metadata。
- Gitea 信任 Runtime Metadata cache 仅表示展示和 Endpoint existence check 信任 cache，不表示绕过 codespace 主状态校验。
- Gitea 重启或本地 cache 丢失后，Runtime Metadata 由 Manager 重建。
- Manager 离线时，不允许新的 Endpoint 打开动作。
- Manager 离线时，不允许新的 SSH 接入。
- resource usage 是可选展示信息。
- 缺失 resource usage 时显示 `unavailable`。
- Runtime Metadata 不保存历史，cache miss 只影响交互与展示，不直接推进主状态。
- Manager 在 `POST /boot` 成功或失败后、Endpoint create/update/delete 后、Manager 重启重建 active Runtime Metadata 后、周期 refresh 时调用 `ReportRuntimeMetadata`。
- Runtime Instance 不直接调用 Gitea 上报 Runtime Metadata。

设计决策：

- Runtime Metadata 是动态观测数据，不是 lifecycle 事实。cache miss 只影响展示和交互入口，不推进或回滚主状态。
- 主状态只能由 operation finalization 和 reconciliation 写入，避免运行时观测数据绕过状态机。

## Gitea Token

Codespace Gitea Token 复用 Gitea 现有 `access_token` 模型（`models/auth/access_token.go`）。

设计依据：

- 参考 Gitea Actions 的 token 认证与 repository 绑定模型。
- Actions 现有实现先把 task token 识别为内部 actor，再在 repository 权限判定阶段按 `task.RepoID` 校验目标 repository；同 repo 允许正常权限，跨 repo 再按额外限制收紧。
- Codespace 采用同类设计：继续复用现有 `access_token` 与 `write:repository` scope，再增加 `codespace.repo_id` 绑定校验。
- Gitea 现有 access token scope 只有 category 级（位图实现，如 `write:repository`），没有单仓库 scope。把"能做 repository 类操作"和"只能访问哪个 repository"拆开，才能在不扩展通用 token 系统的前提下得到可执行且可追踪的边界。

规则：

- token 归属于 codespace 创建用户。
- 所有 codespace token 统一签发 `write:repository`。
- 这是 repository 类能力开关，不限定单仓库范围，也不提升创建用户原有 repository 权限。
- `codespace.gitea_token_id` 指向当前 active access token。
- `codespace.repo_id` 是唯一 repository binding。
- Runtime clone、fetch 和 push 只使用 Git HTTP(S) clone URL。
- Runtime 不使用 Gitea Git SSH clone URL。
- Git HTTP 认证链路识别 codespace-bound token。
- repository 访问只在现有支持 token/basic auth 的入口做 repo binding 校验。
- API v1 repository routes 在 `APIContext.TokenCanAccessRepo(repo)` 或同等公共入口追加 codespace-bound token 校验。
- Web/git HTTP 在 `CheckRepoScopedToken(ctx, repo, level)` 或同等公共入口追加 codespace-bound token 校验。
- 显式启用 `AllowBasic` 或 `AllowOAuth2` 的 repository HTTP 路径复用上述公共校验入口。
- 上述入口在 scope 校验外，额外校验 `target_repo_id == codespace.repo_id`。
- codespace-bound token 只能访问 `codespace.repo_id`；访问其他 repository 时即使 token scope 正常允许，也拒绝。
- codespace token 不授予 `read:user`、`read:organization` 或其他非 repository scope。
- Runtime 需要的 owner/org 展示信息由 Gitea 在 create/resume 时作为只读环境变量注入，不通过 codespace token 调用通用 user/org API。
- 每次 create/resume 都替换 token。
- stop/delete/error/source repo 删除/user 删除时吊销 token。
- 只有 `booting`、`running`、`resuming` 允许持有 active token；`stopped`、`deleting`、`error` 不允许申请或继续使用 token。
- 同一 `codespace_uuid + generation` 只允许保留一个 active token。
- 同一 generation 重复 `RequestGiteaToken` 时，Gitea 先吊销旧 token，再签发新 token，并更新 `codespace.gitea_token_id`。

删除保护：

- 被 `codespace.gitea_token_id` 引用的 access token 不允许手动删除。
- 用户设置页和 API token 列表展示该 token 被 codespace 使用。
- 这是对现有 access token 管理页的 codespace 扩展（增加占用状态展示），不引入新的 token 类型。
- UI/API 显示该 token 当前被哪个 codespace 占用。
- 手动删除返回：
  - Web：提示先 stop/delete 对应 codespace。
  - API：`409 Conflict`。
- 删除保护在 `DeleteAccessTokenByID` 或其统一服务入口执行，Web、API 和当前 token 删除都走同一判断。
- 只有 codespace 生命周期服务可以吊销/删除该 token。
- codespace 生命周期服务使用专用内部入口 `DeleteAccessTokenByIDForCodespaceLifecycle(ctx, tokenID, codespaceID)` 删除。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 必须校验 `codespace.gitea_token_id == tokenID`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 在同一事务内清空或更新 `codespace.gitea_token_id`。
- `DeleteAccessTokenByIDForCodespaceLifecycle` 不能暴露给 Web/API handler 直接调用。
- reconciliation 负责清理 codespace 已不存在但 token 仍标记占用的异常状态。

## Runtime Token

Runtime Token 只由 Manager 生成和校验。

Gitea：

- 不签发 Runtime Token。
- 不保存 Runtime Token。
- 不校验 Runtime Token。
- 不在 ManagerService RPC 中接收 Runtime Token。

Runtime Token 只用于 Runtime Instance 调用 Runtime HTTP API。

设计决策：

- Runtime HTTP API 属于 Manager 私有面，不是 Gitea route。
- Gitea 不需要理解 Runtime Token，也不把 Runtime Token 纳入 Gitea token 生命周期。
- Manager 可以把 Runtime Token 与本地 Runtime Instance、source IP 和 generation 绑定。

## Manager Secret

manager secret 用于认证已注册 Manager 调用 ManagerService RPC。

规则：

- 只在 `RegisterManager` 响应中返回一次。
- 由 Manager 保存在本地配置。
- Gitea 只保存 hash/salt。
- 使用常量时间比较（`subtle.ConstantTimeCompare`）。
- registration secret 和 manager secret 是两个不同生命周期的凭据。
- registration secret 只用于 `gitea-codespace register` 调用 `RegisterManager`。
- manager secret 只用于已注册 Manager 调用后续 ManagerService RPC。
- 重置 registration secret 只影响尚未消费的注册凭据，不影响任何现有 Manager 的 manager secret。
- 已注册 Manager 的 manager secret 继续有效，除非管理员显式重置该 Manager 的 manager secret、禁用 Manager，或物理删除 Manager 记录。
- manager secret 明文只在 `RegisterManager` 成功或管理员显式重置该 Manager secret 时展示一次。
- Manager secret reset 是针对单个 Manager 的管理动作。
- reset 时 Gitea 生成新的 manager secret hash/salt，旧 manager secret 立即失效。
- Manager 需要更新本地配置后重新 `serve` 或重新 `DeclareManager`。
- 不提供 Manager 自助 rotate RPC；manager secret reset 只能由具备管理权限的 Gitea 用户触发。
