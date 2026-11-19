# 验证记录

## 范围和环境

本页记录 2026-11-19 对本轮 self 合并及数据库增量的实际验证，最终提交为 `098facfe362119127e54aed8faddd0c3caa40914`。固定输入为 self `8d65b612a2`、Codespace PR `09670abbde`；Pages `5000d55fb2` 和已包含官方主线 `23836eb610` 保持原样。所有 Gitea 测试均通过仓库 Make 目标启动。

环境：Linux `6.18.60-1-lts`，Go `go1.27.4-X:nodwarf5`，Git `2.56.1`，Node.js `v24.22.3`，pnpm `12.17.0`。测试使用临时 SQLite 数据库及三个仅绑定本机随机端口的临时数据库容器，没有连接部署实例或 Kubernetes。

**实现验收点**

- 验证内容对应本轮固定输入和最终迁移实现。
- 临时测试环境与部署数据分离。
- 已知环境差异和未执行的部署操作明确列出。

## 格式、检查与构建

| Make 目标 | 结果 | 说明 |
| --- | --- | --- |
| `make fmt` | 通过 | 格式化迁移实现和测试 |
| `make tidy generate-swagger swagger-validate` | 通过 | 依赖及生成文件没有引入业务差异 |
| `make checks` | 通过 | 最终重跑退出 0；依赖漏洞警告见下文 |
| `make lint` | 通过 | 最终重跑 Go 检查 0 issues，621 个模板无错误，其余检查通过 |
| `make build` | 通过 | 最终提交再次构建，版本 `29.0.0+dev-507-g098facfe36` |

首次检查在修改尚未暂存时触发 `fmt-check` 的工作树比较，另发现测试导入处不需要的 lint 忽略标记。已移除该标记，审核并暂存后重跑 `make -k checks lint test-migration`，退出码 0。此后检查输出没有额外生成文件改动。

`make checks` 中的安全扫描报告既有依赖 `github.com/blakesmith/ar` 的 `GO-2026-6905`，扫描结果的修复版本为 N/A；Make 目标按当前上游规则记录后返回成功。本轮没有修改依赖或业务代码来消除该警告。

**实现验收点**

- 最终检查日志为 `/tmp/gitea-self-375-checks-final.log`，退出码 0。
- 首轮发现的本轮 lint 问题已修复，最终结果以重跑为准。
- 漏洞警告单独记录，不能把检查退出成功解释为无漏洞。

## 功能与迁移测试

| Make 目标 | 结果 | 覆盖 |
| --- | --- | --- |
| `make test-backend` | 通过 | 完整后端单元测试 |
| `make test-frontend` | 通过 | 121 个文件，402 项测试 |
| `make test-migration` | 通过 | 历史数据库迁移测试、全部逐项迁移、self 372 和 374 升级 |
| `make test-integration` | 完整执行，1 个顶层测试失败 | 唯一失败为下述既有归档长度断言，包含其 GitHubStyle 子测试 |
| `make test-e2e` | 通过 | Chromium、Firefox、WebKit 共 219 项通过、6 项按套件规则跳过 |

self 新增测试使用真实旧表结构和版本表执行完整 `Migrate`，覆盖 374 → 375、372 → 375、375 再次启动保留新实例与令牌。直接迁移测试验证旧实例和孤立凭据清理、共享 DBFS 路径隔离、个人密钥密文及管理配置保留、索引和自增序列延续、失败回滚和 DDL 重试。

完整集成套件包含 `TestAPIDownloadArchive` 及其 `GitHubStyle` 子测试的既有差异：期望 tar.gz 为 266 字节，本机为 264。直接对原始测试仓库运行本机 `git archive --format=tar.gz --prefix=repo1/ master` 同样为 264 字节，并能解包出 `repo1/README.md`；没有经过任何 Codespace 代码。本轮保留原测试和归档实现，如实记录该失败。

主验证命令 `make -k tidy generate-swagger swagger-validate checks lint build test-backend test-frontend test-migration test-integration test-e2e` 已执行到末尾，退出码 2。首轮格式与 lint 问题经修正后单独重跑通过；最终尚未通过的项目只有上述集成归档断言。浏览器套件退出成功，不包含真实 Codespace 集群运行验证。

