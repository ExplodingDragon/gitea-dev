# 数据模型

数据按所有权分为四层：Gitea 保存业务事实，Kubernetes 对象保存平台意图，PVC 保存用户环境，进程内数据只用于加速。每项事实只有一个权威来源，其他层保存可重新生成的引用或观察结果。

## 数据所有权

| 数据层 | 权威内容 | 可重建内容 |
| --- | --- | --- |
| Gitea 数据库 | 用户所有权、仓库与提交、授权、主状态、操作、Manager 绑定 | 页面展示缓存、最近指标 |
| Kubernetes API | GiteaSite、EnvironmentTemplate、Codespace CR 与当前 Pod 意图 | Pod、Service 路由观察结果 |
| PVC | 工作区、Git 私钥、Dev Container 与编辑器持久数据 | 下载缓存、临时构建文件 |
| Manager 内存 | 当前 Leader 工作集、连接和短期授权缓存 | 全部可由 Gitea/Kubernetes 重新建立 |

**设计如此：**Gitea 不保存 Kubernetes 对象详情，Manager 也不把用户业务事实转存到本地文件。这样两边可以独立升级，恢复时不需要判断多个副本谁更新。

### 实现验收点

- 每个持久字段都能明确归属于一个权威数据层。
- Manager 删除本地临时目录并重启后仍能从权威数据恢复。
- Gitea 无需访问 Kubernetes API 即可提供业务页面和权限判断。
- Pod 重建不会丢失 PVC 中的用户数据。

## Gitea 表组

Gitea 使用以下逻辑表组，具体列名和索引以模型与迁移代码为准：

| 表组 | 保存内容 |
| --- | --- |
| Codespace | 所有者、仓库与提交、环境标签、主状态、当前操作版本与时间、Runtime 身份、自动停止和日志偏移 |
| Manager | 名称、所有者、注册摘要、声明地址、标签、在线状态和最后报告时间 |
| Dev Container 模板 | 名称、说明、所有者和配置内容；所有者为零表示站点全局模板 |
| Runtime 凭据 | Gitea Token 摘要、Git SSH 公钥和轮换信息 |
| 用户 Secret | 加密值以及用户选择的仓库适用范围 |
| 仓库授权 | Codespace 对附加仓库的用户确认权限 |

纯关联表优先使用业务联合键作为主键；只有需要独立引用、分页游标或生命周期的实体才使用自增 ID。动态摘要可从规范化内容计算，不作为长期事实重复存储。

Codespace 的 Dev Container 输入采用互斥字段表达：仓库配置保存提交内路径，模板配置保存创建时确定的正文。两者必须且只能存在一个，因此配置来源可以直接推导。当前操作也采用同样原则：主状态决定 create、resume、stop 或 delete，操作开始时间是否存在决定 queued 或 running。操作创建时间为零表示当前没有操作。

Manager 的 Gateway HTTP 地址与 SSH 地址直接保存在 Manager 行中。这两个值随一次 Manager 声明整体更新，没有独立生命周期或多值关系，拆成关联表只会增加事务和查询。SSH Host Key 保存算法与指纹；指纹变化本身已经能表达密钥轮换，不重复保存一个无法参与授权判断的更新时间。

**设计如此：**数据库只保存不能可靠推导的事实。主状态、操作版本、触发来源和三个操作时间共同形成唯一状态，不再同时保存操作类型和操作执行状态，避免多列组合出“状态为 stopped 但操作类型为 create”一类无业务含义的数据。

### 实现验收点

- 关联表不存在未被引用的自增 ID。
- 全局和个人对象通过明确所有者字段区分，并有对应唯一索引。
- Dev Container 配置内容只保存一份，摘要按使用时内容计算。
- Dev Container 路径和正文恰好一个非空，并能据此确定配置来源。
- 当前操作类型与排队/执行阶段能从主状态和时间字段唯一得到。
- Manager 声明地址随 Manager 行原子更新，Host Key 指纹变化无需额外时间字段解释。
- Secret 明文采用 Gitea 加密设施保存，查询和日志不会返回明文。

## 标识与关系

Codespace 数据使用不同标识表达不同关系：

| 标识 | 分配方 | 作用 |
| --- | --- | --- |
| Gitea Codespace ID | Gitea 数据库 | 页面、权限和关系查询 |
| Runtime UUID | Manager | 跨 Gitea 站点和平台资源的全局运行身份 |
| 操作版本 | Gitea | 区分连续生命周期意图 |
| Codespace CR UID、Pod UID | Kubernetes | 区分被删除重建的控制对象与连续 Pod 实例 |
| 访问目标版本 | Agent | 区分同一 Pod 连续发布的可访问目标 |
| 交互代数 | Gitea/Manager 协议 | 撤销旧访问会话 |

