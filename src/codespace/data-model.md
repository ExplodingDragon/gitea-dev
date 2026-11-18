# 数据模型

本文定义数据归属、稳定标识和持久化不变量。列名、索引和自定义资源字段以模型、数据库迁移和 CRD 为准。

## 数据归属

| 数据层         | 权威内容                                              | 恢复方式                    |
| -------------- | ----------------------------------------------------- | --------------------------- |
| Gitea 数据库   | 所有权、仓库提交、授权、业务状态、操作和 Manager 绑定 | 从数据库恢复                |
| Kubernetes API | 站点、环境模板、组件、运行意图和资源状态              | 由 Manager 控制器重新核对   |
| Codespace PVC  | 工作区、Git 私钥、内部 Docker 和 IDE 数据             | 由新的 Runtime Pod 重新挂载 |
| 组件内存       | 连接、Leader 工作集和短期授权缓存                     | 从权威来源重建              |

每项持久事实只有一个权威来源。展示缓存过期只影响信息是否可见，不改变业务状态。这样恢复过程只需核对权威数据，不需要比较多个副本的更新时间。

### 实现验收点

- 每项持久数据都能指出唯一权威来源。
- Manager 丢失进程内状态后能从 Gitea 与 Kubernetes 恢复。
- Gitea 不访问 Kubernetes API 也能执行权限判断和展示业务状态。
- Pod 重建不会丢失 PVC 中的用户数据。

## Gitea 业务数据

Gitea 保存 Codespace、Manager、Manager 注册令牌、Dev Container 模板、运行期凭据、用户 Secret 和附加仓库授权。全局对象与个人对象通过所有者区分，并由查询和数据库约束共同限制可见范围。

Manager 注册令牌按所有者范围保存当前有效值，站点全局范围使用所有者 `0`，个人范围使用用户 ID。令牌只负责创建新的 Manager；每个 Manager 另存带随机盐的运行密钥摘要。范围令牌与实例密钥分开保存，使注册令牌轮换只收紧后续注册入口，不会改变现有实例的身份。删除用户时同时清理其个人注册令牌和 Manager。

Codespace 保存恢复业务状态所需的确定输入：所有者、仓库与锁定提交、环境、当前状态、操作版本、Manager 归属，以及确认后的 Dev Container 来源。仓库配置引用锁定提交中的路径；命名模板保存创建时选定的正文，之后修改模板只影响新环境。

Gitea 使用数字 Codespace ID 作为数据库、RPC、页面与日志的实例标识。Codespace 平台按 Site UID 与数字 ID 定位运行资源，外部访问别名由 Codespace CR 的 Kubernetes UID 生成。这样多个 Gitea 站点可以使用相同数字 ID，而权限与资源映射仍各自独立。

`operation_r_version` 表示最新生命周期意图，`runtime_operation_r_version` 表示当前正在运行的实例由哪一次 create 或 resume 建立。两者分开保存，是因为排队中的 stop 已经增加操作版本，但在 stop 完成前访问入口仍应只接受原运行实例的 Metadata。

个人保存的 Secret 是创建时可选的值来源，用户确认的非空值加密保存在 Codespace 记录中，恢复继续读取这份实例快照。这样修改或删除个人保存的 Secret 只影响后续选择，已有环境的运行配置保持稳定。运行期 Gitea Token 则按当前权限和生命周期签发；Open Code 只保存摘要、目标和过期时间，并由数据库事务一次消费。三类凭据分别对应实例配置、运行授权和一次访问，保留各自的存储与有效期语义。

操作创建时间和开始时间分别表达排队与已领取，执行截止时间是 Gitea 保存的当前租约边界。Manager 报告已经持久化的当前版本后，Gitea 才更新截止时间；重新下发未观察操作只读取剩余时间。尚未领取的操作没有执行截止时间：create 等待可用容量并允许用户删除，resume 等待原 Manager 并允许用户取消。`manager_id` 表示负责执行与清理的 Manager。创建失败后保留该归属，完整资源清单确认实例已清理后才解除，使失败报告和资源删除可以分别重试。

### 实现验收点

