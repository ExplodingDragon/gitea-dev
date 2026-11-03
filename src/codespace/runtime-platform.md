# 运行平台

运行平台由 Manager、Runtime Agent、Gateway 和 Cache 组成。Manager 管理一个逻辑 Kubernetes 集群，Gitea 继续负责用户、权限和业务状态。

## 控制面与资源

Manager 提供管理 API 和 Kubernetes 控制器。多个 Gitea 站点可以接入同一 Manager；每个 `GiteaSite` 对应一个 `codespace-<site-name>` 命名空间，站点的 Codespace CR、PVC、Runtime Pod、配额和网络策略位于其中。

`EnvironmentTemplate` 定义隔离方式、RuntimeClass、资源、StorageClass、Git SSH 密钥类型和 Dev Container 附加配置。RuntimeClass 使用 `codespace.gitea.dev/isolation=kata|sysbox` 标签声明其隔离语义，管理页面据此列出可选项，保存模板时再次核对标签和资源是否仍然存在。这样管理员选择的是经过集群声明的运行能力，而不是可能拼错或与隔离方式不符的自由文本。

隔离方式同时决定 PVC 的接入形式：Kata 使用原始块设备，由来宾内 Agent 挂载 Docker 数据；Sysbox 使用 Kubernetes 文件系统挂载。卷模式属于隔离实现的一部分，因此由 Manager 统一推导，模板只保存隔离方式这个权威事实。创建时，Manager 把模板内容和当前平台镜像引用写入 Codespace CR，使后续恢复继续采用创建时选择的运行配置。平台镜像可以是显式标签或摘要：标签用于持续更新的开发环境，摘要用于内容固定的部署。管理 API 使用 Kubernetes UID 与 `resourceVersion` 处理对象身份和并发修改，Secret 使用只写接口。

管理页面提供英文、简体中文、日文和韩文，浏览器语言用于首次选择，管理员的手动选择保存在本地浏览器。四种语言使用同一组 JSON 词典，Vue 页面直接读取这些词典，Go 管理 API 也从同一目录读取词条并按 `Accept-Language` 返回本地化摘要。管理 API 同时返回稳定错误码和诊断详情：摘要面向管理员展示，诊断详情保留 Kubernetes 返回的具体原因。资源状态也按稳定的 Condition reason 显示本地化摘要，原始 Condition message 只作为可展开的技术详情。共用词典的原因是前后端面对的是同一位管理员，分别维护两套文字会产生词条遗漏和含义不一致。

`CodespaceComponent` 定义一个 Gateway 或 Cache。组件是集群级资源，因为多个站点可以引用同一个平台入口或缓存；它生成的 Pod、Service、NetworkPolicy、身份 Secret 和缓存卷集中在管理命名空间。站点保存组件名称和 UID，Manager 在建立控制流和投影路由时再次核对角色与 UID，因此删除后创建的同名组件不会接管旧站点关系。

### 实现验收点

- Manager 只连接一个 Kubernetes API。
- 不同站点的资源、凭据、配额和网络策略相互隔离。
- Manager、Gateway、Cache 和 Runtime 使用同一份显式标签或摘要镜像引用。
- 模板更新只影响新环境；摘要模式下平台升级也只影响新环境。
- 管理 API 不返回长期 Secret 明文。
- 管理页面只列出带有效隔离标签的 RuntimeClass 和集群中存在的 StorageClass。
- 保存模板时 RuntimeClass 标签需要与隔离方式一致，StorageClass 需要仍然存在。
- Kata 模板生成块模式 PVC，Sysbox 模板生成文件系统模式 PVC，模板中没有第二个卷模式配置来源。
- 管理页面语言切换同时作用于导航、表单、确认框、资源状态和组件语言，并在刷新后保持。
- 四种 JSON 词典具有相同键集合；前端请求携带当前语言，管理 API 的错误摘要来自同一组词典。
- 管理 API 错误包含稳定代码和诊断详情，页面不依赖英文错误文字判断会话状态；动态集群诊断仍可在技术详情中查看。
- 一个组件声明只选择 Gateway 或 Cache 角色，控制器能从声明恢复对应工作负载。
- 站点引用、组件证书和凭据均绑定组件 UID。

## Runtime 与持久数据

Runtime Pod 使用平台镜像，Agent 作为 PID 1 启动专属 Docker、准备工作区、创建 Dev Container、执行生命周期命令并提供访问 RPC。Manager 与 Agent 即使来自同一个平台镜像，也运行在不同 Pod 中；同一镜像用于统一发布和审计，不会合并各自的进程与权限边界。用户镜像运行在该 Docker 中，不直接成为 Kubernetes Pod 容器。

环境模板显式选择 Kata 或 Sysbox RuntimeClass。失败时继续保留原隔离选择，因为自动切换会改变安全边界。仓库配置和命名模板进入同一 Dev Container 解析路径；环境模板可以追加标准 Dev Container Features，并配置 code-server 版本与扩展。code-server Feature 引用由平台版本统一维护，原因是启动脚本、端口和健康检查都与该实现配套；管理员只配置有明确运行含义的版本和扩展。

