# 数据模型

本文定义数据归属、稳定标识和持久化不变量。具体列名、索引和自定义资源字段以 Gitea 模型、数据库迁移和 Kubernetes CRD 为准。

## 数据所有权

| 数据层 | 权威内容 | 恢复方式 |
| --- | --- | --- |
| Gitea 数据库 | 用户所有权、仓库提交、授权、业务状态、操作和 Manager 绑定 | 由 Gitea 数据库恢复 |
| Kubernetes API | 站点、环境模板、Codespace 运行意图和当前资源状态 | 由 Manager 控制器核对并收敛 |
| Codespace PVC | 工作区、Git 私钥、内部 Docker 与编辑器持久数据 | 由新的 Runtime Pod 重新挂载 |
| 组件内存 | 连接、Leader 工作集和短期授权缓存 | 从 Gitea 与 Kubernetes 重新建立 |

每项事实只有一个权威来源。展示数据可以缓存，但缓存过期只影响页面可用性，不改变业务状态。

**设计如此：**Gitea 不需要理解 Kubernetes 对象，Manager 也不保存一份 Gitea 业务数据库。恢复时先读取权威来源，再重建缓存，避免比较多个副本的更新时间。

### 实现验收点

- 每项持久数据都能指出唯一权威来源。
- Manager 丢失进程内状态后能从 Gitea 与 Kubernetes 恢复。
- Gitea 无需访问 Kubernetes API 即可执行权限判断和提供业务页面。
- Pod 重建不会丢失 PVC 中的用户数据。

## Gitea 业务数据

Gitea 持久化以下业务实体：Codespace、Manager、Dev Container 模板、运行期凭据、用户 Secret 和附加仓库授权。全局对象与个人对象使用所有者字段区分；用户只能管理自己的对象，站点管理员管理全局对象。

Codespace 保存恢复一次环境所需的确定输入：所有者、仓库与锁定提交、所选环境、当前业务状态、操作版本、Manager 与 Runtime 绑定，以及已确认的 Dev Container 来源。仓库配置以提交内路径引用；命名模板保存创建时确定的配置正文。模板之后的修改只影响新环境。

用户 Secret 加密保存，查询接口只返回名称和适用范围。Git/API 凭据只保存撤销和轮换需要的信息；明文运行材料按当前权限签发，不作为环境快照长期保存。

### 实现验收点

- Codespace 记录足以在 Gitea 重启后恢复当前业务状态和 Manager 绑定。
- 仓库配置始终绑定锁定提交，模板修改不会改变已有 Codespace。
- 全局对象与个人对象具有明确且可由数据库约束的唯一关系。
- Secret 与短期凭据明文不会出现在列表、日志或普通读取接口中。

## 平台资源

`GiteaSite` 和 `EnvironmentTemplate` 是集群级管理资源。每个站点拥有独立命名空间，其中保存该站点的 Codespace CR、PVC、Runtime Pod、身份和网络策略。

Codespace CR 保存平台执行需要的意图，包括 Gitea 关系、Runtime 身份、固定的运行配置、当前操作版本和期望状态；Status 保存控制器观察到的资源与 Agent 结果。用户 Secret 和 Gitea Token 通过短期投递进入 Runtime，不进入 CR、标签或注解。

PVC 是环境持久数据的边界。stop 删除运行工作负载并保留 PVC，delete 完成后才回收 PVC。Cache 保存可重新生成的镜像与构建数据，不属于 Codespace 业务备份。

### 实现验收点

- 不同 Gitea 站点的运行资源位于不同命名空间。
- CR Spec 表达期望，Status 表达观察结果，两者不保存业务 Secret。
- 删除 Pod 不会删除 PVC；完成 delete 后不会遗留 Codespace 持久资源。
- 清空 Cache 不影响已有 Codespace 从 PVC 恢复。

## 标识与并发

不同标识承担不同作用：Gitea ID 用于业务关系，Runtime UUID 用于跨站点运行身份，操作版本区分连续用户意图，Kubernetes UID 区分同名资源实例，访问目标版本区分连续发布的 Agent 目标。跨站点查询必须同时包含站点身份。

创建事务原子保存 Codespace、初始操作和用户确认的授权。Manager 领取、操作完成、超时与恢复使用当前状态、操作版本和绑定关系进行条件更新；数据库唯一约束负责阻止重复业务关系。操作租约控制跨进程执行权，不替代数据库事务。

**设计如此：**稳定业务身份和易变资源身份分开后，同名 Pod 重建、旧报告迟到和两个 Manager 并发领取都能被当前版本拒绝，而不需要进程内全局锁。

### 实现验收点

- Runtime UUID 绑定后保持稳定，Pod 重建产生新的 Kubernetes UID。
- 旧操作版本、旧 Pod 或旧访问目标的报告不能覆盖当前状态。
- 创建事务失败后不会留下半条 Codespace 或孤立授权。
- 并发领取与完成依靠数据库条件更新和唯一约束收敛。

## 日志、指标与清理

操作日志按 Codespace、操作版本和单调偏移追加，读取使用偏移与大小上限分页。CPU、内存、磁盘、Endpoint 和 ready 状态属于可重建的展示数据；报告必须匹配当前 Runtime 和 Metadata 代数。

delete 完成后清理 Codespace 关系、运行期凭据、日志和展示数据。用户删除 Secret 后，后续运行材料请求立即不再包含该值。数据库迁移在一个事务中建立同一功能所需的表、索引与约束，并保持独立于后续模型定义。

### 实现验收点

- 日志偏移单调，旧操作无法继续追加日志。
- 展示数据过期只显示暂不可用，不触发主状态转换。
- delete 完成后旧 Token、Open Code 和日志无法继续使用或读取。
- Gitea 支持的数据库具有相同的关系和唯一性约束。
