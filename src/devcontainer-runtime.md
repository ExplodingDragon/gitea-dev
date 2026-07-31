# Manager 原生 Dev Container 运行时

## 职责划分

Manager 在 Incus 实例内原生管理 Dev Container，不下载或调用外部 Dev Container 命令行工具。Gitea 固定用户选择的配置来源、提交和摘要，并负责权限、Secret 授权和生命周期状态；Manager 负责 JSONC 解析、镜像或 Dockerfile 构建、Compose、Feature、生命周期命令、Web IDE 和交互连接。这样运行环境只有一套状态和一套恢复入口，SSH、Web IDE 与 Endpoint 不再各自猜测容器目标。

实例首次 create 前只执行平台内置 `bootstrap.sh`。这个脚本负责外层 Linux 用户、Git、证书、Docker 和 workspace clone，不解释 Dev Container 配置，也不负责内部容器的启动、停止或恢复。脚本通过 Go `embed` 随 Manager 发布，不提供部署侧替换入口。**设计如此：**bootstrap 处理的是 Manager 所需的固定主机前置条件；仓库开发环境由类型化 Go 实现处理。把两类职责分开，可以保留简单、可审阅的系统准备步骤，同时避免可替换脚本形成第二套生命周期协议。

Manager 将当前 `gitea-codespace` 可执行文件复制到实例的 root-owned 路径，并通过隐藏的 `runtime` 子命令执行 create、resume、stop、inspect、exec 和 TCP bridge。Manager 与 Incus 实例必须使用相同 CPU 架构；不一致时在复制前返回明确部署错误。该方式让容器和虚拟机使用同一实现，也无需在实例内安装 Node.js 或额外 CLI。

### 实现验收点

- [x] 生产路径只保留一个内置 `bootstrap.sh`，配置文件没有自定义生命周期脚本字段。
- [x] create、resume 和 stop 的 Dev Container 操作由 Go 运行时完成，不下载 Node.js 或外部 Dev Container 命令行工具。
- [x] 实例内运行时使用当前 Manager 可执行文件，复制前校验实例架构。
- [x] bootstrap 输出只包含外层 UID、GID、用户名和 workspace，不保存内部容器状态。

## 公开包与产品适配

Dev Container 实现位于可独立导入的 `gitea.dev/codespace/devcontainer` 和 `gitea.dev/codespace/devcontainer/docker`。前者提供配置类型、JSONC 读取、变量替换、元数据合并、锁文件、错误分类和可恢复状态；后者提供直接使用 Docker、Compose 和 OCI Feature 的具体 `Engine`。当前只有一个运行后端，因此公开 API 保留具体实现，不增加只有一个实现者的接口层。

Codespace 业务位于 `internal/devcontainerruntime`。该适配层把 Codespace UUID、Git 用户信息、运行时只读挂载、平台 Web IDE Feature、Endpoint manifest 和请求结果文件映射到公开 API。`internal/runtimecmd` 只负责实例内命令入口。公开 Engine 在确定 remote user 和 remote environment 后提供一次 lifecycle 前准备回调，Codespace 用它写入 Git 用户信息、凭据助手和运行时可执行文件；这些产品内容统一由内部适配层解释。**设计如此：**Dev Container 解析和 Docker 生命周期本身可以被其他 Go 程序复用，而 Git、Web IDE、Gateway 和 Codespace operation 是本产品的策略；lifecycle 前回调保留必要的执行顺序，同时让公开状态只表达通用环境。

公开加载 API 可以读取调用方指定的绝对或相对配置路径，并通过可选的 `AllowedPathRoot` 施加路径范围。Codespace 创建时始终把当前锁定 workspace 作为该范围，所以配置文件、Compose 文件、Dockerfile 和 build context 解析符号链接后都必须留在本次仓库内；独立调用者可以根据自己的信任模型选择其他根目录。这里由调用方传入范围，是为了让通用库保持可复用，同时让 Codespace 的仓库固定和摘要校验继续形成完整边界。

### 实现验收点

