# RPC 接口

本文定义跨进程职责、安全边界和重试语义。Gitea 与 Manager 的公共接口以 `codespace-proto-go` 为准；Manager、Agent、Gateway、Cache 与 Runtime 命令之间的接口由 `codespace/internal/rpc` 维护。两类接口分别归属跨仓库业务边界和 Codespace 内部运行边界，因此可以独立演进。

## 服务边界

| 服务                     | 调用方向                | 协议归属             | 职责                                                   |
| ------------------------ | ----------------------- | -------------------- | ------------------------------------------------------ |
| `ManagerService`         | Manager → Gitea         | `codespace-proto-go` | Manager 身份、生命周期、运行材料、日志、状态和访问判定 |
| `ComponentService`       | Gateway/Cache → Manager | Codespace 内部       | 组件配置、访问授权、Agent 票据和 Cache 维护许可        |
| `AgentControlService`    | Agent ↔ Manager        | Codespace 内部       | Runtime 命令、结果、心跳和日志                         |
| `AgentAccessService`     | Gateway ↔ Agent        | Codespace 内部       | Shell、命令、SFTP、HTTP 和回环端口转发                 |
| `RuntimeEndpointService` | Dev Container → Agent   | Codespace 内部       | 通过本地 Unix socket 管理 HTTP Endpoint                |
| `RuntimeUSBIPService`    | Dev Container → Agent   | Codespace 内部       | 通过本地 Unix socket 执行受限 USB/IP 客户端操作        |

Gitea 接口只表达 Codespace 业务语义；Kubernetes、Pod 和缓存后端留在 Manager 与内部协议。平台使用同一个二进制交付各组件，但 Manager、Agent、Gateway、Cache 和 Runtime 命令运行在不同进程或 Pod 中，仍需要明确的进程间通信。生成代码和调用端统一使用 Connect v2，通过 HTTP 传输适配器承载 Connect/gRPC，复用双向流、取消、背压、消息限制和 mTLS，避免维护额外的自定义传输格式。身份从请求元数据传入认证上下文，协议版本在接收消息时校验，业务方法直接接收和返回 Proto 消息。

### 实现验收点

- 每个请求都能从认证上下文和消息确定调用者与目标。
- 未知协议版本返回明确错误，不进入业务处理。
- Gitea 协议不包含 Kubernetes 调度或容器网络配置。
- Gitea 与 Codespace 使用同一已发布协议版本。
- 公共协议模块只生成 `codespace/v1`，内部协议只能由 Codespace 导入。

## Gitea 控制面

`RegisterManager` 使用范围注册令牌换取 Manager ID 和独立运行密钥。该方法不携带 Manager 身份请求头，因为身份正是在这次交换中建立；协议版本、令牌和名称仍在服务端校验。注册令牌可重复用于同一范围的多台 Manager，运行密钥只属于一次注册结果。这样管理面可以直接完成接入，而后续所有 RPC 仍具有稳定、可撤销的实例身份。

注册完成后，Manager 声明自身、领取和完成操作，上报日志、Runtime 信息与资源清单，并按需请求运行材料。领取、续期、日志和完成请求携带当前操作版本；running 状态的 Runtime 报告携带建立当前实例的 create/resume 版本。Runtime UUID 由 Manager 在领取 create 后生成，Gitea 通过数据库唯一约束完成一次绑定。

Runtime 信息还携带主 Dev Container 解析完成后的 `workspaceFolder`。Agent 把它与访问目标一起上报，Manager 保存到 Codespace 状态后再放入公共 Runtime Metadata，Gitea 据此生成 VS Code 和 Zed 的 SSH 打开地址。选择解析后的容器路径，是因为 Dockerfile、Compose、Feature 和变量替换都可能改变编辑器实际应打开的位置；主机工作区路径不能表达这个结果。该字段属于可重建的运行事实，由 Kubernetes Codespace 状态持久化并在 Gitea 中按 Runtime Metadata 缓存。启动阶段可以尚未取得路径，发布 ready 时必须同时提供有效的绝对容器路径。

