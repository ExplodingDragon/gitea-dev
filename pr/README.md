This adds first-class Codespaces support. Users can create an isolated Dev Container from a branch, commit, or pull request, then use logs, Web IDE, SSH/SFTP, HTTP endpoints, auto-stop, stop, resume, and deletion from Gitea.

Gitea owns authorization and lifecycle state. A separately deployed [Codespace Manager](https://gitea.com/gitea/gitea-codespace) owns Kubernetes resources, keeping runtime details outside Gitea.

## Screenshots

![Codespace creation review](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-create.png)
![Codespace Manager administration](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-managers.png)
![Codespace Web IDE](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/codespace-web-ide.png?v=22db4df)

Close https://github.com/go-gitea/gitea/issues/27766
Close https://github.com/go-gitea/gitea/issues/33904

Assisted-by: ChatGPT 6 astra high; all generated code was manually reviewed.
