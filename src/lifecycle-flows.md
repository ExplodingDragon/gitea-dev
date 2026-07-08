# 生命周期流程

## 创建流程

### Ref 解析

Create 支持：

| 参数 | 说明 |
| --- | --- |
| `ref_type` | `branch` / `tag` / `commit` / `pull` |
| `ref_name` | ref 标识：`branch` → 分支名；`tag` → 标签名；`commit` → 完整 commit SHA；`pull` → PR ref 路径（如 `refs/pull/42/head`） |
| `commit_sha` | 指定 commit SHA |

Gitea 校验步骤：

1. 校验 repository 可见性和 code-read 权限。
2. 校验 repository 状态。
3. 打开 git repository 并确认非空。
4. 解析并锁定最终 commit SHA。
5. 校验目标 ref/commit 存在且可解析。
6. PR 入口属于 base repository 页面。

Pull Request 规则：

- PR 入口属于 base repository 页面。
- `ref_type=pull` 时从 Gitea 数据加载 PR。
- base repository 必须等于路由 repository。
- 创建用户必须能读取 base repository。
- head repository 不同时，创建用户也必须能读取 head repository。
- 锁定 commit 必须能从 head repository 解析。
- 必要时 operation payload 同时包含 base/head clone URL 与 web URL。
- Manager tag matching 和 `.gitea/codespace.yaml` 使用 base repository。

### Repository Codespace 配置

配置文件：

```text
.gitea/codespace.yaml
```

唯一字段：

```yaml
tag: default
```

规则：

- 配置只从 branch tree 读取。
- `ref_type=branch`：读取该 branch。
- `ref_type=pull`：读取 PR base branch。
- `ref_type=tag`：读取 repository default branch。
- `ref_type=commit`：读取 repository default branch。
- 文件缺失等价于 `tag=default`。
- 空仓库在读取配置前已被拒绝。
- YAML 非法时 create 失败。
- 未知字段忽略，create 日志中提示当前只识别 `tag`。
- `tag` 必须匹配 `[A-Za-z0-9_-]+`。
- `tag` 解析后 lower-case。
- `tag` 确定 create 时的 Manager tag matching。stop、resume、delete 按已绑定的 `manager_id` 执行，不看 tag。
- 实际 checkout commit 仍按用户选择的 branch/tag/commit/PR 锁定 SHA。
- `.gitea/codespace.yaml` 中的 `tag` 字段用于选择 Manager。实际 checkout 以用户选择的 branch/tag/commit/PR 确定的 `commit_sha` 为准。
- tag/commit 场景读取 default branch，避免任意历史 commit 改变 Manager 选择。
- PR 场景使用 base branch，让目标仓库维护者控制运行侧选择；实际代码仍按用户选择的 ref 锁定到具体 commit SHA。

### Manager 匹配

