# 维护与重启恢复

## 总体模型

Gitea 重启和 Manager 重启都属于日常维护事件。重启会短暂影响本地 cache、worker、Gateway session、Runtime Metadata 或 Runtime 观测数据，codespace 主状态仍由 Gitea 数据库和 State Finalization 维护。

维护恢复使用三类数据：

| 类型 | 权威方 | 作用 |
| --- | --- | --- |
| Desired Action | Gitea | 下发 `create/resume/stop/delete` |
| Main State | Gitea | 保存 `queued/booting/running/stopping/stopped/resuming/deleting/error` |
| Runtime Observation | Manager | 上报本地 Runtime 是否存在、metadata、执行结果 |

Gitea 数据库是生命周期权威，本地 cache 和 Manager inventory 是运行观测来源。维护期间先保持数据库主状态稳定，再通过 Manager 重新上报的事实恢复交互能力或收敛差异。

实现验收点：

- Gitea 重启后保留所有 codespace 主状态。
- Manager 重启后通过 `DeclareManager(recovering)` 进入恢复流程。
- Manager 上报的 Runtime inventory 作为 reconciliation 输入。
- Gitea 根据数据库状态返回 cleanup 或继续等待的收敛结果。

## Gitea 重启恢复

Gitea 重启后从数据库恢复：

```text
codespace.status
operation_id
operation_type
operation_status
operation_deadline_unix
manager_id
token binding
日志元数据
```

本地短期数据由 Manager 或用户交互重建：

```text
Gateway Open Token cache
Runtime Metadata cache
本机锁
短期页面观测数据
```

启动后主状态保持：

| 主状态 | 恢复行为 |
| --- | --- |
| `queued` | 等待 Manager claim |
| `booting` | 等待当前 Manager 按 `operation_id` 继续上报 |
| `running` | 等待 Manager 重建 Runtime Metadata |
| `stopping` | 等待当前 Manager 上报 stop 结果 |
| `stopped` | 保持 stopped |
| `resuming` | 等待当前 Manager 上报 resume 结果 |
| `deleting` | 等待当前 Manager 上报 delete 结果 |
| `error` | 保持 error |

Gitea 本地 cache 只承载 open token、Runtime Metadata 和短期页面观测。进程重启后保留数据库状态，可以避免维护重启造成批量误失败；Runtime Metadata 由 Manager 重建，Gateway Open Token 由用户重新 open 生成。

实现验收点：

- Gitea 启动保留所有 codespace 主状态。
- 恢复窗口内接受匹配当前 `operation_id` 的 Manager 上报。
- Runtime Metadata cache 缺失时页面展示 rebuilding 分类。
- 用户重新 open 时生成新的 Gateway Open Token。

## Manager 重启恢复

Manager 启动流程：

1. `DeclareManager(manager_runtime_state=recovering)`。
2. 扫描本地 Runtime Instance。
3. 生成 Runtime inventory snapshot。
4. `ReportInstances` 上报 snapshot。
5. 继续当前 `operation_id` 对应的本地 operation。
6. 重建 Runtime Metadata。
7. `DeclareManager(manager_runtime_state=online)`。
8. 恢复领取新的 create/resume。

`DeclareManagerRequest` 包含：

```text
manager_runtime_state = recovering | online
```

Manager 重启后先恢复已有 Runtime 事实，再领取新的 create/resume，可以让 Gitea 中已有 codespace 平稳接回，尤其是正在 stop/resume 的 operation。

实现验收点：

- recovering 状态写入 `codespace_manager.runtime_state`。
- recovering 期间接受 `UpdateOperation`、`UpdateLog`、`ReportInstances`、`ReportRuntimeMetadata`。
- Manager 完成本地扫描和 metadata 重建后声明 online。
- online 后恢复领取新的 create/resume。

## Runtime Inventory Reconciliation

`ReportInstances` 上报 Manager 本地 Runtime inventory。

Request：

```text
snapshot_id
snapshot_complete
instances:
  - codespace_uuid
    runtime_state
    observed_operation_id
    observed_unix
```

Gitea 计算：

```text
expected = Gitea 中绑定该 Manager 且按主状态应存在 Runtime 的 codespace
reported = Manager 上报的本地 Runtime
extra = reported - expected
missing = expected - reported
```

Gitea 主状态决定 expected：

| Gitea 状态 | Runtime 期望 |
| --- | --- |
| `booting` | 存在 |
| `running` | 存在 |
| `stopping` | 存在，stop 完成后可消失 |
| `resuming` | 存在 |
| `deleting` | 存在，delete 完成后可消失 |
| `queued` | 无绑定 Runtime |
| `stopped` | 无运行 Runtime |
| `error` | 按清理策略处理 |
| 已物理删除 | 无记录 |

数量差异来自 Gitea 期望集合与 Manager 本地集合不同。Gitea 用数据库主状态表达期望，Manager 用 snapshot 表达事实，最终由 Gitea 返回收敛指令。

实现验收点：

- Gitea 按 `manager_id` 查询 expected。
- Manager 上报完整 snapshot 后计算 extra/missing。
- 差异分类写入审计日志或状态消息。
- reconciliation 使用差异证据推进后续动作。

## Extra Runtime 收敛

extra runtime 表示 Manager 本地存在 Gitea 当前未期望存在的 Runtime。

| 场景 | Gitea 指令 |
| --- | --- |
| Gitea 无 codespace 记录 | `cleanup_local_runtime` |
| codespace 已物理删除 | `cleanup_local_runtime` |
| codespace 绑定其他 Manager | `cleanup_local_runtime` |
| codespace 状态为 `stopped` | `cleanup_local_runtime` |
| codespace 状态为 `error` | `cleanup_local_runtime` |
| codespace 状态为 `queued` | `cleanup_local_runtime` |

