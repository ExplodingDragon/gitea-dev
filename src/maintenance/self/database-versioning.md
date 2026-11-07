# 数据库版本与升级范围

## 当前版本序列

Gitea 数据库版本等于最后完成的迁移编号加一。当前 `self` 在上游迁移 364 之后连续注册 365—371，因此全部完成后的数据库版本为 372。

```go
newMigration(365, "Add Codespace tables", v29.AddCodespaceTables),
newMigration(366, "Add Pages support", v29.AddPagesTables),
newMigration(367, "Add Codespace Manager registration token table", v29.AddCodespaceManagerRegistrationTokenTable),
newMigration(368, "Normalize legacy repository unit and login source JSON", v29.NormalizeLegacyConfigJSON),
newMigration(369, "Drop user_open_id table", v29.DropUserOpenIDTable),
newMigration(370, "Add latest_release_id to repository table", v29.AddLatestReleaseIDToRepository),
newMigration(371, "Drop obsolete Codespace queued timeout index", v29.DropCodespaceQueuedTimeoutIndex),
```

| 阶段 | 最后完成的迁移 | 数据库版本 | 结构含义 |
| --- | ---: | ---: | --- |
| 上游分叉点 | 364 | 365 | 尚未执行两个自维护功能的迁移 |
| Codespace 基础结构 | 365 | 366 | Codespace 表可用 |
| Pages 基础结构 | 366 | 367 | Codespace 与 Pages 表可用 |
| Manager 注册令牌 | 367 | 368 | 上一版 `self` 的完整结构 |
| 旧 JSON 规范化 | 368 | 369 | 旧配置已转换为正常 JSON |
| OpenID 2.0 清理 | 369 | 370 | `user_open_id` 已删除 |
| 最新发行版指针 | 370 | 371 | 仓库包含 `latest_release_id` |
| Codespace 索引清理 | 371 | 372 | 当前完整结构 |

**实现验收点**

- `migrations.go` 中 365—371 连续且只出现一次。
- `ExpectedDBVersion()` 返回 372。
- 表中每个数据库版本都等于对应迁移编号加一。

## 为什么继续追加到 371

上一版 `self` 已经把版本 368 发布为“Codespace、Pages 和 Manager 注册令牌均已完成”。本轮上游主线也到达数据库版本 368，但上游的 365—367 分别代表 JSON 规范化、删除 OpenID 2.0 表和最新发行版指针。相同数字已经对应不同历史，因此 `self` 把这三项上游变化追加为 368—370。

Codespace 当前 PR 又从来源迁移 365 删除了 `queued_timeout` 索引。旧 `self` 的迁移 365 已经创建该索引，故将删除操作安排为迁移 371。连续追加使上一版 `self` 只需执行四项迁移即可达到与当前代码一致的结构。

**实现验收点**

- 版本 368 的旧 `self` 会依次执行 368—371。
- 上游三项迁移的实现与 `upstream/main@c74f2f9216` 对应来源文件一致。
- 迁移 371 只删除 `queued_timeout`，并保留 `running_timeout` 和表中数据。

## 支持的升级来源

当前分支直接支持以下来源：

| 数据库来源 | 进入当前代码时的版本 | 执行方式 | 结果 |
| --- | ---: | --- | ---: |
| 全新安装 | 未初始化 | 执行完整迁移序列 | 372 |
| 分叉前上游 | 不高于 365 | 从当前版本顺序执行 `self` 迁移 | 372 |
| 早期 `self` | 366 或 367 | 补齐余下 `self` 迁移 | 372 |
| 上一版 `self` | 368 | 执行 368—371 | 372 |
| 本版 `self` | 372 | 无待执行迁移 | 372 |

迁移 365 之后的上游数据库、Codespace PR 单独数据库和 Pages PR 单独数据库分别拥有自己的版本含义。它们适合继续使用对应分支的升级序列；要改用 `self` 时，应从进入分支迁移 365 之前的备份开始按 `self` 升级。这里采用明确来源的升级路径，是因为 Gitea 原生 `version` 表只保存数字，无法可靠区分同号迁移来自哪个分支。

**实现验收点**

- 昨天数据库版本 368 的 `self` 实例可以直接升级到 372。
- 分叉前版本与既有 `self` 版本均通过 Gitea 原生迁移器完成升级。
- 部署记录保存分支来源，能识别迁移 365 之后的上游或单独 PR 数据库。

## 文件名与实际执行编号

文件名格式为 `pr-<来源 PR>-v<来源迁移编号>-patch<N>.go`。其中 `v` 记录来源分支中变化所属的迁移编号，`patchN` 记录同一 PR 对同一来源迁移的第几项变化。`self` 实际执行编号由 `migrations.go` 决定，并在 [迁移映射](migration-map.md) 中集中列出。

以 Codespace 为例：基础结构、Manager 注册令牌和排队超时索引清理都源自 PR #38337 的迁移 365，所以分别命名为 `patch1`、`patch2`、`patch3`；它们在 `self` 中实际执行于 365、367、371。稳定的来源身份使下一次 PR 变基或上游迁移顺延时仍能直接比较内容。

**实现验收点**

- `pr-38337-v365-patch1.go`、`patch2.go`、`patch3.go` 的来源身份一致，实际编号分别可在映射表查到。
- Pages 文件名为 `pr-40071-v365-patch1.go`，实际注册编号为 366。
- 三项上游迁移文件的来源编号分别为 365、366、367，实际编号分别为 368、369、370。

## 后续迁移安排

下一项 `self` 数据库变化使用迁移 372，完成后数据库版本为 373。若来源修改已经发布过的来源迁移，则在对应来源身份下增加下一个 `patchN`；若来源增加全新迁移，则以新的来源编号从 `patch1` 开始。实现与直接测试紧邻存放，映射文档记录实际执行编号。

遇到 Gitea 改变版本存储或迁移调度机制时，本轮同步应以清晰错误停止，并基于真实数据库来源设计一次转换。正常更新继续使用 Gitea 原生版本表和单一连续序列，不引入额外的结构猜测。

**实现验收点**

- 下一项实际迁移编号为 372。
- 新增迁移同时具备来源身份、实际编号、升级理由和直接测试。
- 版本机制发生变化时，维护记录包含来源版本、目标版本和无法继续顺排的原因。
