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

enum IdleStopNotApplicableReason {
  IDLE_STOP_NOT_APPLICABLE_REASON_UNSPECIFIED = 0;
  IDLE_STOP_NOT_APPLICABLE_REASON_OPERATION_CONFLICT = 1;
  IDLE_STOP_NOT_APPLICABLE_REASON_ALREADY_STOPPED = 2;
  IDLE_STOP_NOT_APPLICABLE_REASON_STATE_UNAVAILABLE = 3;
}

// ManagerService is implemented by Gitea and called by Codespace Manager.
service ManagerService {
  // RegisterManager exchanges the owner scope's current registration token for a Manager identity.
  rpc RegisterManager(RegisterManagerRequest) returns (RegisterManagerResponse);

  // DeclareManager updates Manager metadata, tags, and serves as heartbeat.
  rpc DeclareManager(DeclareManagerRequest) returns (DeclareManagerResponse);

  // FetchOperations returns operations for the Manager to execute.
  rpc FetchOperations(FetchOperationsRequest) returns (FetchOperationsResponse);

  // FinalizeOperation reports the final result of an active operation.
  rpc FinalizeOperation(FinalizeOperationRequest) returns (FinalizeOperationResponse);

  // UpdateLog appends sanitized log lines at a given offset for an active operation.
  rpc UpdateLog(UpdateLogRequest) returns (UpdateLogResponse);

  // ReportRuntimeMetadata writes a Runtime Metadata snapshot to Gitea's configured cache adapter.
  rpc ReportRuntimeMetadata(ReportRuntimeMetadataRequest) returns (ReportRuntimeMetadataResponse);

  // Returns or issues the current token for active create, active resume, or stable running recovery.
  rpc RequestGiteaToken(RequestGiteaTokenRequest) returns (RequestGiteaTokenResponse);

  // Creates or confirms the Codespace-lifetime Git SSH public key.
  rpc EnsureCodespaceGitSSHKey(EnsureCodespaceGitSSHKeyRequest) returns (EnsureCodespaceGitSSHKeyResponse);

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

// --- RegisterManager ---

message RegisterManagerRequest {
  // ManagerService protocol major version. Version 1 is required by this design.
  int32 protocol_version = 1;
  // The registration token shown in the Codespace manager settings page.
  string registration_token = 2;
}

message RegisterManagerResponse {
  // The Manager identity, assigned once and never reused.
  int64 manager_id = 1;
  // The Manager secret, returned only once in this response. Store locally.
  string manager_secret = 2;
}

// --- DeclareManager ---

message DeclareManagerRequest {
  // ManagerService protocol major version. It is independent of the display version.
  int32 protocol_version = 1;
  // Gateway scheme, DNS base domain, and optional port; no business path.
  string gateway_url = 2;
  string gateway_ssh_addr = 3;
  repeated string tags = 4;
  string version = 5;
  string name = 6;
  ManagerRuntimeState manager_runtime_state = 7;
  string gateway_ssh_host_key_algorithm = 8;
  string gateway_ssh_host_key_fingerprint_sha256 = 9;
  int64 gateway_ssh_host_key_updated_unix = 10;
  int32 capacity_total = 11;
  int32 capacity_available = 12;
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
  int32 capacity_available = 2;
  repeated AcceptedOperationType accepted_operation_types = 3;
  int32 max_operations = 4;
  repeated ObservedOperation observed_operations = 5;
  int32 cleanup_capacity_available = 6;
}

message ObservedOperation {
  string codespace_uuid = 1;
  int64 operation_rversion = 2;
}

message FetchOperationsResponse {
  repeated OperationPayload operations = 1;
  repeated RenewedOperationLease renewed_leases = 2;
}

message RenewedOperationLease {
  string codespace_uuid = 1;
  int64 operation_rversion = 2;
  int64 lease_valid_for_milliseconds = 3;
}

message OperationPayload {
  int64 operation_rversion = 1;
  string codespace_uuid = 2;
  int64 log_offset = 3;
  int64 lease_valid_for_milliseconds = 4;

  oneof command {
    CreateOperationPayload create = 10;
    ResumeOperationPayload resume = 11;
    StopOperationPayload stop = 12;
    DeleteOperationPayload delete = 13;
    AbortCreateOperationPayload abort_create = 14;
    AbortResumeOperationPayload abort_resume = 15;
  }
}

message ResumeOperationPayload {
  EffectiveCodespaceRuntimeSettings runtime_settings = 1;
  GitProtocol git_protocol = 2;
}
message StopOperationPayload {}
message DeleteOperationPayload {}
message AbortCreateOperationPayload {}
message AbortResumeOperationPayload {}

message CreateOperationPayload {
  int64 repo_id = 1;
  string repo_full_name = 2;
  string repo_name = 3;
  // Canonical HTTP(S) and SSH clone URLs generated by Gitea.
  string repo_clone_http_url = 4;
  // Absolute URL built from Gitea ROOT_URL, including AppSubURL.
  string repo_web_url = 5;
  int64 owner_id = 6;
  string owner_name = 7;
  string owner_type = 8; // user | organization
  string owner_display_name = 9;
  string codespace_owner_name = 10;
  string start_ref = 11;
  string ref_type = 12;
  string ref_name = 13;
  string commit_sha = 14;
  // Selects the matching local Incus template; it is not passed into Runtime.
  string repo_tag = 15;
  EffectiveCodespaceRuntimeSettings runtime_settings = 16;
  // Immutable protocol selected when this Codespace was created.
  GitProtocol git_protocol = 17;
  string repo_clone_ssh_url = 18;
}

// --- FinalizeOperation ---

message FinalizeOperationRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
  int64 operation_rversion = 3;
  FinalResult final = 4;
}

