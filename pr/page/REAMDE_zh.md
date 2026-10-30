本变更为 Gitea 增加原生的仓库 Pages 支持。仓库管理员可以从分支目录、Gitea Actions 成品或上传的 TAR.GZ 发布静态网站，并在仓库设置中管理发布来源、内容版本、自定义域名和部署状态。

Gitea 保存发布设置和不可变的内容版本，校验自定义域名所有权，并记录每个已登记实例上报的部署结果。独立部署的 [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) 服务下载当前版本、完成发布、管理 HTTPS，并把结果上报给 Gitea。Gitea 暂时不可用时，已经生效的网站仍可继续访问。

## 截图

![仓库 Pages 设置](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages 版本历史](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![通过 Gitea Actions 发布 Pages](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages 实例管理](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

## 行为

- 项目站点使用 `https://<所有者>.<Pages 域名>/<仓库>/`；名称为 `.pages` 的仓库提供 `https://<所有者>.<Pages 域名>/` 所有者主页。
- 内容版本按摘要复用，支持分页、恢复、删除和可配置的保留数量。
- Gitea Actions 可以提交 Pages 成品，并在工作流运行摘要中显示提交事实。配置任一自动来源时，网页和 API 都可以上传 TAR.GZ。
- 自定义域名使用 TXT 所有权校验，证书签发和网站入口由各 Pages 实例负责。
- Pages 网站为公开网站，包括从私有仓库生成的网站。公开仓库转为私有仓库时，Gitea 会关闭站点，仓库管理员明确重新启用后才恢复发布。

所有来源在成为当前版本前使用同一套有资源上限的 TAR.GZ 检查。越界路径、危险归档条目、资源超限和逃逸站点目录的符号链接会被拒绝；检查失败的版本不会替换当前网站。

## 验证

- Gitea：`make checks`、`make lint`、`make build`、`make test-backend`、`make test-frontend`、`make test-migration` 和 `make test-e2e`。
- gitea-pages：`make format`、`make tidy`、`make check`、`go test -race ./...` 和 `golangci-lint run ./...`。

相关提案：https://github.com/go-gitea/gitea/issues/302

相关讨论：https://github.com/go-gitea/gitea/issues/23521

相关提案：https://github.com/go-gitea/gitea/issues/28907

Assisted-by: Codex GPT-6；所有生成的代码均经过人工审阅。
