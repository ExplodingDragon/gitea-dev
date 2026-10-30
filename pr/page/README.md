This adds first-class repository Pages support to Gitea. Repository administrators can publish a static website from a branch directory, a Gitea Actions artifact, or a TAR.GZ upload, then manage its source, versions, custom domain, and deployment status from the repository settings.

Gitea stores publication settings and immutable content versions, verifies custom-domain ownership, and records the result reported by each registered instance. The separately deployed [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) service downloads the current version, publishes it, manages HTTPS, and reports the result back to Gitea. Existing sites remain available when Gitea is temporarily unreachable.

## Screenshots

![Repository Pages settings](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages version history](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![Pages publication from Gitea Actions](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages instance administration](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

## Behavior

- Project sites use `https://<owner>.<pages-domain>/<repository>/`. A repository named `.pages` provides the owner site at `https://<owner>.<pages-domain>/`.
- Content versions are deduplicated by digest and support pagination, restore, deletion, and configurable retention.
- Gitea Actions can submit a Pages artifact and exposes that fact in the workflow run summary. Web and API TAR.GZ uploads remain available for either configured source.
- Custom domains use TXT ownership verification. Certificate issuance and serving are handled by each Pages instance.
- Pages sites are public, including sites built from private repositories. Making a public repository private disables its site until a repository administrator explicitly enables it again.

All sources use the same bounded TAR.GZ validation before a version becomes current. Invalid paths, unsafe archive entries, resource-limit violations, and symbolic links that escape the site are rejected; a rejected version does not replace the current site.

## Validation

- Gitea: `make checks`, `make lint`, `make build`, `make test-backend`, `make test-frontend`, `make test-migration`, and `make test-e2e`.
- gitea-pages: `make format`, `make tidy`, `make check`, `go test -race ./...`, and `golangci-lint run ./...`.

Related: https://github.com/go-gitea/gitea/issues/302

Related: https://github.com/go-gitea/gitea/issues/23521

Related: https://github.com/go-gitea/gitea/issues/28907

Assisted-by: Codex GPT-6; all generated code was manually reviewed.
