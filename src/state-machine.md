# 状态与生命周期

## 总体模型

Codespace 生命周期由三类数据共同表达：

| 数据 | 权威含义 |
| --- | --- |
| `codespace.status` | Gitea 持久主状态，表达资源生命周期结果。 |
| active operation 字段 | Gitea 当前下发给 Manager 的生命周期指令。 |
| Manager runtime fact | Manager 通过 inventory、metadata 和 transition 上报的本地运行事实。 |

动作以 active operation 为准；Manager 事实经 Gitea 校验后改变主状态。Repository 状态只参与 create 来源校验；create operation 完成、workspace 已初始化后，状态机不再因 repository 事件或访问权限变化而改变主状态。`queued`、`booting`、`stopping`、`resuming`、`metadata_rebuilding` 和 `recovering` 都是派生展示态，不写入 `codespace.status`。

Gitea 负责：

- 接收用户 create / resume / stop / delete 请求。
- 写入当前 active operation。
- 通过 `FetchOperations` 批量下发 operation。
- 校验 Manager 上报并执行 State Finalization。
- 根据 Manager runtime fact 处理不同步状态。
- 维护 `codespace.status`、active operation、token、日志和数据库事务一致性。

Manager 负责：

- 通过 `FetchOperations` 拉取 Gitea 下发的 operation。
- 执行本地 Runtime 动作。
- 通过 `UpdateOperation` 上报 lease renew、done、failed；阶段变化通过 Runtime Metadata 和日志表达。
- 通过 `ReportRuntimeMetadata` 上报 Runtime Metadata。
- 通过 `ReportInstances` 上报本地 Runtime inventory。
- 通过 `ReportRuntimeTransition` 上报本地主动 stop/resume 事实。

实现验收点：

- 所有生命周期写入都能明确归属于主状态、active operation 或 Manager fact 之一。
- Manager fact 只有通过 Gitea 校验后才能改变持久主状态。

## 主状态

持久主状态只保存资源生命周期结果：

```mermaid
stateDiagram-v2
    direction TB

    creating: 创建中
    running: 运行中
    stopped: 已停止
    deleting: 删除中
    failed: 失败

    [*] --> creating
    [*] --> failed
    creating --> running
    creating --> failed
    running --> stopped
    running --> failed
    stopped --> running
    stopped --> failed
    creating --> deleting
    running --> deleting
    stopped --> deleting
    failed --> deleting
    deleting --> [*]
    deleting --> failed
    creating --> [*]: 未绑定 delete / force delete
    failed --> [*]: 未绑定 delete / force delete
    running --> [*]: force delete
    stopped --> [*]: force delete
```

| 状态 | 含义 | 主要允许动作 |
| --- | --- | --- |
| `creating` | create 已创建，可能等待 Manager 领取，也可能正在创建 Runtime 和执行初始化。 | delete |
| `running` | Runtime 资源预期存在并运行；无 active stop/delete 且 Runtime Metadata `boot.stage=ready` 时可交互。 | open / SSH / stop / delete |
| `stopped` | Runtime 资源预期存在但不运行，可恢复。 | resume / delete |
| `deleting` | delete 已创建，正在等待 Manager 清理或正在清理。 | 无用户动作 |
| `failed` | 生命周期失败，保留日志和记录。 | delete |

`creating` 覆盖 create 排队和 boot 初始化，排队与执行中由 active operation 区分。`running` 和 `stopped` 是资源结果；stop/resume 执行时主状态不变，交互能力由 active operation 禁用。

实现验收点：

- 数据库只写入五个主状态，排队、启动、停止中和恢复中不进入 `codespace.status`。
- 每个主状态只开放表中列出的用户动作。

## Active Operation

operation 类型：

```text
create
resume
stop
delete
```

operation 状态：

| 状态 | 含义 |
| --- | --- |
| `queued` | operation 已创建，正在等待 Manager 通过 `FetchOperations` 领取。 |
| `running` | operation 已被 Manager 领取，lease 有效。 |

active operation 字段只表达当前 Gitea-issued operation：

