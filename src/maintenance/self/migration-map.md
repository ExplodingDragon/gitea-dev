# 数据库迁移映射

## 当前映射

迁移映射把来源变化、`self` 的实际执行位置和 Git 记录放在同一处。来源 PR 可以继续修改原迁移文件，而 `self` 的每一行都代表一项独立、连续、可能已经执行过的数据库历史。

| 来源 | 来源变化提交 | 当前已同步 PR 头 | 来源位置 | `self` 迁移 | 完成后版本 | `self` 迁移函数 | `self` 文件 | 移植记录提交 |
| --- | --- | --- | --- | ---: | ---: | --- | --- | --- |
| Codespace PR #38337 基础结构 | `1c0f24e4fd7755b47a22e3cb89c3fc366b5901ab` | `18086bdaa7bcb226306e3713647e7ff6e3dac30d` | 来源迁移 365 | 365 | 366 | `v29.AddCodespaceTables` | `modelmigration/v29/pr-38337-v365-patch1.go` | `ac46f7081c42833c9fd52341fe1772b591ffd4ed` |
| Pages PR #40071 基础结构 | `534024baa21f974027c86d0b3b1a5a01b89d85be` | `d362d8afbb4f5184f01cb0e33b316f5eeea9810e` | 来源迁移 365 | 366 | 367 | `v29.AddPagesTables` | `modelmigration/v29/pr-40071-v366-patch1.go` | `2fd1c04de531f300dc4b30711fcf05ec8c30be81` |
| Codespace PR #38337 Manager 注册令牌 | `3fc98fc1c089092a2d77978f8d070fe595f595f2` | `18086bdaa7bcb226306e3713647e7ff6e3dac30d` | 追加到来源迁移 365 | 367 | 368 | `v29.AddCodespaceManagerRegistrationTokenTable` | `modelmigration/v29/pr-38337-v367-patch2.go` | `d552c301702c721fd6a30c730b6e4a9844bfb049` |

Codespace 基础结构保持迁移 365，Pages 改为 366。注册令牌表在来源 PR 中被追加到旧的 365；`self` 将这 10 行表定义转成独立迁移 367，从而让上一版 `self` 的数据库版本 367 也能创建该表。

**实现验收点**

- 映射包含三个实际迁移，`self` 编号连续为 365、366、367。
- 三行文件路径、函数名和注册编号与内层代码一致。
- 每行完成后的数据库版本等于 `self` 迁移编号加一。
- 两个“当前已同步 PR 头”分别等于本轮两个更新合并提交的第二父。

## 来源变化与已发布迁移的关系

“来源变化提交”固定数据库结构首次出现的位置，“当前已同步 PR 头”说明业务代码跟进到的位置。两列分开后，可以准确表达三种情况：来源只有业务变化、来源增加全新迁移、来源修改已经进入 `self` 的旧迁移。

本轮 Pages 从 `ca49ed1a84` 更新到 `d362d8afbb`，只有共同上游变化，`modelmigration` 没有差异。Codespace 从 `abd341fa30` 更新到 `18086bdaa7`，其中 `3fc98fc1c0` 对来源 `v365.go` 增加注册令牌表。因为 `self` 的迁移 365 和 366 已经发布，这项增量形成 Codespace `patch2`，而 `patch1` 继续表示原来的基础结构。

**实现验收点**

- `git diff abd341fa30..18086bdaa7 -- modelmigration` 可以定位来源注册令牌表变化。
- `git diff ca49ed1a84..d362d8afbb -- modelmigration` 为空。
- `git hash-object modelmigration/v29/pr-38337-v365-patch1.go` 与 `self@157dca8bb2` 中该文件的对象哈希相同。
- Codespace 当前来源头中的业务模型有注册令牌表，当前 `self` 通过迁移 367 提供同一结构。

## 新增映射记录的方法

每次接入数据库变化时，先记录来源 PR、固定头提交、结构首次出现的提交和来源迁移位置，再读取 `self` 当前最后迁移编号。新结构占用末尾下一个连续编号，文件名使用对应 PR、实际编号和连续 patch 序号。

完成代码后，同步更新以下记录：

1. `modelmigration/migrations.go` 的编号、标题和函数；
2. 本页的来源位置、`self` 编号和移植提交；
3. `patches/` 下该迁移的结构、升级理由和测试；
4. `database-versioning.md` 的期望版本和升级来源；
5. `verification.md` 的实际测试结果。

**实现验收点**

- 新记录包含来源、完整提交、来源位置、`self` 编号、函数、文件和移植提交。
- 同一来源的 patch 序号保持连续，跨来源的 `self` 迁移编号保持连续。
- 映射、逐项文档、版本文档和验证记录在同一个外层维护提交中更新。
