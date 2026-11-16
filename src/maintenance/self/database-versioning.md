# 数据库版本与升级范围

## 当前连续序列

Gitea 的数据库版本等于最后完成的迁移编号加一。self 在上游迁移 364 之后保留已经发布的自维护序列，并把本轮两项新官方迁移追加到末尾：

```go
newMigration(365, "Add Codespace tables", v29.AddCodespaceTables),
newMigration(366, "Add Pages support", v29.AddPagesTables),
newMigration(367, "Add Codespace Manager registration token table", v29.AddCodespaceManagerRegistrationTokenTable),
newMigration(368, "Normalize legacy repository unit and login source JSON", v29.NormalizeLegacyConfigJSON),
newMigration(369, "Drop user_open_id table", v29.DropUserOpenIDTable),
newMigration(370, "Add latest_release_id to repository table", v29.AddLatestReleaseIDToRepository),
newMigration(371, "Drop obsolete Codespace queued timeout index", v29.DropCodespaceQueuedTimeoutIndex),
newMigration(372, "Add unique index for team name", v29.AddUniqueTeamNameIndex),
newMigration(373, "Add runner_name to action_task", v29.AddRunnerNameToActionTask),
```

| self 迁移 | 完成后版本 | 结构变化 |
| ---: | ---: | --- |
| 365 | 366 | 建立 Codespace 基础结构 |
| 366 | 367 | 建立 Pages 基础结构 |
| 367 | 368 | 建立 Codespace Manager 注册令牌表 |
| 368 | 369 | 规范化旧配置 JSON |
| 369 | 370 | 删除 OpenID 2.0 表 |
| 370 | 371 | 增加仓库最新发行版指针 |
| 371 | 372 | 删除 Codespace 已停用的排队超时索引 |
| 372 | 373 | 建立组织内团队名称唯一索引 |
| 373 | 374 | 保存 Actions 任务使用的运行器名称 |

**实现验收点**

- `migrations.go` 中 365—373 连续、没有重复编号。
- 每行完成后版本等于迁移编号加一。
- 当前最终数据库版本为 374。

## 为什么从 372 继续追加

上一版 self 已经发布数据库版本 372，这个数字表示 365—371 全部完成。上游最新代码把团队名称唯一索引和运行器名称迁移放在官方编号 368、369；如果按官方编号重新排列，就会改变已发布 self 数据库中 368、369 的既有含义。

因此 self 复用官方迁移函数，但把实际执行编号安排为 372、373。旧 self 数据库会按 Gitea 原生迁移器顺序执行新增项，官方文件本身仍保持 `v368.go`、`v369.go`。这个设计同时保护已运行实例和上游文件身份。

**实现验收点**

- 版本 372 的数据库依次执行 `AddUniqueTeamNameIndex` 和 `AddRunnerNameToActionTask`。
- 官方 `v368.go`、`v369.go` 的代码与测试没有为 self 改名或改写。
- 两项迁移完成后版本记录依次变为 373、374。

## 支持的升级来源

本项目支持全新安装和 self 历史中的连续升级。当前直接验证的生产锚点为上一版 self 数据库 372；更早 self 版本按同一迁移列表补齐尚未执行的编号。Gitea 已不支持的过低历史版本仍遵循上游迁移器给出的升级路径。

上游或单独 PR 在迁移 365 之后安装、升级得到的数据库不属于 self 兼容范围，因为它们用相同数字表示不同结构。需要迁入 self 时，应使用进入分歧迁移前的备份，或单独设计一次有明确来源和验收数据的转换；日常 self 更新不通过检测表是否存在来猜测来源。

**实现验收点**

- 现有 self 版本 372 可以直接升级到 374。
- `make test-migration` 验证历史数据库能执行当前迁移器。
- 运维记录包含实例所用分支，能判断数据库是否属于 self 历史。

## 372 到 374 的真实升级测试

`modelmigration/self_migrations_test.go` 建立版本 372 的 SQLite 数据库，使用迁移前的 `team`、`action_task` 和 `action_runner` 结构写入数据，再调用完整的 `modelmigration.Migrate`。测试确认重复团队名得到稳定重命名，`runner_name` 从运行器表回填，版本表最终写为 374。

测试使用完整迁移入口而不是直接调用两个函数，因此同时验证待执行迁移选择、执行顺序和版本推进。`migrations_test.go` 另行检查 372、373、374 三个边界的待执行列表。

**实现验收点**

- `TestUpgradeSelfDatabaseFrom372` 在 `make test-migration` 中通过。
- 旧团队数据和 Actions 任务数据在升级后仍可读取。
- 版本边界测试证明不会漏执行或重复调度 372、373。

## 下一项迁移

下一项 self 数据库变化从实际编号 374 开始，完成后数据库版本为 375。若变化来自两个自维护 PR 已有迁移，则为对应 `pr-*` 身份增加下一个 `patchN`；若变化来自新的官方 `vXXX.go`，保留官方文件名和内容，只在 self 迁移列表末尾安排执行编号。

采用这两条路径是为了分别表达“我们维护的 PR 增量”和“上游正式迁移”。执行编号始终追加，来源身份始终保持稳定，审阅者可以同时回答代码来源和旧实例执行时机。

**实现验收点**

- 下一项 self 实际迁移编号为 374。
- 新迁移在映射中同时记录来源文件身份、self 编号、完成后版本和测试。
- 新增官方迁移可以直接与同一上游文件逐字比较。