```text
operation_rversion
operation_type
operation_status
operation_created_unix
operation_started_unix
operation_deadline_unix
```

operation 完成后不保留 `done` 或 `failed` operation 状态。Gitea 写入最终主状态，并清空 active operation 字段；失败诊断从 codespace 日志读取。

active operation 生命周期：

```mermaid
stateDiagram-v2
    direction TB

    NoOp: 无 active operation
    Queued: queued
    Running: running
    Done: 已写入目标主状态
    Failed: 已写入 failed 主状态

    [*] --> NoOp
    NoOp --> Queued: 写入 operation
    Queued --> Running: Manager 领取
    Queued --> Failed: queue timeout
    Running --> Done: final done
    Running --> Failed: final failed
    Running --> Failed: lease timeout
    Running --> Queued: delete 抢占
    Done --> NoOp: 清空 active operation
    Failed --> NoOp: 清空 active operation
```

`renew lease` 不改变 `operation_status`，仍停留在 `Running`。delete 抢占时会递增 `operation_rversion`、把主状态写为 `deleting`，并用 queued delete payload 替换原 active operation；旧版本上报返回 stale。

`operation_rversion` 是 Gitea 当前下发 operation payload 的版本。递增时机：

```text
创建 create/resume/stop/delete operation
delete 抢占当前 operation
Gitea 替换当前 active operation payload
```

不递增：

```text
FetchOperations 领取
UpdateOperation renew lease
UpdateOperation final done/failed
ReportRuntimeMetadata
ReportInstances
ReportRuntimeTransition
```

`operation_rversion` 写入 `FetchOperations` 返回数据，并由 `UpdateOperation`、`UpdateLog` 携带。Gitea 按 `codespace_uuid + operation_rversion + manager_id` 校验 operation 上报归属。旧版本上报返回 `stale_operation`，主状态不变。

实现验收点：

- 创建或替换 operation 时递增 `operation_rversion`，领取、续租和 final 不递增。
- 同一 codespace 同时最多存在一个 queued 或 running active operation。
- active operation 完成后不保存 done/failed operation 历史。

## 用户动作映射

| 当前主状态 | 用户动作 | 写入结果 |
| --- | --- | --- |
| 无记录 | create | `status=creating, operation_type=create, operation_status=queued, manager_id=0` |
| repository/ref/commit/config 前置校验失败 | 无 | 返回创建错误，不创建 codespace |
| 来源数据完整但无 Manager 匹配 | 无 | `status=failed, manager_id=0`，operation 字段为空，Gitea 写入失败摘要日志 |
| `running` | open / SSH | 不写入 operation 字段；由 Gitea 校验后直接 302 或转交 Gateway |
| `running` | stop | `status=running, operation_type=stop, operation_status=queued` |
| `stopped` | resume | `status=stopped, operation_type=resume, operation_status=queued` |
| `creating/failed` 且 `manager_id=0` | delete | 同步物理删除 codespace、token 和日志 |
| `creating/running/stopped/failed` 且 `manager_id!=0` | delete | `status=deleting, operation_type=delete, operation_status=queued`，同事务吊销 token |
| 任意未物理删除状态 | 站点管理员 force delete | 同步物理删除 Gitea 记录、token 和日志；不声明 Runtime 已清理 |
| `deleting` | 任意用户动作 | 拒绝 |

普通动作要求当前没有 active operation。未绑定 Manager 表示 create 尚未在运行侧建立受 Gitea 管理的资源，delete 直接清理 Gitea 记录。已经绑定 Manager 时，delete 是终止目标，可以抢占当前 create/resume/stop：Gitea 递增 `operation_rversion`，写入 delete operation，把主状态改为 `deleting`，并在同一事务内吊销 token。旧 Manager 使用旧版本上报时返回 stale，避免旧结果覆盖新的删除目标。站点管理员 force delete 是 Manager 永久不可恢复时的故障回收入口，必须显式确认；旧 Manager 后续上报的 Runtime 按 extra runtime 清理。

实现验收点：