- [x] 外部 Go 代码可以直接导入 `devcontainer` 和 `devcontainer/docker`，不依赖 Manager、Gateway 或 Codespace 请求类型。
- [x] `internal/devcontainerruntime` 集中负责 Git、code-server、运行时挂载、Endpoint 和对应的产品字段。
- [x] Codespace 的 Git 用户信息、凭据助手和运行时可执行文件在首次 lifecycle 前准备完成。
- [x] Codespace 调用公开加载 API 时固定 `AllowedPathRoot=workspace`，独立调用者可以显式选择自己的路径策略。
- [x] 顶层公开包和具体 Docker Engine 是 Dev Container 能力的唯一实现路径，调用方直接使用该 API。

## 配置读取与固定

Dev Container 是仓库开发环境的唯一配置格式。Gitea 从规范位置列出候选，每次创建选择一份；没有仓库配置时选择只包含平台默认镜像的配置。仓库文件使用 JSONC，Gitea 与 Manager 都使用 `github.com/tailscale/hujson` 标准化。Gitea 保存来源、路径、锁定提交和原始文件 SHA256；Manager clone 后从 workspace 解析同一文件并再次核对摘要。

原生运行时支持单镜像、Dockerfile build 和多文件 Docker Compose。Dockerfile 路径相对配置文件解析，再确认位于 build context 内。Compose 文件按声明顺序交给 `compose-go` 合并，主服务由 `service` 指定，`runServices` 决定一同启动的服务；主服务和相关容器都进入本地环境状态。Compose 使用主机环境与创建请求的 local environment 做插值，使用 service user 作为用户默认值，并由 Compose 自身执行依赖、健康等待、启动和停止。

配置处理分为三个阶段。读取阶段保留字段是否声明、`remoteEnv` 的 `null`、JSON 数字和字符串或数组形式的端口语义，只检查仓库配置恰好选择 image、build 或 Compose 之一；合并阶段依次应用镜像元数据、Feature 元数据和仓库配置；定型阶段解析容器变量、补充 `waitFor`、`userEnvProbe` 与 `shutdownAction` 默认值，再校验最终配置和主机资源。**设计如此：**默认值如果在元数据合并前写入，会被误认为仓库明确选择并遮盖镜像声明；可选字段如果先转成 `null` 或空字符串，还会把单镜像配置误判成 Compose。三阶段让“没有声明”和“明确声明”在完成合并前保持区别，同时只对真正运行的最终配置做一次权威校验。

单镜像和 Dockerfile 配置默认把 workspace 挂载到 `/workspaces/<目录名>`。Compose 配置默认工作目录为 `/`，workspace 位置由 service volumes 和 `workspaceFolder` 决定，不额外注入一份 bind mount。**设计如此：**Compose 文件已经是多服务卷关系的权威来源，运行时再次挂载 workspace 会覆盖项目声明并让主服务和侧车看到不同文件系统；这一行为与 Dev Container 的 Compose 语义保持一致。

变量替换覆盖 `${localWorkspaceFolder}`、`${localWorkspaceFolderBasename}`、`${localEnv:NAME}`、`${localEnv:NAME:default}` 和 `${devcontainerId}`。镜像与 Feature 元数据合并后，再解析 `${containerWorkspaceFolder}`、`${containerWorkspaceFolderBasename}`、`${containerEnv:NAME}` 和默认值。`remoteEnv`、`containerEnv`、mount、用户、capability、安全选项、init、端口和 lifecycle 使用类型化字段进入 Docker API；mount 按 target 后者覆盖，并支持常用只读、bind propagation 和 volume nocopy 语义。`build.options` 和 `runArgs` 是未类型化命令行字符串，原生运行时无法在不调用 Docker CLI 解析器的情况下证明其含义与安全边界，因此配置应使用对应的类型化 build、mount、capability、security 和 container 字段；出现这两个字段时返回包含替代方式的配置错误。**设计如此：**明确拒绝无法可靠解释的输入，比静默忽略或只支持部分参数更容易定位，也不会制造看似成功但运行结果不同的环境。

### 实现验收点

- [x] JSONC 注释和尾随逗号可解析，仓库文件摘要与创建选择不一致时 create 失败。
- [x] 平台默认、仓库配置、image、Dockerfile 和 Compose 来源都有唯一且可校验的选择。
- [x] Compose 保存主服务及所有相关容器，stop/resume 覆盖完整环境。
- [x] Codespace 的配置、Compose 文件、Dockerfile 和本地 build context 在符号链接解析后仍位于锁定 workspace。
- [x] 单容器自动挂载 workspace；Compose 使用 service volumes，不覆盖仓库声明的卷关系。
- [x] 本地与容器阶段变量、环境、mount、用户和容器属性进入 Docker API；未类型化参数返回说明原因和替代字段的错误。
- [x] image、build 和 Compose 配置经过变量替换后仍保持唯一来源，未声明的字符串或数组字段不会生成空值来源。
- [x] 默认值只在镜像、Feature 和仓库配置合并后写入，最终主机资源要求包含全部来源。
- [x] `remoteEnv` 的 `null` 删除继承变量，标量或数组 `appPort` 在创建容器前完成类型校验。

