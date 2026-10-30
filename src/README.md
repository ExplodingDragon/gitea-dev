# Gitea 设计文档

本目录汇总 Gitea 相关功能的产品设计、系统边界、接口约定和实现验收点。文档按功能分组，Pages 和 Codespace 分别描述各自的管理职责、运行组件、数据模型与生命周期；它们可以独立实现和部署。

## 文档分组

- [Gitea Pages](pages/)：由 Gitea 管理当前 TAR.GZ、`.pages` 所有者主页与仓库项目站点；每个单机实例在 Pages 进程内嵌入独立 etcd，使用一个数据根目录主动部署，并支持分支目录、Actions 成品与 TAR.GZ 上传、standalone 或 nginx 启动模式、自定义域名及 HTTP/HTTPS。
- [Gitea Codespace](codespace/)：远程开发环境的业务管理、运行平台、协议、部署要求和测试方式。

各主题入口汇总相应章节，在线阅读时也可使用左侧目录。
