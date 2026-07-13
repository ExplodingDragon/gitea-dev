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

enum ManagerAdminState {
  MANAGER_ADMIN_STATE_UNSPECIFIED = 0;
  MANAGER_ADMIN_STATE_ENABLED = 1;
  MANAGER_ADMIN_STATE_DISABLED = 2;
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
}

enum GenerationKind {
  GENERATION_KIND_UNSPECIFIED = 0;
  GENERATION_KIND_INVENTORY = 1;
  GENERATION_KIND_RUNTIME = 2;
  GENERATION_KIND_METADATA = 3;
}

// ManagerService is implemented by Gitea and called by Codespace Manager.
service ManagerService {
  // RegisterManager exchanges an active registration token for a Manager identity.
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

  // ReportRuntimeMetadata writes a Runtime Metadata snapshot to Gitea's local cache.
  rpc ReportRuntimeMetadata(ReportRuntimeMetadataRequest) returns (ReportRuntimeMetadataResponse);

  // RequestGiteaToken returns the current Gitea access token for a creating/running codespace,
  // issuing one only when the codespace has no token.
  rpc RequestGiteaToken(RequestGiteaTokenRequest) returns (RequestGiteaTokenResponse);

  // ValidateOpenToken validates and consumes a one-time Gateway Open Token.
  rpc ValidateOpenToken(ValidateOpenTokenRequest) returns (ValidateOpenTokenResponse);

  // VerifySSHPublicKey authenticates an SSH session via public key.
  rpc VerifySSHPublicKey(VerifySSHPublicKeyRequest) returns (VerifySSHPublicKeyResponse);

  // ReportInstances reports the complete set of local Runtime Instances at startup and periodically.
  rpc ReportInstances(ReportInstancesRequest) returns (ReportInstancesResponse);

  // ReportRuntimeTransition reports a Manager-initiated stop/resume fact.
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

message DeclareManagerResponse {
  ManagerAdminState admin_state = 1;
}

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
  string repo_clone_url = 4;
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
  // The plaintext access token for this codespace.
  string token = 1;
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
message ReportRuntimeTransitionInstruction {}
message StopLocalRuntime {}
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
  }
}

message ReportRuntimeTransitionResponse {}

message RuntimeRunningFact {
  string metadata_json = 1;
  int64 metadata_generation = 2;
}

message RuntimeStoppedFact {}

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

业务命令因状态、版本、容量或参数被拒绝时，Gitea 返回 Connect error，并附带 `CodespaceFailureDetail`；category、Connect code 和 retryable 的固定映射见 [统一失败分类](gitea-server.md#统一失败分类)。generation 过旧时额外附带 `StaleGenerationDetail`，Manager 以 `current_generation + 1` 重新生成并持久化对应事实；该 detail 只用于恢复版本基线，不代表 Gitea 接受了旧事实。`UpdateLog` 的 offset conflict/gap 额外附带 `LogOffsetDetail`，使 Manager 以服务端实际文件末尾恢复追加。`ValidateOpenToken`、`VerifySSHPublicKey`、`RevalidateGatewaySession` 属于访问判定，通过 response `oneof outcome` 返回 binding 或 denied；`UpdateOperation` 的幂等结果也由 response `oneof outcome` 穷尽表达。

输入边界：

- 所有 enum 的 `UNSPECIFIED` 和未知数值均作为参数错误拒绝，不能回退为默认行为。
- `FetchOperations.max_operations` 为 `1..256`，`observed_operations` 最多 10000 条且 UUID 唯一。Manager 每次提交全部本地上下文完整的 running operation，省略只表示本地缺少可继续执行的上下文。
- `ReportInstances.instances` 最多 10000 条且 UUID 唯一，每次都是完整快照。
- inventory item 只携带 UUID、Runtime state 和 observed operation version；SSH 验证只携带 UUID 和公钥，运行侧时间、原因、来源 IP 和客户端诊断留在 Manager/Gateway 本地日志。
- `DeclareManager.tags` 和 `backend_capabilities` 各最多 64 项，单项长度和字符集经过校验。
- `metadata_json` 规范化后不超过 `RUNTIME_METADATA_MAX_SIZE`。
- Runtime Metadata 中 endpoints 最多 64 个且 `endpoint_id` 唯一。
- 所有 request 解码后不超过 `CONTROL_PLANE_MAX_REQUEST_SIZE`；`UpdateLog.lines` 单行另受 `LOG_MAX_LINE_SIZE` 限制。

实现验收点：

- 除 `RegisterManager` 外的 RPC 都通过统一 interceptor 认证 Manager ID 和 secret。
- Manager 身份认证成功后，handler 从 request context 读取同一 Manager 记录。
- 命令拒绝与访问判定使用文中规定的两种响应方式，不混合表达。
- stale generation 错误携带 generation 类型和 Gitea 当前已接受值，本地版本丢失的 Manager 可以恢复单调上报。
- Open、SSH 和 session revalidate 的成功 binding 与拒绝 detail 通过 oneof 互斥返回。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP 或 HTTPS（参考 Gitea Actions runner Connect 服务形态）
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
- Manager 配置可以要求 HTTPS 并指定 CA/server name；默认允许受信网络中的 HTTP，不在协议层硬编码 scheme

实现验收点：

- 每个 operation envelope 的 `command` 必须设置一个分支；普通 create 携带完整 payload，resume/stop/delete 使用各自分支，无来源 create 恢复使用 `recover_create_without_source`，disabled 后已领取的 create/resume 使用对应 abort 分支。
- 每个 operation payload 返回当前 `log_offset`，Manager 从该 offset 继续追加日志。
- `UpdateLog` 成功返回服务端规范化写入后的 `next_offset`；offset conflict/gap 返回当前服务端 offset。
- Runtime transition、完整 inventory 和 Runtime Metadata 分别携带自己的单调版本。
- Runtime transition 同时携带产生该事实时观察到的 `operation_rversion`，旧 operation 上下文的事实不能覆盖新 operation 结果。
- Gateway 可以通过 `RevalidateGatewaySession` 周期检查已有 Endpoint 和 SSH session。
- inventory instruction 通过互斥 action 表达 cleanup、transition、operation refetch、清除旧 operation 上下文或本地 stop，不组合无意义的 enum/字段。
- final result 携带原 operation 类型；active operation 清空后仍可在不保存历史的前提下判断重复 final。
- 命令拒绝统一返回 `CodespaceFailureDetail`；generation stale 和日志 offset 错误分别增加专用 detail，访问判定不组合无意义的成功与失败字段。
- HTTP 和 HTTPS transport 下生成的 handler、认证 header、failure detail 和幂等行为一致。