## OCI 镜像与构建缓存

每个 Incus 实例继续运行独立 Docker daemon，停止后恢复同一实例时直接使用本地镜像和构建层。部署者可以通过 Manager 的 `runtime.cache` 为新实例增加两类跨实例缓存：`mirrors` 把原始 OCI registry 主机映射到镜像缓存的基础 URL，`registry` 指定 BuildKit 写入和读取缓存清单的 registry namespace。两项都省略时保持直接访问原始 registry 和实例本地构建，不需要额外基础设施。

镜像映射覆盖单镜像配置、Compose 实际启动服务的显式镜像和 OCI Feature。映射值可以带路径，例如把 `ghcr.io/owner/tool:1` 映射为 `cache.example.com/ghcr/owner/tool:1`；无路径的 Docker Hub mirror 还会合并到实例已有的 Docker daemon 配置，使 Dockerfile 中的 Docker Hub 基础镜像也能使用标准 mirror。Docker daemon 的其他配置和既有 mirror 会保留。带路径的 mirror 以及 Docker Hub 之外的 host 映射由运行时在显式拉取时完成，因为 Docker daemon 的 `registry-mirrors` 不能准确表达这两种关系。**设计如此：**镜像引用转换只承担能够证明语义一致的获取路径，不改写 Dockerfile，也不假设所有 registry 产品都实现同一种代理规则。

mirror 拉取成功后，容器可以使用本地取得的 mirror 引用，但配置、Feature lock 和 Manager 环境状态仍记录仓库声明的原始引用及实际内容 digest。mirror 访问失败时记录一次包含原始引用的警告，再访问原始 registry。HTTPS 是推荐部署方式；显式 HTTP 地址会合并到 Docker daemon 的 insecure registry 列表。私有 mirror 和 cache registry 使用实例 root 用户的标准 Docker credential store，部署者通过基础实例或自定义 profile 准备对应登录信息，不把 registry 用户名、密码或 token 写入 Manager YAML。

Dockerfile、Compose build、Feature 安装层和运行用户调整层统一使用 BuildKit registry cache。cache ref 由仓库、锁定 commit、Dev Container 文件摘要、平台 Web IDE 版本、目标平台和构建阶段计算，因此同一输入的新实例可以复用缓存，不同输入和不同阶段不会并发写入同一引用。平台 Secret、Gitea Token 和 Git SSH 私钥不参与摘要，也不作为 build args 传入。缓存导入不可用时，运行时给出一次警告并使用本地构建重试；缓存导出使用允许失败的发布方式，环境镜像构建成功后不会因为 cache registry 暂时不可用而失败。

缓存只参与 create。resume 使用已保存的容器和环境状态，stop 只停止这些资源，两者不访问 registry。Manager 不共享不同实例的 `/var/lib/docker`，因为该目录同时包含 daemon 元数据和可写运行状态，跨实例共享会破坏现有隔离。外部 registry 保存的构建层可能包含 Dockerfile 复制进去的私有源代码或构建产物，部署者需要为其配置与 Codespace 数据相匹配的访问控制、存储上限、保留期和垃圾回收；这些属于 registry 运维，不在 Manager 中再实现一套容量管理。

### 实现验收点

- [x] `runtime.cache.mirrors` 统一作用于单镜像、Compose 实际启动服务和 OCI Feature；原始引用和真实 digest 继续进入配置、lock 与环境状态。
- [x] Dockerfile、Compose、Feature 和运行用户调整构建使用按仓库输入、平台和阶段隔离的 BuildKit registry cache，cache key 不包含 Secret 或开发凭据。
- [x] mirror 与构建缓存不可用时 create 可以回退原始 registry 或本地构建，并输出一条说明回退对象和原因的警告。
- [x] Docker daemon cache 配置保留实例已有字段和列表；只有 Docker 支持的无路径 Docker Hub mirror 写入 `registry-mirrors`。
- [x] cache 配置只随 create 进入原生运行时，resume 和 stop 不访问 registry 或重新构建。
- [x] 实例继续使用独立 Docker 数据目录；registry 的鉴权、容量、保留期和垃圾回收由部署者管理。

