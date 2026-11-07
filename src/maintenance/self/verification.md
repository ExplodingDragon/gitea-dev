# 验证记录

## 验证范围与环境

本页记录 2026-11-07 对 `self@53d76a7ab066085c21af9098862392ba1d2fc420` 的完整验证。环境为 Linux `6.18.60-1-lts`、Go `go1.27.3-X:nodwarf5`、Git `2.56.0`、Node.js `v24.22.1`、pnpm `12.16.1`。

验证覆盖 `upstream/main@c74f2f9216`、Codespace PR `68bcefaa69`、Pages PR `e645501a81`、`self` 迁移 368—371，以及昨天版本 368 到今天版本 372 的升级序列。

外层提交 `9ef518d71e8c0c1e9dcca05c7b15d598e6f892e9` 固定上述内层提交与本轮维护文档，作为部署仓库审阅和回溯入口。

**实现验收点**

- 验证日期、最终完整提交和五项主要工具版本已记录。
- 外层维护提交与内层 `self` 提交可以分别解析。
- 三个固定来源都是被验证提交的祖先。
- 所有 Gitea 构建与测试均使用仓库 Make 目标。

## 格式化、依赖、静态检查与构建

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `make fmt` | 通过 | 未产生待提交格式差异 |
| `make tidy` | 通过 | Go 模块声明保持整洁 |
| `make go-licenses` | 通过 | 许可证清单无需更新 |
| `make checks` | 通过 | 模块、生成文件、格式和漏洞调用检查完成 |
| `make lint` | 通过 | Go 报告 0 项，621 个模板通过，前端、文档和配置检查通过 |
| `make build` | 通过 | 生产前端资源与 Gitea 二进制构建成功 |

`make checks` 报告依赖 `github.com/blakesmith/ar` 的上游记录 `GO-2026-6905`，当前没有修复版本；Gitea 的检查目标按既有规则记录后继续，命令状态为 0。构建版本为 `29.0.0+dev-410-g53d76a7ab0`。

第一次 lint 受到先前集成测试遗留的 Bleve 二进制索引影响，标准 `make clean` 清理精确测试产物后重新执行，完整 lint 通过。最终提交不包含这些产物。

**实现验收点**

- 六个标准目标最终均以状态 0 退出。
- 漏洞记录包含编号、依赖和当前无修复版本的事实。
- 清理后重新运行的完整 lint 通过，内层没有生成文件差异。

## 迁移、后端与前端测试

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make migrations.individual.test#v29` | 通过 | 当前 v29 逐项迁移直接测试 |
| `make test-migration` | 通过 | 历史迁移、迁移集成和全部逐项迁移 |
| `make test-backend` | 通过 | 全部后端包，包括 Codespace、Pages 和仓库转移 |
| `make test-frontend` | 121 个测试文件、396 项测试全部通过 | Vitest 前端测试 |

迁移 371 的直接测试先建立包含 `queued_timeout` 与 `running_timeout` 的旧 Codespace 表并写入数据，连续执行两次迁移，然后验证前者已删除、后者保留且数据未丢失。完整迁移测试确认当前期望数据库版本为 372。

**实现验收点**

- 四个测试目标均以状态 0 退出。
- `TestDropCodespaceQueuedTimeoutIndex` 覆盖重复执行、目标索引、保留索引和数据保留。
- Codespace、Pages 和 `services/repository` 后端包测试通过。

## 完整集成测试

执行了 `make test-integration`，套件从 Actions 开始运行到最后的 Workflow Run API。Codespace 路由、Manager 设置、生命周期状态机、Pages 管理端和仓库转移相关行为均通过。

唯一失败是用户已确认无需处理的 `TestAPIDownloadArchive` 环境差异。Git 2.56.0 在普通 API 路径和 GitHub 风格路径生成 264 字节的 `tar.gz`，固定夹具期望 266 字节；两个断言属于同一测试，套件其余部分运行到末尾。该差异在此前基线验证中已经出现，归档代码和测试不属于本轮改动，因此保留实际记录而不加入环境特判。

**实现验收点**

- 集成套件运行到最后一个测试文件。
- 唯一失败为 `TestAPIDownloadArchive` 的两处 264/266 字节断言。
- Codespace 和 Pages 集成测试均通过，没有第二类失败。

## 端到端测试

执行 `make test-e2e`。宿主机 Playwright 检查提示缺少六项浏览器动态库，但仓库目标使用容器启动 Gitea 和浏览器，因此完整运行 Chromium、Firefox 和 WebKit 测试。最终 198 项通过，6 项按上游浏览器条件跳过，命令状态为 0。

**实现验收点**

- `make test-e2e` 状态为 0。
- 结果为 198 项通过、6 项跳过、0 项失败。
- 三种浏览器引擎都实际运行了测试。

## Git 与迁移边界检查

祖先检查确认上游和两个 PR 头均已接入。上游源迁移文件与 `self` 的三个来源化文件逐字一致；Codespace 和 Pages 完整建表迁移各只注册一次。最终业务合并中的仓库转移同时具备 Codespace 写锁、Pages 生命周期锁和上游对象通知。

**实现验收点**

- 三项 `git merge-base --is-ancestor` 检查均成功。
- 上游 v365、v366、v367 与对应来源化文件比较无差异。
- 迁移列表连续为 365—371，最终版本为 372。

## 文档、计划与产物清理

最终重新读取 `/tmp/todo-mi.md`。该文件描述 Codespace 仓库中此前 CI 测试修复，完成审计已经记录测试与 lint 通过；本轮 Gitea 更新没有改动它限定的 Codespace 两个测试文件，也没有改变协议、CRD 或生产 Gateway 行为。

内层最终执行 `make clean`，删除 Gitea 二进制、测试二进制、临时配置、集成测试目录和生成产物。外层维护文档通过 Markdown 检查并由 mdBook 完整构建后，只暂存 Gitea 指针与本目录文档。

**实现验收点**

- `/tmp/todo-mi.md` 的完成审计与当前外层用户改动保持原样。
- `make clean` 状态为 0，内层工作树干净。
- Markdown 检查和 mdBook 构建通过，外层其他用户改动未进入维护提交。
