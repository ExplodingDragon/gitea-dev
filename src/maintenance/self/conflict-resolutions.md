# 冲突解决记录

Pages PR #40071 合并到已经包含 Codespace PR #38337 的 `self` 时产生五个文本冲突。两项功能修改的是相邻的路由、生命周期和测试位置，冲突来自共同插入点，而不是业务目标互斥。合并提交 `5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51` 保存了本次解决结果。

## 冲突总表

| 文件 | Codespace 行为 | Pages 行为 | 合并结果 |
| --- | --- | --- | --- |
| `modelmigration/migrations.go` | 注册 Codespace 365 | 注册 Pages 365 | Codespace 365，Pages 366 |
| `routers/api/v1/api.go` | 比较接口支持 Codespace 令牌鉴权 | 在同一仓库路由组注册 Pages 接口 | 保留 Pages 接口，比较接口继续使用 Codespace 鉴权链 |
| `services/org/org.go` | 复用组织删除前置检查 | 组织变私有时同步禁用 Pages | 保留前置检查，并传递 Pages 状态时间 |
| `services/repository/delete.go` | 仓库级串行锁和 Codespace 解绑 | Pages 生命周期锁、删除状态和内容清理 | 按既有锁顺序执行两项清理，共享删除事务 |
| `tests/integration/api_admin_test.go` | 新增 1 个 Codespace 定时任务 | 新增 3 个 Pages 定时任务 | 总数从上游 30 调整为 34，并请求 50 条以覆盖全部结果 |

Pages 原文件 `modelmigration/v29/v365.go` 因 Codespace 文件已在前一提交改名而作为新文件加入，没有形成文本冲突。合并完成后，该文件再由独立提交改名为 `pr-40071-v366-patch1.go`。

## 数据库迁移顺序

两个来源都在各自分支占用迁移 365。`self` 选择 Codespace 365、Pages 366，是因为 Codespace PR 数据库版本 366 可以自然继续执行 Pages 366，也让迁移列表保持连续。最终数据库版本是 367。

这一决定只改变 Pages 在 `self` 中的执行位置，`AddCodespaceTables` 和 `AddPagesTables` 的迁移函数内容都保持来源实现。详细对应关系见[迁移映射](migration-map.md)。

## API 路由组合

Pages 在 `/{username}/{reponame}` 下增加部署、内容上传和版本管理路由。Codespace 为同一组中的比较接口增加 `codespaceTokenRepositoryRoute`，让 Codespace 令牌通过专用仓库上下文进入原有代码读取权限检查。

合并结果先注册全部 Pages 路由，再注册带 Codespace 令牌处理的比较接口。两类路径不同，注册顺序不会相互覆盖；比较接口保留 Codespace 鉴权链，普通访问令牌仍通过原有 `reqRepoReader(unit.TypeCode)` 检查。

## 组织生命周期组合

Codespace 把组织删除的仓库和软件包检查提取为 `checkDeleteOrganizationPreconditions`，并在清理仓库前及删除事务内再次检查。Pages 为 `updateRepoForVisibilityChanged` 增加 `pagesUpdated`，在组织变为私有时与仓库可见性事务一起关闭公开 Pages 站点。

合并结果保留可复用的删除前置检查，并采用 Pages 的四参数可见性更新函数。递归更新派生仓库时继续传递同一个 Pages 状态时间，使一轮组织可见性变更在 Pages 实例看来具有一致顺序。

## 仓库删除组合

Codespace 使用 `WorkingLockKey(repoID)` 的仓库级全局锁串行化仓库删除，并在删除仓库行之前解绑 Codespace 密钥、实例和授权关系。Pages 使用生命周期锁取得单调状态时间，在同一数据库事务中把 Pages 站点标为已删除并收集待清理成品，提交后再删除对象存储内容和释放域名。

合并后的调用顺序为：

1. 取得仓库级全局锁；
2. 取得 Pages 生命周期锁和状态时间；
3. 开启仓库删除事务；
4. 解绑 Codespace 关系；
5. 标记 Pages 删除状态并收集摘要；
6. 删除仓库及其他关联数据并提交；
7. 释放 Pages 生命周期锁；
8. 清理文件、Pages 成品和域名；
9. 返回后释放仓库级全局锁。

该锁顺序与仓库转移流程已经采用的“仓库级锁后取得 Pages 生命周期锁”一致，避免同一仓库的删除、转移和 Codespace 清理并发修改。两项数据库清理都在删除仓库行前完成，任一步失败都会让事务回滚；外部存储仍在事务成功后处理，保持原有仓库删除语义。

## 定时任务数量

上游测试环境有 30 个定时任务。Codespace 注册 `reconcile_codespaces`，Pages 注册 `update_pages_branch_sources`、`verify_pages_domains` 和 `cleanup_pages`，合并后总数为 34。

Codespace 分支为了读取全部 31 项把 API 请求改为 `?limit=50`；Pages 分支只检查总数 33，默认响应页仍为 30。合并结果保留 `limit=50`，并同时断言响应头总数和响应数组长度都是 34，验证四个新增任务确实完成注册。

## 实现验收点

- 合并提交中的人工冲突文件只有本页列出的五个。
- Pages 仓库路由与 Codespace 比较接口鉴权均可从最终路由表访问。
- 组织变私有会在同一事务顺序中更新仓库可见性和 Pages 状态。
- 仓库删除同时完成 Codespace 解绑和 Pages 删除状态提交，外部内容在事务后清理。
- 仓库删除与仓库转移采用相同的仓库级锁、Pages 生命周期锁顺序。
- 管理 API 定时任务测试以 50 为分页上限，并断言总数和返回数量均为 34。
