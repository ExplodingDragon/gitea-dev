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
```

合并提交保留两个父提交，所以 `git log --graph` 可以同时展示 `self` 主线和 PR 原始历史。数据库记录使用普通单父提交，使 `git show` 可以单独回答“为了 `self` 版本序列改了什么”。这种结构避免把功能实现、冲突处理和迁移编号混在一个无法区分的改写提交中。

## 当前提交职责

| 提交 | 类型 | 职责 |
| --- | --- | --- |
| `6702aa22fe138d83d558fcee06a95cd9cace34ad` | 双父合并 | 完整接入 Codespace PR #38337 |
| `ac46f7081c42833c9fd52341fe1772b591ffd4ed` | 数据库记录 | 将 Codespace 迁移文件命名为 `pr-38337-v365-patch1.go`，内容不变 |
| `5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51` | 双父合并 | 完整接入 Pages PR #40071，并解决与 Codespace 的五处重叠 |
| `2fd1c04de531f300dc4b30711fcf05ec8c30be81` | 数据库记录 | 将 Pages 迁移文件命名为 `pr-40071-v366-patch1.go` |

Pages 的迁移注册在合并冲突解决时直接排到 366，因为同一个合并结果必须具有唯一且可编译的迁移序列；随后独立提交只完成来源化文件命名。两个数据库记录提交均被 Git 识别为 100% 重命名，迁移函数内容保持来源 PR 的实现。

## 后续历史组织

更新来源 PR 或同步上游时，以合并提交连接新历史。若来源 PR 增加提交，下一次合并只引入上次来源头之后的新增历史；若上游接收了相关功能，合并关系仍让 Git 利用共同祖先识别已经拥有的提交。

数据库编号调整继续使用独立普通提交。提交说明同时写明来源 PR、原始编号、`self` 编号和调整原因。业务冲突在对应合并提交中解决，数据库文件命名和编号调整在紧随其后的数据库记录提交中完成。维护者因此可以分别审阅来源业务、冲突组合和版本映射。

以下检查用于确认历史关系：

```text
git merge-base --is-ancestor 1c0f24e4fd7755b47a22e3cb89c3fc366b5901ab self
git merge-base --is-ancestor 534024baa21f974027c86d0b3b1a5a01b89d85be self
git rev-list --parents -n 1 6702aa22fe138d83d558fcee06a95cd9cace34ad
git rev-list --parents -n 1 5ccb5d3a0d01dcf96849c7a2eb418140b5bc4f51
```

## 实现验收点

- 两个 `merge-base --is-ancestor` 检查均成功。
- `6702aa22fe` 的两个父提交是 `d3021b69ee` 和 `1c0f24e4fd`。
- `5ccb5d3a0d` 的两个父提交是 `ac46f7081c` 和 `534024baa2`。
- 两个 PR 的作者、提交哈希和内部提交顺序可从 `self` 直接查看。
- 数据库记录提交与合并提交分开，单独查看时只显示迁移命名或编号安排。
