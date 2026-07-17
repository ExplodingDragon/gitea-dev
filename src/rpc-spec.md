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

enum RuntimeState {
  RUNTIME_STATE_UNSPECIFIED = 0;
  RUNTIME_STATE_CREATING = 1;
  RUNTIME_STATE_RUNNING = 2;
  RUNTIME_STATE_STOPPED = 3;
  // Runtime identity exists, but Manager has confirmed it cannot be recovered.
  RUNTIME_STATE_FAILED = 4;
}

enum GenerationKind {
  GENERATION_KIND_UNSPECIFIED = 0;
  GENERATION_KIND_INVENTORY = 1;
  GENERATION_KIND_RUNTIME = 2;
  GENERATION_KIND_METADATA = 3;
}

// ManagerService is implemented by Gitea and called by Codespace Manager.
service ManagerService {
  // RegisterManager exchanges the owner scope's current registration token for a Manager identity.
  rpc RegisterManager(RegisterManagerRequest) returns (RegisterManagerResponse);

  // DeclareManager updates Manager metadata, tags, and serves as heartbeat.
  rpc DeclareManager(DeclareManagerRequest) returns (DeclareManagerResponse);

  // RotateManagerSecret replaces the current Manager credential.
  rpc RotateManagerSecret(RotateManagerSecretRequest) returns (RotateManagerSecretResponse);

  // FetchOperations returns operations for the Manager to execute.
  rpc FetchOperations(FetchOperationsRequest) returns (FetchOperationsResponse);

  // UpdateOperation renews the lease or reports a final result.
  rpc UpdateOperation(UpdateOperationRequest) returns (UpdateOperationResponse);

  // UpdateLog appends sanitized log lines at a given offset for an active operation.
  rpc UpdateLog(UpdateLogRequest) returns (UpdateLogResponse);

  // ReportRuntimeMetadata writes a Runtime Metadata snapshot to Gitea's configured cache adapter.
  rpc ReportRuntimeMetadata(ReportRuntimeMetadataRequest) returns (ReportRuntimeMetadataResponse);

  // RequestGiteaToken returns or issues the current token for a creating or running Codespace.
  rpc RequestGiteaToken(RequestGiteaTokenRequest) returns (RequestGiteaTokenResponse);

  // ValidateOpenToken validates and consumes a one-time Gateway Open Token.
  rpc ValidateOpenToken(ValidateOpenTokenRequest) returns (ValidateOpenTokenResponse);

  // VerifySSHPublicKey authenticates an SSH session via public key.
  rpc VerifySSHPublicKey(VerifySSHPublicKeyRequest) returns (VerifySSHPublicKeyResponse);

  // ReportInstances reports the complete set of local Runtime Instances at startup and periodically.
  rpc ReportInstances(ReportInstancesRequest) returns (ReportInstancesResponse);

  // ReportRuntimeTransition reports a Manager-initiated running, stopped, or failed 状态报告.
  rpc ReportRuntimeTransition(ReportRuntimeTransitionRequest) returns (ReportRuntimeTransitionResponse);

  // RevalidateGatewaySession checks an existing Endpoint or SSH session.
  rpc RevalidateGatewaySession(RevalidateGatewaySessionRequest) returns (RevalidateGatewaySessionResponse);
}

// --- RegisterManager ---

message RegisterManagerRequest {
  // The registration token shown in the Codespace manager settings page.
  string registration_token = 1;
}

message RegisterManagerResponse {
  // The Manager identity, assigned once and never reused.
  int64 manager_id = 1;
  // The Manager secret, returned only once in this response. Store locally.
  string manager_secret = 2;
}

// --- DeclareManager ---

message DeclareManagerRequest {
  reserved 4;
  // Gateway scheme, DNS base domain, and optional port; no business path.
  string gateway_url = 1;
  string gateway_ssh_addr = 2;
  repeated string tags = 3;
  string version = 5;
  string name = 6;
  ManagerRuntimeState manager_runtime_state = 7;
  string gateway_ssh_host_key_algorithm = 8;
  string gateway_ssh_host_key_fingerprint_sha256 = 9;
  int64 gateway_ssh_host_key_updated_unix = 10;
  int32 capacity_total = 11;
  int32 capacity_available = 12;
  repeated string backend_capabilities = 13;
}

message DeclareManagerResponse {}

// --- RotateManagerSecret ---

message RotateManagerSecretRequest {
  // Generated and persisted locally by Manager before this authenticated call.
  string new_manager_secret = 1;
}

message RotateManagerSecretResponse {}

// --- FetchOperations ---

