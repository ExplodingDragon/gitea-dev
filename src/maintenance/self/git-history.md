# Git 历史结构

## 当前提交关系

`self` 通过双父合并连接 PR 原始历史，通过普通单父提交记录自身数据库迁移安排：

```text
d3021b69ee  upstream/main 初始基线
    |\
    | 1c0f24e4fd  PR #38337 初始头
    |/
6702aa22fe  合并 Codespace
    |
ac46f7081c  固定 Codespace 迁移 365 patch1
    |\
    | 534024baa2  PR #40071 初始头
    |/
5ccb5d3a0d  合并 Pages 和双方业务行为
    |
2fd1c04de5  映射 Pages 为迁移 366 patch1
    |\
    | abd341fa30  PR #38337 上一轮头
    |/
2117f129ac  合并上一轮 Codespace 更新
    |\
    | ca49ed1a84  PR #40071 上一轮头
    |/
157dca8bb2  合并上一轮 Pages 更新
    |\
    | 18086bdaa7  PR #38337 当前头，含 3fc98fc1c0 和 upstream/main@4d00ed2a1e
    |/
74ef7df9ba  合并当前 Codespace 更新
    |
d552c30170  将注册令牌表安排为迁移 367 patch2
    |\
    | d362d8afbb  PR #40071 当前头，含 upstream/main@4d00ed2a1e
    |/
0a47af0f52  合并当前 Pages 更新，文件树保持不变
```

这种结构让 `git log --graph` 同时展示 `self` 主线、两个 PR 和上游历史。迁移提交位于对应功能合并之后，使审阅者可以分别查看上游业务实现与 `self` 数据库版本安排。

**实现验收点**

- 图中的每个提交都可以由 `git rev-parse` 解析。
- 两个当前更新合并各有两个父提交，迁移提交 `d552c30170` 只有一个父提交。
- `git log --graph self` 可以从当前头追溯到两个 PR 的原始作者和提交顺序。

## 当前提交职责

| 提交 | 类型 | 职责 |
| --- | --- | --- |
| `6702aa22fe138d83d558fcee06a95cd9cace34ad` | 双父合并 | 初次接入 Codespace PR #38337 |
| `ac46f7081c42833c9fd52341fe1772b591ffd4ed` | 迁移记录 | 固定 Codespace 365 的来源化文件名 |
| `5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51` | 双父合并 | 初次接入 Pages PR #40071 并组合双方行为 |
| `2fd1c04de531f300dc4b30711fcf05ec8c30be81` | 迁移记录 | 将 Pages 来源迁移映射为 `self` 迁移 366 |
| `2117f129acfb41ad2943941899729a3a6022a961` | 双父合并 | 接入 PR #38337 上一轮头 `abd341fa30` |
| `157dca8bb2ed416e2277953f03fe6b10cecd6cd0` | 双父合并 | 接入 PR #40071 上一轮头 `ca49ed1a84` |
| `74ef7df9ba4892c35ce5ec15dcfe1ffbd21e7e59` | 双父合并 | 接入 PR #38337 当前头 `18086bdaa7` 及当前上游 |
| `d552c301702c721fd6a30c730b6e4a9844bfb049` | 迁移记录 | 恢复已发布的 Codespace 365，并新增注册令牌迁移 367 与直接测试 |
| `0a47af0f52a34516290caf54516f0a52a7e1743a` | 双父合并 | 接入 PR #40071 当前头 `d362d8afbb`，树与第一父相同 |

`74ef7df9ba` 相对第一父修改 82 个文件，包含 1339 行新增和 1300 行删除。`d552c30170` 只修改四个迁移相关文件。`0a47af0f52` 不产生文件差异，它的价值是固定 Pages 最新同步位置和下一轮共同祖先。

**实现验收点**

- `git diff --shortstat 157dca8bb2 74ef7df9ba` 显示 82 个文件、1339 行新增、1300 行删除。
- `git show --stat d552c30170` 只列出迁移列表、Codespace patch1、patch2 和 patch2 测试。
- `git rev-parse d552c30170^{tree}` 与 `git rev-parse 0a47af0f52^{tree}` 返回同一树对象 `2b531a3fe2c3ee4254f08e7982e2ecd7ba41e74c`。

## 后续历史组织

来源 PR 或上游增加提交时，下一轮继续以双父合并连接新头。PR 头已经包含目标上游提交时，由该 PR 合并同时带入上游；另一个只补齐相同上游历史的 PR 仍以树不变的双父提交记录。这样每个来源提交保持原哈希，维护者也能精确回答同步到了哪个 PR 头。

数据库变化使用紧随功能合并的普通提交。来源对尚未执行的新迁移增加内容时，可以按 `self` 末尾连续改号；来源对已经进入 `self` 的旧迁移增加内容时，现有 patch 保持原树结构，增量进入新的 `patchN`。这使 Git 历史同时表达代码来源和实际升级顺序。

**实现验收点**

- 新来源头通过合并父提交可追溯，来源提交哈希保持不变。
- 新数据库提交只包含迁移列表、迁移实现和直接对应测试。
- 已进入 `self` 的迁移文件可以与其记录提交或上一已发布头逐字节比较。

## 历史关系检查

```text
git merge-base --is-ancestor 4d00ed2a1e2f4d32b66a71c3eecabc6d6703f6c0 self
git merge-base --is-ancestor 18086bdaa7bcb226306e3713647e7ff6e3dac30d self
git merge-base --is-ancestor d362d8afbb4f5184f01cb0e33b316f5eeea9810e self
git rev-list --parents -n 1 74ef7df9ba4892c35ce5ec15dcfe1ffbd21e7e59
git rev-list --parents -n 1 0a47af0f52a34516290caf54516f0a52a7e1743a
```

**实现验收点**

- 三个 `merge-base --is-ancestor` 检查均成功退出。
- `74ef7df9ba` 的父提交为 `157dca8bb2` 和 `18086bdaa7`。
- `0a47af0f52` 的父提交为 `d552c30170` 和 `d362d8afbb`。
