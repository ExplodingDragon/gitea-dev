本变更为 Gitea 增加仓库 Pages，并由独立部署的 [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) 服务提供网站。Gitea 管理发布设置、内容版本、域名所有权、已登记实例和部署结果；Pages 服务同步和提供当前版本，可直接提供 HTTP、HTTPS，也可作为前置代理的 HTTP 源站。Gitea 暂时不可用时，实例继续提供最后一次确认的部署。

## 行为

- 内容可以来自分支目录、Gitea Actions 成品或网页/API 上传的 TAR.GZ。每种来源成为当前版本前都会经过同一套有资源上限的归档检查。
- 项目站点使用 `https://<所有者>.<Pages 域名>/<仓库>/`；名称为 `.pages` 的仓库提供 `https://<所有者>.<Pages 域名>/` 所有者主页。
- 版本按摘要复用，支持分页、恢复、删除和可配置的保留数量。Actions 提交会显示在工作流运行摘要中。
- 自定义域名使用 TXT 所有权校验，每个 Pages 实例独立上报路由结果。直接提供 HTTPS 的实例使用可配置的 lego DNS 服务商处理默认域名，并使用 HTTP-01 处理自定义域名。
- Pages 网站为公开网站，包括从私有仓库生成的网站。公开仓库转为私有仓库时，Gitea 会关闭站点，仓库管理员明确重新启用后才恢复发布。

## 截图

![仓库 Pages 设置](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages 版本历史](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![通过 Gitea Actions 发布 Pages](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages 实例管理](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

相关内容：https://github.com/go-gitea/gitea/issues/302、https://github.com/go-gitea/gitea/issues/23521、https://github.com/go-gitea/gitea/issues/28907