message FetchOperationsRequest {
  int32 capacity_total = 1;
  int32 capacity_available = 2;
  repeated AcceptedOperationType accepted_operation_types = 3;
  int32 max_operations = 4;
  repeated ObservedOperation observed_operations = 5;
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
  int64 lease_deadline_unix = 3;
}

message OperationPayload {
  reserved 3;
  int64 operation_rversion = 1;
  string codespace_uuid = 2;
  int64 lease_deadline_unix = 4;
  int64 log_offset = 5;

  oneof command {
    CreateOperationPayload create = 10;
    ResumeOperationPayload resume = 11;
    StopOperationPayload stop = 12;
    DeleteOperationPayload delete = 13;
    RecoverCreateWithoutSource recover_create_without_source = 14;
    AbortCreateOperationPayload abort_create = 15;
    AbortResumeOperationPayload abort_resume = 16;
  }
}

message ResumeOperationPayload {}
message StopOperationPayload {}
message DeleteOperationPayload {}
message AbortCreateOperationPayload {}
message AbortResumeOperationPayload {}

message RecoverCreateWithoutSource {
  // Manager must inspect its deterministic Runtime and persisted boot result,
  // then report done or failed without repository data.
}

message CreateOperationPayload {
  int64 repo_id = 1;
  string repo_full_name = 2;
  string repo_name = 3;
  // Absolute URL built from Gitea ROOT_URL, including AppSubURL.
  string repo_clone_url = 4;
  // Absolute URL built from Gitea ROOT_URL, including AppSubURL.
  string repo_web_url = 5;
  string repo_tag = 6;
  int64 owner_id = 7;
  string owner_name = 8;
  string owner_type = 9; // user | organization
  string owner_display_name = 10;
  string codespace_owner_name = 11;
  string start_ref = 12;
  string ref_type = 13;
  string ref_name = 14;
  string commit_sha = 15;
}

// --- UpdateOperation ---

message UpdateOperationRequest {
  string codespace_uuid = 1;
  int64 operation_rversion = 2;

  oneof result {
    // Report a final outcome.
    FinalResult final = 10;
    // Renew the current operation lease without changing state.
    RenewLease renew_lease = 11;
  }
}

message FinalResult {
  FinalStatus status = 1;
  // The original Gitea-issued operation type. Abort commands retain their
  // underlying create/resume type.
  OperationType operation_type = 2;
}

message RenewLease {}

message UpdateOperationResponse {
  oneof outcome {
    LeaseRenewed lease_renewed = 1;
    FinalAccepted final_accepted = 2;
    IdempotentDone idempotent_done = 3;
    StaleOperation stale_operation = 4;
    ResourceAbsent resource_absent = 5;
  }
}

message LeaseRenewed { int64 deadline_unix = 1; }
message FinalAccepted {}
message IdempotentDone {}
message StaleOperation {}
message ResourceAbsent {}

// --- UpdateLog ---

message UpdateLogRequest {
  string codespace_uuid = 1;
  int64 operation_rversion = 2;
  // Byte offset within the log file.
  int64 offset = 3;
  repeated LogLine lines = 4;
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
  string codespace_uuid = 1;
  // JSON data matching the Runtime Metadata schema.
  string metadata_json = 2;
  int64 metadata_generation = 3;
}

message ReportRuntimeMetadataResponse {}

// --- RequestGiteaToken ---

message RequestGiteaTokenRequest {
  string codespace_uuid = 1;
}

message RequestGiteaTokenResponse {
  // The plaintext Codespace Gitea Token for this codespace.
  string token = 1;
  // Gitea's externally reachable ROOT_URL, including AppSubURL.
  string server_url = 2;
}

// --- ValidateOpenToken ---

// Validates and consumes an OAuth2-style authorization code
// issued by Gitea for a codespace endpoint open request.
message ValidateOpenTokenRequest {
  string code = 1;
}

message ValidateOpenTokenResponse {
  oneof outcome {
    OpenTokenBinding allowed = 1;
    AccessDenied denied = 2;
  }
}

message OpenTokenBinding {
  int64 user_id = 1;
  string codespace_uuid = 2;
  // Always set. The default open route uses the logical "workspace" endpoint.
  string endpoint_id = 3;
  int64 manager_id = 4;
}

// --- VerifySSHPublicKey ---

message VerifySSHPublicKeyRequest {
  // codespace_uuid parsed from SSH connection string (cs-{id} prefix).
  string codespace_uuid = 1;
  // SSH wire-format public key blob from the client authentication request.
  bytes public_key = 2;
  reserved 3, 4, 5;
}

