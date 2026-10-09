# Gitea Codespace

本仓库汇总 Gitea Codespace 的目标设计，并通过独立子仓库跟踪 Gitea 集成、运行平台和公共协议的实现。

## 阅读入口

- [设计文档目录](src/SUMMARY.md)说明产品边界、生命周期、数据、协议、部署和测试。
- [Gitea 变更说明](pr/README.md)用于上游审阅和界面截图。
- [Codespace README](codespace/README.md)说明运行平台的构建、部署与验证。
- [Proto README](codespace-proto-go/README.md)说明公共协议的生成与发布。

## 仓库边界

| 目录                                       | 职责                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`gitea`](gitea)                           | 用户流程、权限、业务状态和 Manager 接口                              |
| [`codespace`](codespace)                   | Manager、Agent、Gateway、Cache、Dev Container、管理界面和 Helm chart |
| [`codespace-proto-go`](codespace-proto-go) | Gitea 与 Manager 共享的 Proto 和 Go 代码                             |

三个目录都是独立 Git 仓库。构建、测试和发布由拥有相应代码的子仓库完成，根目录只维护设计与仓库版本关系。
