Adds repository Pages backed by the separately deployed [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) service. Gitea manages repository settings, content versions, custom domains, registered instances, and deployment results. Each Pages instance synchronizes the current site state and keeps serving its last confirmed deployment while Gitea is unavailable.

## Behavior

- Pages is disabled by default for each repository. Content can come from a branch directory or a Gitea Actions artifact, while TAR.GZ uploads remain available through the web UI and API with either source. Every artifact passes through the same bounded archive validation before it becomes current.
- Project sites use `https://<owner>.<pages-domain>/<repository>/`. A repository named `.pages` provides the owner site at `https://<owner>.<pages-domain>/`.
- Versions are deduplicated by digest and support pagination, restore, deletion, and configurable retention. An Actions-created version links to its originating workflow run while that run exists; removing the run does not remove the version or published site.
- Custom domains use TXT ownership verification, and each Pages instance reports its own route result. The Pages service can serve plain HTTP, run behind a TLS-terminating reverse proxy, or manage HTTPS with [lego](https://github.com/go-acme/lego).
- Pages sites are public, including sites built from private repositories. Making a public repository private disables its site until a repository administrator explicitly enables it again.

## Screenshots

![Repository Pages settings](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png?v=20261031)
![Pages version history and deployment results](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png?v=20261031)
![Pages publication workflow in Gitea Actions](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png?v=20261031)
![Pages instance administration](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png?v=20261031)

Related: https://github.com/go-gitea/gitea/issues/302, https://github.com/go-gitea/gitea/issues/23521, https://github.com/go-gitea/gitea/issues/28907
