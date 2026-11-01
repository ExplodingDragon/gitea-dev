# 验证记录

本页记录 2026-11-01 在 Linux、Go `go1.27.3-X:nodwarf5`、Git `2.56.0` 环境中对 Gitea `self` 提交 `2fd1c04de531f300dc4b30711fcf05ec8c30be81` 执行的验证。所有 Go 测试均通过 Gitea Make 目标启动。

## 已执行检查

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `make fmt` | 通过，工作树无格式变化 | Go 格式 |
| `make lint-go` | 通过，`0 issues` | 文件头、Linux 构建静态检查、导入和代码规范 |
| `make test-migration` | 通过 | SQLite 历史迁移、`modelmigration` 和 `modelmigration/v29` |
| `make test-backend` | 通过 | 全部后端包，包括 Codespace、Pages、组织、仓库和定时任务服务 |
| `make test-integration` | 相关功能通过；完整命令因上游归档长度断言退出 | SQLite 集成套件、应用启动、API、Codespace、Pages、仓库生命周期 |

集成套件中以下本次相关用例均已执行通过：

- 管理 API 定时任务列表与执行；
- Pages 管理页面、Actions 部署 API 和版本 API；
- Codespace 路由、模板设置、数据库 UUID 约束、Manager 设置、令牌路由策略、生命周期和清单状态机；
- API 比较接口、仓库可见性、仓库删除、组织和仓库服务相关流程；
- 应用使用数据库版本 367 完成启动。

## 已确认的上游环境差异

`TestAPIDownloadArchive` 把 Git 生成的 `master.tar.gz` 长度固定断言为 266 字节。当前 Git 2.56.0 生成内容等价的 264 字节归档，因此完整集成命令在该用例退出。

按 Gitea 文档规定的筛选入口执行 `make 'test-integration#TestAPIDownloadArchive'`，`self` 稳定复现 264 字节结果。随后在一次性分离工作树中检出同一上游基线 `d3021b69eec62d40752f7034ced4dd091fe085af`，运行相同 Make 目标，上游也以相同的 264/266 差异失败。`self` 相对上游没有修改该测试和归档实现。

这个结果证明失败由当前 Git 版本与上游固定字节长度断言共同产生，不属于两个 PR 的合并回归。本轮维护按确认结论记录该差异，不修改归档业务或上游测试。

## 数据库覆盖范围

本轮本地迁移与集成测试使用 SQLite。Codespace 迁移保留来源实现中针对 SQL Server 的非空 UUID 唯一索引写法，Pages 迁移保持来源 PR 的 XORM 表定义；`make lint-go` 和完整后端测试覆盖这些代码的编译与通用行为。

MySQL、PostgreSQL 和 SQL Server 的实际服务未在本地环境启动。部署到对应数据库前，维护者使用 `gitea/docs/testing.md` 中的环境变量和 `make test-integration` 入口运行相应数据库测试，并把结果追加到本页。

## Git 与工作树检查

两个来源头提交均为 Gitea `self` 的祖先。Codespace 合并提交的父提交为上游基线与 PR #38337 头提交；Pages 合并提交的父提交为 Codespace 数据库记录提交与 PR #40071 头提交。两个迁移文件改名均被 Git 识别为 100% 重命名。

测试和上游基线复核使用的临时集成目录与 `/tmp` 分离工作树已经清理。Gitea 最终工作树保持干净，外层仓库只固定 Gitea 子模块和本维护文档。

## 实现验收点

- `make fmt`、`make lint-go`、`make test-migration` 和 `make test-backend` 均成功退出。
- Codespace、Pages、定时任务数量和合并生命周期相关集成用例均通过。
- 归档长度失败可以在未包含本次改动的固定上游基线上复现，且结果同为 264 字节。
- 验证记录明确区分已执行的 SQLite 测试和待具备服务后执行的其他数据库测试。
- 临时测试目录、进程和分离工作树均已清理，最终提交不包含测试生成物。
