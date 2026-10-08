# Gitea Codespace

本仓库维护 Gitea Codespace 的目标设计，并通过三个独立子仓库跟踪实现。

## 文档

- [总体设计](src/README.md)
- [Gitea 服务端](src/gitea-server.md)
- [运行平台](src/runtime-platform.md)
- [部署要求](src/deployment-requirements.md)
- [实施与测试](src/implementation.md)
- [Gitea 变更说明](pr/README.md)

完整设计目录见 [`src/SUMMARY.md`](src/SUMMARY.md)。

## 子仓库

- [`gitea`](gitea) 提供 Gitea 业务集成，并遵循 Gitea 自身的开发与测试规范。
- [`codespace`](codespace) 提供 Manager、Runtime Agent、Gateway、Cache、管理界面、Helm chart 和 Dev Container 实现。
- [`codespace-proto-go`](codespace-proto-go) 提供共享 Proto 源文件和生成的 Go 代码。

三个目录都是独立 Git 仓库。构建和测试应从拥有该功能的子仓库执行；根目录 Makefile 只协调跨仓库检查。
