# 验证记录

## 验证范围与环境

本页记录 2026-11-04 对 Gitea `self` 提交 `0a47af0f52a34516290caf54516f0a52a7e1743a` 的验证。环境为 Linux `6.18.60-1-lts`、Go `go1.27.3-X:nodwarf5`、Git `2.56.0`、Node.js `v24.22.1` 和 pnpm `12.16.1`。Gitea 的格式化、静态检查、构建和测试均从仓库 Make 目标启动。

验证覆盖本轮上游九项提交、Codespace Manager 注册令牌流程、Pages 当前头、迁移 367 和此前两个 PR 的组合行为。

**实现验收点**

- 验证日期、内层完整提交和五项主要工具版本已记录。
- 当前 `self` 可以解析到记录的提交 `0a47af0f52`。
- 所有 Gitea 测试命令都使用 Make 入口。

## 格式化、生成、静态检查与构建

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make fmt` | 通过，未产生待提交格式差异 | Go 与仓库格式规则 |
| `make tidy` | 通过，依赖声明整洁 | Go 模块和许可证依赖输入 |
| `make go-licenses` | 通过，现有清单为最新 | Go 许可证生成结果 |
| `make checks` | 通过 | pnpm 锁文件、SVG、Go 模块、OpenAPI、Swagger、格式和漏洞调用扫描 |
| `make lint` | 通过，Go 报告 `0 issues`，626 个模板无错误 | Go、TypeScript、Vue、CSS、模板、OpenAPI、Markdown、工作流、JSON 与 YAML |
| `make build` | 通过 | Vite 生产资源和无 CGO Gitea 二进制 |

漏洞扫描没有发现代码实际调用的漏洞；依赖模块中检测到的一项记录不在当前调用路径。构建版本为 `29.0.0+dev-365-g0a47af0f52`。

**实现验收点**

- 六个命令均以状态 0 退出。
- 格式化、依赖整理和生成检查后，内层工作树没有新增源码差异。
- 前端生产资源和 Gitea 主二进制均成功生成。

## 单元测试与迁移测试

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make test-migration` | 通过 | SQLite 历史迁移、全部 `modelmigration` 包和迁移 367 直接测试 |
| `make test-backend` | 通过 | 全部后端包，包括 Codespace、Pages、RPC、路由和服务测试 |
| `make test-frontend` | 121 个测试文件、396 项测试全部通过 | Vitest 前端单元测试 |

迁移 367 的直接测试连续执行两次迁移，检查六列、令牌唯一索引、用户索引和重复令牌错误。完整迁移目标同时确认当前序列可以从历史数据库运行，并得到期望数据库版本 368。

**实现验收点**

- 三个测试目标均以状态 0 退出。
- `services/codespace`、`routers/api/codespace/manager`、`models/pages` 和 `services/pages` 均在后端全量测试中通过。
- `TestAddCodespaceManagerRegistrationTokenTable` 在完整迁移测试中通过。
- 当前期望数据库版本为 368。

## 完整集成测试

执行了 `make test-integration`，测试套件从 Actions 开始运行到最后的 Workflow Run API 测试。Codespace、Pages 和 `/tmp/todo-mi.md` 关注的 Actions 路由行为均通过，其中包括：

- `TestActionsRoute`；
- `TestPagesActionsDeploymentAPI`；
- `TestAPIPagesVersions`；
- `TestCodespaceRoutes`、`TestCodespaceManagerSettings` 和 `TestCodespaceTokenAPIRoutePolicy`；
- `TestAPIPullUpdateCodespaceTokenAllowsForkHead`。

套件唯一失败为已确认的 `TestAPIDownloadArchive` 环境差异。Git 2.56.0 在普通 API 路径和 GitHub 风格路径各生成 264 字节 `tar.gz`，固定夹具期望 266 字节；两处断言属于同一个测试。该差异在此前上游基线验证中已经复现，涉及的归档实现和测试不属于本轮 Codespace、Pages 或迁移变化。用户已确认本轮不处理该错误，因此验证记录保留实际结果，功能实现不增加环境特判。

**实现验收点**

- 完整集成套件运行到末尾，退出状态只由 `TestAPIDownloadArchive` 的两处 264/266 字节断言产生。
- Codespace Manager 注册与设置、Pages Actions 部署和版本 API 测试均在该套件中通过。
- Actions 仓库管理员权限与 Codespace 令牌只读路由测试通过。
- 已知失败记录包含测试名、Git 版本、实际值、期望值和不处理原因。

