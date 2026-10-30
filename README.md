# Gitea 设计与实现

本仓库汇总 Gitea Pages 和 Gitea Codespace 的目标设计，并通过独立子仓库跟踪 Gitea 集成、运行平台和公共协议的实现。

## 阅读入口

- [设计文档目录](src/SUMMARY.md)汇总 Pages 与 Codespace 的产品边界、生命周期、数据、协议、部署和测试。
- [Pages 设计入口](src/pages/README.md)说明独立单机 Pages 实例、`.pages` 所有者主页与仓库项目站点、TAR.GZ 提交与主动部署、通信确认、standalone 与 nginx 子命令和域名 HTTPS。
- [Pages 工程入口](gitea-page/README.md)说明独立 Go 模块的构建和命令入口。
- [Codespace 设计入口](src/codespace/README.md)说明远程开发环境的业务控制面、运行平台、协议、部署要求和测试方式。
- [Pages 变更说明](pr/page/README.md)用于 Pages 上游审阅和界面截图。
- [Codespace 变更说明](pr/README.md)用于 Codespace 上游审阅和界面截图。
- [Codespace README](codespace/README.md)说明运行平台的构建、部署与验证。
- [Proto README](codespace-proto-go/README.md)说明公共协议的生成与发布。

## 仓库边界

| 目录                                       | 职责                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`gitea`](gitea)                           | Gitea 主服务及 Pages、Codespace 的管理集成                            |
| [`gitea-page`](gitea-page)                 | Pages 独立 Go 模块与网站服务                                          |
| [`codespace`](codespace)                   | Manager、Agent、Gateway、Cache、Dev Container、管理界面和 Helm chart |
| [`codespace-proto-go`](codespace-proto-go) | Gitea 与 Manager 共享的 Proto 和 Go 代码                             |

`gitea`、`gitea-page`、`codespace` 和 `codespace-proto-go` 都是独立 Git 仓库，由本仓库以子模块记录对应版本。Gitea 和 Pages 分别构建，通过设计中的内部接口通信。

## Pages 开发说明

顶层仓库使用 `main` 记录设计文档和各子仓库版本；`gitea/` 子仓库的 Pages 变更位于 `feat-pages`，`gitea-page/` 使用自己的 `main`。Pages 服务的模块路径为 `gitea.dev/page`。工程入口与实现验收见 [实施准备](src/pages/implementation.md)，产品和协议行为见 [Pages 设计](src/pages/README.md)。