- 普通动作在 active operation 存在时返回 conflict，delete 可按规则抢占。
- 无绑定 delete 同步完成，有绑定 delete 生成 queued operation 并吊销 token。

## FetchOperations

`FetchOperations` 是 Manager 批量获取 Gitea 下发动作的入口。

Request：

```text
capacity_total
capacity_available
accepted_operation_types
max_operations
observed_operations:
  - codespace_uuid
    operation_rversion
```

Response：

```text
operations:
  - operation_rversion
    codespace_uuid
    lease_deadline_unix
    log_offset
    command 分支
```

领取优先级：

```text
delete -> stop -> resume -> create
```

Fetch 先处理当前 Manager 的 running operation：enabled Manager 的相同版本出现在 `observed_operations` 时只批量刷新 lease，不下发 payload；未观察到或版本不同则恢复下发。disabled Manager 的 running stop/delete 仍按该规则恢复，running create/resume 始终返回 `abort_create|abort_resume`，不重发执行数据、不刷新 lease。然后领取新的 queued operation。所有路径都不改变 `operation_rversion`。

running operation 恢复条件：

- `codespace.manager_id` 等于当前 Manager。
- `operation_status=running`。
- enabled Manager 或 stop/delete 的 `observed_operations` 未包含相同 `codespace_uuid + operation_rversion` 时返回恢复 payload；包含时只刷新 lease。disabled create/resume 不使用 observed 抑制 abort。
- 本次 response 已加入的 running operation 也从后续恢复候选中排除。
- 返回普通执行 payload 时刷新 `operation_deadline_unix=now + lease timeout`；abort payload 不刷新。
- running operation 恢复不占 create/resume 容量，但计入 `max_operations`。
- `repo_id=0` 的 running create 不返回 repository payload，而是返回 `recover_create_without_source` 恢复指令；Manager 按本地 workspace、boot 结果和 `ready` metadata final done 或 failed。
- disabled Manager 的 running create/resume 返回对应 abort 指令；Manager 只清理本轮运行侧工作、追加摘要并 final failed。

queued operation 领取条件：

| operation | 条件 |
| --- | --- |
| delete | 已绑定当前 Manager，主状态为 `deleting`，`operation_status=queued`（不要求 `accepted_operation_types` 包含 delete） |
| stop | 已绑定当前 Manager，主状态为 `running`，`operation_type=stop`，`operation_status=queued`（不要求 `accepted_operation_types` 包含 stop） |
| resume | 已绑定当前 Manager，主状态为 `stopped`，`operation_type=resume`，`operation_status=queued`，本次声明接受 resume，容量可用，caller Manager enabled、声明 online 且未派生为 offline |
| create | 未绑定 Manager，主状态为 `creating`，`operation_type=create`，`operation_status=queued`，owner scope 匹配，tag 匹配，本次声明接受 create，容量可用，caller Manager enabled、声明 online 且未派生为 offline |

领取成功后同事务写入：

```text
operation_status=running
operation_started_unix=now
operation_deadline_unix=now + lease timeout
```

create 领取时额外写入 `manager_id`。领取不递增 `operation_rversion`。

领取实现采用与 Actions `runs-on` 相同的形态：数据库只按稳定字段粗筛 queued operation，owner scope、tag、`accepted_operation_types` 和 capacity 在 Go 内存中判断，最后用条件 UPDATE 抢占。create 不使用 SQL join 或 JSON contains 匹配 Manager tags。

单次 Fetch 在一个数据库事务内刷新 running lease、领取 queued operation 并组装 response。若加载 create 所需 repository/user 数据或构造 payload 失败，服务使用 `codespace_uuid + operation_rversion + operation_status=running + manager_id` 条件释放尚未下发的 claim：恢复 `operation_status=queued`，清空 started/deadline，create 额外恢复 `manager_id=0`。释放条件 affected rows 为 0 表示 operation 已被其他流程替换，不再覆盖当前状态。单条候选失败后继续处理本批其他候选；系统性错误回滚本次全部 claim，不返回部分 response。提交后的响应丢失由下一次 running payload 重发恢复。