- create 记录固定 `repo_tag`。
- enabled Manager 参与 tag 匹配。
- 没有 enabled Manager 支持 `repo_tag` 时，create 直接失败。
- create 创建时不绑定具体 Manager。
- 具体 `manager_id` 只在某个 Manager 通过 `FetchOperation` 成功领取 create [Operation](glossary.md#operation) 时写入。
- 有匹配 Manager 但全部离线、满载、不调用 `FetchOperation`，或调用 `FetchOperation` 但声明不可接收 create 时，create 保持 `queued`（参见 [Manager Capacity](glossary.md#manager-capacity)）。

使用统一 Manager 池，repository 只需要通过 tag 描述运行侧能力需求。Manager 不按 owner/org/repo scope 分组，避免 repository、owner/org 删除流程与 Manager 生命周期互相耦合。

Create operation claim：

- claim 前：`codespace.manager_id=0`，`codespace.operation_status=queued`。
- `FetchOperation` 原子 claim。
- claim 同时写入 `codespace.manager_id`、`codespace.operation_status=running`、`codespace.operation_deadline_unix`，并将 codespace 从 `queued` 推进到 `booting`。
- claim 条件包含 caller Manager enabled、caller Manager 支持 `repo_tag`、本次 `FetchOperation` 声明可接收 create、`codespace.manager_id=0`、`codespace.status=queued`。
- 本次 `FetchOperation` 的 `capacity_available` 必须大于 0。
- Gitea 不在 claim、`done|failed` 或 timeout 时修改 `last_capacity_total / last_capacity_available`。
- claim 成功后，operation 归属不可被后续 `DeclareManager` 覆盖。
- 并发 claim 失败不是系统错误。

### Boot 与 Init

`booting` 是首次 create 的唯一环境初始化状态。

Codespace Manager 在 Runtime Instance 启动后以 `init.sh` 作为唯一初始化入口。

`init.sh` 负责：

- 通过 `GET /boot` 获取初始化所需信息
- 配置 git 凭据
- 使用 Git HTTP(S) clone URL clone 或复用 workspace 目录
- fetch 目标 ref
- checkout 到锁定 commit SHA
- 校验 HEAD 等于锁定 commit SHA
- 准备 OpenSSH
- 将 `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` 写入内部工作用户 `authorized_keys`
- 启动内部 sshd
- 启动默认 Web IDE 或其他本地服务
- 通过 `POST /boot` 上报初始化结果与 internal SSH metadata
- 通过 `/endpoints/{endpoint_id}` 创建、更新或删除 Endpoints

### 环境变量

必需环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `GITEA_REPO_CLONE_URL` | 仓库 Git HTTP(S) clone URL |
| `GITEA_REPO_WEB_URL` | 仓库 Web URL |
| `GITEA_BASE_REPO_CLONE_URL` | PR base 仓库 clone URL（非 PR 场景可空） |
| `GITEA_BASE_REPO_WEB_URL` | PR base 仓库 Web URL（非 PR 场景可空） |
| `GITEA_HEAD_REPO_CLONE_URL` | PR head 仓库 clone URL（非 PR 场景可空） |
| `GITEA_HEAD_REPO_WEB_URL` | PR head 仓库 Web URL（非 PR 场景可空） |
| `GITEA_REPO_ID` | 仓库 ID |
| `GITEA_REPO_FULL_NAME` | 仓库完整名称（如 `owner/repo`） |
| `GITEA_OWNER_ID` | 仓库 owner ID |
| `GITEA_OWNER_NAME` | 仓库 owner 名称 |
| `GITEA_OWNER_TYPE` | 仓库 owner 类型（user/org） |
| `GITEA_OWNER_DISPLAY_NAME` | 仓库 owner 展示名称 |
| `GITEA_REF_TYPE` | ref 类型（branch/tag/commit/pull） |
| `GITEA_REF_NAME` | ref 名称 |
| `GITEA_COMMIT_SHA` | 锁定的 commit SHA |
| `GITEA_TOKEN` | Gitea access token，用于 git 操作 |
| `CODESPACE_UUID` | codespace UUID |
| `CODESPACE_NAME` | 派生名称，格式 `cs-{short_uuid}` |
| `CODESPACE_OWNER_NAME` | codespace 创建者名称 |
| `CODESPACE_REPO_NAME` | 仓库名称 |
| `CODESPACE_WORKSPACE_DIR` | 工作目录路径（由 Manager 注入） |
| `CODESPACE_MANAGER_BASE_URL` | Runtime HTTP API 基础 URL（由 Manager 注入） |
| `CODESPACE_RUNTIME_TOKEN` | Runtime Token（由 Manager 注入） |
| `CODESPACE_GATEWAY_INTERNAL_SSH_PUBLIC_KEY` | Gateway 内部 SSH 公钥 |

可选环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `CODESPACE_BOOT_LOG_PATH` | boot 阶段日志写入路径 |

环境变量规则：

- `CODESPACE_NAME` 由 `codespace.uuid` 派生（`cs-{short_uuid}`），每次展示时计算。
- `CODESPACE_NAME` 生成规则固定为 `cs-{short_uuid}`，其中 `short_uuid` 取 `codespace.uuid` 前 12 位。
- UI 展示名称使用同一派生规则。
- delete 后 `CODESPACE_NAME` 不复用。
- Runtime Instance name 由 Manager 用 `codespace_uuid` 本地生成，`CODESPACE_NAME` 作为补充标识。
- Runtime Instance name 仍由 Manager 用 `codespace_uuid` 本地生成。
- `CODESPACE_WORKSPACE_DIR`、`CODESPACE_MANAGER_BASE_URL` 和 `CODESPACE_RUNTIME_TOKEN` 由 Manager 创建 Runtime 时注入。

Boot 完成条件：

- `init.sh` 成功。
- workspace checkout 到锁定 commit SHA。
- internal SSH 可被 Gateway 连通。
- `internal_ssh.host / port / user / host_key_fingerprint` 已上报。
- 至少一版 Runtime Metadata 被 Gitea 接受。
- 若存在 Web IDE，对应 Endpoint 已上报。

推荐 boot stage：

```text
prepare-runtime
configure-ssh
configure-git
clone-repository
checkout-commit
run-init-script
start-ide
report-endpoints
```

## 外部变化

### Repository 删除

Repository archived、migrating、pending transfer、broken、deleted、git 不可读或 ref 不可解析时，进入以下受限模式：create、resume、open、SSH 均不可用；logs、stop、delete 仍按 Administrative Permission 可用。

Repository 删除：

- repository 删除确认 UI 提示会清理或影响的 codespace 数量。
- repository 删除成功页或确认摘要展示受影响的 codespace 数量。
- repository 删除在 `repo_service.DeleteRepository` / `DeleteRepositoryDirectly` 删除 DB repository 记录前执行 codespace pre-cleanup。
- 对引用该 repository 的关联 codespace，repository 删除事务内：
  - 吊销 Gitea Token，open/SSH/resume 不可用。
  - 写入 `status_message=source repository deleted; cleanup required`。
  - codespace 已绑定 Manager 且 Manager 记录存在时创建 delete operation 并进入 `deleting`。
  - codespace 从未绑定 Manager 或 Manager 记录不存在时进入 `error`。
- disabled Manager 也允许领取已绑定给自己的 delete operation。
- Manager offline 时，只要 Manager 记录仍存在，仍创建 delete operation 并进入 `deleting`，等待 Manager 回来领取。
- delete timeout 后进入 `error`。
- repository 删除事务创建的 delete operation 不依赖 repository row 生成 payload。
- repository DB 记录删除后，Manager 仍能通过 `codespace_uuid` 领取 delete operation 并完成 Runtime cleanup。
- source repository 删除后，相关 codespace 列表和详情页显示 `source repository deleted`。
- repository 删除不发送站点通知。

### Owner/User/Org 删除

- owner 删除前，Gitea 现有流程先处理该 owner 下 repositories。
- 删除该 owner 下 repository 时按 repository 删除规则处理。
- Manager 和 registration token 的归属与管理独立于 owner 或 organization。owner/org 删除操作不级联删除 Manager 或 registration token。
- owner/org 删除触发 repository 删除流程，codespace 由 repository 删除规则处理对应的生命周期。
- 某用户只是其他组织仓库 codespace 创建者时，不阻止组织存在。
- 创建用户删除后 token 被吊销，open/SSH/resume 不可用。
- 组织管理员可清理组织仓库下的相关 codespace。

### Manager 删除

- 普通管理操作只允许禁用 Manager。
- 物理删除 Manager 记录前确认没有未删除 codespace 引用该 Manager。
- 物理删除 Manager 记录前确认没有 active operation 绑定该 Manager。
- 禁用 Manager 与 codespace 生命周期状态更新不在同一事务里批量改写；后续 open/SSH/resume/claim 根据 Manager disabled 状态实时拒绝。
- 物理删除 Manager 是管理清理动作，不负责 Runtime Instance 清理。
- 物理删除 Manager 只注销 Gitea 注册身份，不向 Manager 下发删除指令。
- Manager 记录被物理删除后，后续 ManagerService RPC 按 unregistered manager 返回 unauthenticated。
- Runtime cleanup 通过 codespace delete operation 实现，不能由删除 Manager 记录隐式触发。
- 物理删除 Manager 前先清理引用它的 codespaces 和未完成 operations。

### 重命名

- ID 是权威关联。
- 名称每次展示时解析。
- create/resume operation payload 使用当时当前名称重新生成 clone/web URL。
- 显示缓存和 runtime 动态数据按需从 cache 或 Manager 获取，每次展示时计算。
