# 维护与重启恢复

## 总体模型

Gitea 重启和 Manager 重启都属于日常维护事件。维护恢复不改变 codespace 主状态本身，而是影响 operation 超时判定、Runtime Metadata 重建和 Gateway session。

维护恢复使用三类数据：

| 类型 | 负责方 | 作用 |
| --- | --- | --- |
| Desired Action | Gitea | 当前 active operation，表达期望 Manager 执行的 create/resume/stop/delete。 |
| Main State | Gitea | `creating/running/stopped/deleting/failed`，表达 codespace 资源生命周期结果。 |
| Runtime Fact | Manager | `ReportInstances` 和 Runtime Metadata，表达运行侧实际资源与交互入口。 |

生命周期状态以 Gitea 数据库为准，本地 cache 和 Manager inventory 只提供运行信息。维护期间 Gitea 保持主状态稳定；Manager 恢复完成并上报完整 inventory 后，Gitea 根据事实处理差异。

## Gitea 重启恢复

Gitea 重启后从数据库恢复：

```text
codespace.status
operation_rversion
operation_type
operation_status
operation_created_unix
operation_started_unix
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
短期页面展示数据
```

启动后主状态保持：

| 主状态 | 恢复行为 |
| --- | --- |
| `creating` | 等待当前 create operation 继续上报，或等待 Manager inventory 给出运行侧事实。 |
| `running` | 主状态保持，等待 Manager 重建 Runtime Metadata；open/SSH 在 metadata 缺失时返回 rebuilding 分类。 |
| `stopped` | 主状态保持，等待 Manager inventory 确认 stopped runtime resource 仍存在。 |
| `deleting` | 等待当前 delete operation 继续上报，或等待 inventory 确认资源已缺失后物理删除。 |
| `failed` | 保持 failed。 |

Gitea 本地 cache 只承载 open token、Runtime Metadata 和短期页面展示数据。进程重启后保留数据库状态，可以减少维护重启造成的批量误失败；Runtime Metadata 由 Manager 重建，Gateway Open Token 由用户重新 open 生成。

## Manager 重启恢复

Manager 启动流程：

1. `DeclareManager(manager_runtime_state=recovering)`。
2. 扫描本地所有 Runtime 资源。
3. 生成 Runtime inventory 快照。
4. `ReportInstances(snapshot_complete=true)` 上报完整快照。
5. 继续当前 `operation_rversion` 对应的本地 operation。
6. 重建 Runtime Metadata。
7. `DeclareManager(manager_runtime_state=online)`。
8. 恢复领取新的 create/resume。

`DeclareManagerRequest` 包含：

```text
manager_runtime_state = recovering | online
```

Manager 重启后先恢复已有 Runtime 信息，再领取新的 create/resume，可以让 Gitea 中已有 codespace 平稳接回，尤其是 active operation 正在执行的 codespace。

实现验收点：

- recovering 状态写入 `codespace_manager.runtime_state`。
- recovering 期间接受 `UpdateOperation`、`UpdateLog`、`ReportInstances`、`ReportRuntimeMetadata`。
- Manager 完成本地扫描和 metadata 重建后声明 online。
- online 后恢复领取新的 create/resume。

## Runtime Inventory Reconciliation

`ReportInstances` 上报 Manager 本地 Runtime inventory。

inventory 语义：

- 上报 Manager 持有的所有 Runtime 资源，而不只是 running 进程。
- stopped workspace、volume 或可恢复实例也必须上报。
- snapshot_complete=false 只用于增量诊断，不驱动 missing 判定。
- snapshot_complete=true 表示 Manager 本轮扫描完成，Gitea 可以计算 expected/reported 差异。

Request：

```text
snapshot_id
snapshot_complete
instances:
  - codespace_uuid
    runtime_state
    observed_operation_rversion
    observed_unix
```

Gitea 计算：

```text
expected = Gitea 中绑定该 Manager 且按主状态应存在 Runtime 资源的 codespace
reported = Manager 上报的本地 Runtime 资源
extra = reported - expected
missing = expected - reported
```

Gitea 主状态决定 expected：

| Gitea 状态 | Runtime 期望 |
| --- | --- |
| `creating` 且 `manager_id=0` | 不期望，尚未领取。 |
| `creating` 且 `manager_id!=0` | 期望存在或正在创建。 |
| `running` | 期望存在且 running。 |
| `stopped` | 期望存在且 stopped/retained。 |
| `deleting` | 期望可能存在；缺失即可完成删除。 |
| `failed` | 不要求存在；若存在则按 cleanup 策略处理。 |
| 已物理删除 | 不期望。 |

数量差异来自 Gitea 记录和 Manager 本地 Runtime 列表不同。Gitea 用数据库主状态判断哪些 Runtime 应该存在，Manager 用完整快照报告本地实际列表，最后由 Gitea 返回处理指令。

## Extra Runtime 处理

extra runtime 表示 Manager 本地存在一条 Gitea 当前没有记录为应存在的 Runtime。