批量返回规则：

- `max_operations` 必须在 `1..256`，`observed_operations` 最多 10000 条且 `codespace_uuid` 不重复；Manager 每次上报全部本地上下文完整的 running operation。
- DB 每次在所有优先级合计最多粗筛 1024 个 queued 候选，避免 operation 类型数量放大单次数据库读取。
- 总返回数量不超过 `max_operations`。
- 本次新领取的 queued create/resume 数量不超过 `capacity_available`；running 恢复和 abort 不占新容量。
- stop/delete 不占 create/resume 容量。
- create/resume 需要 `accepted_operation_types` 包含对应类型。
- stop/delete 在 Manager 满载时仍可领取。
- disabled Manager 不领取 queued create/resume；queued/running stop/delete 继续处理。
- enabled Manager 和 disabled stop/delete 已上报相同 `observed_operations` 版本时不重复下发完整 payload；disabled create/resume 仍下发 abort。
- Manager 只对本地执行上下文完整的 operation 声明 observed；缺少 payload 或 boot 结果时不声明 observed，以取得恢复命令。
- Manager 未上报、上报版本不同、或刚领取 queued operation 时返回完整 payload。
- 每个 payload 携带当前 `log_offset`；Manager 从该 offset 继续追加单文件日志。
- 单条候选 payload 构造失败不会丢弃本批已经成功组装或随后可执行的 operation。
- `accepted_operation_types` 只表达本次是否接受 create/resume；stop/delete 是绑定 Manager 必须处理的资源回收动作。
- operation 类型优先级相同时，固定按 `operation_created_unix ASC, uuid ASC` 领取。
- Manager 的 Fetch/续租周期不超过 `OPERATION_LEASE_TIMEOUT / 3`。

`FetchOperations` 领取流程：

```mermaid
flowchart TD
    fetch["FetchOperations"]
    observed["按管理态刷新可续租的 observed lease"]
    recover{"存在需重发的 running operation"}
    resend["加入普通恢复或 abort payload<br/>仅普通恢复刷新 lease"]
    limit{"达到 max_operations"}
    prepare["容量快照和 queued DB 粗筛"]
    filter{"有可领取候选"}
    sort["按优先级排序"]
    claim{"条件更新成功"}
    payload["写 running 并加入 payload"]
    done["返回当前批次"]

    fetch --> observed
    observed --> recover
    recover -- 是 --> resend
    resend --> limit
    recover -- 否 --> prepare
    limit -- 是 --> done
    limit -- 否 --> recover
    prepare --> filter
    filter -- 否 --> done
    filter -- 是 --> sort
    sort --> claim
    claim -- 否 --> filter
    claim -- 是 --> payload
    payload --> limit
```

实现验收点：

- running payload 恢复先于 queued claim，且不会重复下发 Manager 已确认的相同版本。
- disabled 后已领取的 create/resume 只下发 abort 命令，不能继续初始化或恢复。
- enabled Manager 以及 disabled stop/delete 已确认的相同版本不返回 payload，但会刷新 lease；disabled create/resume 仍返回 abort。
- DB 只粗筛稳定字段，owner/tag/type/capacity 在 Go 中判断，条件 UPDATE 决定唯一领取者。
- 单次结果遵守 `max_operations` 和 create/resume capacity 上限。
- 同优先级 FIFO、候选扫描上限和 request 数量限制得到校验。
- 已领取但未成功加入 response 的 operation 被条件释放；create 同时恢复未绑定状态。

## UpdateOperation 与 State Finalization

`UpdateOperation` 续租或上报 Gitea-issued active operation 的最终结果：

```text
renew lease
final done
final failed
```

Gitea 校验：

```text
codespace_uuid
operation_rversion
final.operation_type（final 时）
manager_id
operation_status=running
```

状态写入：