## Feature 与 Web IDE

Manager 使用 ORAS Go 客户端读取 OCI Dev Container Feature，并复用 Docker 凭据访问私有镜像和私有 Feature。每个 Feature 校验媒体类型、单一 layer、`devcontainer-feature.json`、`install.sh`、选项类型、字符串枚举和依赖；`dependsOn` 是硬依赖，`installsAfter` 是不产生失败环的顺序提示，`overrideFeatureInstallOrder` 在满足硬依赖后决定优先顺序。Feature 安装器取得最终 container user、remote user 与 home 环境，entrypoint 在每次容器启动时执行。

运行时读取基础镜像的 `devcontainer.metadata`，按“镜像元数据、Feature 元数据、仓库配置”合并。镜像元数据只提供用户、环境、mount、端口、生命周期、entrypoint 和资源要求等运行属性，不选择 image、build、Compose 或 Feature；Feature 元数据只提供 Feature 规范允许的容器属性。仓库配置在标量和同名环境变量上具有最终选择权，mount 按 target 合并，数组去重，customizations 深度合并，主机资源要求取能够满足全部来源的较大值。**设计如此：**配置来源属于用户选择的仓库文件，镜像和 Feature 只能补充自身拥有的运行信息；明确字段所有权可以防止依赖内容改变创建来源或在宿主机执行仓库之外的初始化命令。最终 OCI digest 写入环境状态，使恢复和诊断可以确认首次创建实际使用的内容。

仓库 Feature 固定到与配置文件同目录的 `devcontainer-lock.json` 或 `.devcontainer-lock.json`，内容记录 version、resolved digest、integrity 和依赖。普通创建在解析完成后原子更新锁文件，frozen 模式要求现有文件完全匹配；平台 Web IDE 由 Codespace 适配层注入，不写入仓库锁。这样仓库锁只描述仓库声明，平台能力不会改写工作区文件；仓库和平台 Feature 的最终 OCI digest 共同写入 Manager 环境状态，恢复和诊断使用的是实际创建结果。

仓库和平台 Feature 进入同一解析、依赖排序和安装流程。相同标准 Feature ID 只有在完整引用和规范化选项一致时去重；引用版本、来源或选项不同表示仓库环境和平台能力对同一工具提出了不同结果，创建会返回指出双方来源和引用的配置错误。**设计如此：**仓库不能静默改写平台 Web IDE，平台也不覆盖仓库配置；明确冲突让仓库维护者调整声明即可得到唯一、可复现的环境。

平台始终加入固定引用的 Coder code-server Feature。Feature 只负责把指定版本的程序安装进镜像，不接管容器 entrypoint；Manager 在容器启动后按实际 remote user、workspace、`remoteEnv` 和当前 Secret 启动唯一的 code-server 进程。Feature 安装器引用随 Manager 发布固定，code-server 程序版本由 `runtime.web_ide.code_server_version` 选择明确语义版本；固定端口为 `13337`，`auth=none`、监听 `0.0.0.0`，并关闭遥测和自身更新检查。配置变化只作用于之后创建的环境，已有环境 resume 使用创建时保存的容器和 Feature digest，用户通过重建 Codespace 完成升级。`customizations.vscode.settings` 写入 code-server 用户目录，扩展按配置安装；单个扩展安装失败记录警告，不阻止 shell 和已有 Web IDE 启动。code-server 不建立第二层登录，因为 Gateway 已负责 Open Code、Cookie、会话和持续权限复检。**设计如此：**平台需要在每次启动时注入当前 Secret 并打开真实 workspace，若同时执行 Feature 自带入口，会先在默认目录启动另一个进程并占用端口；把安装和启动职责分开后，程序版本仍由 Feature 固定，进程环境则由当前运行轮次统一决定。

### 实现验收点

