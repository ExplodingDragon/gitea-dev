# Codespace 待完成验收

本文档只记录当前实现仍缺少的整体验收，不重复描述已经完成的协议、生命周期、Gateway、Dev Container、权限或运行后端功能。设计目标与实现行为以 `src` 下的设计文档为准。

## Gitea 与 Manager 完整端到端测试

现有 Gitea 集成测试使用测试客户端驱动 ManagerService，Manager 进程级测试使用测试 ManagerService 驱动真实 Manager 和 Incus。两侧分别覆盖状态机和运行后端，但还需要一条低资源的完整主流程，将真实 Gitea、真实 Manager 和一个测试运行后端放在同一测试中，验证注册、创建、日志、ready metadata、Gateway 打开、停止、恢复和删除。

这样设计的原因是这条测试只负责证明两个仓库的公开边界能够共同工作；权限组合、状态冲突和运行后端细节继续由现有单元与集成测试覆盖，避免在重型测试中重复所有分支。

### 实现验收点

- [ ] 测试使用真实 Gitea ManagerService 和真实 Manager 进程，不以测试服务替代任一侧控制面。
- [ ] 单次只创建一个低资源实例或等价测试运行环境，并完整执行 create、stop、resume 和 delete。
- [ ] 测试确认 operation 日志、ready Runtime Metadata、workspace Gateway 和最终物理清理结果。

## Codespace 浏览器端到端测试

现有模板、路由和前端组件测试覆盖数据与局部交互，还需要一条 Gitea Playwright 主流程验证仓库入口、创建确认、个人列表、详情、设置弹窗和新标签页打开。浏览器测试用于发现模板组合、布局和真实表单联动问题，不重复服务层权限矩阵。

### 实现验收点

- [ ] 测试从仓库克隆面板进入 Codespaces 创建流程，并能在个人列表和详情页看到创建结果。
- [ ] 自动停止设置与删除使用现有弹窗完成，打开 workspace 后原页面不保留加载状态。
- [ ] 桌面视口下列表、详情侧栏、日志和资源进度条没有横向溢出或控件错位。