| operation | done | failed |
| --- | --- | --- |
| create | `status=running, keep token, clear active operation` | `status=failed, clear active operation, revoke token` |
| resume | `status=running, last_active_unix=now, clear active operation`（`stopped_unix` 不清零） | `status=failed, clear active operation, revoke token` |
| stop | `status=stopped, stopped_unix=now, clear active operation, revoke token` | `status=failed, clear active operation, revoke token` |
| delete | 物理删除 codespace、token、日志和绑定数据 | `status=failed, clear active operation, revoke token` |

State Finalization 在同一事务内执行：

1. 读取 codespace。
2. 校验 `operation_rversion`、`manager_id` 和 `operation_status`。
3. final 时校验请求 `operation_type` 与当前 active operation 类型一致，并校验主状态和目标结果匹配。
4. 更新 codespace 主状态。
5. 按目标主状态处理 token 生命周期绑定。
6. 写入 `stopped_unix` 等状态字段。
7. 清空 active operation 字段。
8. 封闭当前运行中日志追加窗口。

重复 final 同一 `operation_rversion` 时，Gitea 使用请求中的原 operation 类型推导目标：create/resume done 对应 running，stop done 对应 stopped，任意 failed 对应 failed。active operation 已清空且当前主状态匹配时返回 `idempotent_done`，不执行写入；不匹配时返回 `stale_operation`。codespace 已物理删除时返回 `resource_absent`；delete worker 将其视为删除已经达到目标，create/resume/stop worker 停止当前工作并清理本地 Runtime。UUID 不复用，不保存 operation 历史或 tombstone。

stop 失败进入 `failed`：Gitea 无法确认 Runtime 可交互一致性，继续允许 open/SSH 会扩大不一致风险。delete 失败进入 `failed`，用户或管理员可以再次 delete，新的 delete operation 会递增 `operation_rversion`。

token 随主状态收敛：

```mermaid
stateDiagram-v2
    direction TB

    NoToken: 无 token
    HasToken: 持有 token
    Revoking: 吊销处理中
    Cleared: 字段已清空

    [*] --> NoToken
    NoToken --> HasToken: 工作状态申请
    HasToken --> Revoking: stop done
    HasToken --> Revoking: final failed
    HasToken --> Revoking: timeout
    HasToken --> Revoking: missing runtime
    HasToken --> Revoking: 进入 deleting
    HasToken --> Revoking: 创建用户删除
    Revoking --> Cleared: 清空 id 和明文
    Cleared --> NoToken
    NoToken --> [*]: codespace 物理删除
    Cleared --> [*]: codespace 物理删除
```

`creating -> running` 不吊销 token，重复 `RequestGiteaToken` 直接返回已保存明文，二者都不改变 `HasToken` 状态。

实现验收点：

- State Finalization 同事务写主状态、token、时间戳、日志窗口和 active operation 清理。
- final 的 operation 类型与 active operation 不一致时拒绝；active 已清空时仍可按请求类型和当前状态返回确定的幂等结果。
- renew lease 刷新 deadline，final 重试返回明确幂等结果；boot stage 只通过 Runtime Metadata 和日志展示。
- delete final 物理删除后重复 final 返回 `resource_absent`，delete worker 幂等结束，其他 worker 清理本地资源，不要求历史表。

## Manager Runtime Transition

Manager 可以在没有 Gitea-issued active operation 时主动上报本地 stop/resume 事实：

```text
ReportRuntimeTransition:
  codespace_uuid
  runtime_generation
  observed_operation_rversion
  fact:
    running:
      metadata_json
      metadata_generation
    或 stopped
```

接受条件：

| 当前 Gitea 状态 | Manager fact | Gitea 行为 |
| --- | --- | --- |
| `running` 且无 active operation | `stopped` | 写 `status=stopped`，写 `stopped_unix=now`，吊销 token |
| `stopped` 且无 active operation | `running` | 写 `status=running`，要求同请求写入 Runtime Metadata |
| `running/stopped` 且有 active operation | 任意 | 返回 `current_operation_conflict`，主状态不变 |
| `creating/deleting/failed` | 任意 | 返回 `stale_operation`，主状态不变 |
| Manager disabled 且无 active operation | `stopped` | 允许 |
| Manager disabled | `running` | 返回 `manager_disabled` |

