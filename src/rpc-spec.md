# RPC 接口定义

Manager 与 Gitea 之间通过 Connect RPC over HTTP 或 HTTPS 通信，scheme 由部署配置决定，消息和认证语义相同。

proto 定义：

```protobuf
syntax = "proto3";

package codespace.v1;

enum ManagerRuntimeState {
  MANAGER_RUNTIME_STATE_UNSPECIFIED = 0;
  MANAGER_RUNTIME_STATE_ONLINE = 1;
  MANAGER_RUNTIME_STATE_RECOVERING = 2;
}

enum AcceptedOperationType {
  ACCEPTED_OPERATION_TYPE_UNSPECIFIED = 0;
  ACCEPTED_OPERATION_TYPE_CREATE = 1;
  ACCEPTED_OPERATION_TYPE_RESUME = 2;
}

enum FinalStatus {
  FINAL_STATUS_UNSPECIFIED = 0;
  FINAL_STATUS_DONE = 1;
  FINAL_STATUS_FAILED = 2;
}

enum OperationType {
  OPERATION_TYPE_UNSPECIFIED = 0;
  OPERATION_TYPE_CREATE = 1;
  OPERATION_TYPE_RESUME = 2;
  OPERATION_TYPE_STOP = 3;
  OPERATION_TYPE_DELETE = 4;
}

enum GitProtocol {
  GIT_PROTOCOL_UNSPECIFIED = 0;
  GIT_PROTOCOL_HTTP = 1;
  GIT_PROTOCOL_SSH = 2;
}

enum RuntimeState {
  RUNTIME_STATE_UNSPECIFIED = 0;
  RUNTIME_STATE_CREATING = 1;
  RUNTIME_STATE_RUNNING = 2;
  RUNTIME_STATE_STOPPED = 3;
  // Runtime identity exists, but Manager has confirmed it cannot be recovered.
  RUNTIME_STATE_FAILED = 4;
}

enum RuntimeBootStage {
  RUNTIME_BOOT_STAGE_UNSPECIFIED = 0;
  RUNTIME_BOOT_STAGE_PREPARE_RUNTIME = 1;
  RUNTIME_BOOT_STAGE_INITIALIZE_SYSTEM = 2;
  RUNTIME_BOOT_STAGE_PREPARE_WORKSPACE = 3;
  RUNTIME_BOOT_STAGE_START_ENVIRONMENT = 4;
  RUNTIME_BOOT_STAGE_PUBLISH_READY = 5;
  RUNTIME_BOOT_STAGE_READY = 6;
}

enum IdleStopNotApplicableReason {
  IDLE_STOP_NOT_APPLICABLE_REASON_UNSPECIFIED = 0;
  IDLE_STOP_NOT_APPLICABLE_REASON_OPERATION_CONFLICT = 1;
  IDLE_STOP_NOT_APPLICABLE_REASON_ALREADY_STOPPED = 2;
  IDLE_STOP_NOT_APPLICABLE_REASON_STATE_UNAVAILABLE = 3;
}

enum RuntimeReconcileAction {
  RUNTIME_RECONCILE_ACTION_UNSPECIFIED = 0;
  RUNTIME_RECONCILE_ACTION_CLEANUP_LOCAL_RUNTIME = 1;
  RUNTIME_RECONCILE_ACTION_REPORT_RUNTIME_TRANSITION = 2;
  RUNTIME_RECONCILE_ACTION_REFETCH_OPERATION = 3;
  RUNTIME_RECONCILE_ACTION_STOP_LOCAL_RUNTIME = 4;
  RUNTIME_RECONCILE_ACTION_CLEAR_OPERATION_CONTEXT = 5;
}

// ManagerService is implemented by Gitea and called by Codespace Manager.
service ManagerService {
  // DeclareManager updates Manager metadata, tags, and serves as heartbeat.
  rpc DeclareManager(DeclareManagerRequest) returns (DeclareManagerResponse);

  // FetchOperations returns operations for the Manager to execute.
  rpc FetchOperations(FetchOperationsRequest) returns (FetchOperationsResponse);

  // BindRuntimeIdentity stores the Manager-allocated runtime UUID before infrastructure is created.
  rpc BindRuntimeIdentity(BindRuntimeIdentityRequest) returns (BindRuntimeIdentityResponse);

  // FinalizeOperation reports the final result of an active operation.
  rpc FinalizeOperation(FinalizeOperationRequest) returns (FinalizeOperationResponse);

  // UpdateLog appends sanitized log lines at a given offset for an active operation.
  rpc UpdateLog(UpdateLogRequest) returns (UpdateLogResponse);

  // ReportRuntimeMetadata writes a Runtime Metadata snapshot to Gitea's configured cache adapter.
  rpc ReportRuntimeMetadata(ReportRuntimeMetadataRequest) returns (ReportRuntimeMetadataResponse);

  // Returns the complete runtime access material for create, resume, or stable running recovery.
  rpc RequestRuntimeAccess(RequestRuntimeAccessRequest) returns (RequestRuntimeAccessResponse);

  // RequestIdleStop asks Gitea to authorize an idle-triggered stop using current policy and interaction state.
  rpc RequestIdleStop(RequestIdleStopRequest) returns (RequestIdleStopResponse);

  // ValidateOpenToken validates and consumes a one-time Gateway Open Token.
  rpc ValidateOpenToken(ValidateOpenTokenRequest) returns (ValidateOpenTokenResponse);

  // ValidatePublicEndpoint authorizes an unauthenticated request to a public Endpoint.
  rpc ValidatePublicEndpoint(ValidatePublicEndpointRequest) returns (ValidatePublicEndpointResponse);

  // VerifySSHPublicKey authenticates an SSH session via public key.
  rpc VerifySSHPublicKey(VerifySSHPublicKeyRequest) returns (VerifySSHPublicKeyResponse);

  // ReportInstances reports the complete set of local Runtime Instances at startup and periodically.
  rpc ReportInstances(ReportInstancesRequest) returns (ReportInstancesResponse);

  // ReportRuntimeTransition reports a Manager-initiated stopped or failed fact.
  rpc ReportRuntimeTransition(ReportRuntimeTransitionRequest) returns (ReportRuntimeTransitionResponse);

  // RevalidateGatewaySession checks an existing Endpoint or SSH session.
  rpc RevalidateGatewaySession(RevalidateGatewaySessionRequest) returns (RevalidateGatewaySessionResponse);
}

// --- DeclareManager ---

message DeclareManagerRequest {
  // ManagerService protocol major version. It is independent of the display version.
  int32 protocol_version = 1;
  // Gateway scheme, DNS base domain, and optional port; no business path.
  string gateway_url = 2;
  string gateway_ssh_addr = 3;
  repeated EnvironmentTag environments = 4;
  string version = 5;
  string name = 6;
  ManagerRuntimeState manager_runtime_state = 7;
  string gateway_ssh_host_key_algorithm = 8;
  string gateway_ssh_host_key_fingerprint_sha256 = 9;
  int64 gateway_ssh_host_key_updated_unix = 10;
}

message EnvironmentTag {
  // Stable environment key selected during Codespace creation.
  string tag = 1;
  // Short user-facing explanation of the environment.
  string description = 2;
}

message DeclareManagerResponse {
  // Server-selected cadence. Manager applies these values after every successful Declare.
  int64 heartbeat_interval_milliseconds = 1;
  int64 runtime_metadata_refresh_interval_milliseconds = 2;
  // Maximum encoded protobuf message size accepted in either direction.
  int64 control_plane_max_message_size_bytes = 3;
  // Gitea's canonical browser-visible ROOT_URL, including AppSubURL.
  string gitea_web_url = 4;
}

// --- FetchOperations ---

message FetchOperationsRequest {
  // ManagerService protocol major version. Every request carries the caller's version.
  int32 protocol_version = 1;
  int32 startup_capacity_available = 2;
  repeated AcceptedOperationType accepted_operation_types = 3;
  repeated ObservedOperation observed_operations = 4;
  int32 cleanup_capacity_available = 5;
  // Declared environment tags that can create a new instance in this fetch.
  repeated string accepted_create_tags = 6;
}

message ObservedOperation {
  string runtime_uuid = 1;
  int64 operation_rversion = 2;
}

message FetchOperationsResponse {
  repeated OperationPayload operations = 1;
  repeated RenewedOperationLease renewed_leases = 2;
}

message RenewedOperationLease {
  string runtime_uuid = 1;
  int64 operation_rversion = 2;
  int64 lease_valid_for_milliseconds = 3;
}

message OperationPayload {
  int64 operation_rversion = 1;
  int64 codespace_id = 2;
  string runtime_uuid = 3;
  int64 log_offset = 4;
  int64 lease_valid_for_milliseconds = 5;

  oneof command {
    CreateOperationPayload create = 10;
    ResumeOperationPayload resume = 11;
    StopOperationPayload stop = 12;
    DeleteOperationPayload delete = 13;
    AbortCreateOperationPayload abort_create = 14;
    AbortResumeOperationPayload abort_resume = 15;
  }
}

message BindRuntimeIdentityRequest {
  // ManagerService protocol major version. Every request carries the caller's version.
  int32 protocol_version = 1;
  int64 codespace_id = 2;
  int64 operation_rversion = 3;
  string runtime_uuid = 4;
}

message BindRuntimeIdentityResponse {
  string runtime_uuid = 1;
}

message ResumeOperationPayload {
  EffectiveCodespaceRuntimeSettings runtime_settings = 1;
}
message StopOperationPayload {}
message DeleteOperationPayload {}
message AbortCreateOperationPayload {}
message AbortResumeOperationPayload {}

message CreateOperationPayload {
  RepositoryCheckout repository = 1;
  // Selects the manager-local runtime environment for this create.
  string environment_tag = 2;
  // Create-time user identity written to the workspace.
  GitIdentity git_identity = 3;
  DevContainerConfiguration dev_container = 4;
  EffectiveCodespaceRuntimeSettings runtime_settings = 5;
}

message RepositoryCheckout {
  string full_name = 1;
  // Canonical HTTP(S) clone URL generated by Gitea when HTTP clone is enabled.
  string clone_http_url = 2;
  // Canonical SSH clone URL generated by Gitea when Codespace SSH clone is enabled.
  string clone_ssh_url = 3;
  // Preferred protocol computed from current Gitea Git transport settings for this create payload.
  GitProtocol preferred_protocol = 4;
  string start_ref = 5;
  string commit_sha = 6;
}

message GitIdentity {
  // Create-time Gitea username used for the Linux user and Git user.name.
  string gitea_username = 1;
  // Create-time privacy-aware email used for Git commits.
  string git_user_email = 2;
}

message DevContainerConfiguration {
  oneof source {
    // Repository-relative path for a repository Dev Container configuration.
    string repository_path = 1;
    // Non-repository template content selected at create time.
    string template_content = 2;
  }
}

// --- FinalizeOperation ---

message FinalizeOperationRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  int64 operation_rversion = 3;
  FinalStatus status = 4;
  // Abort commands retain their underlying create/resume type.
  OperationType operation_type = 5;
}

message FinalizeOperationResponse {
  bool resource_absent = 1;
}

// --- UpdateLog ---

message UpdateLogRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  int64 operation_rversion = 3;
  // Byte offset within the log file.
  int64 offset = 4;
  repeated LogLine lines = 5;
}

message LogLine {
  int64 timestamp_unix_nano = 1;
  // UTF-8 text without CR/LF; embedded newlines are split before sending.
  string message = 2;
}

message UpdateLogResponse {
  // File end after server-side sanitization and canonical encoding.
  int64 next_offset = 1;
}

// --- ReportRuntimeMetadata ---

message ReportRuntimeMetadataRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  int64 metadata_generation = 3;
  RuntimeMetadata metadata = 4;
}

message ReportRuntimeMetadataResponse {}

message RuntimeMetadata {
  repeated RuntimeEndpoint endpoints = 1;
  RuntimeBoot boot = 2;
  RuntimeResourceUsage resource_usage = 3;
}

message RuntimeEndpoint {
  string endpoint_id = 1;
  string label = 2;
  bool public = 3;
}

message RuntimeBoot {
  int64 operation_rversion = 1;
  RuntimeBootStage stage = 2;
  int64 started_unix = 3;
  int64 last_update_unix = 4;
}

message RuntimeResourceUsage {
  RuntimeCPUUsage cpu = 1;
  RuntimeMemoryUsage memory = 2;
  RuntimeDiskUsage disk = 3;
  int64 observed_unix = 4;
}

message RuntimeCPUUsage {
  int64 used_millicores = 1;
  int64 limit_millicores = 2;
}

message RuntimeMemoryUsage {
  int64 used_bytes = 1;
  int64 limit_bytes = 2;
}

message RuntimeDiskUsage {
  int64 used_bytes = 1;
  int64 limit_bytes = 2;
}

// --- RequestRuntimeAccess ---

message RequestRuntimeAccessRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  int64 operation_rversion = 3;
  RuntimeGitSSHKey git_ssh_key = 4;
}

message RuntimeGitSSHKey {
  // SSH wire-format public key generated or recovered by Manager.
  bytes public_key = 1;
}

message RuntimeSecretEnvironmentVariable {
  // Environment variable name selected for the source repository.
  string name = 1;
  // Plaintext value used only for the current runtime startup.
  string value = 2;
}

message RequestRuntimeAccessResponse {
  RuntimeAccessBundle access = 1;
}

message RuntimeAccessBundle {
  // The plaintext Codespace Gitea Token for this codespace.
  string gitea_token = 1;
  // Gitea's externally reachable ROOT_URL, including AppSubURL.
  string gitea_server_url = 2;
  // User secrets currently applicable to the source repository.
  repeated RuntimeSecretEnvironmentVariable secrets = 3;
  GitSSHTrust git_ssh_trust = 4;
}

message GitSSHTrust {
  // Canonical lines for the Git SSH host and effective port.
  repeated string known_hosts_lines = 1;
}

// --- RequestIdleStop ---

message EffectiveCodespaceRuntimeSettings {
  bool auto_stop_enabled = 1;
  // Zero only when auto_stop_enabled is false.
  int64 idle_timeout_seconds = 2;
  int64 interaction_generation = 3;
}

message RequestIdleStopRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  EffectiveCodespaceRuntimeSettings observed_settings = 3;
}

message RequestIdleStopResponse {
  oneof outcome {
    IdleStopPending pending = 1;
    IdleStopObservationChanged observation_changed = 2;
    IdleStopNotApplicable not_applicable = 3;
  }
}

message IdleStopPending { int64 operation_rversion = 1; }
message IdleStopObservationChanged {
  EffectiveCodespaceRuntimeSettings runtime_settings = 1;
}
message IdleStopNotApplicable {
  IdleStopNotApplicableReason reason = 1;
}

// --- ValidateOpenToken ---

// Validates and consumes an OAuth2-style authorization code
// issued by Gitea for a codespace endpoint open request.
message ValidateOpenTokenRequest {
  int32 protocol_version = 1;
  string code = 2;
}

message ValidateOpenTokenResponse {
  oneof outcome {
    OpenTokenBinding allowed = 1;
    FailureDetail denied = 2;
  }
}

message OpenTokenBinding {
  int64 user_id = 1;
  string runtime_uuid = 2;
  // Always set. The default open route uses the logical "workspace" endpoint.
  string endpoint_id = 3;
  int64 interaction_generation = 4;
}

// --- ValidatePublicEndpoint ---

message ValidatePublicEndpointRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  string endpoint_id = 3;
}

message ValidatePublicEndpointResponse {
  oneof outcome {
    PublicEndpointAllowed allowed = 1;
    FailureDetail denied = 2;
  }
}

message PublicEndpointAllowed {}

// --- VerifySSHPublicKey ---

message VerifySSHPublicKeyRequest {
  int32 protocol_version = 1;
  // runtime_uuid parsed from SSH connection string (cs-{id} prefix).
  string runtime_uuid = 2;
  // SSH wire-format public key blob from the client authentication request.
  bytes public_key = 3;
}

message VerifySSHPublicKeyResponse {
  oneof outcome {
    SSHAuthBinding allowed = 1;
    FailureDetail denied = 2;
  }
}

message SSHAuthBinding {
  int64 user_id = 1;
  int64 interaction_generation = 2;
}

// --- ReportInstances ---

message ReportInstancesRequest {
  int32 protocol_version = 1;
  // Strictly increases for each complete local scan attempt.
  int64 inventory_generation = 2;
  // Complete set of local Runtime Instance identifiers owned by this Manager.
  repeated RuntimeInstanceRef instances = 3;
}

message RuntimeInstanceRef {
  string runtime_uuid = 1;
  RuntimeState runtime_state = 2;
  // Zero means that Manager has no local active-operation context.
  int64 observed_operation_rversion = 3;
}

message ReportInstancesResponse {
  // Exactly one result for every RuntimeInstanceRef in the request.
  repeated RuntimeInstanceResult results = 1;
}

message RuntimeInstanceResult {
  string runtime_uuid = 1;
  // Present when the Runtime still belongs to this Manager and is not being cleaned up.
  EffectiveCodespaceRuntimeSettings runtime_settings = 2;
  RuntimeReconcileAction action = 3;
  // The current Gitea operation version required by version-sensitive actions.
  int64 current_operation_rversion = 4;
}

// --- ReportRuntimeTransition ---

message ReportRuntimeTransitionRequest {
  int32 protocol_version = 1;
  string runtime_uuid = 2;
  int64 runtime_generation = 3;
  // The latest Gitea-issued operation version observed before this fact was produced.
  int64 observed_operation_rversion = 4;
  // Only RUNTIME_STATE_STOPPED and RUNTIME_STATE_FAILED are valid.
  RuntimeState runtime_state = 5;
}

message ReportRuntimeTransitionResponse {}

// --- RevalidateGatewaySession ---

message RevalidateGatewaySessionRequest {
  int32 protocol_version = 1;
  oneof session {
    EndpointSessionBinding endpoint = 2;
    SSHSessionBinding ssh = 3;
  }
}

message EndpointSessionBinding {
  int64 user_id = 1;
  string runtime_uuid = 2;
  string endpoint_id = 3;
}

message SSHSessionBinding {
  int64 user_id = 1;
  string runtime_uuid = 2;
}

message RevalidateGatewaySessionResponse {
  oneof outcome {
    SessionAllowed allowed = 1;
    FailureDetail denied = 2;
  }
}

message SessionAllowed {}

// Carries a stable denial category for access decisions and Connect command errors.
message FailureDetail {
  // Lower_snake_case reason used by callers for branching.
  string category = 1;
}

// Attached only when a generation is stale, so Manager can recover after
// losing its local generation without weakening monotonic ordering.
message StaleGenerationDetail {
  int64 current_generation = 1;
}

// Attached to UpdateLog offset conflict/gap errors. Manager resumes from this
// server-authoritative byte offset after resolving the error.
message LogOffsetDetail {
  int64 current_offset = 1;
}
```

