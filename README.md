# Gitea Codespace

本仓库汇总 Gitea Codespace 的目标设计，并通过子仓库跟踪 Gitea、Manager 和共享协议的实现。

- [总体设计](src/README.md)
- [部署要求](src/deployment-requirements.md)
- [实施与测试](src/implementation.md)
- [Gitea 变更说明](pr/README.md)

`codespace` 和 `codespace-proto-go` 是独立 Go 模块。根目录的 `make test` 调用各模块公开的验证入口；Gitea 仍按其仓库文档提供的命令单独验证。