- 多个未领取的 Codespace 可以同时排队，各自具有独立数字 ID。
- 同一数字 ID 在不同站点中定位各自的 CR、路由、日志与权限。
- running 状态始终具有有效的运行实例版本；进入 stopped、failed 或 deleting 后该版本清零。
- 创建失败不会留下半条 Codespace、孤立授权或明文凭据。
- 每个范围只有最新注册令牌可用于注册；同一有效令牌可以创建多个具有独立密钥摘要的 Manager。
- 注册响应之外的查询不返回 Manager 运行密钥，Codespace Manager 不持久化注册令牌。
- 模板修改不会改变已有 Codespace 的恢复输入。
- 创建时确认的 Secret 值随实例加密保存；修改或删除个人保存的值后，实例恢复仍使用原值，空的自定义输入不注入变量。
- 未领取的 create 在容量不足时保持排队并可删除；未领取的 resume 可以取消并回到 stopped。
- 未观察 operation 的重新下发不改变执行截止时间，精确观察当前版本后才更新租约。
- create 失败后保留可诊断的 failed 记录和 Manager 归属，完整清单确认资源消失后解除归属，再按失败记录保留期限清理。
- Secret、Open Code 和运行期 Token 的明文不会出现在列表、日志或普通读取接口中。

## 平台数据

`GiteaSite`、`EnvironmentTemplate` 和 `CodespaceComponent` 是集群级资源；Codespace CR 位于站点命名空间。集群级组件适合被多个站点按 UID 引用，组件工作负载仍位于管理命名空间，避免把平台入口和缓存复制到每个站点。环境模板使用 `metadata.name` 作为 Gitea 环境标签，站点用名称和 UID 引用它；这让管理页面、Manager 声明、Gitea 调度和 Runtime 快照比较同一个标识，也允许多个站点安全共享同一模板。CR Spec 保存平台执行所需的固定输入和当前操作，Status 保存控制器观察结果。用户 Secret 和 Gitea Token 通过短期投递进入 Runtime，不写入 CR、标签或注解。