message VerifySSHPublicKeyResponse {
  oneof outcome {
    SSHAuthBinding allowed = 1;
    AccessDenied denied = 2;
  }
}

message SSHAuthBinding {
  int64 user_id = 1;
  string codespace_uuid = 2;
}

// --- ReportInstances ---

message ReportInstancesRequest {
  int64 inventory_generation = 1;
  // Complete set of local Runtime Instance identifiers owned by this Manager.
  repeated RuntimeInstanceRef instances = 2;
}

message RuntimeInstanceRef {
  string codespace_uuid = 1;
  RuntimeState runtime_state = 2;
  // Zero means that Manager has no local active-operation context.
  int64 observed_operation_rversion = 3;
  reserved 4;
}

message ReportInstancesResponse {
  // Instructions for reported divergences; missing resources need no local instruction.
  repeated InstanceInstruction instructions = 1;
}

message InstanceInstruction {
  string codespace_uuid = 1;
  reserved 2, 3;

  oneof action {
    CleanupLocalRuntime cleanup_local_runtime = 10;
    ReportRuntimeTransitionInstruction report_runtime_transition = 11;
    RefetchOperation refetch_operation = 12;
    StopLocalRuntime stop_local_runtime = 13;
    ClearOperationContext clear_operation_context = 14;
  }
}

message CleanupLocalRuntime {}
message ReportRuntimeTransitionInstruction {
  // Use this value as observed_operation_rversion for the requested fact.
  int64 current_operation_rversion = 1;
}
message StopLocalRuntime {
  // The latest operation version known by Gitea when this instruction was made.
  int64 current_operation_rversion = 1;
}
message RefetchOperation { int64 current_operation_rversion = 1; }
message ClearOperationContext { int64 current_operation_rversion = 1; }

// --- ReportRuntimeTransition ---

message ReportRuntimeTransitionRequest {
  string codespace_uuid = 1;
  int64 runtime_generation = 2;
  reserved 3, 4;
  // The latest Gitea-issued operation version observed before this fact was produced.
  int64 observed_operation_rversion = 5;

  oneof fact {
    RuntimeRunningFact running = 10;
    RuntimeStoppedFact stopped = 11;
    RuntimeFailedFact failed = 12;
  }
}

message ReportRuntimeTransitionResponse {}

message RuntimeRunningFact {
  string metadata_json = 1;
  int64 metadata_generation = 2;
}

message RuntimeStoppedFact {}
message RuntimeFailedFact {}

// --- RevalidateGatewaySession ---

message RevalidateGatewaySessionRequest {
  oneof session {
    EndpointSessionBinding endpoint = 1;
    SSHSessionBinding ssh = 2;
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
    AccessDenied denied = 2;
  }
}

message SessionAllowed {}

message AccessDenied {
  string category = 1;
  bool retryable = 2;
}

// Attached to Connect errors returned for command rejection. Access decisions
// use their response oneof instead of command errors.
message CodespaceFailureDetail {
  string category = 1;
  bool retryable = 2;
}

// Attached only when a generation is stale, so Manager can recover after
// losing its local generation without weakening monotonic ordering.
message StaleGenerationDetail {
  GenerationKind generation_kind = 1;
  int64 current_generation = 2;
}