每个 Codespace 使用独立 PVC 保存工作区、内部 Docker、Git SSH 私钥和 IDE 数据。Token、用户 Secret、Unix socket 与进程状态写入易失目录。工作区准备是可重复的：未完成的克隆只使用临时目录，目标目录已存在时核对锁定提交并刷新 Git 凭据。任意 Dev Container 生命周期命令不具备通用幂等性，Agent 在 PVC 中持久记录其开始和结果，响应丢失后只重报已经完成的结果，结果未知时停止恢复并提供诊断。

Kata 使用原始块卷。Agent 挂载前通过 mTLS 请求 Manager 确认当前 CR、Pod、PVC 和操作许可；首次格式化许可先以 `started` 写入 CR Status，再返回 Agent。文件系统检查和挂载成功后记录 `ready`。已有 ext4 卷经过检查后直接挂载；格式化已开始但无法识别文件系统时，保留卷并报告恢复错误。文件系统探测失败本身不能证明卷为空，这个持久化确认使进程崩溃或响应丢失也不会导致旧卷被重新格式化。

生命周期输出直接流式写入操作日志；需要返回正文的元数据查询分别限制标准输出、错误输出为 1 MiB，超限明确失败。取消生命周期执行时，Agent 关闭 Docker 连接并停止专属 Docker 进程，再退出当前 Pod 的执行循环；后续操作由 Manager 在确认旧 Pod 停止后推进。这样关闭客户端连接不会被误认为容器内命令已经停止。

### 实现验收点

- Runtime 不挂载节点容器运行时套接字，也不持有 Kubernetes API 凭据。
- Kata 与 Sysbox 分别在对应 RuntimeClass 上通过真实启动验证。
- Web IDE 配置由平台维护的 code-server Feature、管理员选择的版本和扩展共同生成。
- 附加 Features 使用标准 Dev Container `features` 对象输入，并按声明顺序注入。
- 所有 Dev Container 来源使用同一解析和执行路径。
- Pod 替换后工作区、内部 Docker 和 IDE 数据保持一致。
- 克隆中断不会留下被当作完成工作区的目标目录，已有工作区只在提交匹配时复用。
- Dev Container 生命周期命令不会因 Manager 重连或 Pod 内循环重启被盲目重放。
- ready 只在 Dev Container 与必要访问服务可用后发布。
- Agent 只能通过内部 RPC 接收操作和发布运行事实。
- 块卷格式化前已有持久化许可；恢复挂载已有 ext4，未知文件系统保留数据并提供恢复诊断。
- 大量生命周期日志不积累在内存中；元数据输出超限和执行取消都有确定结果。
- 生命周期取消完成后，旧 Docker 执行环境已停止；普通用户访问断连只关闭对应连接。

## Gateway 与访问

Gateway 提供 HTTP/WebSocket、SSH 和 SFTP 入口。它从 Manager 获取当前路由，每次建立数据流前复核 Gitea 权限并取得短期 Agent 票据，再通过 mTLS 直连 Agent。Manager 不转发用户数据。

路由快照只包含当前 Gateway UID 关联的已就绪站点，以及这些站点命名空间中绑定有效、Pod 和访问目标可用的实例。Manager 使用组件 UID、站点 Gateway UID 和实例 Site UID 的缓存索引定位候选，避免每个 Gateway 周期扫描整个集群。实例处于停止、恢复或尚未获得地址等状态时，只从快照中排除该实例；身份冲突同时记录诊断，实际读取故障仍返回错误。签发票据前实时核对站点、实例、Pod UID 和目标版本，因此缓存中的旧路由不能授权新的连接。

Gateway SSH 主机密钥由 Manager 生成，私钥保存在 Kubernetes Secret 中。轮换时 Manager 更新当前组件拥有的 Secret，凭据资源版本随 Pod 模板变化并触发 Gateway 滚动更新，再发布新的公钥指纹。使用固定 Secret 名称可以让 Deployment 始终引用当前组件的密钥，组件 UID 与所有者关系则防止同名重建后继承旧密钥。Agent 提供 PTY、命令、SFTP、HTTP Endpoint 和回环端口转发；Dev Container 通过本地 Unix socket 管理 Endpoint。

SSH 命令正常退出时先有界排空输出再发送退出状态；断连时同时关闭 RPC 与本地管道，释放被慢客户端阻塞的读取和写入。完成通知可以重复观察，重复关闭保持幂等。TCP 的输入半关闭仍允许读取剩余响应，避免截断请求完成后的数据。

外部 DNS、TLS 和监听器由 Kubernetes Ingress 或 Gateway API 管理，使应用授权与平台证书分别由对应组件负责。

Gateway 组件可以引用一个现有 Gateway API `Gateway` 及监听器名称。Manager 只读取父 Gateway 验证监听协议，并为该组件维护 HTTPRoute 和可选 TCPRoute；未填写父 Gateway 时，组件仍提供集群内 Service，由集群管理员使用其他入口方式暴露。父监听器属于单个 Gateway 组件的部署选择，放在组件配置中可以让同一集群的多个入口使用不同域名和监听器。

