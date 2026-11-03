# Gitea self 分支维护总览

## 维护目标

`self` 是本项目直接维护的 Gitea 分支。它从上游提交 `d3021b69eec62d40752f7034ced4dd091fe085af` 建立，通过双父合并完整保留 Codespace PR #38337、Pages PR #40071 和它们包含的上游历史。外层 `gitea-dev/main` 固定已验证的内层提交并保存维护文档，内层 `gitea/self` 承载可以部署的 Gitea 代码与数据库迁移序列。

两个 PR 在上游各自开发时都从迁移 365 开始。`self` 直接采用自己的连续迁移序列：Codespace 基础结构为 365，Pages 为 366，Codespace Manager 注册令牌表为 367。数据库进入这组序列后继续沿 `self` 升级，当前期望数据库版本为 368。

**实现验收点**

- 外层仓库当前分支为 `main`，内层 Gitea 当前分支为 `self`。
- 内层分支同时包含两个 PR 的完整提交历史和上游 `main@4d00ed2a1e`。
- 迁移列表连续注册 365、366、367，`ExpectedDBVersion()` 返回 368。

## 当前组成

| 内容 | 固定来源 | `self` 中的记录 |
| --- | --- | --- |
| 初始上游基线 | `upstream/main@d3021b69ee` | `self` 建立点 |
| 当前上游更新 | `upstream/main@4d00ed2a1e` | 随两个最新 PR 头进入 |
| Codespace 初始实现 | PR #38337 `1c0f24e4fd` | 合并提交 `6702aa22fe` |
| Codespace 上一轮更新 | PR #38337 `abd341fa30` | 合并提交 `2117f129ac` |
| Codespace 当前实现 | PR #38337 `18086bdaa7` | 合并提交 `74ef7df9ba` |
| Pages 初始实现 | PR #40071 `534024baa2` | 合并提交 `5ccb5d3a0d` |
| Pages 上一轮更新 | PR #40071 `ca49ed1a84` | 合并提交 `157dca8bb2` |
| Pages 当前实现 | PR #40071 `d362d8afbb` | 合并提交 `0a47af0f52` |
| Codespace 基础迁移 | PR #38337 原迁移 365 | `pr-38337-v365-patch1.go` |
| Pages 基础迁移 | PR #40071 原迁移 365 | `pr-40071-v366-patch1.go` |
| Manager 注册令牌迁移 | PR #38337 提交 `3fc98fc1c0` 对原迁移 365 的增量 | `pr-38337-v367-patch2.go` |
| 当前 `self` 头提交 | 两个最新 PR 头均已接入 | `0a47af0f52` |

本轮 Codespace 更新带入 Manager 按站点或用户作用域注册的新流程，以及上游从 `1f51d2c318` 到 `4d00ed2a1e` 的九项提交。Pages 最新头只合并同一上游 `main`，因此它的更新合并提交保留第二父历史，但文件树与第一父提交相同。

**实现验收点**

- PR #38337 头 `18086bdaa7`、PR #40071 头 `d362d8afbb` 和上游 `4d00ed2a1e` 都是当前 `self` 的祖先。
- `74ef7df9ba` 和 `0a47af0f52` 都有两个父提交，第二父分别是本轮固定的两个 PR 头。
- `0a47af0f52` 的文件树与第一父 `d552c30170` 相同，Pages 更新没有重复引入文件变化。

## 数据库维护方式

`self` 使用 Gitea 现有的 `version` 表、`modelmigration/migrations.go` 和迁移执行流程。每次数据库变化都在列表末尾分配下一个连续编号。已经进入 `self` 的迁移文件表示可能已经执行过的数据库历史，因此它的结构保持稳定；来源 PR 后续把新表追加到旧迁移时，`self` 把这部分增量放入新的 `patchN`，让低版本数据库和已经运行 `self` 的数据库都能沿同一序列到达最新结构。

本轮 PR #38337 把 `codespace_manager_registration_token` 表追加到来源迁移 365。`self` 保留已发布的 Codespace 365 和 Pages 366，把新表独立注册为迁移 367。这样业务实现与上游 PR 一致，`self` 相对来源功能代码的维护差异集中在数据库迁移位置及其直接测试。

**实现验收点**

- `pr-38337-v365-patch1.go` 与本轮开始时 `self@157dca8bb2` 中的文件内容一致。
- 注册令牌表只由 `pr-38337-v367-patch2.go` 创建，迁移 367 可以重复执行。
- 迁移 367 验证列结构、令牌唯一索引和用户索引，重复令牌插入会得到数据库错误。
- 除 `modelmigration` 及其直接测试外，本轮 Codespace 与 Pages 业务代码均来自两个固定 PR 头。

## 文档入口

- [数据库版本与升级范围](database-versioning.md)解释迁移编号、数据库版本和可接受来源。
- [迁移映射](migration-map.md)记录来源变化到 `self` 编号的对应关系。
- [Git 历史结构](git-history.md)说明双父合并和迁移记录提交的职责。
- [上游同步流程](upstream-sync.md)给出以后接收上游、PR 和旧迁移增量的步骤。
- [冲突解决记录](conflict-resolutions.md)解释初次组合冲突和本轮迁移拆分理由。
- [验证记录](verification.md)列出执行过的检查、完整集成测试结果和环境限制。
- `patches/` 为每一项 `self` 迁移保存来源、结构、升级行为和验证入口。

**实现验收点**

- 维护者可以从本页定位每个来源提交、合并提交、迁移编号和详细说明。
- 三个当前迁移都在 `migration-map.md` 和对应的 `patches/` 文档中有记录。
- 验证文档中的提交、数据库版本和测试结果与当前 `self` 一致。