实现验收点：

- 共享 proto 包名为 `codespace.v1`，服务名为 `ManagerService`，Gitea 与 Manager 都使用同一份生成代码。
- [x] 每个 ManagerService request 都把 `protocol_version` 定义为 protobuf 字段 1；业务字段从 2 开始编号。
- `ManagerService` 包含本章列出的声明、运行身份绑定、生命周期、日志、Runtime Metadata、开发凭据、空闲停止、访问校验、inventory、runtime transition 和 session revalidate RPC。
- operation、final、runtime、git protocol、idle stop reason 等枚举只把明确业务值作为可处理输入，`UNSPECIFIED` 用于输入校验失败。
- `FailureDetail.category` 是稳定的 `lower_snake_case` 字符串，Gitea、Manager 和 Gateway 直接以该字符串进行分支和日志记录。
- response 中的 `oneof outcome` 穷尽表达访问判定、idle stop 和 session revalidate 的互斥结果；inventory 使用单一 action enum，final 只返回 Manager 需要特殊处理的资源不存在标记。

## 认证机制

所有 RPC 使用以下 HTTP header 认证：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

每个 ManagerService request 都必须提交 `protocol_version=1`。Gitea 先通过统一入口认证 Manager ID 和 secret，再在取得业务锁、更新 heartbeat/generation 或执行生命周期读写前校验版本。Manager 身份由 Gitea 管理页创建，ManagerService 只负责已签发身份的运行期通信。

