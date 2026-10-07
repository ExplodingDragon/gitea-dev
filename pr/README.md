This adds first-class Codespaces support to Gitea. Users can create an isolated Dev Container environment from a repository branch, commit, or pull request and manage its lifecycle from Gitea.

Gitea remains the authorization and lifecycle control plane: it owns repository permissions, user secrets, Manager registration, and user-visible state. Separately deployed Codespace Managers provision runtime resources on Kubernetes and report results through the shared RPC protocol, keeping Kubernetes implementation details outside Gitea.

The integration provides:

- creation from branches, commits, and pull requests;
- repository and user Dev Container configurations;
- site and personal Managers with explicit environment selection;
- scoped Git/API credentials, Codespace secrets, SSH, SFTP, Web IDE, and authenticated HTTP endpoints;
- incremental logs, resource usage, auto-stop, stop, resume, and delete controls.

Related projects:

- [Gitea Codespace Manager](https://gitea.com/gitea/gitea-codespace)
- [Codespace protocol for Go](https://gitea.com/gitea/codespace-proto-go)
- [Architecture and deployment design (zh-CN)](https://github.com/ExplodingDragon/gitea-dev)

## Usage

1. Create and name a Manager in site administration or user settings, then generate its one-time registration secret.
2. Deploy the Codespace Manager and use its administration page to add the Gitea site and at least one Kubernetes environment template.
3. Open **Code > Codespaces** from a repository branch, commit, or pull request; select the environment and Dev Container configuration; review repository access and secret names; then create the Codespace.
4. Use the Codespace page to follow progress and manage Web IDE, SSH, endpoints, resource usage, auto-stop, stop, resume, and deletion.

Gitea and Git URLs must be reachable from Runtime Pods. Deployment requirements and test targets are documented in the [Manager repository](https://gitea.com/gitea/gitea-codespace).

## Verification

An end-to-end verification is complete when a Codespace reaches **Running**, logs load incrementally, Web IDE and SSH access succeed, an HTTP endpoint opens, workspace data survives stop and resume, and deletion removes the runtime resources.

## Screenshots

### Creation review

![Codespace creation review with environment, Dev Container configuration, repository access, and secrets](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-create.png)

### Manager administration

![Codespace Manager administration with status, environment tags, and assignment information](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-managers.png)

### Web IDE

![A Gitea repository open in the browser-based development environment with its file tree, editor, and terminal](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-web-ide.png)

----
AI Disclosure:

This PR was designed and implemented using ChatGPT 6 astra high. All generated code has been manually reviewed by a human.

---
Close #27766
Close #33904
