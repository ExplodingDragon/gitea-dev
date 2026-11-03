# 目录

[设计文档总览](README.md)

# Gitea Pages

- [总体设计](pages/README.md)
- [实施准备与工程入口](pages/implementation.md)
- [GitHub Pages 调研与功能评估](pages/github-pages-research.md)
- [通信、同步与状态展示](pages/communication.md)
- [发布、TAR.GZ 存储与访问](pages/publishing.md)
- [公开访问、自定义域名与 HTTP/HTTPS](pages/access-and-domains.md)
- [证书管理与部署](pages/certificates.md)
- [生命周期与故障恢复](pages/lifecycle.md)
- [数据、Pages 本地架构与验证](pages/data-and-validation.md)

---

# Gitea Codespace

- [总体设计](codespace/README.md)

### 核心架构

- [Gitea 服务端](codespace/gitea-server.md)
- [运行平台](codespace/runtime-platform.md)

### 行为与接口

- [生命周期](codespace/lifecycle.md)
- [数据模型](codespace/data-model.md)
- [RPC 接口](codespace/rpc-spec.md)

### 运维与开发

- [部署要求](codespace/deployment-requirements.md)
- [实施与测试](codespace/implementation.md)

---

# Gitea self 分支维护

- [维护总览](maintenance/self/README.md)
- [数据库版本与升级范围](maintenance/self/database-versioning.md)
- [迁移映射](maintenance/self/migration-map.md)
- [Git 历史结构](maintenance/self/git-history.md)
- [上游同步流程](maintenance/self/upstream-sync.md)
- [冲突解决记录](maintenance/self/conflict-resolutions.md)
- [验证记录](maintenance/self/verification.md)
- [Codespace PR #38337 迁移 365 patch1](maintenance/self/patches/pr-38337-v365-patch1.md)
- [Codespace PR #38337 迁移 367 patch2](maintenance/self/patches/pr-38337-v367-patch2.md)
- [Pages PR #40071 迁移记录](maintenance/self/patches/pr-40071-v366-patch1.md)
