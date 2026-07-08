# 状态与生命周期

## 主状态

用户可见状态与存储主状态使用单轴状态图：

```mermaid
stateDiagram-v2
    direction LR

    queued: queued
    booting: booting
    running: running
    stopping: stopping
    stopped: stopped
    resuming: resuming
    deleting: deleting
    error: error

    [*] --> queued
    queued --> booting
    booting --> running
    running --> stopping
    stopping --> stopped
    stopped --> resuming
    resuming --> running
    queued --> deleting
    booting --> deleting
    running --> deleting
    stopping --> deleting
    stopped --> deleting
    resuming --> deleting
    error --> deleting
    deleting --> [*]

    queued --> error
    booting --> error
    stopping --> error
    resuming --> error
    deleting --> error
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `queued` | 请求和 operation 已创建，但尚未被 Manager 通过 `FetchOperation` 成功领取。 |
| `booting` | 首次 create 正在构建环境并执行 `init.sh`。 |
| `running` | Runtime Instance 正在运行，可按条件 open/SSH。 |
| `stopping` | 正在停止 Runtime Instance。 |
| `stopped` | Runtime Instance 已停止，可按条件 resume。 |
| `resuming` | 正在恢复 stopped Runtime Instance。 |
| `deleting` | 正在删除 Runtime Instance 和 Gitea 记录。 |
| `error` | 生命周期失败终态，用户只能 delete。 |

规则：

- `booting` 只能由 create 进入。
- resume 不进入 `booting`。
- `error` 不回到正常状态。
- `error` 后 delete 会创建新的 delete operation 并递增 generation，不视为 retry。
- open、SSH、resume、stop、delete、logs 是否可用，由主状态、repo 状态、用户状态、Manager 在线状态和 Runtime Metadata 共同决定。

## Operation 状态

Operation status 统一为：

| 状态 | 含义 |
| --- | --- |
| `queued` | operation 已创建，但尚未被任何 Manager 通过 `FetchOperation` 成功领取。 |
| `running` | 已被 Manager claim，lease 有效或可续租。 |
| `done` | Manager 上报成功，且 Gitea 已完成 State Finalization。 |
| `failed` | Manager 上报失败或 Gitea 判定超时失败，且 Gitea 已完成 State Finalization。 |

不使用 `leased`、`succeeded`、`cancelled`、`attempts`、`max_attempts`、`retry`。

## State Finalization

Codespace 主状态只能由 Gitea State Finalization 写入。

`UpdateOperation` 只记录 operation 事实并触发 State Finalization。Manager 永远不能直接覆盖 codespace 主状态。

State Finalization 在同一事务内执行：

1. 读取 codespace 和 operation。
2. 校验 `active_operation_id`。
3. 校验 `generation`。
4. 校验当前状态转移合法。
5. 应用 operation 终态结果。
6. 更新 codespace 主状态。
7. 更新 token 状态。
8. 写入 `stopped_unix`、`status_message`、`gitea_token_id` 等主状态字段。
9. 清空 `active_operation_id`。

`active_operation_id` 含义：

- `active_operation_id` 只表示当前未完成 lifecycle [Operation](glossary.md#operation)。
- lifecycle [Operation](glossary.md#operation) 处于 `queued|running` 时，`active_operation_id` 指向该 operation。
- lifecycle [Operation](glossary.md#operation) 进入 `done|failed` 并完成 [State Finalization](glossary.md#state-finalization) 后，`active_operation_id` 清空。
- 创建新的 stop、resume 或 delete operation 时，`active_operation_id` 写入新 operation。
- 日志展示通过历史 operation 记录查询，不依赖 `active_operation_id` 保留。
- delete done 后物理删除 codespace、[Operation](glossary.md#operation) 和日志。

状态推进：

| Operation 结果 | 状态变化 |
| --- | --- |
| create done | `booting` -> `running` |
| create failed | `queued` / `booting` -> `error` |
| resume done | `resuming` -> `running` |
| resume failed | `resuming` -> `error` |
| stop done | `stopping` -> `stopped` |
| stop failed | `stopping` -> `error` |
| delete done | `deleting` -> physical delete |
| delete failed | `deleting` -> `error` |

超时：

| 超时类型 | 状态变化 |
| --- | --- |
| queue timeout | `queued` -> `error` |
| boot timeout | `booting` -> `error` |
| resume timeout | `resuming` -> `error` |
| stop timeout | `stopping` -> `error` |
| delete timeout | `deleting` -> `error` |

进入 `stopping`、`deleting`、`error` 的同一事务里吊销 active Gitea Token。

## State Reconciliation

`reconcile_codespace_operations` 周期运行。

职责：

- 检查中间态。
- 检查 active [Operation](glossary.md#operation) deadline。
- 检查 Manager offline timeout。
- 将超时 [Operation](glossary.md#operation) 标记为 failed。
- 通过 [State Finalization](glossary.md#state-finalization) 进入 `error`。
- 吊销失效 Gitea Token。
- 写入 `status_message`。
- 处理 stale Runtime Metadata 与 ReportInstances 分歧。

规则：

- Gitea 是状态权威。
- Manager 观测事实不能恢复 Gitea 主状态。
- Gitea 当前为 `error` 而 Manager 报告 runtime 仍存在时，Gitea 记录 [State Divergence](glossary.md#state-divergence) 并返回 [Manager Instruction](glossary.md#manager-instruction) `cleanup_local_runtime`。
- Gitea 已物理删除 codespace 而 Manager 继续上报时，Gitea 返回 `NotFound + cleanup_local_runtime`。
- Manager 声称 runtime 不存在而 Gitea 认为 running 时，Gitea 进入 `error` 并吊销 token。
- Gitea 认为 deleting 时，任何非 delete 上报都不能改变状态。