`FetchOperations` 使用至少一次交付。`ObservedOperation` 表示 Manager 已经把该 Runtime UUID 和操作版本持久化到 Kubernetes，并持有当前版本的本地执行许可，而不是仅在内存中收到消息。Gitea 对精确匹配当前版本的观察记录续租；未观察或低版本观察会在现有租约内重新返回当前 payload，返回的有效期是数据库租约的剩余时间。Manager Leader 重启后通过一次重新下发恢复本地许可；确定拒绝撤销许可，失败提交暂时不可达时仍会再次收到同一 payload。这个定义使请求和响应丢失可以安全重试，也确保尚未接受或已经拒绝的操作不会因轮询自动延长。

`FinalizeOperation` 使用 Codespace ID、操作版本、类型和认证 Manager 定位业务操作。Runtime 已绑定时还必须精确匹配 Runtime UUID；未绑定 create 的确定性失败使用空 Runtime UUID 提交，使错误能够在分配运行身份前收敛。过期、重复或已经被新操作替代的最终报告按幂等成功处理，但不能修改当前状态。采用 Codespace ID 作为基础定位，是因为 create 在绑定前还没有 Runtime UUID，而数据库业务行已经具有稳定身份。

没有任务的轮询返回正常空结果。高频成功轮询可以省略普通 HTTP 请求日志，错误仍保留诊断信息。

