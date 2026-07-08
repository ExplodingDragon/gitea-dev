# RPC 接口定义

Manager 与 Gitea 之间通过 Connect RPC over HTTP 通信。

proto 定义：

```protobuf
syntax = "proto3";

package codespace.v1;

// ManagerService is implemented by Gitea and called by Codespace Manager.
service ManagerService {
  // RegisterManager exchanges a one-time registration secret for a Manager identity.
  rpc RegisterManager(RegisterManagerRequest) returns (RegisterManagerResponse);

  // DeclareManager updates Manager metadata, capacity, tags, and serves as heartbeat.
  rpc DeclareManager(DeclareManagerRequest) returns (DeclareManagerResponse);

  // FetchOperation pulls an operation that the Manager can claim and execute.
  rpc FetchOperation(FetchOperationRequest) returns (FetchOperationResponse);

  // UpdateOperation renews the lease, updates progress, or reports a final result.
  rpc UpdateOperation(UpdateOperationRequest) returns (UpdateOperationResponse);

  // UpdateLog appends sanitized log lines at a given offset for an active operation.
  rpc UpdateLog(UpdateLogRequest) returns (UpdateLogResponse);

  // ReportRuntimeMetadata writes a Runtime Metadata snapshot to Gitea's local cache.
  rpc ReportRuntimeMetadata(ReportRuntimeMetadataRequest) returns (ReportRuntimeMetadataResponse);

  // RequestGiteaToken requests a one-time Gitea access token for an active create/resume operation.
  rpc RequestGiteaToken(RequestGiteaTokenRequest) returns (RequestGiteaTokenResponse);

  // ValidateOpenToken validates and consumes a one-time Gateway Open Token.
  rpc ValidateOpenToken(ValidateOpenTokenRequest) returns (ValidateOpenTokenResponse);

  // VerifySSHPassword authenticates an SSH session via password (+ optional TOTP).
  rpc VerifySSHPassword(VerifySSHPasswordRequest) returns (VerifySSHPasswordResponse);

  // VerifySSHPublicKey authenticates an SSH session via public key.
  rpc VerifySSHPublicKey(VerifySSHPublicKeyRequest) returns (VerifySSHPublicKeyResponse);

  // ReportInstances reports the set of local Runtime Instances (used after Manager restart).
  rpc ReportInstances(ReportInstancesRequest) returns (ReportInstancesResponse);
}

// --- RegisterManager ---

message RegisterManagerRequest {
  // The one-time registration secret issued by the Gitea admin.
  string registration_secret = 1;
}

message RegisterManagerResponse {
  // The Manager identity, assigned once and never reused.
  string manager_uuid = 1;
  // The Manager secret, returned only once in this response. Store locally.
  string manager_secret = 2;
}

// --- DeclareManager ---

message DeclareManagerRequest {
  string gateway_url = 1;
  string gateway_ssh_addr = 2;
  string gateway_internal_ssh_public_key = 3;
  repeated string tags = 4;
  int32 capacity_total = 5;
  int32 capacity_available = 6;
  // Optional diagnostic metadata.
  map<string, string> meta = 7;
}

message DeclareManagerResponse {}

// --- FetchOperation ---

message FetchOperationRequest {
  int32 capacity_total = 1;
  int32 capacity_available = 2;
  // Operation types the Manager is willing to accept this pull.
  repeated string accepted_operation_types = 3; // e.g. ["create", "resume", "stop", "delete"]
}

message FetchOperationResponse {
  // Present when an operation was claimed.
  OperationPayload operation = 1;
}

message OperationPayload {
  string operation_uuid = 1;
  string operation_type = 2; // create | resume | stop | delete
  string codespace_uuid = 3;
  int64 generation = 4;
  string ssh_user = 5;
  int64 lease_deadline_unix = 6;

  // Fields present only for create/resume.
  string repo_clone_url = 10;
  string repo_web_url = 11;
  string repo_tag = 12;
  string base_repo_clone_url = 13;
  string base_repo_web_url = 14;
  string head_repo_clone_url = 15;
  string head_repo_web_url = 16;
  string start_ref = 17;
  string ref_type = 18;
  string ref_name = 19;
  string commit_sha = 20;
  int64 pull_id = 21;
}

// --- UpdateOperation ---

message UpdateOperationRequest {
  string operation_uuid = 1;
  string codespace_uuid = 2;
  int64 generation = 3;

  // Optional: renew the lease.
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
  string status_message = 2;
}

message ProgressUpdate {
  string stage = 1;
  string message = 2;
}

message UpdateOperationResponse {
  string operation_status = 1;
  int64 deadline_unix = 2;
}

// --- UpdateLog ---

message UpdateLogRequest {
  string operation_uuid = 1;
  string codespace_uuid = 2;
  int64 generation = 3;
  // Byte offset within the log file.
  int64 offset = 4;
  // Pre-sanitized log lines, each as a single-line string.
  repeated string lines = 5;
}

message UpdateLogResponse {}

// --- ReportRuntimeMetadata ---

message ReportRuntimeMetadataRequest {
  string codespace_uuid = 1;
  int64 generation = 2;
  // JSON payload matching the Runtime Metadata schema.
  string metadata_json = 3;
}

message ReportRuntimeMetadataResponse {
  // True if the metadata was accepted and written to cache.
  bool accepted = 1;
}

// --- RequestGiteaToken ---

message RequestGiteaTokenRequest {
  string operation_uuid = 1;
  string codespace_uuid = 2;
  int64 generation = 3;
  // Must be "create" or "resume".
  string operation_type = 4;
}

message RequestGiteaTokenResponse {
  // The plaintext access token. Returned once; not stored by ManagerService.
  string token = 1;
}

// --- ValidateOpenToken ---

message ValidateOpenTokenRequest {
  string open_token = 1;
}

message ValidateOpenTokenResponse {
  bool allowed = 1;
  int64 user_id = 2;
  string codespace_uuid = 3;
  int64 generation = 4;
  string endpoint_id = 5;
  string manager_uuid = 6;
  // Only present when allowed=false.
  string failure_reason = 7;
}

// --- VerifySSHPassword ---

message VerifySSHPasswordRequest {
  string ssh_user = 1;
  // Plaintext password, may include ":totp=XXXXXX" suffix.
  string password = 2;
  string source_ip = 3;
  string user_agent_or_client_version = 4;
  string gateway_session_id = 5;
}

message VerifySSHPasswordResponse {
  bool allowed = 1;
  int64 user_id = 2;
  string codespace_uuid = 3;
  int64 generation = 4;
  string failure_category = 5;
  bool failure_retryable = 6;
}

// --- VerifySSHPublicKey ---

message VerifySSHPublicKeyRequest {
  string ssh_user = 1;
  string public_key_blob = 2;
  // Optional, for diagnostics only.
  string public_key_fingerprint = 3;
  // Optional, for diagnostics only.
  string public_key_algorithm = 4;
  string source_ip = 5;
  string user_agent_or_client_version = 6;
  string gateway_session_id = 7;
}

message VerifySSHPublicKeyResponse {
  bool allowed = 1;
  int64 user_id = 2;
  string codespace_uuid = 3;
  int64 generation = 4;
  string failure_category = 5;
  bool failure_retryable = 6;
}

// --- ReportInstances ---

message ReportInstancesRequest {
  // Set of local Runtime Instance identifiers owned by this Manager.
  repeated RuntimeInstanceRef instances = 1;
}

message RuntimeInstanceRef {
  string codespace_uuid = 1;
  int64 generation = 2;
}

message ReportInstancesResponse {
  // For each instance, a Manager Instruction if action is needed.
  repeated InstanceInstruction instructions = 1;
}

message InstanceInstruction {
  string codespace_uuid = 1;
  int64 generation = 2;
  // e.g. "cleanup_local_runtime".
  string manager_instruction = 3;
}
```

## 认证机制

所有 RPC（除 `RegisterManager` 外）使用以下 HTTP header 认证：

```text
x-codespace-manager-uuid: <manager uuid>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用一次性 registration secret 认证，secret 通过 request body 传递。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP (参考 Gitea Actions runner Connect 服务形态)
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