## 端到端测试环境

`make test-frontend` 准备 Playwright 浏览器时报告当前系统缺少 `libicu74`、`libxml2`、`libflite1`、`libharfbuzz-icu0`、`libmanette-0.2-0` 和 `libhyphen0`。Vitest 不依赖这些动态库，因此前端单元测试完整通过；真实浏览器端到端测试需要这些库，本机没有运行 `make test-e2e`。

源码不为本机环境增加绕过分支。安装上述系统库后，可以直接使用仓库标准 `make test-e2e` 补充浏览器验证。

**实现验收点**

- 缺少的六项系统库和受影响的测试类型已记录。
- 前端单元测试结果与 Playwright 环境限制分开记录。
- 具备系统库的环境可以直接使用标准 Make 目标补跑。

## Git、迁移边界与代码清理检查

`upstream/main@4d00ed2a1e`、Codespace PR 头 `18086bdaa7` 和 Pages PR 头 `d362d8afbb` 都是当前 `self` 的祖先。两笔更新合并保留双父历史；Pages 合并树与第一父相同。Codespace 更新中的旧网页预创建 Manager、重置密钥弹窗、前端组件和对应过时测试已由来源提交删除，当前搜索只保留运行身份需要的 `GenerateManagerSecret` 等有效实现。

`d552c30170` 把 `self` 特有变化限制在迁移列表、恢复后的 patch1、新 patch2 和直接测试。patch1 对象哈希与本轮开始的 `self` 相同，业务模型和服务保持来源 PR 实现。

**实现验收点**

- 三个来源祖先检查均成功。
- `74ef7df9ba` 和 `0a47af0f52` 的父提交与固定 PR 头一致。
- 代码中没有合并冲突标记，也没有旧 Manager 创建或密钥弹窗入口。
- patch1 对象哈希为 `2d7a6d19571fc53b8de2b591e23344eb89e77712`。

## 文档与产物清理

外层维护文档和目录使用仓库现有 Node.js 依赖执行 Markdown 检查，结果通过。随后使用临时输出目录执行 `mdbook build`，HTML 构建成功。`mdbook-mermaid` 报告它由 mdBook 0.5.0 构建而当前命令为 0.5.4，该兼容提示没有影响预处理和 HTML 输出。临时目录在命令结束时删除。

内层执行 `make clean`，删除 Gitea 二进制、集成测试二进制、临时配置、集成测试工作目录和生成产物。清理后内层工作树保持干净。

**实现验收点**

- mdBook 成功生成完整 HTML 文档。
- `src/SUMMARY.md` 与全部 `src/maintenance/self/**/*.md` 通过 Markdown 检查。
- 临时文档输出目录已删除。
- `make clean` 状态为 0，最终内层提交不包含测试二进制或集成测试目录。
- 内层 `self` 工作树干净，外层只由维护提交暂存 Gitea 指针与维护文档。

## `/tmp/todo-mi.md` 闭环复核

最终重新读取了 `/tmp/todo-mi.md`。其中九项实现验收点全部为已完成状态；当前 `self` 继续保留该计划要求的九个上游提交、`gitea.dev/sdk v1.5.0`、Codespace 协议依赖、仓库 Actions 管理权限和 Codespace 令牌只读边界。完整集成测试也再次覆盖对应路由行为。

该文件中的“不新增迁移”描述的是上一轮只合并 `upstream/main` 到 `feat-remote-dev` 的范围。本轮 `self` 迁移 367 来自其后新增的 Codespace 提交 `3fc98fc1c0`，用于当前 Manager 注册令牌功能；它不改变上一轮上游同步结论。当前 Codespace 外部契约变化已经在 `src/codespace/` 的设计文档中体现，维护分支的编号安排则由本目录记录。

**实现验收点**

- `/tmp/todo-mi.md` 中没有未勾选验收项，已勾选项共九项。
- 九个上游提交都是当前 `self` 的祖先。
- `go.mod` 同时包含 `gitea.dev/codespace-proto-go` 当前协议版本和 `gitea.dev/sdk v1.5.0`。
- Actions 管理、读取和 Codespace 令牌边界与计划一致，并已通过完整集成测试。