### 实现验收点

- 每个数据流都需要当前有效的用户授权和 Agent 票据。
- SSH 主机私钥只存在于对应 Secret。
- 单个实例不可用不影响其他实例的路由，Pod 被替换或目标失效后不能获得访问票据。
- Gateway 快照只读取绑定到自身的站点和实例，站点数量增长不会扩大为全量 Runtime 扫描。
- SSH 正常退出保留输出和退出码；断连释放阻塞任务，TCP 半关闭后仍可接收响应。
- 每张票据只绑定一种访问能力。
- 本地端口转发只访问当前 Dev Container 的回环地址。
- Pod 或目标版本变化后，旧路由和票据失效。
- 配置父 Gateway 时，HTTP 监听器与可选 SSH 监听器存在且协议匹配，Manager 只维护当前组件拥有的 Route。
- 取消父 Gateway 或 SSH 监听器后，对应 Route 被控制器清理，组件 Service 保持可用。

## Cache

Cache 是独立组件，支持本地文件系统或 S3。它为允许的上游镜像提供代理，并按 GiteaSite UID、仓库 ID 和用户 ID 生成签名缓存目录。站点 UID 区分不同站点以及同名重建的站点，避免 Gitea 各自分配的数字 ID 重合造成跨站点共享。Runtime 的 Docker 数据保存在 PVC，Cache 只减少重复下载与构建。

Cache 从 Manager 获取配置、短期认证和维护许可。缓存丢失时允许在原授权范围内回源；维护许可保证同一存储同一时刻只有一个垃圾回收执行者。

申请清理许可和提交清理完成均等待 Manager 按请求序号确认。等待受超时和调用取消控制，结束后释放请求记录；迟到的响应只对应原请求，连接故障同时结束尚未确认的维护请求。这样“已发送”与“已完成”有明确区别，重连也不会继续持有旧请求的等待资源。

Cache 执行许可在 Manager 首次获取 Kubernetes Lease 后生效，后续只由成功续约的对应请求确认延长。Cache 用请求发送时间加许可时长计算到期，并保留一秒余量；后续独立配置推送和重复确认只更新配置或被忽略，不会增加执行时间。独立到期计时器同时取消请求、上传和垃圾回收，即使控制流发送阻塞，旧进程也会停止使用共享存储。

控制流结束后，Manager 保留已有 Lease 直到自然到期。断连无法证明远端进程已经停止，等待现有的 15 秒租期可以让旧进程先按本地许可退出，再允许新进程接管存储。停用后的 Cache 停止获取和续期租约；客户端遇到到期许可时重建连接，以便重新启用后正常恢复。管理面删除 Cache 组件时也检查这段租期：先停用 Cache 并等待租期结束，再删除组件，避免级联回收 Lease 使旧写入者提前失去保护。

### 实现验收点

- 私有镜像和构建缓存按站点、仓库与用户范围隔离读取。
- Registry 与仓库组合不会产生缓存键冲突。
- 清理完成在 Manager 确认后才返回成功；取消、超时和控制流关闭均结束等待，并可在后续有效连接上继续维护。
- Cache 清空后可以回源，已有 Codespace 仍可从 PVC 恢复。
- 同一存储同一时刻只有一个垃圾回收执行者。
- 数字仓库和用户 ID 相同的不同站点仍使用不同缓存目录和授权。
- 控制流单向中断、发送阻塞、迟到响应和重复响应均不能使 Cache 超过已确认的许可期限运行。
- 停用后的 Cache 不再续约，组件在写入租期结束后才可删除。

## 高可用与恢复

Manager 多副本通过 Kubernetes Lease 选举。只有 Leader 连接 Gitea、领取操作、协调 Runtime 和签发访问票据；备用副本保持可接替状态。新 Leader 先核对 Gitea 当前操作与 CR、PVC、Pod 和 Agent，再领取新任务。

恢复不依赖节点本地文件。Kubernetes 无法证明旧 Pod 已停止写入 PVC 时，Manager 撤销其执行权和路由并保留数据，等待管理员针对当前资源身份确认，再把环境收敛到 stopped，通过普通 resume 启动新 Pod。

Gitea 删除 Manager 身份与运行平台清理分别由各自管理员操作。Manager 管理面在站点停用后允许显式删除运行环境数据，请求携带当前 CR UID、资源版本和 Pod UID。控制器复用普通 delete 的停止确认和资源删除流程，避免失效凭据触发不可撤销的数据删除。

### 实现验收点

- 同一时刻只有 Leader 推进生命周期操作。
- 新 Leader 完成资源核对前不领取新 create。
- 部分清单、未知归属或失联节点不会触发误删或双写。
- 管理员确认只对当前 CR 和 Pod 身份生效。
- 站点停用后的数据删除仍先确认旧写入者停止，再回收 PVC；同名替换或过期页面不能删除新资源。
