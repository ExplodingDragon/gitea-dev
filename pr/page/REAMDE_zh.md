本变更为 Gitea 增加原生的仓库 Pages 支持。仓库管理员可以从分支目录、Gitea Actions 成品或上传的 TAR.GZ 发布带版本记录的静态网站，并在 Gitea 中管理发布来源、版本历史、自定义域名和各个 Pages 实例的部署结果。

Gitea 负责权限、发布设置、不可变内容版本、成品存储、域名所有权校验、仓库生命周期变化和部署状态。独立部署的 [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) 服务会主动同步所有已启用站点，检查并展开当前成品，提供已经确认的本地内容，管理证书，并把部署结果上报给 Gitea。每个已登记实例都独立部署全部站点，因此 Gitea 暂时不可用时，已经生效的网站仍可继续访问。

## 截图

![仓库 Pages 设置](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages 版本历史](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![通过 Gitea Actions 发布 Pages](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages 实例管理](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

## 主要功能

- 项目站点使用与 GitHub Pages 一致的 `https://<所有者>.<Pages 域名>/<仓库>/` 地址；名称为 `.pages` 的仓库提供 `https://<所有者>.<Pages 域名>/` 所有者主页。
- 支持分支目录和 Actions 两种自动发布来源；无论选择哪种来源，都可以在版本管理页通过网页或 API 上传 TAR.GZ。
- 内容版本按摘要复用，支持稳定分页、恢复、删除和可配置的保留数量，并明确区分成品准备完成与实例部署成功。
- 提供兼容 Pages 成品发布流程的 Gitea Actions 部署接口；工作流运行成功提交成品后，其运行摘要会显示 Pages 项。
- 支持自定义域名 TXT 所有权校验、各实例独立发布状态、运维提供的证书，以及基于 `go-acme/lego` 的 ACME 自动签发。
- 仓库设置中提供站点设置和版本历史；站点管理后台提供 Pages 实例登记和最近通信状态。

Pages 网站均为公开网站，包括从私有仓库发布的网站。公开仓库转为私有仓库时，Gitea 会关闭原有站点，由仓库管理员再次明确启用公开网站。

独立服务支持直接提供 HTTP/HTTPS、生成并启用 Nginx 配置，也可以通过 `Publisher` 接口将 `gitea.dev/page` Go 包嵌入其他服务。服务使用单成员内嵌 etcd 保存本地状态，并在内容进入请求路径前主动完成部署。Pages 进程不可用时，Nginx 可以继续提供上一次确认成功的内容。

所有发布来源都进入同一套有资源上限的 TAR.GZ 检查流程。Gitea 和 Pages 服务会拒绝危险的归档条目类型、绝对路径、越界路径、超限内容、过多条目和不安全的符号链接。相对符号链接最终仍位于当前站点内时可以使用，目标文件暂时不存在也可以接受；展开时会移除普通文件的可执行权限。候选内容部署失败时，已经确认的网站继续生效。

## 验证

- Gitea：`make fmt`、`make lint`、`make test-backend`、`make test-frontend`、`make test-migration` 和 `make test-e2e`。
- Pages 集成测试：`TestAdminPagesInstances`、`TestAPIPagesVersions`、`TestPagesActionsDeploymentAPI` 和 `TestActionsRoute`。
- gitea-pages：`make format`、`make tidy`、`make check`、`go test -race ./...` 和 `golangci-lint run ./...`。

相关提案：https://github.com/go-gitea/gitea/issues/302

相关讨论：https://github.com/go-gitea/gitea/issues/23521

相关提案：https://github.com/go-gitea/gitea/issues/28907

Assisted-by: Codex GPT-6；所有生成的代码均经过人工审阅。