Gitea 记录中没有当前 Manager 对该 Runtime 的生命周期所有权时，该 Runtime 属于运行侧残留资源。Gitea 返回 cleanup 指令，使 Manager 本地状态收敛到数据库权威状态。

实现验收点：

- extra runtime 返回 cleanup instruction。
- extra runtime 保持 Gitea 主状态稳定。
- Manager 清理完成后下一次 snapshot 中该 Runtime 消失。
- cleanup 过程写入 Manager 本地日志和 Gitea 差异审计信息。

## Missing Runtime 收敛

missing runtime 表示 Gitea 期望 Runtime 存在，但 Manager 完整 snapshot 中没有对应 Runtime。

| Gitea 状态 | 收敛行为 |
| --- | --- |
| `booting` | 恢复窗口内等待当前 create 继续上报；窗口到期进入 `error` |
| `running` | 记录 divergence，吊销 token，进入 `error` |
| `stopping` | 当前 stop operation 可上报 done，进入 `stopped` |
| `resuming` | 恢复窗口内等待当前 resume 继续上报；窗口到期进入 `error` |
| `deleting` | 当前 delete operation 可上报 done，物理删除 |
| `error` | 返回 cleanup instruction 或保持 error 记录 |
| `stopped` | 保持 stopped |

Runtime 缺失是运行侧事实。对于 stop/delete，缺失满足目标结果；对于 running/create/resume，缺失表示交互能力无法成立，需要由 Gitea 收敛到明确失败状态或等待恢复窗口内的继续上报。

实现验收点：

- missing running 由 Gitea finalization 到 `error`。
- missing stopping 通过 stop done 收敛到 `stopped`。
- missing deleting 通过 delete done 完成物理删除。
- missing booting/resuming 使用恢复窗口吸收维护重启抖动。

## stop 恢复

Manager 重启后继续处理当前 stop operation。

| Runtime 观测 | Manager 行为 |
| --- | --- |
| Runtime 仍运行 | 继续 stop，完成后上报 done |
| Runtime 已停止 | 上报 done |
| Runtime 已不存在 | 上报 done |
| stop 执行失败 | 上报 failed |

stop 的目标是让 codespace 退出可交互运行态。Runtime 已停止或已不存在都满足 stop 目标，Gitea 可以推进到 `stopped` 并吊销 active token。

实现验收点：

- stop 上报匹配当前 `operation_id`。
- stop done 后进入 `stopped`。
- stop done 同事务吊销 active token。
- stop failed 后进入 `error` 并保留日志。

## resume 恢复

Manager 重启后继续处理当前 resume operation。

| Runtime 观测 | Manager 行为 |
| --- | --- |
| Runtime 已运行且 metadata 完整 | 先上报 Runtime Metadata，再上报 done |
| Runtime 正在恢复 | 继续 resume 并上报 progress |
| Runtime 仍停止 | 继续执行 resume |
| Runtime 不存在或恢复失败 | 上报 failed |

resume 的目标是恢复可交互运行态。`running` 展示后用户会立即使用 open/SSH，因此 Manager 先重建 Runtime Metadata，再上报 resume done，可以让主状态和交互入口同步可用。

实现验收点：

- resume 上报匹配当前 `operation_id`。
- resume done 前至少一版 Runtime Metadata 被 Gitea 接受。
- resume done 后进入 `running`。
- resume failed 后进入 `error` 并吊销 token。

## Reconciliation

恢复证据：

```text
DeclareManager(recovering/online)
ReportInstances(snapshot_complete=true)
ReportInstances 包含 codespace_uuid
UpdateOperation 携带当前 operation_id
ReportRuntimeMetadata 被接受
```

配置：

```ini
GITEA_RESTART_RECOVERY_GRACE = 5m
MANAGER_RESTART_GRACE = 10m
OPERATION_RECOVERY_GRACE = 15m
DELETE_RECOVERY_GRACE = 30m
RUNTIME_METADATA_REBUILD_GRACE = 5m
```

差异分类：

```text
extra_runtime
missing_runtime
manager_mismatch
stale_operation
metadata_missing
snapshot_incomplete
```

维护重启期间，Gitea 给 Manager 时间重新上报完整事实；完整 snapshot 到达后，Gitea 按数据库主状态和当前 operation 收敛差异。这样既能吸收正常维护抖动，也能在真实差异出现时给出明确结果。

实现验收点：

- recovery window 内保留当前主状态。
- 有恢复证据时刷新 `operation_last_recovering_unix`。
- snapshot complete 后计算 expected/reported 差异。
- extra runtime 返回 cleanup。
- missing runtime 按当前主状态收敛。
- recovery deadline 到期后通过 State Finalization 推进明确结果。

## Gateway Session 恢复

Gitea 重启后，已建立 Gateway session 等待下一次 revalidate。Open Token cache 丢失只影响未消费 token，用户重新从 Gitea open 可生成新的 token。

Manager/Gateway 重启后，live Endpoint session 和 SSH session 会断开。用户重新从 Gitea open 或重新 SSH；`running` codespace 主状态保持，Runtime Metadata 重建前页面展示 `runtime metadata rebuilding`。

长连接断开是维护重启的自然结果，workspace 生命周期由数据库状态和 Manager 恢复上报决定。用户重新 open 或重新 SSH 即可恢复交互。

实现验收点：

- Gitea 重启后未消费 Open Token 可通过重新 open 补发。
- Manager/Gateway 重启后 live session 断开并可重新建立。
- Runtime Metadata 重建前页面展示 rebuilding 分类。
- `running` 主状态在恢复窗口内保持稳定。