`protocol_version` 是 ManagerService 的主版本。当前设计只支持版本 1，Gitea 同一时刻只实现一个主版本；只有会改变既有字段含义、状态推进或错误处理的不兼容变更才提高它。普通增加可由旧端忽略的 protobuf 字段时保持当前主版本。版本不匹配返回 `protocol_mismatch`，当前请求不产生任何业务写入。Manager 收到该错误后关闭入口和新的 Incus 修改，以明确错误退出。该字段与用于页面展示的软件 `version`、Manager 本地状态格式以及实例内原生运行时格式互相独立，也不保存到 Manager 数据库记录。

**设计如此：每个请求都携带主版本，ManagerService 不协商多个协议主版本。**逐请求字段能拒绝仍持有有效 Secret 但协议不匹配的进程，也不会依赖最近一次 Declare 或数据库中的历史声明推测当前调用方版本。Gitea 和 Manager 可以在保持主版本兼容时独立更新；需要提高主版本时，由部署方完成配套升级。这个边界在执行生命周期写入前拒绝不兼容客户端，同时不增加能力列表和分支状态机。

**设计如此：每个 request 的 `protocol_version` 固定为 protobuf 字段 1。**协议版本是所有请求共同且最先校验的前置字段，放在第一位可以从消息定义直接看出统一约定；业务字段从 2 开始编号，但不把字段号连续作为运行时设计目标。字段是否连续只影响 proto 文件整洁度，不影响 Gitea 的兼容判定；Gitea 运行时只校验主版本是否等于当前支持值。

`CONTROL_PLANE_TIMEOUT` 到期返回 Connect `DeadlineExceeded`，caller 取消返回 `Canceled`；这两类传输终止不附 `FailureDetail`。已提交的短事务结果保持有效，调用方按 operation、generation 或 offset 规则继续。

