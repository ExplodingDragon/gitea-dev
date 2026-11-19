# 合并结果与数据库差异审计

## 本轮固定基准

2026-11-19 从 `self@8d65b612a28b71a2fef99c5534a19ec2344bd783` 合并 Codespace PR `09670abbdecdd30f42a13e1e20b1dd2a625cc527`。Pages 保持 `5000d55fb2`，PR 已包含的官方主线保持 `23836eb610`。本轮没有额外更新主线。

先由 Git 生成正常合并树，再把 self 数据库增量与它比较。这样“只有数据库差异”有精确的可复现基准：它是已有 self（包含 Pages）与本轮 Codespace 的正常业务组合，不是单独 Codespace PR 的树。

```bash
git merge-tree --write-tree \
  8d65b612a28b71a2fef99c5534a19ec2344bd783 \
  09670abbdecdd30f42a13e1e20b1dd2a625cc527
```

本轮返回树 `b1f1d5f8656885ec7445e857dff1a43e74972326`，无文本冲突。

**实现验收点**

- 双父合并 `e152d93af21700a53df53c05924c0a607afff450` 的两个父提交与上述输入一致。
- 正常合并树可以从固定输入重新生成。
- PR 的业务实现、配置、生成文件及业务测试均采用该树内容。

## 自动合并中需要识别的数据库变化

Git 将 PR 新完整 `v370.go` 的修改自动跟随重命名应用到 self 的历史 `pr-38337-v365-patch1.go`。文本合并虽成功，但若直接接受，已部署 self 不会重新执行迁移 365，新结构变化就会遗漏。

因此合并提交保留 patch1 的已发布内容，并移除新导入、只针对 PR 新完整结构的 `v370_test.go`。self 通过后续 patch4 和完整升级测试验证最终结构，历史 patch1—patch3 的含义保持稳定。官方 `v365`—`v369` 及测试完全不变。

**实现验收点**

- 合并提交相对更新前 self 的 `modelmigration/` 没有变化。
- patch4 单独追加为 374，数据库普通提交只修改迁移目录。
- patch4 测试覆盖 PR 新结构和 self 真实升级，官方文件仍与固定主线逐字相同。

## 最终差异检查

```bash
git diff --exit-code \
  b1f1d5f8656885ec7445e857dff1a43e74972326 098facfe362119127e54aed8faddd0c3caa40914 \
  -- . ':!modelmigration'
git diff --name-status \
  b1f1d5f8656885ec7445e857dff1a43e74972326 098facfe362119127e54aed8faddd0c3caa40914
git diff --exit-code 8d65b612a28b71a2fef99c5534a19ec2344bd783 \
  098facfe362119127e54aed8faddd0c3caa40914 -- modelmigration/v29/pr-38337-v365-patch1.go \
  modelmigration/v29/pr-38337-v365-patch2.go \
  modelmigration/v29/pr-38337-v365-patch3.go \
  modelmigration/v29/pr-38337-v365-patch3_test.go \
  modelmigration/v29/pr-40071-v365-patch1.go
git diff --exit-code 23836eb610b6673dc4ef7001d432e48dd3af1537 \
  098facfe362119127e54aed8faddd0c3caa40914 -- 'modelmigration/v29/v36*.go'
```

首项比较覆盖整个非迁移目录，没有额外排除业务文件。完整差异只包括保留历史 patch1、替换 PR 完整迁移测试、增加 patch4、注册版本和 self 升级测试。外层文档维护不属于内层 Gitea 业务差异。

**实现验收点**

- 非迁移比较输出为空、退出码为 0。
- 完整文件清单全部位于 `modelmigration/`。
- 已发布 PR 文件和官方文件比较输出均为空。
- 旧轮次人工合并记录仍可在 Git 文档历史中追溯，当前说明只描述本轮实际变化。
