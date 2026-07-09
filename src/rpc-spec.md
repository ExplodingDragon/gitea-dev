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

  // VerifySSHPublicKey authenticates an SSH session via public key.
  rpc VerifySSHPublicKey(VerifySSHPublicKeyRequest) returns (VerifySSHPublicKeyResponse);

  // ReportInstances reports the set of local Runtime Instances (used after Manager restart).
  rpc ReportInstances(ReportInstancesRequest) returns (ReportInstancesResponse);
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
  // Optional diagnostic metadata.
  map<string, string> meta = 4;
  string version = 5;
  string name = 6;
  // online | recovering
  string manager_runtime_state = 7;
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
  string operation_id = 1;
  string operation_type = 2; // create | resume | stop | delete
  string codespace_uuid = 3;
  int64 lease_deadline_unix = 4;

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
}

// --- UpdateOperation ---

message UpdateOperationRequest {
  string codespace_uuid = 1;
  string operation_id = 2;

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
  string codespace_uuid = 1;
  string operation_id = 2;
  // Byte offset within the log file.
  int64 offset = 3;
  // Pre-sanitized log lines, each as a single-line string.
  repeated string lines = 4;
}

message UpdateLogResponse {}

// --- ReportRuntimeMetadata ---

message ReportRuntimeMetadataRequest {
  string codespace_uuid = 1;
  // JSON payload matching the Runtime Metadata schema.
  string metadata_json = 2;
}

message ReportRuntimeMetadataResponse {
  // True if the metadata was accepted and written to cache.
  bool accepted = 1;
}

// --- RequestGiteaToken ---

message RequestGiteaTokenRequest {
  string codespace_uuid = 1;
  string operation_id = 2;
  // Must be "create" or "resume".
  string operation_type = 3;
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
  string endpoint_id = 4;
  int64 manager_id = 5;
  // Only present when allowed=false.
  string failure_reason = 6;
}

// --- VerifySSHPublicKey ---

message VerifySSHPublicKeyRequest {
  // codespace_uuid parsed from SSH connection string (cs-{id} prefix).
  string codespace_uuid = 1;
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
  string failure_category = 4;
  bool failure_retryable = 5;
}

// --- ReportInstances ---

message ReportInstancesRequest {
  string snapshot_id = 1;
  bool snapshot_complete = 2;
  // Set of local Runtime Instance identifiers owned by this Manager.
  repeated RuntimeInstanceRef instances = 3;
}

message RuntimeInstanceRef {
  string codespace_uuid = 1;
  string runtime_state = 2;
  string observed_operation_id = 3;
  int64 observed_unix = 4;
}

message ReportInstancesResponse {
  // For each instance, a Manager Instruction if action is needed.
  repeated InstanceInstruction instructions = 1;
}

message InstanceInstruction {
  string codespace_uuid = 1;
  // e.g. "cleanup_local_runtime".
  string manager_instruction = 2;
  // e.g. "extra_runtime", "missing_runtime", "manager_mismatch".
  string divergence_category = 3;
}
```

## 认证机制

所有 RPC（除 `RegisterManager` 外）使用以下 HTTP header 认证：

```text
x-codespace-manager-id: <manager id>
x-codespace-manager-secret: <manager secret>
```

`RegisterManager` 使用 registration token 认证，token 通过 request body 传递。

## 传输

- 使用 [Connect RPC](https://connectrpc.com/) over HTTP (参考 Gitea Actions runner Connect 服务形态)
- 使用生成的 Connect handler
- 仅通过 Connect RPC 对 Manager 暴露控制面接口