- [x] Feature 通过 OCI API 拉取，依赖顺序、用户选项和摘要进入同一创建结果。
- [x] 基础镜像元数据、Feature 元数据和仓库配置按固定顺序合并，私有镜像使用 Docker 凭据。
- [x] Feature 锁文件使用官方路径和字段并校验 digest，只记录仓库声明的 Feature，不记录平台 Web IDE Feature。
- [x] 平台 Web IDE 作为带来源的 Feature 注入；与仓库相同配置时去重，不同配置返回明确冲突。
- [x] `installsAfter` 只影响顺序，Feature entrypoint 在每次启动时执行。
- [x] 预构建镜像 entrypoint 按标签顺序与本次安装的 Feature entrypoint 一同执行，镜像元数据不能改变配置来源。
- [x] Feature 字符串选项符合声明的枚举，Feature 元数据不能声明规范外的用户或主机资源属性。
- [x] 多个 Feature 的 lifecycle 命令合并为可执行的同级命令集合，不产生嵌套命令对象。
- [x] Web IDE Feature 只安装程序；Manager 使用当前 remote environment 和 Secret 启动唯一进程，并打开环境状态中的实际 workspace。
- [x] code-server 配置变化只影响新建环境；已有环境 resume 使用已保存状态，通过重建完成升级。
- [x] Manager 在发布 ready 前通过 Dev Container 内的 localhost 连接检查 code-server `/healthz`。

## 生命周期与状态

create 顺序为：创建并启动 Incus 实例、写入 root seed、执行 bootstrap、写入当前 Secret、解析固定配置、加入平台 Web IDE Feature、准备镜像和 Feature、创建单容器或 Compose 环境、安装容器内运行时工具、初始化 Endpoint 清单、执行 `onCreateCommand`、`updateContentCommand`、`postCreateCommand`、`postStartCommand`，配置 Git，启动 Web IDE 并发布 ready。workspace clone 只属于 bootstrap；Dev Container create 重试会按 Codespace 标签清理本次未完成的 Docker 对象后重新创建，不接管其他对象。运行时只为实际选择 Compose 的配置计算项目名，并在确认存在同项目标签的容器、网络或卷后执行 Compose 清理；单镜像和 Dockerfile 路径只清理所有者标签对应的容器。Compose 先回收项目资源，所有者标签再兜底清理残留容器，因此首次 image 创建、重复 delete 和已经清空的项目都不会产生虚假的 Compose 警告。code-server 版本只在创建环境时使用；resume 读取 Manager 保存的环境状态，不重新读取部署配置。

stop 先停止环境状态中的主容器和相关容器，再清理易失 Secret，最后停止 Incus 实例。resume 启动同一组容器，执行 `postStartCommand`，重新写入本次 Secret，恢复 Web IDE并完成 ready 检查；它不重新解析仓库配置、不 clone、不 checkout，也不根据后来变化的分支重建环境。delete 以 Incus 实例为资源边界直接删除实例，Docker 资源随实例一同删除。

`postAttachCommand` 在平台 Web IDE 附着以及每次 Gateway SSH shell/exec 附着前执行。`initializeCommand` 在外层 workspace、以实际运行用户执行；其他 lifecycle 在主 Dev Container 的 remote user 和 remote workspace 中执行。对象形式的 lifecycle 命令按规范并行执行，字符串和数组保持各自的 shell 或 argv 语义。

公开环境状态保存格式版本、环境 ID、调用方 owner ID、配置路径和摘要、workspace、Compose identity、全部容器 ID、合并后的配置、remote user/workdir/env、Feature digest 和 lifecycle 完成标记。Codespace UUID 只存在于内部请求和 owner 映射，固定 Web IDE 端口只存在于产品适配层，两者都不污染通用状态。请求、结果和环境 JSON 使用固定格式版本并位于 `/var/lib/gitea-codespace/state`；Secret 不进入该状态。旧格式因字段所有权已经变化而直接报错，避免恢复到无法证明身份的 Docker 对象。

### 实现验收点

- [x] create、stop、resume 和 delete 分别覆盖完整 Dev Container 环境和外层 Incus 资源。
- [x] resume 使用已保存环境，不重新解析仓库文件或修改 workspace HEAD。
- [x] `postAttachCommand` 跟随 Web IDE 和 Gateway SSH 附着执行。
- [x] 环境状态包含恢复和 Gateway 所需的全部目标，且不包含 Secret 明文。
- [x] 通用环境使用 owner ID；Codespace UUID 和固定 Web IDE 端口由内部适配层解释。
- [x] 请求和结果控制文件在每次调用后删除，格式或环境身份不一致时拒绝继续。
- [x] image/build 创建与删除不调用 Compose；Compose 清理先确认项目资源存在，并覆盖容器、网络和卷。
- [x] Endpoint 默认清单在首次 lifecycle 前完成初始化，resume 不重新生成清单。