message FinalResult {
  FinalStatus status = 1;
  // The original Gitea-issued operation type. Abort commands retain their
  // underlying create/resume type.
  OperationType operation_type = 2;
}

message FinalizeOperationResponse {
  oneof outcome {
    FinalAccepted final_accepted = 1;
    IdempotentDone idempotent_done = 2;
    StaleOperation stale_operation = 3;
    ResourceAbsent resource_absent = 4;
  }
}

message FinalAccepted {}
message IdempotentDone {}
message StaleOperation {}
message ResourceAbsent {}

// --- UpdateLog ---

message UpdateLogRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
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
  string codespace_uuid = 2;
  // JSON data matching the Runtime Metadata schema.
  string metadata_json = 3;
  int64 metadata_generation = 4;
}

message ReportRuntimeMetadataResponse {}

// --- RequestGiteaToken ---

message RequestGiteaTokenRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
}

message RequestGiteaTokenResponse {
  // The plaintext Codespace Gitea Token for this codespace.
  string token = 1;
  // Gitea's externally reachable ROOT_URL, including AppSubURL.
  string server_url = 2;
}

// --- EnsureCodespaceGitSSHKey ---

message EnsureCodespaceGitSSHKeyRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
  // Canonical SSH wire-format public key blob parsed from the Runtime helper request.
  bytes public_key = 3;
}

message EnsureCodespaceGitSSHKeyResponse {
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
  string codespace_uuid = 2;
  bool observed_auto_stop_enabled = 3;
  int64 observed_idle_timeout_seconds = 4;
  int64 observed_interaction_generation = 5;
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
  string codespace_uuid = 2;
  // Always set. The default open route uses the logical "workspace" endpoint.
  string endpoint_id = 3;
  int64 interaction_generation = 4;
}

// --- ValidatePublicEndpoint ---

message ValidatePublicEndpointRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
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
  // codespace_uuid parsed from SSH connection string (cs-{id} prefix).
  string codespace_uuid = 2;
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
  string codespace_uuid = 1;
  RuntimeState runtime_state = 2;
  // Zero means that Manager has no local active-operation context.
  int64 observed_operation_rversion = 3;
}

message ReportInstancesResponse {
  // Exactly one result for every RuntimeInstanceRef in the request.
  repeated RuntimeInstanceResult results = 1;
}

message RuntimeInstanceResult {
  string codespace_uuid = 1;
  // Present when the Runtime still belongs to this Manager and is not being cleaned up.
  EffectiveCodespaceRuntimeSettings runtime_settings = 2;

  oneof action {
    CleanupLocalRuntime cleanup_local_runtime = 10;
    ReportRuntimeTransitionAction report_runtime_transition = 11;
    RefetchOperation refetch_operation = 12;
    StopLocalRuntime stop_local_runtime = 13;
    ClearOperationContext clear_operation_context = 14;
  }
}

// Persists local cleanup, then deletes the owned Incus instance, sessions,
// credentials and the local Codespace snapshot for this UUID.
message CleanupLocalRuntime {}
message ReportRuntimeTransitionAction {
  // Use this value as observed_operation_rversion for the requested fact.
  int64 current_operation_rversion = 1;
}
message StopLocalRuntime {
  // The latest operation version known by Gitea when this action was made.
  int64 current_operation_rversion = 1;
}
message RefetchOperation { int64 current_operation_rversion = 1; }
message ClearOperationContext { int64 current_operation_rversion = 1; }

// --- ReportRuntimeTransition ---

message ReportRuntimeTransitionRequest {
  int32 protocol_version = 1;
  string codespace_uuid = 2;
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
  string codespace_uuid = 2;
  string endpoint_id = 3;
}

message SSHSessionBinding {
  int64 user_id = 1;
  string codespace_uuid = 2;
}

message RevalidateGatewaySessionResponse {
  oneof outcome {
    SessionAllowed allowed = 1;
    FailureDetail denied = 2;
  }
}

message SessionAllowed {}

