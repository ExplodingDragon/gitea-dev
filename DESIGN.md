# 设计 Gitea Codespace

## 组件说明

* Gitea 实例
  负责 codespace 管理入口、用户权限、组织/仓库配置和 codespace 记录。
  用户在 Gitea 中创建、打开、停止、恢复、删除 codespace。
  打开 codespace 时，Gitea 重定向到 Codespace Gateway / Manager。

* Codespace Gateway / Manager
  统一负责 codespace 访问入口、Web / SSH / 端口预览转发、实例调度、生命周期管理、资源限制、状态维护、token 管理和初始化脚本配置。

* LXD / Incus Agent
  负责实际创建、启动、停止、恢复、销毁 codespace 实例。
  Codespace Gateway / Manager 通过 Incus API 操作实例、执行命令、管理文件和配置端口转发。

* codespace
  用户的远程开发环境，由 LXD / Incus container 或 VM 承载。

---

## 当前实现修正

为了先把协议、状态机和端到端流程跑通，当前代码实现增加了一个 reference mode：

* `codespace` 单二进制同时承载 reference control plane、Gateway、Runtime API 和 embedded manager。
* control plane、Gateway 和 manager 之间仍然按文档中的 gRPC / HTTP 契约通信，没有把协议边界抹掉。
* 实例编排通过 provisioner 抽象隔离，当前内置 `fake` provisioner 用于开发和测试；后续可替换为 Incus 实现。
* 当前状态存储为内存实现，用于跑通完整流程；后续可替换为 Gitea / 数据库存储适配器。
* Gateway 对 open / preview URL 默认按当前请求推导 base URL，而不是完全依赖静态配置，便于本地开发、测试和反向代理接入。

这部分不改变最终生产部署边界，只是把 reference implementation 收敛为一个更容易验证的起点。

---

## 功能

* Gitea 主导 codespace 管理。
* 支持 global / org / user / repo 多层级配置。
* 支持从 repo / branch / commit / PR 创建 codespace。
* 支持在 Gitea 中打开、停止、恢复、删除 codespace。
* 点击打开 codespace 后，重定向到 Codespace Gateway / Manager。
* 支持 Web / SSH / 端口预览访问。
* 支持 CPU、内存、磁盘、网络等资源限制。
* 支持空闲自动停止。
* 默认提供裸 codespace。
* Codespace Gateway / Manager 通过 Incus API 在 codespace 内 clone 项目。
* Codespace Gateway / Manager 可配置初始化脚本。
* 初始化脚本在克隆后的仓库根目录执行。
* 默认初始化脚本用于调用 `@devcontainer/cli` 初始化开发环境。
* codespace 停止时保留数据。
* codespace 删除时清理实例、磁盘、网络、token 和转发规则。
* 使用短期 token 访问 Gitea。
* token 写入 codespace 内的 git 配置，便于 pull / push。
* codespace 停止、删除或权限变化时吊销 token。
* LXD / Incus 作为主要隔离边界。
* 不直接暴露宿主机文件系统和内部管理接口。

---

## 基本流程

1. 用户在 Gitea 仓库中创建 codespace。
2. Gitea 校验用户对 repo / branch / PR 的权限。
3. Gitea 创建 codespace 管理记录。
4. Codespace Gateway / Manager 根据配置选择镜像、规格和实例类型。
5. Codespace Gateway / Manager 调用 Incus API 创建并启动实例。
6. Codespace Gateway / Manager 生成短期 token。
7. Codespace Gateway / Manager 通过 Incus API 在 codespace 内 clone 指定 repo 和 ref。
8. Codespace Gateway / Manager 通过 Incus API 将 token 写入 git 配置。
9. Codespace Gateway / Manager 通过 Incus API 在仓库根目录执行初始化脚本。
10. codespace 状态变为 Running。
11. 用户在 Gitea 中点击打开 codespace。
12. Gitea 重定向到 Codespace Gateway / Manager。
13. 用户通过 Codespace Gateway / Manager 使用 Web / SSH / 端口预览。
14. codespace 空闲后自动停止并保留数据。
15. 删除 codespace 时清理实例、磁盘、网络、token 和转发规则。

---

## 生命周期

* Creating
* Running
* Stopped
* Resuming
* Deleting
* Deleted
* Failed

---

## 配置项

支持 global / org / user / repo 配置：

* 是否允许 codespace。
* 默认 LXD / Incus 镜像。
* codespace 类型：container / VM。
* CPU、内存、磁盘限制。
* 最大运行时间。
* 最大空闲时间。
* 最大 codespace 数量。
* 是否允许公网端口。
* 初始化脚本内容。
* 默认环境变量。
* Codespace Gateway / Manager 地址。

策略优先级：

* repo > user > org > global
* hard deny 优先级最高

---

## 实现约束

* Codespace Gateway / Manager 是唯一直接访问 Incus API 的组件。
* Incus Unix socket 权限等同于高权限管理入口，不能暴露给普通用户或 codespace。
* container 场景可直接通过 Incus 执行命令和管理文件。
* VM 场景需要 VM 内的 incus-agent 正常运行，才能通过 Incus API 执行命令和管理文件。
* Web / SSH / 端口预览由 Codespace Gateway / Manager 统一转发。
* 端口转发可基于 Incus proxy device 或 Gateway 自身反向代理实现。
* token 写入 git 配置后，需要在停止、删除、权限变化时清理或失效。