环境模板保存 Dev Container 平台附加配置、完整的出站代理 URL、直连目标和附加 CA，这些内容共同决定工作负载的构建和运行行为，适合由声明资源持续协调。平台附加配置包括 Web IDE、Features 和一份生命周期脚本。Web IDE 保存规范化的镜像引用、镜像声明的提供方标识和原始 `options` 对象；镜像为空表示关闭。新建启用 Web IDE 的模板或修改其 Web IDE 配置时，Manager 校验 OCI 元数据和选项，保留所选标签或显式摘要。创建 Codespace 时，这份配置随完整运行配置进入 `Codespace.Spec.Runtime` 快照。因此模板修改只影响后续创建，已有实例保留原镜像引用与配置；标签指向的内容可以随发布更新，需要固定程序内容时使用显式摘要。镜像格式与更新规则见 [Provider 概览](https://github.com/ExplodingDragon/gitea-codespace/blob/main/providers/README.md)。

生命周期脚本以 `build`、`start`、`stop` 参数区分最终镜像构建、每次启动和正常停止。代理需要认证时，用户名和密码使用标准 URL 用户信息表示；管理页面可以读取和编辑完整 URL，因为它本身就是管理员维护的运行配置，运行进程也必须取得同一值。Manager 从运行快照生成 Codespace 自有代理 Secret，Pod 只引用 Secret 键；Cache 的代理配置从组件声明投影到组件已有的 Secret。已有实例在停止、恢复和 Pod 重建后沿用创建时确认的脚本和网络配置。

提供方镜像通过 OCI 元数据声明身份、协议、选项 Schema、版本和来源，具体格式由 [Provider 开发指南](https://github.com/ExplodingDragon/gitea-codespace/blob/main/providers/DEVELOPMENT.md)维护。Schema 的引用保留在声明内，多架构镜像使用一致的配置语义，使 Manager 可以只读取镜像元数据完成验证。镜像建议只帮助管理员填写地址，官方与第三方提供方使用同一数据模型。

PVC 是环境数据的持久边界。stop 删除运行工作负载并保留 PVC，delete 确认清理后才回收 PVC。Cache 保存可重新生成的性能数据，不属于业务备份。

块卷初始化事实保存于 CR Status，与已有卷 UID 绑定：空值表示尚未发放格式化许可，`started` 表示已经发放，`ready` 表示文件系统检查并挂载成功。该事实不能从 PVC 中的文件推导，因为格式化可能在创建第一个文件前中断；它随 CR 保留，直到数据删除流程完成。

### 实现验收点

- 不同站点的 Codespace 资源位于不同命名空间。
- 环境模板只使用 `metadata.name` 作为环境标签，管理页面、站点引用、Manager 声明和 Runtime 快照看到同一名称。
- 站点通过名称和 UID 引用 Gateway、Cache 与环境模板，同名重建的资源不会自动取得旧授权。
- 组件配置位于 `CodespaceComponent`，组件凭据位于管理命名空间中由当前组件 UID 拥有的 Secret。
- 完整代理 URL、直连目标和 CA 可以从环境模板或 Cache 组件审计，运行 Secret 只保存可从对应声明或 Codespace 快照重新生成的环境投影。
- Codespace 创建后拥有独立代理 Secret，模板代理 URL 或 CA 的后续修改不会改变已有环境，Pod 重建继续使用同一快照。
- 生命周期脚本与环境模板一起进入 Codespace 运行快照；模板后续修改只影响新建实例。
- Web IDE 的镜像引用、提供方标识和原始 `options` 一起进入 Codespace 运行快照；关闭状态不携带镜像或配置，模板后续修改不会改变已有实例。
- 新建或修改启用的 Web IDE 配置时校验镜像元数据与选项；其他模板编辑保留已验证的配置，控制器协调和创建 Codespace 使用保存值。
- 标签引用与显式摘要均可保存；官方与第三方 Web IDE 使用同一配置和运行协议，多架构镜像的受支持平台声明一致。
- CR Spec 表达期望，Status 表达观察结果；平台长期 Secret 和 Gitea Token 不写入 CR，管理员明确配置的代理 URL 则按运行配置保存在模板和实例快照中。
- 删除 Pod 不会删除 PVC，完成 delete 后不遗留 Codespace 持久资源。
- Cache 丢失后可以回源，不影响 PVC 中的环境数据。
- 块卷初始化事实在首次设备写入前持久化，Pod 替换保留这一事实。

## 标识、并发与清理

Gitea 数字 ID 表示业务关系，Site UID 与该 ID 共同定位平台实例。操作版本区分连续用户意图，Kubernetes UID 区分同名资源实例，目标版本区分 Agent 的连续发布。Gateway 从路由快照建立外部别名到站点与 ID 的映射，Manager 上报 HTTP URL、SSH URI 和工作目录，Gitea 据此生成页面中的命令与编辑器链接。停止和恢复保留 CR，因此外部别名保持稳定。

创建事务原子保存 Codespace、初始操作和用户确认的授权。领取、完成、超时与恢复通过读取时的状态、操作版本和绑定关系进行条件更新；更新不到记录表示其他请求已经推进状态。用户活动代数独立保护活动更新和自动停止取消，因此用户活动与 Manager 操作结果可以各自收敛。

Kubernetes Status 按事实来源分工：资源控制器记录 Namespace、Pod、PVC 和条件，Agent 记录启动进度与访问目标，站点协调器记录清单代数、访问入口配置和操作确认。每次写入先读取同一 UID 的最新资源，再核对 generation、操作版本与类型或 Pod UID，并把本流程负责的字段合并到最新 Status。中止操作可以沿用原操作版本，因此版本和类型共同组成操作身份。这样 Agent 上报与控制器观察可以并行推进，Kubernetes 的 `resourceVersion` 仍负责发现真实冲突，同一次远程 Gitea 调用也不会因本地 Status 重试而重复执行。

日志按当前操作版本和单调偏移追加。指标、Endpoint 和 ready 信息属于可重建展示数据；Gitea 以持久化的运行实例版本判断它们是否属于当前 Runtime，缓存缺失不阻止已经满足业务前置条件的操作完成。delete 完成后清理业务关系、运行凭据、日志和展示数据。

Gitea 扫描和删除使用数据库主键定位 Codespace，再比较当前操作快照。数字 ID 从创建记录开始保持稳定，使排队记录也能由用户取消、已领取操作能按执行时限收敛，或随 Manager 关系清理。

### 实现验收点

- 状态写入只接受当前操作版本与类型、Pod 身份和目标版本。
- Kubernetes Status 的并发写入保留其他流程已经提交的字段；generation、操作版本或资源 UID 变化时，旧观察结果等待新一轮协调。
- 并发领取和完成依靠数据库条件更新与唯一约束只产生一个结果。
- 日志只由当前操作按单调偏移追加。
- 展示数据过期不触发主状态转换。
- stop 排队或执行期间，Endpoint 只接受建立当前运行实例的 create/resume 版本；新操作版本不能冒充新的 Runtime。
- delete 完成后旧 Token、Open Code 和日志不可继续使用。
- 排队记录可以由用户取消；已领取记录可以按执行时限收敛，Manager 删除也能清理相关记录。
- HTTP 和 SSH 外部别名由平台解析为站点与数字 ID；停止恢复保留别名，资源重建后旧 UID 的票据失效。
