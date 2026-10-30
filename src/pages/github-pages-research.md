# GitHub Pages 调研与功能评估

本章从 GitHub Pages 的公开产品能力中提取站点地址、发布来源、域名和状态展示规则，并说明它们在 Gitea Pages 中的对应设计。最终行为由各专题章节完整定义。

## 站点归属和默认地址

GitHub Pages 区分用户/组织主页和项目站点，项目站点使用仓库路径。[GitHub Pages 概述](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Gitea 采用固定 `.pages` 仓库提供所有者主页，普通仓库提供项目路径：

```text
<owner>.<pages-instance>/       # <owner>/.pages
<owner>.<pages-instance>/<repo>/
```

每个仓库最多一个站点，默认关闭；用户和组织使用相同规则。外部地址使用当前名称，内部使用 `repo_id`，因此改名和转移能自然更新地址而不复制内容。固定仓库名适用于多个 Pages 实例，不需要为每台实例保存主页选择。

### 实现验收点

- `.pages` 自动成为所有者主页，普通仓库自动成为项目站点。
- 多个实例可以使用不同根地址，同一仓库用途保持一致。
- 站点默认关闭，改名和转移更新外部地址但保持仓库 ID 和自定义域名。

## 发布来源

GitHub 支持分支目录和 Actions 构建产物。[发布来源配置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)、[自定义 Actions 工作流](https://docs.github.com/en/pages/using-custom-workflows-with-github-actions)

Gitea 保留 GitHub 的两种自动发布方式，并增加随时可用的网页/API 上传。三种版本产生方式统一生成 TAR.GZ：

| 来源 | 采用方式 | 原因 |
| --- | --- | --- |
| 分支目录 | 固定提交 SHA，读取根目录或指定目录生成 TAR.GZ。 | 无需工作流，固定提交保证一次读取一致。 |
| Actions 成品 | 同仓库工作流上传 Artifact，部署步骤把同一运行成品交给 Gitea。 | 复用现有 Artifact、OIDC 和 `pages: write` 边界。 |
| 网页/API | 同步上传完整 TAR.GZ。 | 支持外部构建系统和人工发布。 |

Actions 的构建命令由工作流完成，Gitea 只接收静态成品；这样构建工具与 Pages 发布链路保持分离。Action 兼容性必须在真实 Gitea URL、Runner 和版本组合上验证。[上传 Pages 产物](https://github.com/actions/upload-pages-artifact)、[部署 Pages](https://github.com/actions/deploy-pages) 仅作为协议参考。

设置页只在“Actions 或上传”和“分支目录”之间选择自动发布方式。网页/API 上传放在版本管理页，因为它表示管理员明确选择一个新版本，不需要先切换或覆盖自动来源；分支模式下上传后，只有分支出现新提交才会再次自动产生版本。

### 实现验收点

- 分支、Actions 和网页/API 上传都进入同一 TAR.GZ 检查、存储和主动部署链路。
- 自动发布方式只有 `artifact` 与 `branch`；手动上传不会改变自动发布方式及分支处理进度。
- 分支来源固定提交并由周期检查补偿未及时处理的变化。
- Actions 成功表示成品已准备，实例发布结果单独展示。
- 工作流负责构建并提供静态成品，Pages 从已生成的静态成品开始检查、保存和发布。

## 自定义域名与 HTTP/HTTPS

GitHub Pages 支持自定义域名、HTTPS 和证书自动维护。Gitea 将管理责任拆分：Gitea 定期检查用户域名 TXT 所有权，Pages 侧执行 ACME 和真实入口检查；用户自定义域名采用 HTTP-01，Pages 默认域名可采用 DNS-01。[GitHub 自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)、[HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)

Gitea 多实例允许同一域名分别在实例上成功或失败，仓库页面展示实例结果。自定义域名从根路径提供一个站点，默认地址仍使用所有者和仓库路径。

### 实现验收点

- 自定义域名只绑定一个仓库并经过 TXT 所有权条件。
- 证书材料和 ACME 请求留在 Pages，不进入 Gitea 数据库。
- HTTP-01 预检查失败时不消耗 CA 验证请求，地址结果按实例分别展示。

## 仓库可见性与公开访问

GitHub Pages 的网站访问和源码仓库权限可以分开。Gitea Pages 网站使用公开访问方式：私有源码可以明确发布公开网站，公开仓库转为私有仓库时站点关闭，重新启用需要再次确认。

### 实现验收点

- 管理页面明确显示源码可见性与网站公开性是两个事实。
- 网站请求不读取 Gitea 会话或仓库权限。
- 私有源码仓库经过明确确认后可以发布公开网站，仓库可见性变化会关闭站点。

## 部署状态与规模参考

GitHub 的部署结果通常表示一次成品是否成功。Gitea Pages 分开记录成品准备、内容安装、配置应用和地址发布，因为独立实例可能离线或只有某个自定义域名失败。所有实例主动部署全部站点，使用稳定时间分页、有界并发和持久当前事实处理大规模站点。

### 实现验收点

- 成品准备成功不会直接显示为网站发布成功。
- 单个实例或单个地址失败不会阻塞其他实例。
- 大量站点使用分页、并发和周期恢复，不依赖访客请求触发部署。
