Adds repository Pages backed by the separately deployed [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) service. Gitea manages publication settings, content versions, domain ownership, registered instances, and deployment results; the Pages service synchronizes and serves the current version and manages HTTPS. An instance keeps serving its last confirmed deployment while Gitea is unavailable.

## Behavior

- Content can come from a branch directory, a Gitea Actions artifact, or a web/API TAR.GZ upload. Every source passes through the same bounded archive validation before it becomes current.
- Project sites use `https://<owner>.<pages-domain>/<repository>/`. A repository named `.pages` provides the owner site at `https://<owner>.<pages-domain>/`.
- Versions are deduplicated by digest and support pagination, restore, deletion, and configurable retention. Actions submissions are identified in the workflow run summary.
- Custom domains use TXT ownership verification; each Pages instance handles certificate issuance and reports its own deployment result.
- Pages sites are public, including sites built from private repositories. Making a public repository private disables its site until a repository administrator explicitly enables it again.

## Screenshots

![Repository Pages settings](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages version history](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![Pages publication from Gitea Actions](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages instance administration](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

Related: https://github.com/go-gitea/gitea/issues/302, https://github.com/go-gitea/gitea/issues/23521, https://github.com/go-gitea/gitea/issues/28907
