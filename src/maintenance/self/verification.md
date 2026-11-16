# 验证记录

## 验证范围与环境

本页记录 2026-11-16 对 `self@8d65b612a28b71a2fef99c5534a19ec2344bd783` 的验证。环境为 Linux `6.18.60-1-lts`、Go `go1.27.3-X:nodwarf5`、Git `2.56.0`、Node.js `v24.22.2`、pnpm `12.17.0`。

验证覆盖 `upstream/main@23836eb610`、Codespace PR `0f1c19ba10`、Pages PR `5000d55fb2`、self 迁移 372—373 和上一版数据库 372 到当前版本 374 的实际升级。所有 Gitea 测试均从仓库 Make 目标启动。

**实现验收点**

- 验证日期、最终提交和五项主要工具版本已记录。
- 三个固定来源都是被验证提交的祖先。
- 远端 `origin/self` 已确认指向被验证提交。

## 格式化、生成、静态检查与构建

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `make fmt` | 通过 | Go 格式化完成，未留下差异 |
| `make tidy` | 通过 | Go 模块声明无需更新 |
| `make generate-swagger` | 通过 | OpenAPI 文件重新生成且无需提交变化 |
| `make swagger-validate` | 通过 | Swagger 2.0 文档有效 |
| `make checks` | 通过 | 生成、格式和依赖检查完成 |
| `make lint` | 通过 | Go 0 项问题，621 个模板及前端、文档、配置检查通过 |
| `make build` | 通过 | 前端生产资源和 Gitea 二进制构建成功 |

`make checks` 报告依赖 `github.com/blakesmith/ar` 的 `GO-2026-6905`，当前没有可用修复版本；检查目标按上游现有规则记录后返回成功。构建版本为 `29.0.0+dev-499-g8d65b612a2`。

**实现验收点**

- 七个标准目标均以状态 0 退出。
- 生成和依赖整理后内层没有新差异。
- 漏洞记录包含编号、依赖和当前无修复版本的事实。

## 数据库、后端和前端测试

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make migrations.individual.test` | 通过 | 全部迁移包的直接测试 |
| `make test-migration` | 通过 | 历史数据库、全部逐项迁移和 self 372 → 374 |
| `make test-backend` | 通过 | 全部后端包，包括 Codespace、Pages、组织和仓库服务 |
| `make test-frontend` | 121 个文件、402 项测试通过 | Vitest 前端测试 |

新增 `TestSelfMigrationTail` 检查 372、373、374 的待执行边界；`TestUpgradeSelfDatabaseFrom372` 使用旧 SQLite 结构和版本表执行完整迁移，并验证数据结果和版本 374。官方 `v368`、`v369` 的直接测试继续保持上游内容。

**实现验收点**

- 四个测试目标均以状态 0 退出。
- 真实升级测试验证版本推进、团队名称处理和运行器名称回填。
- Codespace、Pages、组织与仓库服务测试通过。

## 完整集成测试

`make test-integration` 从 Actions 测试运行到最后的 Workflow Run API。Codespace 路由与状态机、Pages 管理端与 API、组织变化、仓库删除与转移、两个 PR 的组合路径均通过。

唯一失败为上游 `TestAPIDownloadArchive` 的固定压缩字节长度断言：本机 Git 2.56.0 对普通 API 路径和 GitHub 风格路径都生成 264 字节 `tar.gz`，测试夹具期望 266 字节。单独执行 `make 'test-integration#TestAPIDownloadArchive'` 得到相同结果；响应状态、归档生成和其他格式测试正常。该文件相对正常 PR 合并结果没有 self 差异，用户已确认此既知环境错误无需处理。

**实现验收点**

- 完整套件运行到最后一个测试文件。
- 唯一失败为 `TestAPIDownloadArchive` 的两处 264/266 字节断言。
- 单独重跑稳定复现，没有第二类集成失败。

## 端到端测试

`make test-e2e` 使用仓库容器运行 Chromium、Firefox 和 WebKit。宿主机 Playwright 预检查提示缺少浏览器动态库，但容器提供运行环境，最终 219 项通过、6 项按浏览器能力跳过、0 项失败，命令状态为 0。

这组测试覆盖本轮上游新增和更新的 Actions、仓库设置、PR 差异复制、项目工作流以及常用仓库操作，证明完整前端与服务组合可以启动并工作。

**实现验收点**

- `make test-e2e` 状态为 0。
- 结果为 219 项通过、6 项跳过、0 项失败。
- Chromium、Firefox、WebKit 都实际运行了测试。

## 来源、文件与迁移审计

实施结束后再次查询远端，三个来源哈希与开始时一致。祖先检查全部成功，两个双父合并的第二父精确对应 PR 头。官方 `v365`—`v369` 文件及测试与上游逐字一致，两个 PR 的重复 `v370.go` 不在最终树中。

非数据库自动合并文件与两个 PR 的正常合并树比较为空；四个正常人工冲突文件按双方语义审阅。相对上游的 self 数据库差异只包含四项自维护 PR 来源文件、迁移列表、self 边界测试和真实升级测试。

**实现验收点**

- 远端哈希、祖先关系和合并第二父检查通过。
- 九个官方迁移文件比较通过，`v370.go` 缺失检查通过。
- 非数据库没有 self 专用兼容代码。

## 文档与产物清理

内层执行 `make clean`，删除构建二进制、测试二进制、临时配置和集成测试目录，工作树保持干净。维护文档更新为当前规则，删除三个过时官方补丁文档，并由 mdBook 构建验证链接和目录。

外层只提交 `gitea` 指针、`src/maintenance/self/`、`src/SUMMARY.md` 和根目录 `AGENTS.md`；原有 README、Codespace 子模块和 Codespace 设计文档改动继续留在用户工作区。

最终重新读取 `/tmp/todo-mi.md`。其中克隆面板布局修复、清理和验证清单均已勾选完成；本轮更新接入该功能分支的最新提交后，前端测试、生产构建和三浏览器端到端测试继续通过，因此该计划保持闭环。

**实现验收点**

- `make clean` 后内层 `git status` 干净。
- mdBook 构建通过，目录不包含失效文档链接。
- 外层维护提交不包含用户原有的其他改动。
- `/tmp/todo-mi.md` 的全部清单仍为完成状态，当前验证没有发现需要重新打开的事项。