**实现验收点**

- 迁移清理和保留范围、失败重试及再次启动均有执行结果。
- 集成套件完成后列出全部失败，不将已知失败标作通过。
- 主验证日志保存在 `/tmp/gitea-self-375-validation.log`。
- 浏览器套件覆盖三种浏览器，完整执行到 219 通过、6 跳过；没有新增浏览器失败。

## 多数据库迁移验证

以下通过 `make migrations.individual.test MIGRATE_TEST_PACKAGES='gitea.dev/modelmigration gitea.dev/modelmigration/v29' GOTEST_FLAGS='-timeout 40m -count=1'` 执行，分别指定 `GITEA_TEST_DATABASE` 及临时库连接。强制重新运行，避免切换数据库时复用测试缓存。

| 数据库 | 结果 | 范围 |
| --- | --- | --- |
| SQLite，仓库默认驱动 | 通过 | 全部迁移套件及 self 升级，另覆盖视图阻止 DDL 后的重试 |
| PostgreSQL 17 | 通过 | modelmigration 和 v29 全部测试 |
| MySQL 8.4 | 通过 | modelmigration 和 v29 全部测试 |
| SQL Server 2019，15.0.4500.2 | 通过 | modelmigration 和 v29 全部测试 |

跨数据库首次运行发现 PostgreSQL 旧 UUID 条件索引返回完整物理名，以及 SQL Server 测试不能显式插入自增版本 ID。实现已按索引列识别 UUID，测试改为由数据库分配版本记录 ID；上述结果均为修正后、禁用缓存的最终重跑结果。

日志分别为 `/tmp/gitea-self-375-pg.log`、`/tmp/gitea-self-375-mysql.log`、`/tmp/gitea-self-375-mssql.log`。这些结果验证迁移行为，不表示三个外部数据库都执行了完整业务集成套件；完整业务集成使用 SQLite。

验证后已停止并删除 `gitea-self375-pg-test`、`gitea-self375-mysql-test`、`gitea-self375-mssql-test` 三个临时容器，删除的仅是可重新生成的测试数据。

**实现验收点**

- 三个外部数据库命令最终退出码均为 0。
- SQLite 专属故障注入在其他数据库明确跳过，其余迁移测试实际执行。
- 临时容器在验证结束后删除，不保留测试凭据或部署数据。

## 差异审计与文档闭环

正常合并树为 `b1f1d5f8656885ec7445e857dff1a43e74972326`。最终树与它比较，`modelmigration/` 以外输出为空，退出码 0；完整差异清单只包含迁移注册、升级测试、历史 patch1 保留、patch4 及替代的 PR 完整结构测试。官方 v365—v369 及其测试与主线 `23836eb610` 完全相同，历史 PR 补丁与更新前 self 完全相同。可复现命令见 [差异审计](conflict-resolutions.md)。

维护说明替换旧的“当前 374”内容，保留历史迁移的来源说明，并新增 patch4 发布步骤；目录和 AGENTS 同步更新。文档由 `mdbook build` 验证，mdbook-mermaid 的构建版本提示不影响生成。

最终构建日志为 `/tmp/gitea-self-375-build-final.log`。本轮失败诊断目录和集成测试二进制移至 `/tmp/gitea-self375-test-artifacts.oYNUOE`，可以取回；更新前已存在的测试目录保持原样。保留本轮构建的 Gitea 二进制，源码工作树干净。

重新读取 `/tmp/todo-mi.md`：它是已完成的 Codespace 配置边界清理计划，并非本轮数据库迁移计划。全部清单已勾选，本次接入的 PR 包含该配置调整；本轮测试没有要求重新打开其中事项。文件保持原样。

实际部署资源清理、新镜像发布和线上生命周期验收未在本次执行；这是 [patch4 部署说明](patches/pr-38337-v365-patch4.md) 定义的发布操作，而不是代码仓库修改。

**实现验收点**

- 内层差异范围、官方及历史文件逐字比较完成。
- 内层先推送，外层再提交指针及文档；其他子模块保持原样。
- mdBook 与 `git diff --check` 通过，文档提交哈希和数据库版本与代码一致。
- 明确区分代码验证完成和真实实例部署完成。