// Returned in access decisions and attached to Connect command errors.
message FailureDetail {
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
- `ManagerService` 包含本章列出的注册、声明、生命周期、日志、Runtime Metadata、开发凭据、空闲停止、访问校验、inventory、runtime transition 和 session revalidate RPC。
- operation、final、runtime、git protocol、idle stop reason 等枚举只把明确业务值作为可处理输入，`UNSPECIFIED` 用于输入校验失败。
- response 中的 `oneof outcome` 穷尽表达访问判定、final、idle stop、inventory action、runtime transition 和 session revalidate 的互斥结果。

## 认证机制

所有 RPC（除 `RegisterManager` 外）使用以下 HTTP header 认证：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，token 通过 request body 传递。每个 ManagerService request 都必须提交 `protocol_version=1`。Register 在查询 registration token 前校验版本；其他 RPC 先通过统一入口认证 Manager ID 和 secret，再在取得业务锁、更新 heartbeat/generation 或执行生命周期读写前校验版本。

`protocol_version` 是 ManagerService 的主版本。当前设计只支持版本 1，Gitea 同一时刻只实现一个主版本；只有会改变既有字段含义、状态推进或错误处理的不兼容变更才提高它。普通增加可由旧端忽略的 protobuf 字段时保持当前主版本。版本不匹配返回 `protocol_mismatch`，当前请求不产生任何业务写入。Manager 收到该错误后关闭入口和新的 Incus 修改，以明确错误退出。该字段与用于页面展示的软件 `version`、Manager 本地状态文件格式版本以及脚本结果版本互相独立，也不保存到 Manager 数据库记录。

**设计如此：每个请求都携带主版本，ManagerService 不协商多个协议主版本。**逐请求字段能拒绝仍持有有效 Secret 但协议不匹配的进程，也不会依赖最近一次 Declare 或数据库中的历史声明推测当前调用方版本。Gitea 和 Manager 可以在保持主版本兼容时独立更新；需要提高主版本时，由部署方完成配套升级。这个边界在执行生命周期写入前拒绝不兼容客户端，同时不增加能力列表和分支状态机。

**设计如此：每个 request 的 `protocol_version` 固定为 protobuf 字段 1。**协议版本是所有请求共同且最先校验的前置字段，放在第一位可以从消息定义直接看出统一约定；其余业务字段从 2 开始连续编号，当前 wire contract 以这套完整布局为准。

`CONTROL_PLANE_TIMEOUT` 到期返回 Connect `DeadlineExceeded`，caller 取消返回 `Canceled`；这两类传输终止不附 `FailureDetail`。已提交的短事务结果保持有效，除 `RegisterManager` 外的调用方按 operation、generation 或 offset 规则继续；`RegisterManager` 的不确定结果由管理员先检查未 Declare 的记录。

业务命令因状态、版本、容量或参数被拒绝时，Gitea 返回 Connect error，并附带 `FailureDetail(category)`；category 对应的 Connect code 和处理方式见 [统一失败分类](gitea-server.md#统一失败分类)。协议只传输 category，避免 category、Connect code 和另一个布尔字段给出互相矛盾的重试含义。generation 过旧时额外附带 `StaleGenerationDetail(current_generation)`；调用方根据当前 RPC 知道是哪一类 generation，并以服务端当前值为基线生成更高版本。普通 Runtime 或 Metadata 的相同 generation 对应不同内容时返回不可重试的 `generation_conflict`，表示单对象本地状态损坏。Fetch 或 inventory 中任一正数 `observed_operation_rversion` 大于仍存在且绑定当前 Manager 的 Codespace 当前版本时返回不可重试的 Manager 级 `state_history_conflict`，并在该请求的业务写入前结束。`UpdateLog` 的 offset conflict/gap 额外附带 `LogOffsetDetail`，使 Manager 以服务端实际文件末尾恢复追加。访问判定通过 response `oneof outcome` 返回 binding 或 `FailureDetail`；`FinalizeOperation` 和 `RequestIdleStop` 的幂等或竞态结果也由各自 response `oneof outcome` 穷尽表达。

输入校验规则：

- [x] 每个 request 的 `protocol_version` 必须等于当前 ManagerService 主版本 1；0、负数和其他版本返回 `protocol_mismatch`，不能按旧客户端或默认行为继续。Register 在 token 查询前拒绝；其他 RPC 在 Manager 身份认证后、任何业务读取结果或写入前拒绝。
- enum 只接受各定义中明确列出的业务值；`UNSPECIFIED` 和未知数值返回 `invalid_argument`。这样新增枚举值不会被旧服务端误作默认行为。
- `codespace_uuid` 只接受 Gitea 生成的 36 字符小写带连字符 UUID v4；其他形式在查询和构造锁 key 前返回 `invalid_argument`，保证一个 Codespace 只有一种外部表达。
- 数据库中的 operation/generation `0` 只表示尚未产生版本；`operation_rversion`、`inventory_generation`、`runtime_generation` 和 `metadata_generation` 的有效新值从 `1` 开始。operation-bound RPC 和 `ReportRuntimeTransition.observed_operation_rversion` 必须大于 0。inventory item 的 `observed_operation_rversion=0` 固定表示 Manager 没有可继续的完整 active operation 上下文，即使 Gitea 当前 `codespace.operation_rversion` 已经是正数也成立；正数固定表示 Manager 持有该版本的完整 active operation 上下文。该字段不传输本地历史最高版本，也不写回数据库版本。
- 所有版本递增使用 checked increment。任一 operation、交互或 Manager generation 无法递增时返回不可重试的 `version_exhausted`，不提交主状态、active operation、交互结果或本地快照的部分写入。Codespace operation/交互版本由管理员 force delete，单对象 runtime/metadata 版本由 Manager 清理该 UUID，inventory 版本由管理员删除 Manager 并重新注册；版本保持正数和单调递增，不回绕或重置。
- `DeclareManager.capacity_total` 为 `1..10000`，单个 Manager 管理的 Runtime 总数上限为 10000；超限时按 Manager 恢复规则保持 recovering。
- `FetchOperations.capacity_available` 为 `0..DeclareManager.capacity_total`，限制本次新领取的 create/resume；`cleanup_capacity_available` 为 `0..256`，限制本次新领取的 stop/delete。`max_operations` 为 `1..256`，只限制完整 operation payload；两个可用容量都为 0 时仍处理全部 observed 续租，但不领取 queued operation。Manager 每次提交全部本地上下文完整的 running operation：相同版本续租，较低版本取得当前 payload，省略项保持不执行并等待原 deadline。
- `FetchOperations` 在续租、timeout 和 claim 前批量预检 observed 版本；高于已存在且绑定当前 Manager 的 Codespace 当前版本时整次返回 `state_history_conflict`。无记录或 binding 不匹配的 UUID 不续租，由完整 inventory 返回清理结果。
- `FetchOperationsResponse.renewed_leases` 最多与 request 的 `observed_operations` 等长；同一 UUID 不能同时出现在 `operations` 和 `renewed_leases`。普通 operation payload 与 observed 批量续租都返回正数 `lease_valid_for_milliseconds`：通常精确等于 `OPERATION_LEASE_TIMEOUT`，标准 lease 会越过固定总执行期限时返回到总期限为止、向下取整的实际正整数毫秒数。Gitea 把同一次授权的绝对 deadline 写入数据库但不通过协议回传；abort payload 不续租，因此相对时长固定为 0。
- `ReportInstances.instances` 最多 10000 条且 UUID 唯一，每次都是完整扫描结果。每次提交都使用高于 Manager 本地已使用值的新 `inventory_generation`；传输失败后的下一次完整扫描也使用更高值。Gitea 原子接受任何高于数据库当前值的 generation，等于或低于当前值返回 stale；更高请求成立后，旧 handler 在逐项写入和返回响应前复检失败并停止。数据库查询成功并明确确认 reported UUID 不存在时才返回 `cleanup_local_runtime`；数据库或请求处理失败不转换成清理指令。
- `ReportInstancesResponse.results` 与 request 的 UUID 一一对应。仍属于当前 Manager 且未进入 cleanup 的结果携带当前有效设置；cleanup 结果不携带设置；未绑定 creating 可以同时没有设置和 action。Manager 先确认 response 属于本地最新 inventory generation，再按结果应用设置和互斥 action。
- 每个 `RuntimeInstanceResult` 只使用 `cleanup_local_runtime`、`refetch_operation`、`clear_operation_context`、`stop_local_runtime` 或 `report_runtime_transition` 之一，优先级依次为 cleanup、refetch、clear、stop、report。Gitea 有 active operation 且其版本高于 Manager 上报的正数版本时可以 refetch；Manager 上报的正数版本高于 Gitea 当前 operation 版本时，整次请求返回 Manager 级 `state_history_conflict`。metadata cache 缺失和 final 的 ready 前置条件由对应 RPC 处理。
- inventory item 只携带 UUID、Runtime state 和 observed operation version；Gateway 用户 SSH 验证只携带 UUID 和客户端公钥，运行侧时间、原因、来源 IP 和客户端诊断留在 Manager/Gateway 本地日志。该 `VerifySSHPublicKey` 公钥用于用户连接工作区，与 `EnsureCodespaceGitSSHKey` 确保的 Runtime Git SSH 公钥是两个独立用途。
- `report_runtime_transition.current_operation_rversion` 始终携带 Gitea 当前 operation 版本；它可由 Gitea running、Runtime stopped 的分歧或无 active operation 的 `RUNTIME_STATE_FAILED` inventory 触发。Gitea stopped、Runtime running 返回 `stop_local_runtime`；启动只能由 Gitea 下发的 resume operation 完成。`ReportRuntimeTransition.runtime_state` 只接受 `STOPPED|FAILED`：运行健康检查确认基础交互持续失败时，Manager 先停止实例再提交 `STOPPED`；只有资源明确不可恢复时提交 `FAILED`。诊断详情只进入 Manager 本地日志。
- `DeclareManager` 每次提交完整当前快照；客户端可以修改声明字段后整体覆盖，但不能通过 Declare 修改 Manager 身份、owner、secret 或 Codespace binding。
- `DeclareManagerResponse` 返回正数 `heartbeat_interval_milliseconds`、`runtime_metadata_refresh_interval_milliseconds` 和 `control_plane_max_message_size_bytes`，并返回来自 Gitea `ROOT_URL` 的规范 absolute `http|https` `gitea_web_url`。该 URL 必须有 host，不含 userinfo、query 或 fragment，path 是规范 AppSubURL 并以 `/` 结尾；HTTP 与 HTTPS 都可使用。Manager 启动后先以 recovering 立即声明，成功取得全部字段后才启动周期任务和领取流程；后续成功响应原子替换当前服务端参数。字段非法时 Manager 保持 recovering 和零容量，不采用本地猜测值。
- `DeclareManager.tags` 最多 64 项，单项 lower-case 后使用 `[a-z0-9_-]+`、长度为 1-64，并规范化去重。
- `gateway_url` 使用无尾随点的规范 ASCII DNS 主机名，每个标签为 1..63 字符，最长派生 Endpoint Host 不超过 253 字符，并与 Gitea `ROOT_URL` 处于不同可注册域；`gateway_url` 与 `gateway_ssh_addr` 分别在 Manager 间保持规范化唯一。任一校验或唯一性冲突都不产生部分声明更新。
- `metadata_json` 规范化后不超过 `RUNTIME_METADATA_MAX_SIZE`。
- Runtime Metadata 中 endpoints 最多 64 个且 `endpoint_id` 唯一；ID 固定匹配 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`，每项必须包含布尔 `public`。`workspace` 项的 `public` 必须为 false，并继续使用无 ID 前缀的 workspace Host。
- 每个 Endpoint 的 `label` 必须是合法 UTF-8；去除首尾 Unicode 空白后保存，按 Unicode 字符数计算的长度为 1 到 64，且不包含控制字符、`<` 或 `>`。Manager 与 Gitea 使用相同规则，不执行 Unicode 归一化、替换或自动清洗；非法 label 不写入本地路由或 Gitea cache。
- Runtime Metadata 的 boot 上下文按状态校验：active create/resume 使用当前 operation 和适用的 `prepare-runtime|initialize-system|prepare-workspace|start-environment|publish-runtime|ready` 顺序，running 固定为 boot 版本不大于当前 operation 的 `ready`；stopped 且无 active operation 时拒绝 metadata。同一 boot 版本一旦 ready 就保持 ready。
- `ReportRuntimeMetadataResponse` 为空。成功响应确认 Gitea 接受了该请求携带的 `metadata_generation + metadata_json`；Manager 使用发送前保存的 generation 和完整快照更新 ready 接受记录并判断是否还需发送本地更新版本。功能关闭返回 `state_unavailable`，Manager 保留本地快照和 generation 重试。
- `OpenTokenBinding.endpoint_id` 和 Endpoint session binding 始终非空；默认 open 固定使用 `workspace`。
- Gitea 按功能开关、站点默认值和对象模式解析 `auto_stop_enabled + idle_timeout_seconds`。Manager 保存这两个实际运行值和 `interaction_generation`，不计算设置摘要；default 与 custom 当前解析结果相同时在运行侧具有相同策略，数据库中的 mode 仍决定站点默认值以后变化时是否跟随。
- `RequestIdleStop` 直接提交 Manager 观察到的开关、超时和交互版本。Gitea 先返回已经存在的同一 idle stop，再按当前 operation 和主状态返回 `not_applicable`；其余情况比较三个观察值，任一变化时返回完整 `observation_changed(runtime_settings)`。只有当前设置启用、三个值一致、Codespace 为 running 且版本可以递增时才创建 idle stop，并以统一 `pending(operation_rversion)` 表达首次创建或幂等重试。版本不能递增时返回不可重试的 `version_exhausted`。
- create/resume payload 和成功的当前 `ReportInstances` 响应都携带完整有效设置。`auto_stop_enabled=false` 时超时固定为 0；启用时超时必须大于 0。延迟设置快照可能短暂改变 Manager 本地计时，但 `RequestIdleStop` 会直接比较当前有效值和交互版本；控制面稳定后，下一次成功完整 inventory 重新下发当前设置。Open 和 SSH 的 allowed binding 返回本次事务提交后的 `interaction_generation`，Manager 只向前更新该值并重新开始完整空闲时长。
- `ValidateOpenToken` 对无法解析或显式过期的 code 尽力删除；Manager、Codespace、状态、权限、metadata、Endpoint 或在线状态校验不通过时返回 denied 并保留 code 到原 TTL。全部检查通过后删除必须成功才返回 allowed；删除后的交互事务失败会消费 code，用户重新发起 open。
- `ValidateOpenToken`、`ValidatePublicEndpoint`、`VerifySSHPublicKey` 和 `RevalidateGatewaySession` 只在 Codespace 功能启用时返回 allowed；功能关闭使用 response 的 `denied(state_unavailable)`，不创建新的协议状态。认证和公共普通 HTTP 每次转发前检查本地状态以及相同授权键最多 1 秒的新鲜 allowed，缺失时分别调用 `RevalidateGatewaySession` 或 `ValidatePublicEndpoint`；认证 WebSocket、SSH、公共 WebSocket 和持续超过复检周期的 HTTP 请求继续定时校验且不复用普通 HTTP 短期结果。
- `ValidatePublicEndpoint` 只接受非 `workspace` 的普通 Endpoint。调用方 Manager 必须仍与 Codespace binding 匹配且在线，Codespace 必须为稳定 running 且没有 active operation（包括 queued idle stop），Runtime Metadata 必须 ready，目标 Endpoint 必须存在且 `public=true`。成功不创建 Gateway session、不推进 `interaction_generation`、不更新 `last_active_unix`；denied 或 RPC 无法确认时 Gateway 不转发请求。
- `ValidateOpenToken` 和 `VerifySSHPublicKey` 的 allowed 只表示 Gitea 控制面授权。Gateway 在 RPC 前预检本地 Codespace session 准入，allowed 后再在同一 Codespace 协调锁内复检准入、当前路由和 session 上限，并完成 session 登记或最长 30 秒的 SSH connecting reservation；并发生命周期或路由变化先成立时不建立连接。
- SSH 公钥只用于 `VerifySSHPublicKey` 的本次新连接认证。`RevalidateGatewaySession` 的 SSH binding 固定为 `user_id + codespace_uuid`；公钥删除拒绝后续新连接，已有 transport 继续按用户登录状态、功能开关、生命周期、Manager/metadata、TTL、空闲超时和周期复检收敛。
- `RequestGiteaToken` 在功能启用、Manager 声明为 online 或 recovering 且 heartbeat 有效时，只接受三种阶段：已领取且租约未到期的 create、已领取且租约未到期的 resume，以及无 active operation 的 running。成功时返回或签发 Token，并始终返回规范化 `server_url`。active stop 创建前已经下发的 Token 仍按 running 阶段完成新请求授权，但该 worker 不能重新读取、签发或修复 Token；active stop、active delete 和站点排空下的 `RequestGiteaToken` 返回 `state_unavailable`。
- create/resume payload 的 `git_protocol` 必须等于 Codespace 创建时固化的 `http|ssh` 首选项。create 同时下发两种规范 clone URL；所选脚本实际使用 SSH 时，通过 `EnsureCodespaceGitSSHKey` 创建或确认公钥，SSH remote 的 resume 复用同一密钥。请求公钥为空、无法解析、算法不是 Ed25519 或超过 Gitea SSH key 大小限制时返回 `invalid_argument`。
- `EnsureCodespaceGitSSHKey` 只接受与调用方 Manager 绑定、当前已领取且期限未到期的 create/resume 初始化阶段；固化首选项为 `http` 或 `ssh` 都可以调用。create 可以在 HTTP(S) 首选失败后为 SSH fallback 调用；resume 由脚本仅在 workspace 当前实际 remote 为 SSH 时调用。绑定不存在时创建，绑定为相同公钥时幂等返回当前 `known_hosts_lines`；已有不同公钥或全局指纹冲突时返回 `key_conflict`，不替换当前绑定。响应至少包含一条与 Gitea SSH 对外 host 和有效端口匹配的规范化 Host Key 行。
- User、Deploy 和 Codespace 公钥创建在各自数据库事务前取得同一规范指纹锁并在事务内复查。Codespace 路径先取得 Codespace lock 再取得指纹锁；不同 Codespace 或不同 Key 类型并发提交相同公钥时只允许一个符合类型规则的创建结果，历史重复指纹返回数据完整性硬错误。
- 所有编码后的 protobuf request 和 response 都不超过 `CONTROL_PLANE_MAX_MESSAGE_SIZE`；`UpdateLog.lines` 单行另受 `LOG_MAX_LINE_SIZE` 限制。日志按返回的消息上限分批，inventory、observed operation、Runtime Metadata 和单条日志物理行是必须能整体传输的协议单元。

实现验收点：

- [x] 任一 request 协议版本不匹配时不产生业务写入；Register 不查询 token 或创建 Manager，Declare 不更新 heartbeat 或声明快照，其他 RPC 不推进 operation、generation、日志、交互或清理结果。Manager 关闭入口和新动作后退出。
- [x] 全部 ManagerService request 的 `protocol_version` 都是字段 1，各请求业务字段从 2 开始连续编号。
- Runtime Metadata 的 label 校验覆盖非法 UTF-8、去除首尾 Unicode 空白后为空、1/64/65 字符边界、控制字符、`<`、`>` 和合法中文；Manager 与 Gitea 对相同输入得到相同规范值和内容 hash。
- 软件展示版本、ManagerService 主版本、本地状态格式版本和脚本结果版本使用不同字段，任一实现都不从另一个版本推导兼容性。
- [x] 除 `RegisterManager` 外的 RPC 都通过统一 interceptor 认证 Manager ID 和 secret；所有 request 随后通过统一版本校验，handler 不各自遗漏该前置条件。
- Manager 身份认证成功后，handler 从 request context 读取同一 Manager 记录。
- 首次 Declare 响应在 64 KiB 读取上限内返回三个正数控制参数和规范 `gitea_web_url`；Manager 只在完整校验成功后原子启用这些参数并进入 online。URL 带 AppSubURL 时通过结构化 URL resolve 生成 Gitea 打开路由，不使用字符串拼接；非法响应保持 recovering 和零容量，后续成功 Declare 可以整体替换旧值。
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
- 任一版本无法递增时返回 `version_exhausted` 且不写部分状态；清理范围按版本归属固定为 force delete 单个 Codespace、Manager 清理单 UUID 或删除并重新注册 Manager。
- Open、公共 Endpoint、SSH 和 session revalidate 的成功结果与拒绝 detail 通过 oneof 互斥返回。
- 功能关闭时四个访问 RPC 都返回 `denied(state_unavailable)`；认证和公共普通 HTTP 在下一次请求且最迟已有 allowed 的 1 秒期限结束后不进入 upstream，WebSocket、持续公共 HTTP 和 SSH 最迟在一个复检周期内关闭。
- metadata 成功空响应的语义完全来自对应请求；Manager 不从 response 读取 generation、boot 或快照字段。
- Open Code 缓存值无法解析、显式过期、暂时访问失败、成功删除和删除失败分别具有确定的消费结果；allowed 一定对应已经成功删除的 code。
- Open/SSH 的 Gitea allowed 不能越过 Manager 本地恢复和并发生命周期边界；最终本地复检与 session 登记使用同一个 Codespace 协调锁临界区。公共 Endpoint allowed 同样需要 Gateway 在调用前后复检同一不可变公共路由引用，并在该锁内登记有界连接名额。
- 公共 Endpoint 还复用 Manager 的本地交互准入边界；进程恢复期间保留的路由不能仅凭 Gitea allowed 提前转发。
- Gateway 在调用 `ValidatePublicEndpoint` 前先于本地协调锁内取得 per-Endpoint 与 per-IP 的 `validating` 名额，allowed 后复检并原地转为连接名额；拒绝、传输失败和并发取消都释放同一名额。
- SSH 认证成功后的 connecting reservation 在 30 秒内转为 live 或只清理一次；公钥删除后新连接被拒绝，现有 transport 不需要新增公钥指纹字段即可按既有 session 边界结束。
- RequestIdleStop 的 `pending`、`observation_changed` 和 `not_applicable` 三种 outcome 互斥；`not_applicable.reason` 区分 operation 冲突、已经停止和生命周期暂不可用。响应丢失后以同一观察值重试，已创建的 idle stop 仍返回同一 `operation_rversion` 的 `pending`。
- create/resume 和完整 inventory 能把当前有效自动暂停设置下发给 Manager；延迟快照不能绕过 RequestIdleStop 的当前值复检而创建 stop。
- 控制面稳定后，完整 inventory 在一个报告周期加当前 RPC 退避内重新下发 Gitea 当前自动暂停设置。
- ReportInstances 对每个 reported UUID 恰好返回一个结果；仍绑定当前 Manager 的非 cleanup 结果携带设置，同一结果至多携带一个差异 action。
- Open 和 SSH 成功结果携带最新 `interaction_generation`；Manager 使用该值替换本地观察值并重新开始空闲计时。
- 默认 workspace、Runtime workspace Endpoint 和 Manager 内置 Web SSH 都使用同一个 Open Token binding 结构，由 `endpoint_id=workspace` 表达稳定授权对象。
- RequestGiteaToken 请求只包含 `codespace_uuid`；服务端根据当前 Codespace、active operation、Manager 和功能状态决定返回 Token 或 `state_unavailable`。单一请求形态确保调用方无法通过自报用途改变授权结果。
- RequestGiteaToken 成功响应的 `token/server_url` 均非空；Manager 不从 clone URL 或内部控制面地址推导 Runtime 使用的 Gitea 根地址。
- active create、active resume 和无 active operation 的 running 可以请求 Token；active stop 返回 `state_unavailable`，但创建 stop 前已有的 Token 继续按 running 阶段授权到 stop final。
- create/resume 初始化阶段可以取得并使用 Token；本次 operation 的 ready metadata 和 Token 行缺一时，final done 被拒绝。
- create/resume payload 始终携带已固化的 `git_protocol` 作为首次 clone 首选项；create 同时携带 HTTP(S)/SSH URL。脚本实际尝试 SSH 前通过 `EnsureCodespaceGitSSHKey` 创建或确认公钥；之后改用 HTTP(S) 成功时，已经登记的公钥按 Codespace 生命周期保留。
- `EnsureCodespaceGitSSHKey` 请求只携带 UUID 和公钥字节；用户、仓库、初始化阶段和生命周期状态由服务端当前关系取得，响应只返回 Runtime 建立严格 SSH Host Key 校验所需的规范化行。
- 相同公钥和响应丢失可以幂等重试；不同公钥不会替换当前绑定。公钥不携带 operation 版本，Manager 使用本地 operation 上下文把 Runtime 请求关联到当前生命周期操作。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP 或 HTTPS（参考 Gitea Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
- Manager 配置可以要求 HTTPS 并指定 CA/server name；默认允许受信网络中的 HTTP，不在协议层硬编码 scheme

实现验收点：

- 每个 operation envelope 的 `command` 必须设置一个分支；普通 create 携带完整 payload，resume/stop/delete 使用各自分支；站点排空后 deadline 未到期的 create 使用 `abort_create`，对应 resume 使用 `abort_resume`。
- `CreateOperationPayload.repo_tag` 携带创建时锁定并用于 claim 的 tag，使声明多个 tag 的 Manager 可以选择同名 Incus 模板；该值不传入 Runtime。
- `CreateOperationPayload.repo_clone_http_url` 和 `repo_clone_ssh_url` 由 Gitea 现有仓库克隆地址生成器分别产生规范 HTTP(S) 与 SSH 地址；两者始终同时返回，`git_protocol` 表示站点固化的首次首选项。内置 `start.sh` 在受控临时 workspace 中先使用首选地址，clone/fetch 非零退出时清理该目录并用另一地址重试一次；本地前置错误和 HEAD 校验失败不切换协议。自定义脚本可以选择任一地址，Manager 仍以锁定 SHA 和实际 remote 的本地凭据配置作为结果校验。`repo_web_url` 使用包含 `AppSubURL` 的 `ROOT_URL`。
- `CreateOperationPayload` 与 `ResumeOperationPayload` 都携带创建时固化的首选 `GitProtocol`；create 同时携带两种 clone URL，实际 remote 为 SSH 时通过 `EnsureCodespaceGitSSHKey` 创建或确认 Codespace 公钥。
- observed-only 续租通过 `renewed_leases` 返回 UUID、版本和相对有效时长；普通 payload 使用相同的相对时长语义。Manager 据此建立不受两端墙上时钟差异影响的本地执行截止点。
- 每个 operation payload 返回当前 `log_offset`，Manager 从该 offset 继续追加日志。
- `UpdateLog` 成功返回服务端规范化写入后的 `next_offset`；offset conflict/gap 返回当前服务端 offset。
- Runtime transition、完整 inventory 和 Runtime Metadata 分别携带自己的单调版本。
- Runtime transition 同时携带生成该状态报告时观察到的 `operation_rversion`，旧 operation 上下文的状态报告不能覆盖新 operation 结果。
- Gateway 通过 `RevalidateGatewaySession` 复检已有认证 session：普通 HTTP 在每次请求转发前检查最多 1 秒的新鲜 allowed，缺失时调用，WebSocket 和 SSH 按固定定时器调用。公共 Endpoint 使用独立的 `ValidatePublicEndpoint` 和同样的普通 HTTP 短期 allowed，不构造虚假用户或 session binding；短期结果、并发 miss 合并和全进程 RPC 上限都属于 Manager 进程内行为，不增加协议字段或持久状态。
- inventory action 通过互斥 action 表达 cleanup、transition、operation refetch、清除旧 operation 上下文或本地 stop；transition action 携带生成状态报告所需的当前 operation 版本。
- final result 携带 Manager 本地保存的原 operation 类型；active operation 存在时严格校验，清空后只按相同版本和目标主状态判断重复 final。
- 普通命令拒绝返回 `FailureDetail`；只有 generation stale 和日志 offset 错误增加对应专用 detail，generation conflict 不附 stale detail。`FinalizeOperation` 的四种正常处理结果、`RequestIdleStop` 的三种竞态结果和访问判定分别使用自身 response oneof。
- HTTP 和 HTTPS transport 下生成的 handler、认证 header、failure detail 和幂等行为一致。
- `EnsureCodespaceGitSSHKey` 的公钥使用 SSH wire bytes；响应只传输规范化 known_hosts 行，不重复传输可由 Codespace 推导的用户、仓库、状态或协议字段。