业务命令因状态、版本、容量或参数被拒绝时，Gitea 返回 Connect error，并附带 `FailureDetail(category)`；category 是稳定的 `lower_snake_case` 字符串，对应的 Connect code 和处理方式见 [统一失败分类](gitea-server.md#统一失败分类)。错误的人类可读文本继续由 Connect error message 承担。**设计如此：失败分类不是跨语言闭合集合，而是 Gitea 服务层给 Manager 和 Gateway 使用的稳定机器可读原因。**使用字符串可以让新增业务拒绝原因只修改实际产生和消费该原因的代码，避免为了普通分类新增反复修改 proto、生成代码和双向转换表。generation 过旧时额外附带 `StaleGenerationDetail(current_generation)`；调用方根据当前 RPC 知道是哪一类 generation，并以服务端当前值为基线生成更高版本。普通 Runtime 或 Metadata 的相同 generation 对应不同内容时返回不可重试的 `generation_conflict`，表示单对象本地状态损坏。Fetch 或 inventory 中任一正数 `observed_operation_rversion` 大于仍存在且绑定当前 Manager 的 Codespace 当前版本时返回不可重试的 Manager 级 `state_history_conflict`，并在该请求的业务写入前结束。`UpdateLog` 的 offset conflict/gap 额外附带 `LogOffsetDetail`，使 Manager 以服务端实际文件末尾恢复追加。访问判定通过 response `oneof outcome` 返回 binding 或 `FailureDetail`；`RequestIdleStop` 的竞态结果也由 response `oneof outcome` 穷尽表达。`FinalizeOperation` 成功时只用 `resource_absent` 区分 Gitea 已不存在该对象，其余 accepted、重复提交或已经被新状态接管的结果都表示 Manager 可以结束本地旧 operation 上下文。

输入校验规则：

- [x] 每个 request 的 `protocol_version` 必须等于当前 ManagerService 主版本 1；0、负数和其他版本返回 `protocol_mismatch`，不能按旧客户端或默认行为继续。Gitea 在 Manager 身份认证后、任何业务读取结果或写入前拒绝。
- enum 只接受各定义中明确列出的业务值；`UNSPECIFIED` 和未知数值返回 `invalid_argument`。这样新增枚举值不会被旧服务端误作默认行为。
- `runtime_uuid` 只接受 Manager 生成并由 Gitea 绑定的 36 字符小写带连字符 UUID v4；其他形式在查询和构造锁 key 前返回 `invalid_argument`，保证一个 Codespace 只有一种运行侧表达。
- 数据库中的 operation/generation `0` 只表示尚未产生版本；`operation_rversion`、`inventory_generation`、`runtime_generation` 和 `metadata_generation` 的有效新值从 `1` 开始。operation-bound RPC 和 `ReportRuntimeTransition.observed_operation_rversion` 必须大于 0。inventory item 的 `observed_operation_rversion=0` 固定表示 Manager 没有可继续的完整 active operation 上下文，即使 Gitea 当前 `codespace.operation_rversion` 已经是正数也成立；正数固定表示 Manager 持有该版本的完整 active operation 上下文。该字段不传输本地历史最高版本，也不写回数据库版本。
- 所有版本递增使用 checked increment。任一 operation、交互或 Manager generation 无法递增时返回不可重试的 `version_exhausted`，不提交主状态、active operation、交互结果或本地快照的部分写入。Codespace operation/交互版本由管理员 force delete，单对象 runtime/metadata 版本由 Manager 清理该 UUID，inventory 版本由管理员删除 Manager 并创建新 Manager 身份；版本保持正数和单调递增，不回绕或重置。
- Manager 本地 `capacity_total` 为 `1..10000`，只用于限制本机管理的 Runtime 总数，不进入 Declare 或 Gitea 数据库。`FetchOperations.startup_capacity_available` 和 `cleanup_capacity_available` 均为 `0..256`，分别限制本次新领取的 create/resume 与 stop/delete。`accepted_create_tags` 最多 64 项，必须是当前 Declare 环境 tag 的规范子集，只限制新 create；resume 继续使用既有 Manager binding 和本地环境快照。Gitea 以两类容量之和推导 operation payload 上限，并限制在 `1..256`；两个可用容量都为 0 时仍处理全部 observed 续租，但不领取 queued operation。Manager 每次提交全部本地上下文完整的 running operation：相同版本续租，较低版本取得当前 payload，省略项保持不执行并等待原 deadline。**设计如此：**总容量和各环境当前能否创建都是 Manager 的瞬时运行事实，Fetch 只传递当前真正可执行的范围，避免 Gitea 保存会立即过期的容量快照。
- create operation 被领取时，`OperationPayload.codespace_id` 携带 Gitea 主记录 ID，`runtime_uuid` 为空。Manager 在修改 Incus、写入本地 Codespace 快照或建立 Gateway 路由前生成 UUID v4，并调用 `BindRuntimeIdentity(codespace_id, operation_rversion, runtime_uuid)`。Gitea 在 Codespace lock 内确认当前 Manager、当前 create operation 和 UUID 唯一后写入 `codespace.uuid`。相同 UUID 的重复绑定幂等成功，不同 UUID 或其他 Codespace 已占用该 UUID 时返回冲突。**设计如此：**create 排队和创建者页面需要一个立即可用的数据库身份，运行侧资源需要由真正领取任务的 Manager 分配唯一身份；绑定 RPC 是这两个身份之间的提交点，确保没有 Incus 资源先于 Gitea 接受的 runtime UUID 出现。
- `FetchOperations` 在续租、timeout 和 claim 前批量预检 observed 版本；高于已存在且绑定当前 Manager 的 Codespace 当前版本时整次返回 `state_history_conflict`。无记录或 binding 不匹配的 UUID 不续租，由完整 inventory 返回清理结果。
- `FetchOperationsResponse.renewed_leases` 最多与 request 的 `observed_operations` 等长；同一 UUID 不能同时出现在 `operations` 和 `renewed_leases`。普通 operation payload 与 observed 批量续租都返回正数 `lease_valid_for_milliseconds`：通常精确等于 `OPERATION_LEASE_TIMEOUT`，标准 lease 会越过固定总执行期限时返回到总期限为止、向下取整的实际正整数毫秒数。Gitea 把同一次授权的绝对 deadline 写入数据库但不通过协议回传；abort payload 不续租，因此相对时长固定为 0。
- `ReportInstances.instances` 最多 10000 条且 UUID 唯一，每次都是完整扫描结果。每次提交都使用高于 Manager 本地已使用值的新 `inventory_generation`；传输失败后的下一次完整扫描也使用更高值。Gitea 原子接受任何高于数据库当前值的 generation，等于或低于当前值返回 stale；更高请求成立后，旧 handler 在逐项写入和返回响应前复检失败并停止。数据库查询成功并明确确认 reported UUID 不存在时才返回 `cleanup_local_runtime`；数据库或请求处理失败不转换成清理指令。
- `ReportInstancesResponse.results` 与 request 的 UUID 一一对应。仍属于当前 Manager 且未进入 cleanup 的结果携带当前有效设置；cleanup 结果不携带设置；未绑定 creating 可以同时没有设置和 action。Manager 先确认 response 属于本地最新 inventory generation，再按结果应用设置和互斥 action。
- 每个 `RuntimeInstanceResult` 只使用 `cleanup_local_runtime`、`refetch_operation`、`clear_operation_context`、`stop_local_runtime` 或 `report_runtime_transition` 之一，优先级依次为 cleanup、refetch、clear、stop、report。Gitea 有 active operation 且其版本高于 Manager 上报的正数版本时可以 refetch；Manager 上报的正数版本高于 Gitea 当前 operation 版本时，整次请求返回 Manager 级 `state_history_conflict`。metadata cache 缺失和 final 的 ready 前置条件由对应 RPC 处理。
- inventory item 只携带 UUID、Runtime state 和 observed operation version；Gateway 用户 SSH 验证只携带 UUID 和客户端公钥，运行侧时间、原因、来源 IP 和客户端诊断留在 Manager/Gateway 本地日志。该 `VerifySSHPublicKey` 公钥用于用户连接工作区，与 `RequestRuntimeAccess.git_ssh_key.public_key` 提交的 Runtime Git SSH 公钥是两个独立用途。
- `report_runtime_transition.current_operation_rversion` 始终携带 Gitea 当前 operation 版本；它可由 Gitea running、Runtime stopped 的分歧或无 active operation 的 `RUNTIME_STATE_FAILED` inventory 触发。Gitea stopped、Runtime running 返回 `stop_local_runtime`；启动只能由 Gitea 下发的 resume operation 完成。`ReportRuntimeTransition.runtime_state` 只接受 `STOPPED|FAILED`：运行健康检查确认基础交互持续失败时，Manager 先停止实例再提交 `STOPPED`；只有资源明确不可恢复时提交 `FAILED`。诊断详情只进入 Manager 本地日志。
- `DeclareManager` 每次提交完整当前快照；客户端可以修改声明字段后整体覆盖，但不能通过 Declare 修改 Manager 身份、owner、secret 或 Codespace binding。
- `DeclareManagerResponse` 返回正数 `heartbeat_interval_milliseconds`、`runtime_metadata_refresh_interval_milliseconds` 和 `control_plane_max_message_size_bytes`，并返回来自 Gitea `ROOT_URL` 的规范 absolute `http|https` `gitea_web_url`。该 URL 必须有 host，不含 userinfo、query 或 fragment，path 是规范 AppSubURL 并以 `/` 结尾；HTTP 与 HTTPS 都可使用。Manager 启动后先以 recovering 立即声明，成功取得全部字段后才启动周期任务和领取流程；后续成功响应原子替换当前服务端参数。字段非法时 Manager 保持 recovering，后续 Fetch 提交两类零可用槽位，不采用本地猜测值。
- `DeclareManager.environments` 包含 1..64 项；tag 转为 lower-case 后使用 `[a-z0-9_-]+`、长度为 1..64，description trim 后最长 255 字符。规范化后的重复 tag 拒绝整次声明。
- `gateway_url` 使用无尾随点的规范 ASCII DNS 主机名，每个标签为 1..63 字符，最长派生 Endpoint Host 不超过 253 字符。Gitea 会识别它与 `ROOT_URL`、Session Cookie Domain 或其他 Manager 声明地址的重叠并记录部署诊断，但不会因为共享 Gateway URL 或 SSH 地址拒绝 Declare。任一语法校验失败都不产生部分声明更新。**设计如此：**共享入口是常见反向代理和统一 Gateway 部署形态，安全边界来自 Runtime UUID、Open Code binding、session 和 Manager 绑定复检，而不是地址唯一性。
- `ReportRuntimeMetadata.metadata` 使用 `RuntimeMetadata` typed message。`endpoints`、`boot` 和 `resource_usage` 都通过 proto 字段表达。Gitea 按规范化后的 typed snapshot 计算编码大小，固定不能超过 256 KiB。**设计如此：**Manager、codespace-proto-go 和 Gitea 共享同一份生成结构，字段含义由 proto 定义承担；页面展示、缓存 hash 和 Gateway 判定使用同一组字段。该上限保护单次缓存对象和 RPC 内存占用，属于双方实现共同遵循的协议保护值，不是部署规格，因此无需提供站点配置。
- `CreateOperationPayload.start_ref` 表达本次 clone 来源中的检出方式。普通分支和普通 Pull Request 来源分支使用 `refs/heads/<name>`，Tag 使用 `refs/tags/<name>`，AGit Pull Request 使用基仓库内部 PR ref，直接 commit 为空；`commit_sha` 始终锁定最终 HEAD。**设计如此：**协议只需要给 Manager 一个 clone 来源和一个 Git ref，不需要为 PR 再增加与现有 branch 检出重复的结构。
- Runtime Metadata 中 endpoints 最多 64 个且 `endpoint_id` 唯一；其中最多 63 个来自 Runtime manifest，Manager 固定补入一个 `endpoint_id=workspace`、`label=Workspace`、`public=false` 的 Web IDE 描述。普通 ID 固定匹配 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`，每项必须包含布尔 `public`。`workspace` 继续使用无 ID 前缀的 workspace Host。
- 每个 Endpoint 的 `label` 必须是合法 UTF-8；去除首尾 Unicode 空白后保存，按 Unicode 字符数计算的长度为 1 到 64，且不包含控制字符、`<` 或 `>`。Manager 与 Gitea 使用相同规则，不执行 Unicode 归一化、替换或自动清洗；非法 label 不写入本地路由或 Gitea cache。
- Runtime Metadata 的 boot 上下文按状态校验：active create/resume 使用当前 operation 和适用的 `RUNTIME_BOOT_STAGE_PREPARE_RUNTIME`、`RUNTIME_BOOT_STAGE_INITIALIZE_SYSTEM`、`RUNTIME_BOOT_STAGE_PREPARE_WORKSPACE`、`RUNTIME_BOOT_STAGE_START_ENVIRONMENT`、`RUNTIME_BOOT_STAGE_PUBLISH_READY`、`RUNTIME_BOOT_STAGE_READY` 顺序，running 固定为 boot 版本不大于当前 operation 的 `READY`；stopped 且无 active operation 时拒绝 metadata。同一 boot 版本一旦 ready 就保持 ready。`PUBLISH_READY` 表示 Manager 已完成运行侧校验，正在发布可进入的 ready metadata；这样命名是为了避免被误解成发布 Runtime 本体。
- `RuntimeResourceUsage` 只表达 CPU、内存和磁盘三类当前用量。CPU 使用 millicores，内存和磁盘使用 bytes；`observed_unix` 是 Manager 采样时间。各 used/limit 字段必须大于或等于 0，limit 为 0 表示当前无法从 Incus 取得明确限制。指标采样失败不会使 ready、final、open、SSH 或 Endpoint 授权失败，只让页面暂时显示无可用指标。**设计如此：**这些指标用于创建者判断当前工作区资源状态，不承担配额、调度或生命周期判断；复杂的网络、进程和 I/O 细项收益低且解释成本高，本设计不放入控制面协议。
- `ReportRuntimeMetadataResponse` 为空。成功响应确认 Gitea 接受了该请求携带的 `metadata_generation + metadata` typed snapshot；Manager 使用发送前保存的 generation 和完整快照更新 ready 接受记录并判断是否还需发送本地更新版本。功能关闭返回 `state_unavailable`，Manager 保留本地快照和 generation 重试。
- `OpenTokenBinding.endpoint_id` 和 Endpoint session binding 始终非空；默认 open 固定使用 `workspace`。
- Gitea 按功能开关、站点默认值和对象模式解析 `auto_stop_enabled + idle_timeout_seconds`。Manager 保存这两个实际运行值和 `interaction_generation`，不计算设置摘要；default 与 custom 当前解析结果相同时在运行侧具有相同策略，数据库中的 mode 仍决定站点默认值以后变化时是否跟随。
- `RequestIdleStop` 直接提交 Manager 观察到的开关、超时和交互版本。Gitea 先返回已经存在的同一 idle stop，再按当前 operation 和主状态返回 `not_applicable`；其余情况比较三个观察值，任一变化时返回完整 `observation_changed(runtime_settings)`。只有当前设置启用、三个值一致、Codespace 为 running 且版本可以递增时才创建 idle stop，并以统一 `pending(operation_rversion)` 表达首次创建或幂等重试。版本不能递增时返回不可重试的 `version_exhausted`。
- create/resume payload 和成功的当前 `ReportInstances` 响应都携带完整有效设置。`auto_stop_enabled=false` 时超时固定为 0；启用时超时必须大于 0。延迟设置快照可能短暂改变 Manager 本地计时，但 `RequestIdleStop` 会直接比较当前有效值和交互版本；控制面稳定后，下一次成功完整 inventory 重新下发当前设置。Open 和 SSH 的 allowed binding 返回本次事务提交后的 `interaction_generation`，Manager 只向前更新该值并重新开始完整空闲时长。
- `ValidateOpenToken` 对无法解析或显式过期的 code 尽力删除；Manager、Codespace、状态、权限、metadata、Endpoint 或在线状态校验不通过时返回 denied 并保留 code 到原 TTL。全部检查通过后删除必须成功才返回 allowed；删除后的交互事务失败会消费 code，用户重新发起 open。
- `ValidateOpenToken`、`ValidatePublicEndpoint`、`VerifySSHPublicKey` 和 `RevalidateGatewaySession` 只在 Codespace 功能启用时返回 allowed；功能关闭使用 response 的 `denied(state_unavailable)`，不创建新的协议状态。认证和公共普通 HTTP 每次转发前检查本地状态以及相同授权键最多 1 秒的新鲜 allowed，缺失时分别调用 `RevalidateGatewaySession` 或 `ValidatePublicEndpoint`；认证 WebSocket、SSH、公共 WebSocket 和持续超过复检周期的 HTTP 请求继续定时校验且不复用普通 HTTP 短期结果。
- `ValidatePublicEndpoint` 只接受非 `workspace` 的普通 Endpoint。调用方 Manager 必须仍与 Codespace binding 匹配且在线，Codespace 必须为稳定 running 且没有 active operation（包括 queued idle stop），Runtime Metadata 必须 ready，目标 Endpoint 必须存在且 `public=true`。成功不创建 Gateway session、不推进 `interaction_generation`、不更新 `last_active_unix`；denied 或 RPC 无法确认时 Gateway 不转发请求。
- `ValidateOpenToken` 和 `VerifySSHPublicKey` 的 allowed 只表示 Gitea 控制面授权。Open 流程在 RPC 后复检准入、当前路由和 session 上限并完成 session 登记。SSH 在配置的握手期限内确认本地 workspace、Incus API 和 Dev Container 后登记 live session，再复查本地目标；生命周期清理先成立时复查失败，后成立时取消已登记连接。
- SSH 公钥只用于 `VerifySSHPublicKey` 的本次新连接认证。`RevalidateGatewaySession` 的 SSH binding 固定为 `user_id + runtime_uuid`；公钥删除拒绝后续新连接，已有 transport 继续按用户登录状态、功能开关、生命周期、Manager/metadata、TTL、空闲超时和周期复检收敛。
- `RequestRuntimeAccess` 在功能启用、Manager 声明为 online 或 recovering 且 heartbeat 有效时，只接受三种阶段：与请求 `operation_rversion` 完全一致、已领取且租约未到期的 create 或 resume，以及请求版本等于 Codespace 当前版本且没有 active operation 的 running。Manager 每次都提交已经生成或恢复的 `RuntimeGitSSHKey.public_key`；成功响应在 `RuntimeAccessBundle` 中一次返回 `gitea_token`、规范化 `gitea_server_url`、当前源仓库可用的 Codespace Secret 和 Git SSH known_hosts。Secret 使用类型化重复字段表达并按名称排序；协议不通过 JSON 字符串传递第二套结构。active stop、active delete 和站点排空下的请求返回 `state_unavailable`。
- create payload 的 `repository.preferred_protocol` 由 Gitea 在构造 payload 时按当前站点 Git 传输配置计算，并且必须属于本次可用 clone 能力。create 下发当前可用协议的规范 clone URL；不可用协议对应字段为空。resume payload 不携带协议，Manager 以 workspace 实际 remote 恢复凭据配置。`RequestRuntimeAccess` 先在 Codespace 状态锁内确认当前 Manager、binding、生命周期版本和创建用户，再处理 Runtime 公钥与 SSH clone 配置；已经通过前述状态校验的请求，其公钥为空、无法解析或超过 Gitea SSH key 大小限制时返回 Connect `InvalidArgument`，失败分类为 `invalid_public_key`。**设计如此：**Manager 不可用或 operation 已被接管是当前请求的主状态结果，不应被无效公钥掩盖；Manager 可以先按状态机收敛，再处理本地密钥数据。密钥算法由 Manager 本地配置选择，默认 `ed25519`，可选 `rsa-4096`。绑定不存在时创建，绑定为相同公钥时幂等返回，已有不同公钥或全局指纹冲突时返回 `key_conflict`，不替换当前绑定。
- [x] `RequestRuntimeAccess` 在同一个 Codespace 状态锁内用同一份版本校验保护 Token、Secret 和 Git SSH 公钥关系，并在成功响应中返回严格 SSH Host Key 校验所需的规范化行。**设计如此：**这些材料在每次 create/resume 启动前必然一起取得，合并 RPC 可以消除两次相同生命周期校验；Token/Secret 数据事务、公钥指纹锁和授权文件重写仍保持各自现有边界，避免为了表面上的单事务把文件系统操作纳入数据库事务。
- [x] `RequestRuntimeAccess` 在 Runtime 公钥校验前返回当前 Manager、binding 或生命周期错误；只有状态允许的请求才以 Connect `InvalidArgument` 和 `invalid_public_key` 失败分类表达公钥格式问题。
- [x] User、Deploy 和 Codespace 公钥创建在各自数据库事务前取得同一规范指纹锁并在事务内复查。Codespace 路径先取得 Codespace lock 再取得指纹锁；不同 Codespace 或不同 Key 类型并发提交相同公钥时只允许一个符合类型规则的创建结果，历史重复指纹返回数据完整性硬错误。
- 所有编码后的 protobuf request 和 response 都不超过固定的 32 MiB 控制面消息上限；`UpdateLog.lines` 单行受 Gitea 内部日志行大小保护值限制。日志按返回的消息上限分批，inventory、observed operation、Runtime Metadata 和单条日志物理行是必须能整体传输的协议单元。**设计如此：**消息上限用于约束实现资源消耗，调整它不能增加 Codespace 功能或容量，因此由 Gitea 与 Manager 固定采用同一值，不作为部署配置公开。
- codespace-proto-go 生成包包含 `RuntimeMetadata`、`RuntimeEndpoint`、`RuntimeBoot`、`RuntimeResourceUsage`、`RuntimeCPUUsage`、`RuntimeMemoryUsage` 和 `RuntimeDiskUsage`，Gitea 与 Manager 不维护另一套同名业务 struct。
- Runtime Metadata 的内容 hash 基于校验后的 typed 字段：Endpoint 按 `endpoint_id` 排序，label 使用规范化文本，boot 使用 enum 值，resource usage 使用数值字段。请求中不存在 JSON 空白或对象 key 顺序导致的 hash 差异。

实现验收点：

- [x] 任一 request 协议版本不匹配时不产生业务写入；Declare 不更新 heartbeat 或声明快照，其他 RPC 不推进 operation、generation、日志、交互或清理结果。Manager 关闭入口和新动作后退出。
- [x] 全部 ManagerService request 的 `protocol_version` 都是字段 1；Gitea 运行时拒绝版本不匹配请求，不依赖业务字段号是否连续。
- Runtime Metadata 的 label 校验覆盖非法 UTF-8、去除首尾 Unicode 空白后为空、1/64/65 字符边界、控制字符、`<`、`>` 和合法中文；Manager 与 Gitea 对相同输入得到相同规范值和内容 hash。
- 软件展示版本、ManagerService 主版本、Manager 本地状态格式和实例内原生运行时格式使用不同字段，任一实现都不从另一个版本推导兼容性。
- [x] 所有 RPC 都通过统一 interceptor 认证 Manager ID 和 secret；所有 request 随后通过统一版本校验，handler 不各自遗漏该前置条件。
- [x] create payload 在 runtime UUID 绑定前使用 `codespace_id` 定位 Gitea 记录；`BindRuntimeIdentity` 成功后，运行侧 RPC 才使用 `runtime_uuid` 定位同一记录。
- [x] `BindRuntimeIdentity` 对相同 UUID 幂等，对不同 UUID 重绑、跨 Codespace 重复和错误 Manager 请求拒绝且不产生部分写入。
- Manager 身份认证成功后，handler 从 request context 读取同一 Manager 记录。
- 首次 Declare 响应在 64 KiB 读取上限内返回三个正数控制参数和规范 `gitea_web_url`；Manager 只在完整校验成功后原子启用这些参数并进入 online。URL 带 AppSubURL 时通过结构化 URL resolve 生成 Gitea 打开路由，不使用字符串拼接；非法响应保持 recovering，后续 Fetch 提交两类零可用槽位；后续成功 Declare 可以整体替换旧值。
- 命令拒绝与访问判定使用文中规定的两种响应方式，不混合表达。
- deadline/cancel 使用 Connect 标准 code 且不携带业务 failure detail，不被映射为 `internal_error`。
- Gitea 启动校验保证协议允许的最大不可拆分请求和响应能放入消息上限；超限输入在业务事务前返回 Connect `ResourceExhausted`，不推进 generation、不处理部分清单，也不生成清理指令。
- stale generation 错误携带 Gitea 当前已接受值；当前 RPC 已经确定 generation 类型，本地版本丢失的 Manager 可以恢复单调上报。
- `ReportInstances` 不以覆盖全部实例的 Manager 长锁串行；更高 generation 被接受后，旧请求不能继续写入或返回 action。
- inventory 只接受高于当前值的新 generation；更高请求成立后，旧请求停止逐项处理并且不返回结果。正数 observed operation 高于 Gitea 当前版本时返回 Manager 级 `state_history_conflict`，不推进基线、不处理差异、不生成清理指令。
- `cleanup_local_runtime` 只来自成功的当前 generation `ReportInstances` 响应，并覆盖数据库明确无记录、binding 不匹配和 failed 三种情况；普通 `resource_absent`、空 Fetch 或 RPC 错误不替代该明确指令。
- cleanup action 在 Manager 本地当前 generation 复检通过后先持久化，再关闭会话、删除归属 Incus 实例和本地快照；实例内凭据随根存储一并删除，Gitea 不等待完成回执。
- Manager 丢失本地 operation 版本基线后，running 主状态对应 stopped Runtime 或无 active operation 的 failed inventory 可使 Gitea 返回 `report_runtime_transition.current_operation_rversion`；stopped 主状态对应 running Runtime 只返回 stop 指令。failed inventory 的本地正版本低于当前 active operation 时通过 refetch 取得当前版本和 payload，版本相同时直接使用本地完整上下文提交 final failed；`observed_operation_rversion=0` 时不返回 refetch，原 operation 按既有 deadline 超时。
- `observed_operation_rversion` 的 0 和正数只表达 active operation 上下文是否完整，不携带历史最高版本。Manager 在内存中把每次请求与发出请求时各 UUID 已持久化的最高版本关联：响应版本低于该请求起点时使用本地 `operation_version_regression` 硬错误处理；响应不低于请求起点、但低于处理响应时本地最高版本时只丢弃延迟结果。该判断不增加协议字段，也不借 inventory 请求 Gitea 自动修复历史。
- 普通 operation payload 和 observed 批量续租都携带精确的正整数毫秒相对 lease 时长；服务端 Unix deadline 只保存在 Gitea。Manager 从请求开始时的本地单调时钟建立保守执行截止点。abort 的相对时长为 0，只授权立即执行对应的缩减清理。
- 所有版本字段拒绝负数和不允许的 0，递增永不发生回绕。
- 任一版本无法递增时返回 `version_exhausted` 且不写部分状态；清理范围按版本归属固定为 force delete 单个 Codespace、Manager 清理单 UUID 或删除并创建新 Manager 身份。
- Open、公共 Endpoint、SSH 和 session revalidate 的成功结果与拒绝 detail 通过 oneof 互斥返回。
- 功能关闭时四个访问 RPC 都返回 `denied(state_unavailable)`；认证和公共普通 HTTP 在下一次请求且最迟已有 allowed 的 1 秒期限结束后不进入 upstream，WebSocket、持续公共 HTTP 和 SSH 最迟在一个复检周期内关闭。
- metadata 成功空响应的语义完全来自对应请求；Manager 不从 response 读取 generation、boot 或快照字段。
- Open Code 缓存值无法解析、显式过期、暂时访问失败、成功删除和删除失败分别具有确定的消费结果；allowed 一定对应已经成功删除的 code。
- Open/SSH 的 Gitea allowed 不能越过 Manager 本地恢复和并发生命周期边界。Open 的最终本地复检与 session 登记使用同一个 Codespace 协调边界；SSH 在握手内确认本地后端，登记 live transport 后立即复查 Runtime 目标，生命周期清理发生在登记前后都能关闭连接。公共 Endpoint allowed 同样需要 Gateway 在调用前后复检同一不可变公共路由引用，并登记有界连接名额。
- 公共 Endpoint 还复用 Manager 的本地交互准入边界；进程恢复期间保留的路由不能仅凭 Gitea allowed 提前转发。
- Gateway 在调用 `ValidatePublicEndpoint` 前先于本地协调锁内取得 per-Endpoint 与 per-IP 的 `validating` 名额，allowed 后复检并原地转为连接名额；拒绝、传输失败和并发取消都释放同一名额。
- SSH 协议握手、Gitea 认证和本地后端确认在配置期限内完成；未完成握手会释放全局在途名额。公钥删除后新连接被拒绝，现有 transport 不需要新增公钥指纹字段即可按既有 session 边界结束。
- RequestIdleStop 的 `pending`、`observation_changed` 和 `not_applicable` 三种 outcome 互斥；`not_applicable.reason` 区分 operation 冲突、已经停止和生命周期暂不可用。响应丢失后以同一观察值重试，已创建的 idle stop 仍返回同一 `operation_rversion` 的 `pending`。
- create/resume 和完整 inventory 能把当前有效自动暂停设置下发给 Manager；延迟快照不能绕过 RequestIdleStop 的当前值复检而创建 stop。
- 控制面稳定后，完整 inventory 在一个报告周期加当前 RPC 退避内重新下发 Gitea 当前自动暂停设置。
- ReportInstances 对每个 reported UUID 恰好返回一个结果；仍绑定当前 Manager 的非 cleanup 结果携带设置，同一结果至多携带一个差异 action。
- Open 和 SSH 成功结果携带最新 `interaction_generation`；Manager 使用该值替换本地观察值并重新开始空闲计时。
- 默认 workspace 使用 `endpoint_id=workspace` 表达固定 Web IDE 授权对象；该保留值不出现在 Runtime Endpoint manifest，由 Manager 补入现有 `RuntimeMetadata.endpoints`，不为 code-server 增加专用 RPC 路由字段。**设计如此：**现有 Endpoint message 已能表达 Gitea 所需的授权和展示信息，实际实例目标仍由 Manager 本地 route store 保存。
- RequestRuntimeAccess 请求携带 `runtime_uuid`、`operation_rversion` 和固定上报的 `RuntimeGitSSHKey.public_key`；服务端根据当前 Codespace、active operation、Manager 和功能状态决定返回运行访问材料或 `state_unavailable`。请求不携带自报用途，调用方无法用额外模式字段改变授权结果。
- RequestRuntimeAccess 成功响应的 `access.gitea_token` 和 `access.gitea_server_url` 均非空；Manager 不从 clone URL 或内部控制面地址推导 Runtime 使用的 Gitea 根地址。
- response 中的 Secret 只来自创建用户的所有仓库范围或指定当前源仓库的记录，Gitea 在返回前复核当前代码写权限和拉取请求来源；名称唯一且按名称稳定排序。Manager 收到后仅用于本轮 create/resume 或 running 恢复，不写入持久状态。
- Manager 把 Secret 写入 Runtime 的 root 管理临时文件，并在运行命令的日志脱敏集合中加入全部非空值。stop 清理该临时文件；Secret 值的变更在下一次 create 或 resume 中取得。
- active create、active resume 和无 active operation 的 running 可以请求访问材料，但请求版本必须等于当前 Codespace operation 版本；active stop 返回 `state_unavailable`，但创建 stop 前已有的 Token 继续按 running 阶段授权到 stop final。
- create/resume 初始化阶段可以取得并使用 Token；本次 operation 的 ready metadata 和 Token 行缺一时，final done 被拒绝。
- create payload 在 `repository` 中携带本次计算出的 `preferred_protocol` 作为首次 clone 首选项，并携带当前可用协议的 HTTP(S)/SSH URL，禁用协议字段为空。resume payload 不携带协议；Manager 按 workspace 实际 remote 处理凭据。Manager 在运行 init/start 前先生成或恢复固定公钥，再通过 `RequestRuntimeAccess` 一次取得全部材料；之后改用 HTTP(S) 成功时，已经登记的公钥按 Codespace 生命周期保留。
- [x] 相同 operation 版本、公钥和响应丢失可以幂等重试；不同公钥不会替换当前绑定。running 恢复使用 Codespace 当前最后 operation 版本，避免无版本请求在生命周期变化后取得旧对象材料。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP 或 HTTPS（参考 Gitea Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
- Manager 配置可以要求 HTTPS 并指定 CA/server name；默认允许受信网络中的 HTTP，不在协议层硬编码 scheme

实现验收点：

- 每个 operation envelope 的 `command` 必须设置一个分支；普通 create 携带完整 payload，resume/stop/delete 使用各自分支；站点排空后 deadline 未到期的 create 使用 `abort_create`，对应 resume 使用 `abort_resume`。
- `CreateOperationPayload.environment_tag` 携带用户在 Gitea 确认页显式选择、服务端最终复检并用于 claim 的运行环境键；仓库 Dev Container 文件不修改该字段。Manager 在修改 Incus 前精确匹配本地声明环境，并把有效环境保存到本地 state、Incus 实例元数据和 bootstrap 输入。
- `CreateOperationPayload.repository.clone_http_url` 和 `repository.clone_ssh_url` 由 Gitea 现有仓库克隆地址生成器分别产生规范 HTTP(S) 与 SSH 地址；只有对应 clone 能力可用时返回非空。`repository.preferred_protocol` 表示本次 create 的首次首选项，并且必须指向一个非空 URL。内置 bootstrap 在受控临时 workspace 中先使用首选地址，clone/fetch 非零退出且另一种 URL 非空时清理该目录并在同一次调用中重试一次；最终失败写入不可恢复结果。本地前置错误和 HEAD 校验失败不切换协议。Manager 仍以锁定 SHA 和实际 remote 的本地凭据配置作为结果校验。
- `CreateOperationPayload.repository` 携带 `preferred_protocol`；`ResumeOperationPayload` 不携带协议。Manager 无论实际 remote 使用何种协议都通过一次 `RequestRuntimeAccess` 上报固定公钥并取得完整访问材料。
- `CreateOperationPayload.git_identity.gitea_username` 携带创建时的 Gitea 用户名，`git_identity.git_user_email` 携带隐私保护后的 Git email。Manager 用用户名派生 Runtime Linux 用户名和 Git `user.name`，并只在 create 初始化时写入 Git identity；resume 使用本地 state，不覆盖 workspace 中用户后续修改过的 Git identity。
- `CreateOperationPayload.dev_container` 按来源使用互斥字段：仓库来源携带相对 `repository_path`，对应提交使用 `repository.commit_sha`；模板来源携带创建时固化的 `template_content`。Manager 将该结构保存到本地 state，resume 从本地恢复，不要求 Gitea 重发 create payload。
- 多份仓库 Dev Container 文件只在 Gitea 创建页作为候选选择一份，RPC 始终只传一个 `dev_container`。基础镜像、Feature、Compose 与 lifecycle 组合由 Manager 原生运行时处理，不扩展控制面字段。
- `CreateOperationPayload.dev_container` 必须携带创建确认时固定的 Dev Container 选择。仓库来源使用路径和 `repository.commit_sha`，Manager clone 后从 workspace 读取；模板来源使用 Gitea 在创建时写入 Codespace 行的内容。附加仓库权限只由 Gitea 从用户选中的 Dev Container 配置解析和授权，Manager 不接收 authorization ID 或规则副本。
- observed-only 续租通过 `renewed_leases` 返回 UUID、版本和相对有效时长；普通 payload 使用相同的相对时长语义。Manager 据此建立不受两端墙上时钟差异影响的本地执行截止点。
- 每个 operation payload 返回当前 `log_offset`，Manager 从该 offset 继续追加日志。
- `UpdateLog` 成功返回服务端规范化写入后的 `next_offset`；offset conflict/gap 返回当前服务端 offset。
- Runtime transition、完整 inventory 和 Runtime Metadata 分别携带自己的单调版本。
- Runtime transition 同时携带生成该状态报告时观察到的 `operation_rversion`，旧 operation 上下文的状态报告不能覆盖新 operation 结果。
- Gateway 通过 `RevalidateGatewaySession` 复检已有认证 session：普通 HTTP 在每次请求转发前检查最多 1 秒的新鲜 allowed，缺失时调用，WebSocket 和 SSH 按固定定时器调用。公共 Endpoint 使用独立的 `ValidatePublicEndpoint` 和同样的普通 HTTP 短期 allowed，不构造虚假用户或 session binding；短期结果、并发 miss 合并和全进程 RPC 上限都属于 Manager 进程内行为，不增加协议字段或持久状态。
- inventory action 通过互斥 action 表达 cleanup、transition、operation refetch、清除旧 operation 上下文或本地 stop；transition action 携带生成状态报告所需的当前 operation 版本。
- final result 携带 Manager 本地保存的原 operation 类型；active operation 存在时严格校验，清空后只按相同版本和目标主状态判断重复 final。
- 普通命令拒绝返回 `FailureDetail`；只有 generation stale 和日志 offset 错误增加对应专用 detail，generation conflict 不附 stale detail。`FinalizeOperation` 直接提交 final status 与原 operation type，成功响应只保留 `resource_absent`；`RequestIdleStop` 的三种竞态结果和访问判定使用自身 response oneof。
- `FailureDetail.category` 原样承载统一失败分类表中的字符串；Gitea 写入服务层返回的分类字符串，Manager 和 Gateway 直接读取该字符串。
- HTTP 和 HTTPS transport 下生成的 handler、认证 header、failure detail 和幂等行为一致。
- [x] `RequestRuntimeAccess.git_ssh_key.public_key` 使用 SSH wire bytes；响应在 Token 和 Secret 之外只传输规范化 known_hosts 行，不重复传输可由 Codespace 推导的用户、仓库、状态或协议字段。
- SSH clone 未启用时，Gitea 不下发 `repository.clone_ssh_url`；`RequestRuntimeAccess` 仍登记固定公钥并返回空 known_hosts 集合，使 HTTP-only create/resume 使用同一启动流程。SSH clone 启用时响应至少包含一条匹配规范 SSH clone URL 的 Host Key 行。
