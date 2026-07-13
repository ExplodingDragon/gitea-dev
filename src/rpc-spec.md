# RPC 接口定义

Manager 与 Gitea 之间通过 Connect RPC over HTTP 通信。

proto 定义：

```protobuf
syntax = "proto3";

package codespace.v1;

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

  // UpdateOperation renews the lease, updates progress, or reports a final result.
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

  // ReportInstances reports the set of local Runtime Instances (used after Manager restart).
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
  string gateway_url = 1;
  string gateway_ssh_addr = 2;
  repeated string tags = 3;
  // Includes gateway_ssh_host_key_algorithm, gateway_ssh_host_key_fingerprint_sha256,
  // gateway_ssh_host_key_updated_unix, capacity snapshot, and backend capabilities.
  map<string, string> meta = 4;
  string version = 5;
  string name = 6;
  // online | recovering
  string manager_runtime_state = 7;
}

message DeclareManagerResponse {
  // enabled | disabled
  string admin_state = 1;
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
  repeated string accepted_operation_types = 3; // create | resume
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
  int64 operation_rversion = 1;
  string operation_type = 2; // create | resume | stop | delete
  string codespace_uuid = 3;
  int64 lease_deadline_unix = 4;
  int64 log_offset = 5;

  // Set only when operation_type=create.
  CreateOperationPayload create = 10;
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
    // Update progress without finalizing.
    ProgressUpdate progress = 11;
  }
}

message FinalResult {
  // "done" or "failed".
  string status = 1;
}

message ProgressUpdate {
  // Current boot stage. May be empty to signal "renew lease" only;
  // Gitea responds with updated deadline_unix.
  string stage = 1;
}

message UpdateOperationResponse {
  // "accepted" | "idempotent_done" | "stale_operation"
  string result = 1;
  // Latest lease deadline when result is "accepted".
  int64 deadline_unix = 2;
}

// --- UpdateLog ---

message UpdateLogRequest {
  string codespace_uuid = 1;
  int64 operation_rversion = 2;
  // Byte offset within the log file.
  int64 offset = 3;
  // Pre-sanitized log lines, each as a single-line string.
  repeated string lines = 4;
}

message UpdateLogResponse {}

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
  bool allowed = 1;
  int64 user_id = 2;
  string codespace_uuid = 3;
  string endpoint_id = 4;
  int64 manager_id = 5;
  string failure_category = 6;
  bool failure_retryable = 7;
}

// --- VerifySSHPublicKey ---

message VerifySSHPublicKeyRequest {
  // codespace_uuid parsed from SSH connection string (cs-{id} prefix).
  string codespace_uuid = 1;
  string public_key_blob = 2;
  string source_ip = 3;
  string user_agent_or_client_version = 4;
  string gateway_session_id = 5;
}

message VerifySSHPublicKeyResponse {
  bool allowed = 1;
  int64 user_id = 2;
  string codespace_uuid = 3;
  string failure_category = 4;
  bool failure_retryable = 5;
}

// --- ReportInstances ---

message ReportInstancesRequest {
  int64 inventory_generation = 1;
  bool snapshot_complete = 2;
  // Set of local Runtime Instance identifiers owned by this Manager.
  repeated RuntimeInstanceRef instances = 3;
}

message RuntimeInstanceRef {
  string codespace_uuid = 1;
  string runtime_state = 2;
  int64 observed_operation_rversion = 3;
  int64 observed_unix = 4;
}

message ReportInstancesResponse {
  // For each instance, a Manager Instruction if action is needed.
  repeated InstanceInstruction instructions = 1;
}

message InstanceInstruction {
  string codespace_uuid = 1;
  // e.g. "cleanup_local_runtime" or "report_runtime_transition".
  string manager_instruction = 2;
  // e.g. "extra_runtime", "missing_runtime", "manager_mismatch".
  string divergence_category = 3;
}

// --- ReportRuntimeTransition ---

message ReportRuntimeTransitionRequest {
  string codespace_uuid = 1;
  int64 runtime_generation = 2;
  string transition_reason = 3;
  int64 observed_unix = 4;

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
  bool allowed = 1;
  string failure_category = 2;
  bool failure_retryable = 3;
}

// Attached to Connect errors returned for command rejection. Success responses
// contain only success data; expected access decisions keep their response fields.
message CodespaceFailureDetail {
  string category = 1;
  bool retryable = 2;
  string manager_instruction = 3;
}
```

## 认证机制

所有 RPC（除 `RegisterManager` 外）使用以下 HTTP header 认证：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，token 通过 request body 传递。

业务命令因状态、版本、容量或参数被拒绝时，Gitea 返回 Connect error，并附带 `CodespaceFailureDetail`。`ValidateOpenToken`、`VerifySSHPublicKey`、`RevalidateGatewaySession` 属于访问判定，拒绝是正常响应；`UpdateOperation.result` 属于幂等协议结果，也保留在成功响应中。

实现验收点：

- 除 `RegisterManager` 外的 RPC 都通过统一 interceptor 认证 Manager ID 和 secret。
- Manager 身份认证成功后，handler 从 request context 读取同一 Manager 记录。
- 命令拒绝与访问判定使用文中规定的两种响应方式，不混合表达。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP (参考 Gitea Actions runner Connect 服务形态)
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口

实现验收点：

- create operation 必须携带完整 `create` payload；resume/stop/delete 的 `create` 字段为空。
- 每个 operation payload 返回当前 `log_offset`，Manager 从该 offset 继续追加日志。
- Runtime transition、完整 inventory 和 Runtime Metadata 分别携带自己的单调版本。
- Gateway 可以通过 `RevalidateGatewaySession` 周期检查已有 Endpoint 和 SSH session。
- 命令拒绝统一返回 `CodespaceFailureDetail`，成功响应不增加无意义的失败字段。