Gitea 按固定顺序检查 Manager binding、active operation conflict、Manager admin/runtime state、`observed_operation_rversion`、`runtime_generation`、主状态与 fact 兼容性，最后检查 running metadata。`observed_operation_rversion` 把事实绑定到产生它时看到的 Gitea operation 上下文，防止旧 stop/resume 事实在较新的 operation final 后才到达并覆盖新结果。版本匹配后只接受更高 runtime generation；相同 generation 且主状态已经匹配时幂等返回，不重复写主状态或 metadata；更低 generation 返回 stale generation 和当前值。全部检查通过后同事务写入主状态、Runtime Metadata 和 `runtime_generation`。`ReportRuntimeTransition` 不递增 `operation_rversion`，因为它不是 Gitea 下发的指令，而是 Manager 上报的运行事实。

主动 transition 表达 Manager 本地策略或恢复事实，不是用户动作，因此不更新 `last_active_unix`。只有用户 resume final、成功消费 open code 和成功 SSH 认证更新该字段。

实现验收点：

- active operation 存在时主动 transition 不改主状态。
- runtime generation 乱序、重复和新版本分别得到 stale、幂等和接受结果。
- 旧 `observed_operation_rversion` 的事实不能覆盖较新 operation 已写入的主状态。
- disabled Manager 只能上报符合 disabled 能力表的 stopped 事实。
- 多个条件同时失败时按固定校验顺序返回稳定分类，任何失败都不产生部分写入。

## Runtime Metadata

`ReportRuntimeMetadata` 上报当前 Runtime 快照：

```text
endpoints
internal_ssh
boot
metadata_generation
```

Runtime Metadata 写入 Gitea 本地 cache，用于页面展示、Endpoint existence check、open 和 SSH 判定。主状态和权限判断仍以数据库字段为准。

`boot.stage` 使用固定阶段并包含终态 `credential-refresh` 和 `ready`。create final done 要求当前 metadata 已为 `ready`；resume final done 和主动 running transition 可先提交 `credential-refresh`，写入 running 后由 Manager 申请新 token、刷新 Runtime credential，再递增 metadata generation 上报 `ready`。open/SSH 在 ready 前返回 `runtime_not_ready`，因此不需要增加新的持久主状态。

写入条件：

- caller Manager 与 `codespace.manager_id` 匹配。
- `metadata_generation` 高于 cache 当前版本时覆盖；相同版本且规范化内容相同时只刷新 TTL，相同版本但内容不同时返回 generation conflict，更低版本返回 stale 和 cache 当前 generation。cache miss 时接受 Manager 用正 generation 重建快照。
- `status in (creating, running, stopped)`。
- `status=stopped` 时 metadata 只用于展示保留资源信息，不提供 open/SSH。
- `status=deleting/failed` 返回 stale。

Runtime Metadata 变化频繁且可重建，放在 cache 中。cache miss 只影响展示和交互入口，不改变主状态。

Gitea 在接受请求时写入 `last_reported_unix=now`，该时间不属于 Manager 快照内容，也不参与 generation 内容比较。Manager 对 active codespace 的 metadata 刷新周期不超过 cache TTL 三分之一。

实现验收点：

- metadata cache 接受当前 Manager 的新版本快照和相同版本、相同内容的 TTL 刷新。
- cache miss 不触发主状态变更，交互入口返回 metadata rebuilding 分类。
- 本地 metadata generation 丢失时，Manager 可根据 stale detail 恢复版本基线后重报 backend 当前快照。

## 派生展示态

页面和 API 可以从持久主状态、active operation 和 Manager 运行态派生展示状态：

| 条件 | 展示态 |
| --- | --- |
| `status=creating && operation_status=queued` | `queued` |
| `status=creating && operation_status=running` | `booting` |
| `status=running && operation_type=stop && operation_status in (queued,running)` | `stopping` |
| `status=stopped && operation_type=resume && operation_status in (queued,running)` | `resuming` |
| `status=deleting` | `deleting` |
| `status=running && Manager offline/recovering` | `recovering` |
| Runtime Metadata cache miss 且 Manager online/recovering | `metadata_rebuilding` |
| `status=running` 且 metadata boot stage 不是 `ready` | `runtime_not_ready` |