## 凭据与 Secret

Manager 在 bootstrap 前将本轮 Gitea Token、Codespace Git SSH 私钥、公钥和 known_hosts 写入 root seed。bootstrap 创建最终 helper 和只读凭据目录，Dev Container 只读挂载这些文件；HTTP(S) remote 使用 credential helper，SSH remote 使用包装命令和严格 Host Key 校验。Git 用户名和隐私邮箱只在首次创建时写入 Dev Container 用户的 Git 配置，之后 resume 不根据 Gitea 账户变化覆盖用户设置。

Codespace Secret 只写入运行中的 `/run/gitea-codespace/secrets.json`，owner 是 bootstrap 确认的外层用户。create/resume 从 Gitea 取得当前仓库授权的值并重写文件，stop 删除。所有用户进程使用同一合并顺序：解析后的 `remoteEnv` 提供基础值，本轮 Secret 覆盖同名普通变量，平台保留变量最后覆盖。lifecycle、`postAttachCommand`、Gateway shell/exec、code-server 和扩展安装都使用该结果；code-server 的终端、任务和扩展宿主因此自然继承本轮值。Secret 仍只作为进程环境传递，不进入 Docker 或 Compose 的持久环境、Manager state、Dev Container state 或日志。**设计如此：**Secret 需要对实际开发进程可用，但不应因容器检查、状态文件或镜像配置而在停止后继续存在；统一合并函数也避免不同入口对同名变量采用不同优先级。

### 实现验收点

- [x] Token、SSH 私钥和 Secret 明文不进入 Manager 持久状态。
- [x] HTTP(S) 与 SSH Git 使用各自固定 helper，SSH 使用 known_hosts 严格校验。
- [x] create/resume 写入当前 Secret，stop 清理；lifecycle、Web IDE、扩展和交互命令取得相同变量。
- [x] 同名变量按 `remoteEnv`、Secret、平台保留变量的顺序覆盖，输入 map 不被修改。
- [x] Git identity 只在首次 create 配置，resume 保留用户在 workspace 中的后续调整。

## Gateway 接入

SSH shell/exec 通过 Incus exec 启动隐藏的 `runtime exec`，再由 Docker API进入主 Dev Container；PTY、窗口 resize、signal、退出码和非交互 stdout/stderr 保持独立语义。SFTP 继续使用 Incus 文件 API，以外层 UID/GID和 workspace 作为默认目录，文件系统范围保持 Incus SFTP 的原生能力。

Web IDE、普通 HTTP Endpoint 和 SSH `direct-tcpip` 都通过 Incus exec 启动 `runtime tcp`，再在主 Dev Container 内连接 `localhost`、`127.0.0.1` 或 `::1`。外部请求仍经过 Gateway 的 Gitea认证、会话、限流和持续权限复检；容器不开放 Manager 控制端口，也不需要内部 sshd或 direct 网络地址。Dev Container 的 `forwardPorts` 和 `appPort` 在 create 时生成初始 Endpoint manifest；文件使用实际运行用户和 `0600` 权限，resume 保留用户后续修改。容器内可直接从 `PATH` 使用 `gitea-codespace-endpoint list`、`set <port> [--label ...] [--protocol http|https] [--public]` 和 `delete <port>` 管理入口。普通 Endpoint ID 固定由端口生成 `port-<port>`，默认标签为 `Port <port>`、协议为 HTTP、访问方式为私有。**设计如此：**用户实际管理的是主 Dev Container 的端口；固定 ID 能让重复 set 成为更新同一入口，端点清单作为唯一运行事实又能在 stop/resume 后保留公开选择，无需 Gitea 增加第二份可写状态。

`portsAttributes` 先匹配准确端口，再匹配范围最小的端口段，最后使用 `otherPortsAttributes`。`label` 和 `protocol=http|https` 进入 Endpoint；`onAutoForward=ignore` 表示该端口不生成 Gateway 路由，其余自动打开方式都生成可访问入口。Gateway 为每个入口分配远程 URL，因此 `requireLocalPort` 和 `elevateIfNeeded` 作为本地客户端端口分配提示无需改变服务端路由。**设计如此：**仓库仍使用标准端口声明，服务端只解释与远程 Gateway 有实际对应关系的部分，不模拟本地编辑器的端口占用行为。