Manager ID 只表示某个 Gitea 站点内的注册记录，必须与站点身份一起使用。Kubernetes 资源以站点 UID、Codespace ID 和 Runtime UUID 标签建立关系，避免不同 Gitea 实例使用相同数据库 ID 时发生冲突。

### 实现验收点

- 任何跨站点查找都包含站点身份，不能只使用 Manager ID 或 Codespace ID。
- Runtime UUID 在创建绑定后不可修改。
- 资源标签足以从 Kubernetes 对象反查其 GiteaSite 和 Codespace。
- 操作版本、对象 UID、访问目标版本和交互代数的用途不会混用。

## 事务边界与唯一性

创建事务同时保存 Codespace、初始操作和用户确认的仓库授权。推荐 Secret 的创建或授权也在提交成功前完成；实际注入值在 Runtime 请求访问材料时按当前权限读取。Manager 注册事务同时校验注册 Secret、建立 Manager 身份并保存首次声明，任何一步失败都回滚。

生命周期更新使用条件语句匹配当前状态、操作版本和 Manager 绑定。唯一索引负责阻止重复的业务关系；代码负责把冲突转换为稳定的幂等结果。数据库事务用于原子性，操作租约用于跨进程执行权，两者承担不同职责。

### 实现验收点

- 创建事务失败后不存在半条 Codespace、孤立授权或部分 Secret 更新。
- 注册失败不会消费 Secret 或留下不完整 Manager。
- 并发领取、完成和超时处理都带当前版本条件。
- 数据库支持的唯一性由索引表达，不依赖进程内全局锁。

## Kubernetes 资源模型

`GiteaSite` 和 `EnvironmentTemplate` 是集群级管理资源。每个站点使用 `codespace-<site-name>` 命名空间，命名空间内保存该站点的 Codespace CR、PVC 和 Runtime Pod。

Codespace CR 记录平台执行需要的最小意图：站点与 Codespace 关系、Runtime UUID、当前操作版本、环境模板引用和期望运行状态。观察状态记录实际 Pod、Agent 连接和最近错误。用户 Secret 通过短期投递进入 Runtime，不复制进 CR。

### 实现验收点

- 两个 GiteaSite 的资源位于不同命名空间，网络和 RBAC 可以独立限制。
- 删除 Pod 不删除 CR/PVC；删除 Codespace 的最终清理才删除持久资源。
- CR Spec 只包含执行意图，Status 只包含平台观察结果。
- Secret、Gitea Token 和 Agent 私钥不会写入 CR 或标签。

## 日志与展示缓存

操作日志按 Codespace、操作版本和单调偏移保存。追加必须匹配当前操作；读取使用偏移和上限分页。日志存储不承担状态机职责，最终状态由 Codespace 主状态表达。

CPU、内存、磁盘、Endpoint 和 ready 状态是带 Metadata 代数的展示缓存。报告必须匹配已绑定的 Runtime UUID 与当前操作，Metadata 代数只负责拒绝乱序或冲突内容。缓存过期时页面显示暂不可用，不能据此改变主状态。

### 实现验收点

- 日志偏移单调且重复追加可检测，旧操作不能继续写入。
- 日志分页有明确大小上限，删除 Codespace 时能清理对应对象。
- 展示缓存过期不触发主状态转换。
- Endpoint 缓存只含用户可见信息，不包含 Pod IP 或容器内部标识。

## 数据清理

业务删除完成后清理 Codespace 关系、凭据、日志和展示缓存。模板和 Manager 的删除先检查新建或运行中的引用；用户 Secret 删除立即影响后续凭据请求。Codespace 保存已经确认的 Dev Container 输入，因此模板后续修改只影响新建环境。

数据库迁移在一个事务内建立相关表、索引和约束，并在 Gitea 支持的数据库上产生相同关系。迁移代码独立描述当时的数据结构，使后续模型变化不会改变历史迁移。

### 实现验收点

- 删除业务对象不会遗留可继续使用的 Token 或 Open Code。
- 正在被新建流程引用的 Manager 或模板有明确的删除结果。
- 迁移独立于当前业务模型，并原子创建相关表和索引。
- SQLite、MySQL 和 PostgreSQL 的迁移结果具有相同约束。