同一记录满足多个条件时，展示优先级固定为：`deleting > failed > stopping/resuming/booting/queued > recovering > metadata_rebuilding > runtime_not_ready > running/stopped`。这些状态用于 UI 和失败分类，不写入 `codespace.status`。

实现验收点：

- Web 与 API 对同一数据库记录派生出相同展示态。
- 多个条件同时满足时严格使用固定优先级。

## 不同步收敛

| 不同步场景 | Gitea 行为 |
| --- | --- |
| Manager 上报旧 `operation_rversion` | 返回 `stale_operation`，主状态不变 |
| Manager 有 Runtime，Gitea 无 codespace | 返回 `cleanup_local_runtime` action |
| Manager 有 Runtime，但 `codespace.manager_id != caller` | 返回 `cleanup_local_runtime` action |
| inventory observed operation version 与 Gitea 当前值不同 | 返回 `refetch_operation(current_operation_rversion)`，本轮不使用该实例事实改写主状态 |
| Manager 保留非零旧 operation 上下文但 Gitea 当前无 active operation | 返回 `clear_operation_context(current_operation_rversion)`；Manager 只在本地版本不高于该值时清除旧 worker，不删除 Runtime |
| disabled Manager 上报 Gitea stopped、Runtime running | 返回 `stop_local_runtime`，Gitea 主状态保持 stopped |
| Gitea 期望 Runtime 存在，完整 inventory 缺失 Runtime | active create lease 有效时保持 `creating`；其他 `creating/running/stopped` 进入 `failed` |
| Gitea `deleting`，完整 inventory 缺失 Runtime | 视为 delete 完成，物理删除 |
| queued operation 超时未领取 | 当前 operation failed，写 `status=failed` 并清空 active operation |
| running operation lease 超时且 Manager online | 当前 operation failed，写 `status=failed` 并清空 active operation |
| running operation lease 超时但 Manager recovering/offline grace 内 | 暂缓失败，等待完整 inventory 或 Manager online |
| Manager 主动报 stopped，但 Gitea 有 active operation | 返回 `current_operation_conflict`，以 active operation 为准 |
| Manager 主动报 running，但缺失 Runtime Metadata | 拒绝 transition，返回 `metadata_required` |
| Runtime Metadata 丢失 | 主状态不变，open/SSH 返回 `metadata_rebuilding` |
| `creating/running` token 缺失且创建用户仍存在 | 允许 Manager 通过 `RequestGiteaToken` 获取新 token |
| 创建用户已删除且 token binding 残留 | 清理 binding，不重新签发 token |
| `stopped/failed/deleting` token 仍存在 | reconciliation 调用生命周期入口吊销 token |
| 完整 inventory generation 等于最近接受版本且 hash 相同 | 不重复已经完成的条件状态写入，但按当前数据库状态重新计算并返回 instruction |
| 完整 inventory generation 低于最近接受版本 | 返回 stale，不参与 missing 判定 |

实现验收点：

- 每种不同步场景都有唯一主状态结果或 Manager instruction。
- stale 上报和旧 generation 不会改写当前主状态。

## 超时处理

`operation_created_unix + QUEUE_TIMEOUT` 表达 queued operation 等待 Manager 领取的硬截止时间，`now >= 截止时间` 后即使 Cron 尚未运行也不能领取。`operation_deadline_unix` 表达 running operation 的 lease 截止时间；online Manager 在 `now >= deadline` 后不能普通续租或 final。Manager 通过 `UpdateOperation(renew_lease)` 或 Fetch observed 批量续租刷新 deadline。

queued operation 超时和 running operation 超时都按当前 operation failed 处理：写入 `status=failed`，吊销 token，并清空 active operation。delete 的 running operation 超时也进入 `failed`，用户或管理员可以再次 delete。