### 实现验收点

- [x] SSH shell/exec 在主 Dev Container 内执行，并支持 PTY resize、signal 和准确退出码。
- [x] Web IDE 与 Endpoint 通过 Incus exec和 Docker API连接容器 localhost，不依赖容器 IP或 host 网络。
- [x] `localhost`、`127.0.0.1` 和 `::1` 的转发行为一致。
- [x] 端口属性支持准确端口、范围和默认值；`ignore` 不发布 Endpoint，HTTP/HTTPS 和 label 进入路由。
- [x] Endpoint helper 位于 Dev Container 的 `PATH`，按端口完成 list、set 和 delete，并能明确选择私有或公共入口。
- [x] 初始清单归实际运行用户所有且只在 create 生成；stop/resume 保留用户修改。
- [x] Runtime 内没有访问 Manager 控制端口的路径，所有外部接入先经过 Gateway认证。

## 部署与测试

Incus 系统容器和虚拟机都需要可用 agent、受支持的 Linux 用户管理工具、Git、证书和 Docker Engine。Manager 可执行文件必须能在实例架构和 libc 环境中运行；推荐发布同架构的静态 Go 二进制。虚拟机强制以 agent 可用作为启动前提，不提供无 agent 的降级路径。

真实 E2E 分为两层。`test-devcontainer-e2e-required` 直接连接 Docker Engine：Compose 用例使用 Dev Containers 官方基础镜像和官方 `common-utils` Feature，验证多服务、image metadata 合并、Feature 安装、remote user 的 UID/GID、生命周期命令和同一容器的 stop/resume；单镜像用例验证 image 来源、标量端口、`remoteEnv` 删除语义和无 Compose 清理警告。这层用于快速定位通用 Engine 的行为。`test-e2e-runtime-required` 在真实 Incus 实例内安装并使用 Docker Engine，写入同一份标准夹具，再经过 Manager 构建出的真实可执行文件完成 workspace、create、stop 和 resume；这层用于验证部署链路。该入口在测试实例内放置临时本地 Git 仓库，clone、checkout 和摘要校验仍按生产流程执行，官方镜像和 Feature 仍从真实仓库拉取。**设计如此：**自包含 Git 仓库避免示例仓库网络波动掩盖运行时结果；两层使用相同输入和断言，可以区分 Dev Container 实现错误与 Incus 部署错误，同时避免把官方 CLI 当作生产依赖。

完整 Manager E2E 继续分别覆盖 system container 和 VM，并验证 Web IDE、SSH/PTY、TCP 和 SFTP。单个实例 CPU 为 1、内存上限不超过 1 GiB。需要测试外部仓库时，`CODESPACE_E2E_REPO_CLONE_HTTP_URL` 指向实例可访问的测试仓库，并由 `CODESPACE_E2E_REPO_COMMIT_SHA` 固定实际提交。普通测试在未检测到 Incus 或未显式启用镜像拉取型 E2E 时跳过；required 入口把缺少 Incus、Docker、仓库或镜像条件作为失败返回。这样日常单元测试保持稳定，发布验收仍会真实拉取官方资产并执行容器行为。

### 实现验收点

- [x] container 与 VM 使用同一运行时代码和网络接入方式。
- [x] E2E 使用真实 `gitea-codespace` 可执行文件，覆盖完整环境生命周期。
- [x] Docker 直测与 Incus 运行时 E2E 使用同一份标准夹具，并真实拉取官方基础镜像和官方 Feature。
- [x] 标准夹具验证 Compose、image metadata、Feature、UID/GID、lifecycle 和 stop/resume 后容器身份不变。
- [x] Docker 直测包含真实单镜像创建，验证端口、远程环境和按来源清理行为。
- [x] Incus 运行时 E2E 使用自包含 Git 仓库完成真实 clone、分支 tracking 和摘要校验，仓库网络不影响容器运行时判定。
- [x] 测试实例内存上限不超过 1 GiB，并按部署能力区分可选和 required 入口。
- [x] 完整 Manager E2E 使用调用方明确提供的可达仓库和锁定提交，不使用示例域名或伪提交。
- [x] 架构、agent、Docker或镜像条件不满足时给出可定位的部署错误。