| 场景 | Gitea 指令 |
| --- | --- |
| Gitea 无 codespace 记录 | `cleanup_local_runtime` |
| codespace 已物理删除 | `cleanup_local_runtime` |
| codespace 绑定其他 Manager | `cleanup_local_runtime` |
| codespace 状态为 `failed` | `cleanup_local_runtime` |
| codespace 状态为 `creating` 且 `manager_id=0` | `cleanup_local_runtime` |

Gitea 记录中没有当前 Manager 对该 Runtime 的生命周期归属时，该 Runtime 属于运行侧残留资源。Gitea 返回 cleanup 指令，让 Manager 清理本地残留 Runtime。

## Missing Runtime 处理

missing runtime 表示 Gitea 记录中应该存在 Runtime 资源，但 Manager 完整快照中没有对应资源。

| Gitea 状态 | 处理方式 |
| --- | --- |
| `creating` | Manager online 且 snapshot complete 后进入 `failed`。 |
| `running` | 进入 `failed`，吊销 token。 |
| `stopped` | 进入 `failed`，因为已经无法 resume。 |
| `deleting` | 视为 cleanup 已完成，物理删除 codespace、日志和绑定数据。 |
| `failed` | 保持 failed。 |

Runtime 缺失说明 Manager 本地没有对应资源。对于 delete，缺失满足目标结果；对于 creating/running/stopped，缺失说明 Gitea 记录和运行侧事实已经无法形成可交互或可恢复的 workspace，因此进入 failed。

## Active Operation 超时

`operation_created_unix + QUEUE_TIMEOUT` 是 queued operation 等待 Manager 领取的最长时间。`operation_deadline_unix` 是 running operation 的 lease 截止时间。Manager 在截止前通过 `UpdateOperation` 续租或上报终态。

queued operation 等待超时后按当前 operation failed 处理。running operation lease 到期时按 Manager 状态判断：

| Manager 状态 | 处理 |
| --- | --- |
| online | `operation_deadline_unix` 到期后按当前 operation failed 处理。 |
| recovering | 暂缓失败，等待完整 inventory 或 Manager online。 |
| offline 且未超过 `MANAGER_RESTART_GRACE` | 暂缓失败。 |
| offline 超过 `MANAGER_RESTART_GRACE` | 按当前 operation failed 处理。 |

维护窗口属于 Manager 可用性事件，不写入每条 codespace。完整 inventory 到达后优先使用运行侧事实，不再等待 operation timeout。

## stop 恢复

Manager 重启后继续处理当前 stop operation。

| Runtime 状态 | Manager 行为 |
| --- | --- |
| Runtime 仍运行 | 继续 stop，完成后上报 done。 |
| Runtime 已停止 | 上报 done。 |
| Runtime 不存在 | 上报 failed；Gitea 根据 missing runtime 进入 failed。 |
| stop 执行失败 | 上报 failed。 |

stop 的目标是让 running codespace 退出可交互运行态，并保留可恢复资源。Runtime 不存在不满足 stopped 的可恢复语义，因此进入 failed，而不是 stopped。

## resume 恢复

Manager 重启后继续处理当前 resume operation。

| Runtime 状态 | Manager 行为 |
| --- | --- |
| Runtime 已运行且 metadata 完整 | 先上报 Runtime Metadata，再上报 done。 |
| Runtime 正在恢复 | 继续 resume 并上报 progress。 |
| Runtime 仍停止 | 继续执行 resume。 |
| Runtime 不存在或恢复失败 | 上报 failed。 |

resume 的目标是恢复可交互运行态。`running` 展示后用户会立即使用 open/SSH，因此 Manager 先重建 Runtime Metadata，再上报 resume done，可以让主状态和交互入口同步可用。

## Reconciliation

恢复证据：

```text
DeclareManager(recovering/online)
ReportInstances(snapshot_complete=true)
ReportInstances 包含 codespace_uuid
UpdateOperation 携带当前 operation_rversion
ReportRuntimeMetadata 被接受
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

实现验收点：

- Manager recovering/offline grace 内不因 operation deadline 直接失败 active operation。
- snapshot_complete=false 不触发 missing runtime。
- snapshot_complete=true 后计算 expected/reported 差异。
- extra runtime 返回 cleanup。
- missing runtime 按当前主状态处理。
- `running` 主状态在 Manager offline/recovering 时保持稳定，交互入口返回 unavailable/recovering 分类。

## Gateway Session 恢复

Gitea 重启后，已建立 Gateway session 等待下一次 revalidate。Open Token cache 丢失只影响未消费 token，用户重新从 Gitea open 可生成新的 token。

Manager/Gateway 重启后，live Endpoint session 和 SSH session 会断开。用户重新从 Gitea open 或重新 SSH；`running` codespace 主状态保持，Runtime Metadata 重建前页面展示 `metadata_rebuilding`。

长连接断开是维护重启的自然结果，workspace 生命周期由数据库状态和 Manager 恢复上报决定。用户重新 open 或重新 SSH 即可恢复交互。