// Attached to UpdateLog offset conflict/gap errors. Manager resumes from this
// server-authoritative byte offset after resolving the error.
message LogOffsetDetail {
  int64 current_offset = 1;
}
```

## 认证机制

所有 RPC（除 `RegisterManager` 外）使用以下 HTTP header 认证：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，token 通过 request body 传递。

`CONTROL_PLANE_TIMEOUT` 到期返回 Connect `DeadlineExceeded`，caller 取消返回 `Canceled`；这两类传输终止不附 `CodespaceFailureDetail`。已提交的短事务结果保持有效，除 `RegisterManager` 外的调用方按 operation、generation 或 offset 幂等规则重试；`RegisterManager` 的不确定结果由管理员先检查未 Declare 的记录。

业务命令因状态、版本、容量或参数被拒绝时，Gitea 返回 Connect error，并附带 `CodespaceFailureDetail`；category、Connect code 和 retryable 的固定映射见 [统一失败分类](gitea-server.md#统一失败分类)。generation 过旧时额外附带 `StaleGenerationDetail`，Manager 以 `current_generation + 1` 重新生成并持久化对应状态；该 detail 只用于恢复版本基线，不代表 Gitea 接受了旧状态报告。相同 generation 对应不同内容时返回 `generation_conflict`，不附 stale detail，因为请求 generation 已经是双方共同的当前基线；Manager 对该已知值做 checked increment，重新读取 backend 当前状态或快照后再提交。`UpdateLog` 的 offset conflict/gap 额外附带 `LogOffsetDetail`，使 Manager 以服务端实际文件末尾恢复追加。`ValidateOpenToken`、`VerifySSHPublicKey`、`RevalidateGatewaySession` 属于访问判定，通过 response `oneof outcome` 返回 binding 或 denied；`UpdateOperation` 的幂等结果也由 response `oneof outcome` 穷尽表达。

输入校验规则：

- enum 只接受各定义中明确列出的业务值；`UNSPECIFIED` 和未知数值返回 `invalid_argument`。这样新增枚举值不会被旧服务端误作默认行为。
- `codespace_uuid` 只接受 Gitea 生成的 36 字符小写带连字符 UUID v4；其他形式在查询和构造锁 key 前返回 `invalid_argument`，保证一个 Codespace 只有一种外部表达。
- 数据库中的 operation/generation `0` 只表示尚未产生版本；`operation_rversion`、`inventory_generation`、`runtime_generation` 和 `metadata_generation` 的有效新值从 `1` 开始。operation-bound RPC 和 `ReportRuntimeTransition.observed_operation_rversion` 必须大于 0，只有 inventory item 允许用 `observed_operation_rversion=0` 表示本地没有 active operation 上下文。
- 所有版本递增使用 checked increment。Gitea 的 `operation_rversion` 到达 `int64` 上限时返回 `state_unavailable`，主状态和 active operation 保持原值；Manager 的 inventory/runtime/metadata generation 到达上限时保留现有值、进入 recovering 并记录本地错误，相同 generation 的幂等重试仍可继续。版本始终保持正数和单调递增。
- `DeclareManager.capacity_total` 为 `1..10000`，单个 Manager 管理的 Runtime 总数上限为 10000；超限时按 Manager 恢复规则保持 recovering。
- `FetchOperations.max_operations` 为 `1..256`，`observed_operations` 最多 10000 条且 UUID 唯一。Manager 每次提交全部本地上下文完整的 running operation，省略只表示本地缺少可继续执行的上下文。
- `FetchOperationsResponse.renewed_leases` 最多与 request 的 `observed_operations` 等长；同一 UUID 不能同时出现在 `operations` 和 `renewed_leases`。
- `ReportInstances.instances` 最多 10000 条且 UUID 唯一，每次都是完整快照；Gitea 以条件写入接受 `inventory_generation + inventory_hash`，逐项处理前复检当前 generation，更高 generation 成立后旧请求停止写入且不返回 instruction。`RUNTIME_STATE_CREATING` 只表示具有稳定 identity 的资源存在，`RUNTIME_STATE_FAILED` 只表示 identity 仍存在但 Manager 已确认不可恢复，两者都不直接改写主状态。failed inventory 在无 active operation 时由 Gitea 返回带当前版本的 transition 指令，再由 Manager 提交 failed 状态报告；有 active operation 时返回 refetch，Manager 取得权威 payload 后提交 final failed。
- inventory item 只携带 UUID、Runtime state 和 observed operation version；SSH 验证只携带 UUID 和公钥，运行侧时间、原因、来源 IP 和客户端诊断留在 Manager/Gateway 本地日志。
- `report_runtime_transition.current_operation_rversion` 始终携带 Gitea 当前 operation 版本；它可由 Gitea running、Runtime stopped 的分歧或无 active operation 的 `RUNTIME_STATE_FAILED` inventory 触发。Gitea stopped、Runtime running 返回 `stop_local_runtime`，主动 running 使用 Manager 启动前持久化的版本直接提交。failed 状态报告为空结构，失败详情只进入 Manager 本地日志。
- `DeclareManager` 每次提交完整当前快照；客户端可以修改声明字段后整体覆盖，但不能通过 Declare 修改 Manager 身份、owner、secret 或 Codespace binding。
- `DeclareManager.tags` 和 `backend_capabilities` 各最多 64 项，单项 lower-case 后使用 `[a-z0-9_-]+`、长度为 1-64，并规范化去重。
- `gateway_url` 与 `gateway_ssh_addr` 分别在 Manager 间保持规范化唯一；冲突不产生部分声明更新。
- `metadata_json` 规范化后不超过 `RUNTIME_METADATA_MAX_SIZE`。
- Runtime Metadata 中 endpoints 最多 64 个且 `endpoint_id` 唯一；ID 使用 1 到 30 位 DNS-safe 小写字母、数字或连字符。
- `OpenTokenBinding.endpoint_id` 和 Endpoint session binding 始终非空；默认 open 固定使用 `workspace`。
- `RequestGiteaToken` 在功能启用、Manager online 或处于有效 recovering 窗口，且 Codespace 为已领取 create 的 creating 或无 active operation 的 running 时返回或签发 Token，并始终返回规范化 `server_url`；active stop/delete 和站点排空均拒绝，不读取、签发或修复 Token。
- 所有 request 解码后不超过 `CONTROL_PLANE_MAX_REQUEST_SIZE`；`UpdateLog.lines` 单行另受 `LOG_MAX_LINE_SIZE` 限制。

实现验收点：

- 除 `RegisterManager` 外的 RPC 都通过统一 interceptor 认证 Manager ID 和 secret。
- Manager 身份认证成功后，handler 从 request context 读取同一 Manager 记录。
- 命令拒绝与访问判定使用文中规定的两种响应方式，不混合表达。
- deadline/cancel 使用 Connect 标准 code 且不携带业务 failure detail，不被映射为 `internal_error`。
- stale generation 错误携带 generation 类型和 Gitea 当前已接受值，本地版本丢失的 Manager 可以恢复单调上报。
- `ReportInstances` 不以覆盖全部实例的 Manager 长锁串行；更高 generation 被接受后，旧请求不能继续写入或返回 instruction。
- Manager 丢失本地 operation 版本基线后，running 主状态对应 stopped Runtime 或无 active operation 的 failed inventory 可使 Gitea 返回 `report_runtime_transition.current_operation_rversion`；stopped 主状态对应 running Runtime 只返回 stop 指令，有 active operation 的 failed inventory 通过 refetch 恢复版本和 payload。
- 所有版本字段拒绝负数和不允许的 0，递增永不发生回绕。
- Gitea 的 operation 版本耗尽返回 `state_unavailable` 且不写部分状态；Manager generation 耗尽时停止新上报并进入 recovering。
- Open、SSH 和 session revalidate 的成功 binding 与拒绝 detail 通过 oneof 互斥返回。
- 默认 workspace 与普通 Endpoint 使用同一个 Open Token binding 结构，不增加 Web SSH 专用 RPC 分支。
- RequestGiteaToken 请求只包含 `codespace_uuid`；服务端根据当前 Codespace、active operation、Manager 和功能状态决定返回 Token 或 `state_unavailable`。单一请求形态确保调用方无法通过自报用途改变授权结果。
- RequestGiteaToken 成功响应的 `token/server_url` 均非空；Manager 不从 clone URL 或内部控制面地址推导 Runtime 使用的 Gitea 根地址。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP 或 HTTPS（参考 Gitea Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
- Manager 配置可以要求 HTTPS 并指定 CA/server name；默认允许受信网络中的 HTTP，不在协议层硬编码 scheme

实现验收点：

- 每个 operation envelope 的 `command` 必须设置一个分支；普通 create 携带完整 payload，resume/stop/delete 使用各自分支，无来源 create 恢复使用 `recover_create_without_source`，站点排空后已领取的 create/resume 使用对应 abort 分支。
- observed-only 续租通过 `renewed_leases` 返回 UUID、版本和新 deadline，不为避免重发 payload 而丢失 Manager 本地续租回执。
- 每个 operation payload 返回当前 `log_offset`，Manager 从该 offset 继续追加日志。
- `UpdateLog` 成功返回服务端规范化写入后的 `next_offset`；offset conflict/gap 返回当前服务端 offset。
- Runtime transition、完整 inventory 和 Runtime Metadata 分别携带自己的单调版本。
- Runtime transition 同时携带生成该状态报告时观察到的 `operation_rversion`，旧 operation 上下文的状态报告不能覆盖新 operation 结果。
- Gateway 通过 `RevalidateGatewaySession` 复检已有 session：普通 HTTP 在间隔到期后的下一次请求转发前调用，WebSocket 和 SSH 按固定定时器调用。
- inventory instruction 通过互斥 action 表达 cleanup、transition、operation refetch、清除旧 operation 上下文或本地 stop；transition action 携带生成状态报告所需的当前 operation 版本。
- final result 携带 Manager 本地保存的原 operation 类型；active operation 存在时严格校验，清空后只按相同版本和目标主状态判断重复 final。
- 普通命令拒绝返回 `CodespaceFailureDetail`；只有 generation stale 和日志 offset 错误增加对应专用 detail，generation conflict 不附 stale detail。`UpdateOperation` 的五种正常处理结果和访问判定分别使用自身 response oneof。
- HTTP 和 HTTPS transport 下生成的 handler、认证 header、failure detail 和幂等行为一致。
