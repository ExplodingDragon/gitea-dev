本变更为 Gitea 增加仓库 Pages，并由独立部署的 [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) 服务提供网站。Gitea 管理仓库设置、内容版本、自定义域名、已登记实例和部署结果。每个 Pages 实例同步当前站点状态；Gitea 暂时不可用时，实例继续提供最后一次确认的部署。

## 行为

- 每个仓库的 Pages 默认关闭。内容可以来自分支目录或 Gitea Actions 成品；无论选择哪一种来源，都可以通过网页或 API 上传 TAR.GZ。每个成品成为当前版本前都会经过同一套有资源上限的归档检查。
- 项目站点使用 `https://<所有者>.<Pages 域名>/<仓库>/`；名称为 `.pages` 的仓库提供 `https://<所有者>.<Pages 域名>/` 所有者主页。
- 版本按摘要复用，支持分页、恢复、删除和可配置的保留数量。由 Actions 创建的版本会在对应运行仍存在时链接到该运行；清理运行不会删除版本或已经发布的网站。
- 自定义域名使用 TXT 所有权校验，每个 Pages 实例独立上报路由结果。Pages 服务可以直接提供 HTTP、在终止 TLS 的前置代理后运行，或通过 [lego](https://github.com/go-acme/lego) 自行管理 HTTPS。
- Pages 网站为公开网站，包括从私有仓库生成的网站。公开仓库转为私有仓库时，Gitea 会关闭站点，仓库管理员明确重新启用后才恢复发布。

## 截图

![仓库 Pages 设置](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png?v=20261031)
![Pages 版本历史与部署结果](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png?v=20261031)
![Gitea Actions 中的 Pages 发布工作流](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png?v=20261031)
![Pages 实例管理](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png?v=20261031)

相关内容：https://github.com/go-gitea/gitea/issues/302、https://github.com/go-gitea/gitea/issues/23521、https://github.com/go-gitea/gitea/issues/28907
