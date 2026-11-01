# 验证记录

本页记录 2026-11-02 对 Gitea `self` 提交 `157dca8bb2ed416e2277953f03fe6b10cecd6cd0` 的验证。环境为 Linux `6.18.56-1-lts`、Go `go1.27.3-X:nodwarf5`、Git `2.56.0`、Node.js `v24.21.0` 和 pnpm `12.14.0`。所有 Gitea 格式化、检查和测试均从仓库 Make 目标启动。

## 已执行检查

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make fmt` | 通过，工作树无格式变化 | Go 与模板格式 |
| `make lint-go` | 通过，`0 issues` | 文件头、Linux 构建静态检查、导入和代码规范 |
| `make lint-templates` | 通过，627 个模板、0 个错误 | Go HTML 模板语法和规范 |
| `make lint-js` | 通过 | ESLint 与 Vue TypeScript 类型检查 |
| `make lint-shell` | 通过 | Shell 脚本，包括本轮上游更新的 Playwright 启动脚本 |
| `make test-migration` | 通过 | SQLite 历史迁移、`modelmigration` 和 `modelmigration/v29` |
| `make test-backend` | 通过 | 全部后端包，包括 Codespace、Pages 及本轮新增的列表筛选测试 |
| `make test-frontend` | 121 个测试文件、398 项测试全部通过 | Vitest 前端单元测试 |
| `make 'test-integration#TestCodespace'` | 通过 | Codespace 路由、服务、数据库和生命周期集成行为 |
| `make 'test-integration#TestPagesActionsDeploymentAPI'` | 通过 | Pages Actions 部署接口 |
| `make 'test-integration#TestAPIPagesVersions'` | 通过 | Pages 版本接口 |
| `make clean` | 通过 | 删除二进制、集成测试目录和生成产物 |

三个定向集成测试都使用默认 SQLite，各自建立独立工作目录和随机端口。应用构建版本为 `29.0.0+dev-349-g157dca8bb2`，启动时使用当前迁移序列，Codespace 365 与 Pages 366 共同得到期望数据库版本 367。

## 端到端测试环境

`make test-frontend` 在准备 Playwright 浏览器时报告当前系统缺少 `libicu74`、`libxml2`、`libflite1`、`libharfbuzz-icu0`、`libmanette-0.2-0` 和 `libhyphen0`。前端单元测试不依赖这些浏览器系统库，因此仍完整通过；`make test-e2e` 需要真实启动 Playwright 浏览器，本轮环境不具备运行条件。

端到端覆盖留给安装了上述系统库和 Playwright 浏览器的环境执行。这个安排把环境准备问题与源码结果分开：当前提交不增加环境绕过代码，后续环境具备条件后直接运行仓库标准 `make test-e2e` 即可补齐验证。

## 已确认的上游环境差异

上一轮已经确认 `TestAPIDownloadArchive` 在 Git 2.56.0 下生成 264 字节归档，而固定断言期望 266 字节；相同差异可以在上游基线 `d3021b69ee` 复现，且与 Codespace、Pages 代码无关。本轮更新没有修改该测试或归档实现，评审范围也明确沿用既有结论，因此没有重复运行这一已知失败用例。

本轮以三个功能相关的定向集成入口验证更新内容。这样测试结果直接覆盖 Codespace 与 Pages 合并行为，同时保留上一轮对归档长度环境差异的完整原因记录。

## 数据库覆盖范围

本轮迁移与集成测试使用 SQLite。两个最新 PR 头相对各自迁移来源提交都没有 `modelmigration` 差异；`make test-migration` 验证现有 Codespace 365、Pages 366 及期望数据库版本 367 继续有效。

MySQL、PostgreSQL 和 SQL Server 的实际服务未在本地环境启动。部署到对应数据库前，维护者使用 `gitea/docs/testing.md` 中的环境变量和 Make 入口运行相应数据库集成测试，并把结果追加到本页。Codespace 的 SQL Server 非空 UUID 唯一索引和 Pages 的 XORM 表定义本轮均未变化。

## Git 与工作树检查

Codespace 最新头 `abd341fa30` 和 Pages 最新头 `ca49ed1a84` 都是 Gitea `self` 的祖先。`2117f129ac` 的父提交为原 `self@2fd1c04de5` 与最新 Codespace PR 头；`157dca8bb2` 的父提交为 `2117f129ac` 与最新 Pages PR 头。Pages 更新合并的文件树与第一父提交相同，完整记录了同步位置而没有重复文件改动。

本轮代码相对原 `self` 只修改 12 个来源文件，共 168 行新增、149 行删除，没有迁移差异。`make clean` 已清理测试生成物，内层 Gitea 工作树保持干净。外层 `main` 只记录内层提交指针和维护文档。

## 实现验收点

- 格式化、四项静态检查、迁移测试、后端测试和前端测试均成功退出。
- `TestCodespace`、`TestPagesActionsDeploymentAPI` 和 `TestAPIPagesVersions` 三个定向集成测试均通过。
- 当前迁移序列仍为 Codespace 365、Pages 366，期望数据库版本为 367。
- 两个最新 PR 头均为 `self` 的祖先，两笔更新合并提交均保留两个父提交。
- 端到端测试的未覆盖原因和所缺系统库已经明确记录，可在具备 Playwright 运行环境后直接补跑。
- 测试生成物已经清理，最终提交不包含临时二进制或集成测试目录。
