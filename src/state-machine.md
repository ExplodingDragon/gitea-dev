# 状态与生命周期

## 主状态

用户可见状态与存储主状态使用单轴状态图：

```mermaid
stateDiagram-v2
    direction LR

    queued: 排队中 (queued)
    booting: 启动中 (booting)
    running: 运行中 (running)
    stopping: 停止中 (stopping)
    stopped: 已停止 (stopped)
    resuming: 恢复中 (resuming)
    deleting: 删除中 (deleting)
    error: 错误 (error)

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
| `queued` | 请求和 operation 已创建，正在等待 Manager 通过 `FetchOperation` 领取。 |
| `booting` | 首次 create 正在构建环境并执行 `init.sh`。 |
| `running` | Runtime Instance 正在运行，可按条件 open/SSH。 |
| `stopping` | 正在停止 Runtime Instance。 |
| `stopped` | Runtime Instance 已停止，可按条件 resume。 |
| `resuming` | 正在恢复 stopped Runtime Instance。 |
| `deleting` | 正在删除 Runtime Instance 和 Gitea 记录。 |
| `error` | 生命周期失败终态，用户可查看日志并执行 delete 完成清理。 |

规则：

- `booting` 表示首次 create 初始化。
- resume 使用 `resuming` 表示从已停止 Runtime 恢复。
- `error` 通过 delete 退出生命周期。
- `error` 后 delete 创建新的 delete operation，用于清理资源和记录。
- open、SSH、resume、stop、delete、logs 是否可用，由主状态、repo 状态、用户状态、Manager 在线状态和 Runtime Metadata 共同决定。

create 和 resume 使用不同状态，是因为首次创建包含 clone、checkout、初始化脚本和内部 SSH 配置，而 resume 复用已有 Runtime 数据。分开表达可以让日志、超时和 UI 状态对用户更准确。`error` 通过 delete 退出，是为了保持失败现场和日志可见，让用户或管理员先看清失败原因，再清理 Runtime 和记录。

## Operation 状态

Operation status 统一为：

| 状态 | 含义 |
| --- | --- |
| `queued` | operation 已创建，正在等待 Manager 通过 `FetchOperation` 领取。 |
| `running` | 已被 Manager claim，lease 有效或可续租。 |
| `done` | Manager 上报成功，且 Gitea 已完成 State Finalization。 |
| `failed` | Manager 上报失败或 Gitea 判定超时失败，且 Gitea 已完成 State Finalization。 |

Operation status 使用 `queued` / `running` / `done` / `failed` 四个值。四值模型覆盖等待、执行、成功终态和失败终态，足以支持 Manager claim、lease、stale report 和 State Finalization，同时避免引入与主状态重复的中间状态。

## State Finalization

Codespace 主状态由 Gitea State Finalization 写入。

`UpdateOperation` 只记录 operation 事实并触发 State Finalization。Manager 上报进度和终态，Gitea State Finalization 写入主状态。

State Finalization 在同一事务内执行：

1. 读取 codespace。
2. 校验 `operation_status == running`。
3. 校验当前状态转移合法。
4. 写入 `operation_status = done|failed` 和 `operation_finished_unix`。
5. 更新 codespace 主状态。
6. 更新 token 状态。
7. 写入 `stopped_unix`、`status_message`、`gitea_token_id` 等主状态字段。

`operation_status` 含义：

- `queued`：operation 已创建，正在等待 Manager 通过 `FetchOperation` 领取。
- `running`：Manager 已领取，表示有正在执行的操作。用于 stale detection、operation-bound RPC 匹配和并发保护。
- `done|failed`：operation 已完成，[State Finalization](glossary.md#state-finalization) 后主状态已推进。
- 创建新的 stop、resume 或 delete 时，`operation_type` 和 `operation_status` 在同一行覆写。
- 日志追加到同一 codespace 文件，不按 operation 切分。
- delete done 后物理删除 codespace 和日志。

主状态由 Gitea Finalization 统一写入，是因为 Manager 只掌握运行侧事实，Gitea 才同时拥有用户权限、token 生命周期、repository 状态和数据库事务。把状态推进集中在 Gitea，可以让 token 吊销、日志封闭、状态消息和主状态变化在同一事务内完成。

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

进入 `stopping`、`deleting`、`error` 的同一事务里吊销 active Gitea Token。这样可以让交互入口关闭和 token 失效同步生效，避免 Runtime 在停止、删除或失败后继续使用旧 token 访问 repository。

## State Reconciliation

`reconcile_codespace_states` 周期运行。

职责：

- 检查中间态。
- 检查 `operation_deadline_unix` 超时。
- 检查 Manager offline timeout。
- 将超时 operation 标记为 failed。
- 通过 [State Finalization](glossary.md#state-finalization) 进入 `error`。
- 吊销失效 Gitea Token。
- 写入 `status_message`。
- 处理 stale Runtime Metadata 与 ReportInstances 分歧。

规则：

- Gitea 是状态权威。Manager 上报的运行时观测数据用于展示和诊断，由 Gitea reconciliation 和 State Finalization 保持主状态一致。
- Gitea 当前为 `error` 而 Manager 报告 runtime 仍存在时，Gitea 记录 [State Divergence](glossary.md#state-divergence) 并返回 [Manager Instruction](glossary.md#manager-instruction) `cleanup_local_runtime`。
- Gitea 已物理删除 codespace 而 Manager 继续上报时，Gitea 返回 `NotFound + cleanup_local_runtime`。
- Manager 声称 runtime 不存在而 Gitea 认为 running 时，Gitea 进入 `error` 并吊销 token。
- Gitea 处于 deleting 时，只接受 delete 结果推进。

Reconciliation 负责把超时、Manager 离线和 Runtime 分歧收敛到明确状态。这样设计可以让用户看到稳定的主状态，而不是直接暴露 Manager 重启、cache 丢失或运行侧残留实例等临时观测差异。