`RuntimeResourceUsage` 表达完整的 CPU、内存和磁盘观察，`observed_unix` 是参与计算的最早采样时间。Manager 组合完整快照并保持发布时间递增，使 Gitea 可以按同一时间判断整组统计是否仍有效。来源选择、换算和过期规则由[运行资源统计](runtime-platform.md#运行资源统计)定义，Gitea 只消费最终展示结果。

ManagerService 的请求和响应统一限制为 32 MiB，两端直接使用公共协议包中的常量。传输限制与 Kubernetes 单个持久化对象的大小限制分别生效：前者容纳资源清单等批量消息，后者控制资源保存成本。

### 实现验收点

- `RegisterManager` 只接受有效范围注册令牌并返回新的 Manager ID、运行密钥、规范名称和 Gitea Web 地址。
- 除 `RegisterManager` 外，ManagerService 方法都要求有效的 Manager ID 与运行密钥。
- 注册令牌重置不改变已经签发的运行身份。
- Manager 凭据只能操作对应的 Manager 记录。
- 领取、续期、日志、Runtime 报告和完成都校验当前绑定与版本。
- 未观察或低版本观察返回当前 operation 且不延长租约，精确观察当前版本才返回续租结果。
- `FinalizeOperation` 始终携带 Codespace ID；已绑定操作同时匹配 Runtime UUID，未绑定 create 只接受失败终态和空 Runtime UUID。
- 每个 Runtime UUID 只绑定一个 Codespace，未绑定请求可以正常排队。
- 运行材料按请求时的用户和仓库权限生成。
- create/resume 完成不依赖展示缓存命中，后续 Runtime 报告必须匹配持久化的运行实例版本。
- ready Runtime Metadata 包含主 Dev Container 的解析后工作目录；Manager 重启或 Endpoint 更新后仍能从 Codespace 状态恢复同一路径。
- 资源上报使用现有完整消息；同一次快照的时间反映最早参与观察，缺少必要指标时沿用有效快照或等待后续采集。
- 两端接受相同大小范围的 RPC 消息，资源保存仍执行自己的对象大小校验。

## 组件与 Agent

Gateway 和 Cache 使用各自身份连接 Manager，并接收版本化配置；发现版本缺口时重新获取完整快照。Gateway 建立用户流前请求业务授权和短期 Agent 票据。Cache 按配置限制上游、缓存范围和维护动作。

Agent 以当前 Codespace CR 和 Pod 身份建立控制流。生命周期命令绑定操作版本，日志使用独立的批量 RPC，避免大量输出阻塞控制命令。Agent 先把执行阶段和结果原子写入 PVC，再向 Manager 上报，重连时复用已经完成的结果。诊断日志使用下述内存发送流程，与执行事实的持久化分别处理。

Agent 资源报告只包含当次采集成功的指标，缺失项由 Manager 保留仍有效的既有观察。Manager 按来源和指标缓存这些临时数据，组合后才对 Gitea 上报完整统计，因此单项采集失败不会被误解为零使用量。

块卷挂载前使用 `PrepareVolume` 请求确认。Manager 根据 mTLS 身份读取当前 CR、Pod 和 PVC，并校验操作许可；首次请求持久记录格式化已开始后返回成功，挂载后确认请求把状态更新为就绪。这个独立请求发生在工作区可写之前，使卷初始化也能获得持久化保护，Agent 仍只访问 Manager 服务。

Cache 控制流用递增序号关联请求和确认。Manager 首次获取或后续续约对应 Lease 成功后返回正的许可时长；后续独立配置推送的许可时长为零。客户端仅消费一次对应发送记录，并用发送时间计算到期，避免响应延迟或重放延长旧执行者的权限。Cache GC 的完整时序见[运行平台](runtime-platform.md#cache)；其关键协议语义是：凭据只有在最晚到期时间登记成功后才返回，维护许可携带持久化的 `ReadyAt`，已有凭据可以在该时间前完成一次跨多个 HTTP 请求的镜像推送。

控制流重连或 Manager 重启时，未完成维护沿用原 `ReadyAt`，不重新延长凭据窗口；完成清理后才恢复新凭据发放。这个边界只扩展 Cache 内部控制确认的时间语义，不增加 Gitea RPC、公共 Proto 或 Kubernetes CRD。

Gateway 使用按能力签发的短期票据访问 Shell、命令、SFTP、HTTP Endpoint 或回环端口。Shell 与命令是两种独立能力，因为 SSH Shell 请求可以在没有 PTY 时通过标准输入接收脚本，而命令请求携带需要由登录 Shell 求值的明确内容。PTY 是这两种请求都可以附带的终端属性。这样 Agent 可以按实际请求签发和校验票据，VS Code Remote-SSH 等客户端也能通过无 PTY Shell 执行初始化脚本。Dev Container 通过挂载的 Unix socket 管理 Endpoint，不需要访问 Manager 网络端口。

远程转发复用同一票据模型，监听和接受连接使用两种独立能力。`ReverseTCPListen` 的目标是容器 TCP 绑定或 USB/IP 来源二选一；Agent 创建监听后返回 `reverse_tcp_ready.port`。普通绑定使用主容器网络命名空间，USB/IP 使用 Agent 回环随机端口。后续监听流报告连接 ID，Gateway 为每个连接建立独立 Access 流。监听 ID 和连接 ID 仅在当前 Runtime 内存中有效；全部待接受和已建立连接共享现有上限，未在 30 秒内领取的待接受连接释放。

`Access` 的 `accepted` 表示 Shell、命令或 SFTP 的 Docker exec 已成功附着，或者 TCP 目标已实际连接。HTTP Endpoint 与 SSH 回环转发共用 TCP 消息语义：`stdin` 与 `stdout` 传输数据，`stdin_eof` 只结束向目标发送，`stdout_eof` 只表示目标停止发送，`exit_status` 表示执行结束。两个方向分别结束，因此 HTTP Transport 能及时发现上游空闲连接关闭，SSH 客户端也能在收到 EOF 后继续发送剩余输入。stderr 保持为容器进程的独立诊断通道，SFTP 适配器最多保留 4 KiB 诊断用于失败说明；TCP 拨号和传输错误直接通过 RPC 返回。

Agent 直接在授权目标容器的网络命名空间中创建 TCP socket，再通过 Access 流转发数据。SSH 本地转发选择主容器，HTTP Endpoint 使用当前访问目标中保存的容器 ID，因此 Compose 辅助服务也能使用同一实现。普通反向监听复用同一套命名空间查询。每次创建 socket 都读取 Docker 的当前运行 PID，并打开对应的网络命名空间句柄；进入命名空间完成创建后即释放句柄，数据传输由 socket 保持原网络归属。

正向拨号在锁定的系统线程上依次尝试字面量 `127.0.0.1` 和 `::1`，共用 15 秒期限。显式指定地址族是为了让 socket 创建始终发生在目标命名空间，避免域名解析和并行拨号创建的新 goroutine 使用 Agent 网络。正反向 TCP 共用流转发逻辑，单条 RPC 消息上限为 256 KiB，输出最多按 32 KiB 分块。请求取消、Runtime 停止或执行目标替换时，取消正在进行的拨号并关闭已建立连接；普通 Endpoint 列表更新保留其他有效数据流。

`RuntimeUSBIPService` 与 Endpoint 服务共用挂载到主 Dev Container 的 Agent Unix socket。创建和恢复时根据 Kata/VHCI 能力安装平台 CLI，插件据此显示功能。客户端提供 `sources`、`list [--source name]`、`attach <bus-id> [--source name]`、`status`、`detach <port>`。Agent 根据来源注册记录调用标准 `usbip --tcp-port <分配端口>`，容器内调用者只需选择来源。仅有一个来源时 attach 可以自动选择，多个来源时必须指定。list 对来源并行查询，最多四个命令同时执行，共用 30 秒总期限，单个来源失败保留其他结果。插件子进程期限为 35 秒；来源关闭会取消仍在执行的对应命令，已建立设备流的生命周期独立于短命令期限。

内部响应携带来源名、监听 ID、实际端口及命令输出。CLI 的 sources/list/status JSON 为 `version: 1`、`sources` 和 `devices`，来源项包含 `name` 和可选 `error`，注册仅表示 SSH 入口存在。设备通过 `(source, busId)` 区分，包含 `description` 及可取得的 `vendorId`、`productId`。status 保留标准 usbip 输出中的远端地址和端口来匹配来源，并提供数值 VHCI `port` 和 `state`；零是有效端口，来源或远端记录缺失时对应字符串为空，仍可按 VHCI 端口解绑。无法识别的单来源列表输出记录为来源错误，status 格式错误明确失败，避免把解析失败显示为空列表。

`stop_listening` 停止新连接并关闭尚未领取的连接，Agent 完成后发送 `exit_status=0`；Gateway 等待已经发起的 SSH channel 打开完成后确认取消。普通 TCP 已建立连接保留到各自数据流结束，USB/IP 来源则同时关闭设备连接，使内核感知设备移除。SSH 连接断开会取消其所有数据流；Runtime 停止或主容器更换会统一回收监听和连接。监听控制流意外失败结束所属 SSH 连接，以便客户端明确发现转发失效。本地 Unix socket 与回环来源入口属于当前工作区信任接口，跨组件授权来自 SSH、Manager 票据和 Agent mTLS。

内部 Proto 生成到 `codespace/internal/rpc`，从 Go 包边界上阻止其他仓库依赖运行实现。需要跨越 Gitea 与 Manager 的业务类型由公共协议定义，内部协议直接引用这些类型，避免维护重复消息。

### 实现验收点

- Gateway 与 Cache 分别使用绑定自身角色的身份和能力。
- 控制流重连后可以从完整快照恢复配置。
- 控制流建立失败和运行中断都进入现有重连流程，取消请求会释放连接。
- Agent 票据只适用于一个 Runtime、Pod、目标版本和访问能力。
- 无 PTY Shell 能持续读取标准输入直到 EOF；命令请求必须携带非空命令，二者不能共用同一能力票据。
- TCP 目标连接成功前不会发送 `accepted`，Shell、命令与 SFTP 在 exec 附着后发送确认。
- TCP 数据先于对应方向的 EOF 到达，单向 EOF 保留反向传输，stderr 不进入 HTTP、WebSocket 或 SFTP 数据。
- 请求取消能够取消尚未完成的 Dial，并释放已建立的 TCP 连接；Runtime 停止和执行目标替换执行相同清理。
- TCP 连接与传输错误通过 RPC 返回，Shell、命令和 SFTP 保留 exec 退出状态；正常 TCP 结束保留独立的半关闭语义。
- IPv4-only 和 IPv6-only 服务都在目标容器中连接；Agent 同端口的回环服务不会被选中，Compose Endpoint 连接其实际所属容器。
- 日志队列满或上传失败时，控制命令和执行结果继续按生命周期事实推进。
- 单项资源采集成功即可更新对应缓存；发往 Gitea 的统计仍是完整快照。
- Dev Container 可以通过本地 socket 增删和查询 Endpoint。
- 普通 TCP 与 USB/IP 共享监听管理和半关闭传输；监听与接受使用独立票据，普通监听取消保留已建立连接，USB/IP 来源取消关闭对应设备流。
- 多个转发在同一 SSH 连接共存，取消确认后不再打开该绑定的新 channel；来源重连使用新监听 ID，旧清理不影响新来源。
- 本地 USB/IP API 提供 sources/list/attach/status/detach，选择来源和 VHCI 端口；来源名重复明确失败，多个来源的同名设备通过来源加 bus ID 区分。
- 创建和恢复都按当前能力安装或清除平台 USB 命令，插件据此展示功能；短命令超时会结束该次执行，已建立的数据连接使用会话生命周期。
- JSON 查询区分无来源、来源查询失败和空设备列表；已导入设备保留 VHCI 端口零，来源断开后仍可查询和断开设备。
- 来源查询共用总期限，单个来源失败不隐藏其他设备；来源关闭会取消对应的短命令并清理设备流，其他来源保持在线。
- 公共业务类型在公共协议中只有一份定义。
- `PrepareVolume` 只接受当前身份和操作许可；格式化请求重复调用明确失败，挂载成功确认可重复提交。
- Cache 许可来自一次成功获取或续约租约的对应确认；发送、等待和服务运行均受许可到期控制。
- Cache 凭据只有在其到期时间登记成功后才返回；维护冻结新凭据，已有凭据在 `ReadyAt` 前覆盖 blob、HEAD 和 manifest 的完整多请求写入。
- `ReadyAt` 在控制流重连和 Manager 重启后保持，清理完成、失败或许可过期后才恢复凭据发放。
- GC Lease 的最近完成时间在控制连接轮换后仍有效，最小间隔内不会重复触发清理。

## 操作日志

Manager 是向 Gitea 提交日志的唯一主体。基础设施进度在 Manager 内产生，Agent 的阶段与命令输出通过 `UploadLogs` 提交；两种来源进入同一操作的内存队列，按 Manager 接收顺序发送，保留各行原始时间戳。这让 Pod 创建之前就有进度，同时把偏移和网络重试集中在发送层。

Agent 在入队前完成凭据脱敏、UTF-8 整理和拆行，单行最多 32 KiB。Agent 输出与 Manager 诊断共用脱敏实现，同时识别已知凭据的原文、URL 编码、Base64 和 JSON 转义形式；多行凭据按整体及各行处理，因为日志既可能来自命令输出，也可能来自序列化的状态消息。队列达到 64 行或约 128 KiB 时发送；低流量通过 1 秒定时器形成批次，持续产生新日志不会重置等待时间。每批 RPC 携带协议版本、操作版本和日志行，Manager 校验当前 Pod 身份、操作版本和批次大小后入队。回复表示已处理接收请求；实际到达 Gitea 的时间由独立发送流程决定。Agent 请求出错或回复丢失时放弃该批次，因为 Manager 可能已接收，后续批次继续提交。

Agent 每操作的队列预算为 1 MiB；Manager 每操作为 1 MiB、全部操作合计为 64 MiB。预算包含正在上传的数据和行记录开销。达到预算时丢弃新日志，在随后有空间时追加汇总的丢失行数。日志是诊断信息，接受进程重启、网络异常或内存满时的少量缺失，换取生命周期执行和资源使用的可预测性。队列、发送偏移和进度去重信息都由进程内存管理；执行报告继续按生命周期要求持久化。

每个操作只有一个 Manager 发送流程。初始化时使用现有 `UpdateLog` 的空 `Lines`、`Offset = 0` 查询远端末尾，然后发送不可变批次；成功后采用 Gitea 返回的 `NextOffset`。该查询负责确定发送位置，操作载荷中的日志位置属于变化中的观测值，保存执行输入时将其归零，使同一操作能够在日志继续增长时重复领取。

暂时错误由发送层按 1、2、4、5 秒的间隔重试，每次 RPC 最多 5 秒，同一批次保持内容、时间戳和偏移不变，使响应丢失后的重试能够复用 Gitea 的重放确认。偏移冲突或空缺时放弃冲突批次，重新查询末尾后继续。操作过期、实例消失或达到日志上限时结束发送；其他永久请求错误记录本地诊断并结束。网络等待在队列锁之外进行，各实例独立发送。

Agent 命令结束后提交剩余半行，最多等待 5 秒完成当前输出发送，再上报执行结果。Manager 准备最终提交结果时，通过既有报告循环给予日志队列最多 5 秒排空时间；队列已空、已关闭或期限到达即可继续最终提交。站点停用、领导权结束、操作替换及实例删除都会结束对应发送流程。重新启动后以 Gitea 当前末尾开始，已确认的历史日志仍由 Gitea 保存。

### 实现验收点

- Pod 创建前产生接收进度，PVC、调度、容器等待、停止和删除进度能够与 Agent 输出进入同一操作日志。
- 日志批次保留原始时间戳并按接收顺序发送；Manager 响应丢失后重发相同批次只追加一次。
- 日志末尾位置变化时，同一操作仍可重复领取，发送流程以远端当前偏移继续提交。
- Agent 上传回复丢失后仍能提交后续日志，并在后续输出中汇总丢失情况。
- 阻塞上传时，正在发送的批次仍计入每操作和全局内存预算。
- 偏移冲突后重新取得远端末尾，重启后也从远端当前末尾接续。
- 低速持续输出触发定时上传；日志排空到期后执行结果仍能完成提交。
- 日志终止或站点关闭会释放队列与发送流程，其他实例继续正常发送。

## 错误、重试与关闭

接口使用标准 RPC 状态区分参数、认证、权限、对象、状态冲突和暂时不可用。写操作通过操作版本、资源 UID、Metadata 代数或稳定资源键实现幂等。

请求校验错误明确标记为参数错误，已知业务冲突映射到对应状态。数据库、缓存和其他未分类内部故障返回脱敏的 Internal，服务端记录诊断原因；取消和超时保留各自的状态。FailureDetail 只携带调用端实际使用的分类，代数和日志偏移的一致性由服务端校验以及成功响应共同保证。

所有跨组件连接都具有应用层身份。流式接口限制消息大小、空闲时间和缓冲；组件关闭时先停止接收新请求，再在有限时间内释放已有连接。

### 实现验收点

- 同类失败在不同服务中使用一致的 RPC 状态。
- 客户端错误不暴露内部查询和目标地址，错误与诊断日志均不输出 Token、Secret 或私钥。
- 网络重试不会创建第二个操作、Runtime 或命令执行。
- 慢客户端和关闭中的连接不会无限占用资源。