active operation lease 到期时按 Manager 状态判断：

| Manager 状态 | 处理 |
| --- | --- |
| online | 按当前 operation failed 处理。 |
| recovering 且 `now-last_recovering_unix <= MANAGER_RESTART_GRACE` | 暂缓失败，等待 Manager 完整 inventory 或 online。 |
| recovering 超过 `MANAGER_RESTART_GRACE` | 不再暂停 lease 超时，按当前 operation failed 处理。 |
| offline 且 `now-(last_online_unix+MANAGER_OFFLINE_TIMEOUT) <= MANAGER_RESTART_GRACE` | 暂缓失败。 |
| offline 超过上述 hard deadline | 按当前 operation failed 处理。 |

维护恢复是 Manager 级事件，不在每条 codespace 上保存 recovery deadline。`offline_since=last_online_unix+MANAGER_OFFLINE_TIMEOUT`，offline hard deadline 为 `offline_since+MANAGER_RESTART_GRACE`；recovering hard deadline 仍从首次 `last_recovering_unix` 起算。grace 内允许绑定 Manager 使用当前版本的首次 Fetch、renew 或 final 恢复已经到期的 lease，并原子写入新 deadline；超过 hard deadline 后拒绝恢复。完整 `ReportInstances` 到达后，Gitea 在该请求内优先使用 inventory 事实处理差异。

Cron、claim、renew 和 final 都以 `codespace_uuid + operation_rversion + operation_status` 进行条件更新。Cron 额外校验当前 Manager 不在有效 grace；并发时第一个条件更新成功者生效，后续流程按最新主状态返回 stale、idempotent 或 resource absent，不覆盖先完成的结果。

实现验收点：

- queued 和 running 分别使用创建时间与 lease deadline 超时。
- recovering 或 offline grace 内不会因 deadline 直接写 failed；recovering 超过 hard grace 后不能无限冻结 operation。
- 截止时间在业务写入中直接校验，不依赖 Cron 是否已经扫描到该记录。

## State Reconciliation

`reconcile_codespace_states` 周期运行。

职责：

- 检查 queued operation timeout。
- 检查 running operation lease。
- 检查 Manager online/offline/recovering。
- 检查并收敛 token 生命周期绑定。
- 通过 State Finalization 写入明确结果。

Runtime inventory 不持久化，extra/missing/mismatch 只在 `ReportInstances` 请求事务内计算和处理；Runtime Metadata cache miss 由交互入口实时返回 `metadata_rebuilding`。二者都不由周期任务读取或重放。这里的 State Reconciliation 是状态收敛规则集合，`reconcile_codespace_states` 只是其中处理持久数据库超时和 binding 的周期入口。

恢复证据：

```text
DeclareManager(recovering/online)
ReportInstances(完整快照)
ReportInstances 包含 codespace_uuid
UpdateOperation 携带当前 operation_rversion
ReportRuntimeMetadata 被接受
ReportRuntimeTransition 被接受
```

差异分类：

```text
extra_runtime
missing_runtime
manager_mismatch
stale_operation
current_operation_conflict
metadata_missing
metadata_required
runtime_state_mismatch
```

维护重启期间，Gitea 给 Manager 时间重新上报完整运行信息；完整 snapshot 到达后，Gitea 按数据库主状态、当前 active operation 和 Runtime inventory 处理差异。

实现验收点：

- 持久主状态只使用 `creating/running/stopped/deleting/failed`，operation 完成后清空 active operation 字段。
- `manager_id=0` 的 codespace 删除不创建 operation；已绑定 codespace 的 delete 由绑定 Manager 领取。
- `FetchOperations` 可在同一批响应中恢复 running payload 并领取多个 queued operation。
- 主动 Runtime transition、inventory 和 metadata 的旧版本均不能覆盖新事实。
- token 只在 `creating/running` 可用，进入 `deleting` 时立即吊销。
- 创建用户删除后只清理 token binding，不在工作状态自动补签。
- 展示态按固定优先级派生，不写入 `codespace.status`。
