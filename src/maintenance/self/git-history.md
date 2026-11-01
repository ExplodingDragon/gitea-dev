# Git 历史结构

## 当前提交关系

`self` 从固定的上游基线建立，然后依次合并两个 PR，并在每次相关合并后记录数据库迁移安排：

```text
d3021b69ee  upstream/main 基线
    |\
    | 1c0f24e4fd  PR #38337 头提交
    |/
6702aa22fe  合并 Codespace PR #38337
    |
ac46f7081c  记录 Codespace 为 self 迁移 365
    |\
    | 534024baa2  PR #40071 头提交
    |/
5ccb5d3a0d  合并 Pages PR #40071，并保留双方业务行为
    |
2fd1c04de5  映射 Pages 为 self 迁移 366
    |\
    | abd341fa30  PR #38337 最新头，包含 cce5f01a94 和上游 1f51d2c318
    |/
2117f129ac  合并最新 Codespace PR #38337
    |\
    | ca49ed1a84  PR #40071 最新头，包含上游 1f51d2c318
    |/
157dca8bb2  合并最新 Pages PR #40071
```

合并提交保留两个父提交，所以 `git log --graph` 可以同时展示 `self` 主线和 PR 原始历史。数据库记录使用普通单父提交，使 `git show` 可以单独回答“为了 `self` 版本序列改了什么”。这种结构把功能实现、冲突处理和迁移编号分成可以独立复核的记录。

两个最新 PR 头都包含上游 `1f51d2c318`。Codespace 更新合并由 `2117f129ac` 一次带入该上游提交和 Codespace 新功能；Pages 最新头中的文件内容此时已经全部存在，所以 `157dca8bb2` 的文件树与第一父提交相同。这个双父提交仍有实际维护价值：它明确证明 `ca49ed1a84` 已被审阅和接入，后续 Git 合并也能从该提交继续计算共同祖先。

## 当前提交职责

| 提交 | 类型 | 职责 |
| --- | --- | --- |
| `6702aa22fe138d83d558fcee06a95cd9cace34ad` | 双父合并 | 完整接入 Codespace PR #38337 |
| `ac46f7081c42833c9fd52341fe1772b591ffd4ed` | 数据库记录 | 将 Codespace 迁移文件命名为 `pr-38337-v365-patch1.go`，内容不变 |
| `5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51` | 双父合并 | 完整接入 Pages PR #40071，并解决与 Codespace 的五处重叠 |
| `2fd1c04de531f300dc4b30711fcf05ec8c30be81` | 数据库记录 | 将 Pages 迁移文件命名为 `pr-40071-v366-patch1.go` |
| `2117f129acfb41ad2943941899729a3a6022a961` | 双父合并 | 接入 Codespace PR #38337 的最新头 `abd341fa30`，包括仓库所有者筛选和上游 WebKit 测试更新 |
| `157dca8bb2ed416e2277953f03fe6b10cecd6cd0` | 双父合并 | 记录 Pages PR #40071 的最新头 `ca49ed1a84` 已接入，文件树保持不变 |

Pages 的迁移注册在合并冲突解决时直接排到 366，因为同一个合并结果必须具有唯一且可编译的迁移序列；随后独立提交只完成来源化文件命名。两个数据库记录提交均被 Git 识别为 100% 重命名，迁移函数内容保持来源 PR 的实现。

## 后续历史组织

更新来源 PR 或同步上游时，以合并提交连接新历史。若来源 PR 增加提交，下一次合并只引入上次来源头之后的新增历史；若来源 PR 已经合并本轮目标上游提交，该 PR 合并就是上游提交进入 `self` 的可追溯路径。每个来源提交只需沿最能说明来源的路径进入一次，历史关系因此保持清晰。

数据库编号发生变化时使用独立普通提交。提交说明同时写明来源 PR、原始编号、`self` 编号和调整原因。业务冲突在对应合并提交中解决，数据库文件命名和编号调整在紧随其后的数据库记录提交中完成。若来源更新没有迁移差异，保留现有迁移和映射即可；本轮两个 PR 都属于这种情况。维护者因此可以分别审阅来源业务、冲突组合和版本映射，也能从提交数量判断数据库是否真的变化。

以下检查用于确认历史关系：

```text
git merge-base --is-ancestor 1c0f24e4fd7755b47a22e3cb89c3fc366b5901ab self
git merge-base --is-ancestor 534024baa21f974027c86d0b3b1a5a01b89d85be self
git merge-base --is-ancestor abd341fa30284bdd17ac82c317fa6a2ec479c795 self
git merge-base --is-ancestor ca49ed1a84320a98055084b06c7b43571a4205e8 self
git rev-list --parents -n 1 6702aa22fe138d83d558fcee06a95cd9cace34ad
git rev-list --parents -n 1 5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51
git rev-list --parents -n 1 2117f129acfb41ad2943941899729a3a6022a961
git rev-list --parents -n 1 157dca8bb2ed416e2277953f03fe6b10cecd6cd0
```

## 实现验收点

- 四个 `merge-base --is-ancestor` 检查均成功。
- `6702aa22fe` 的两个父提交是 `d3021b69ee` 和 `1c0f24e4fd`。
- `5ccb5d3a0d` 的两个父提交是 `ac46f7081c` 和 `534024baa2`。
- `2117f129ac` 的两个父提交是 `2fd1c04de5` 和 `abd341fa30`。
- `157dca8bb2` 的两个父提交是 `2117f129ac` 和 `ca49ed1a84`，其文件树与 `2117f129ac` 相同。
- 两个 PR 的作者、提交哈希和内部提交顺序可从 `self` 直接查看。
- 数据库记录提交与合并提交分开；本轮来源迁移未变化，因此没有新增数据库记录提交。
