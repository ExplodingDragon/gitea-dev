This adds first-class repository Pages support to Gitea. Repository administrators can publish versioned static websites from a branch directory, a Gitea Actions artifact, or a TAR.GZ upload, then manage source settings, version history, custom domains, and per-instance deployment results in Gitea.

Gitea owns authorization, publication settings, immutable content versions, artifact storage, domain ownership checks, repository lifecycle changes, and deployment status. A separately deployed [gitea-pages](https://github.com/ExplodingDragon/gitea-pages) service actively synchronizes every enabled site, validates and extracts its current artifact, serves the confirmed local content, manages certificates, and reports deployment results to Gitea. Each registered instance is independent and deploys all sites, so existing websites remain available while Gitea is temporarily unreachable.

## Screenshots

![Repository Pages settings](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-settings.png)
![Pages version history](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-versions.png)
![Pages publication from Gitea Actions](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-actions.png)
![Pages instance administration](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/page/pages-instances.png)

## Highlights

- GitHub-style project addresses at `https://<owner>.<pages-domain>/<repository>/` and owner sites at `https://<owner>.<pages-domain>/` from a repository named `.pages`.
- Branch/directory and Actions publication sources, with web and API TAR.GZ uploads available from the version management page for either source.
- Deduplicated content versions with stable pagination, restore, deletion, configurable retention, and a clear distinction between artifact readiness and deployment success.
- Gitea Actions deployment endpoints compatible with the Pages artifact flow, plus a Pages entry in workflow run summaries after a run submits an artifact.
- Custom domains with TXT ownership verification, per-instance publication status, operator certificates, and ACME through `go-acme/lego`.
- Site settings and version history integrated into repository settings, with Pages instance registration and communication status in site administration.

Default Pages sites are public, including sites published from private repositories. When a public repository becomes private, Gitea disables its existing site and requires a repository administrator to explicitly enable the public website again.

The separate service supports standalone HTTP/HTTPS serving, generated Nginx configuration, and embedding as the `gitea.dev/page` Go package through a `Publisher` interface. It stores local state in a single-member embedded etcd and deploys content before it reaches the request path. Nginx can continue serving the last confirmed deployment while the Pages process is unavailable.

All publication sources enter the same bounded TAR.GZ validation pipeline. Gitea and the Pages service reject unsafe archive entry types, absolute or escaping paths, oversized content, excessive entries, and unsafe symbolic links. Relative symbolic links are accepted when their resolved path remains inside the site, including links whose target is not present, and executable permission bits are removed during extraction. A failed candidate keeps the previous confirmed website active.

## Validation

- Gitea: `make fmt`, `make lint`, `make test-backend`, `make test-frontend`, `make test-migration`, and `make test-e2e`.
- Pages integration coverage: `TestAdminPagesInstances`, `TestAPIPagesVersions`, `TestPagesActionsDeploymentAPI`, and `TestActionsRoute`.
- gitea-pages: `make format`, `make tidy`, `make check`, `go test -race ./...`, and `golangci-lint run ./...`.

Related: https://github.com/go-gitea/gitea/issues/302

Related: https://github.com/go-gitea/gitea/issues/23521

Related: https://github.com/go-gitea/gitea/issues/28907

Assisted-by: Codex GPT-6; all generated code was manually reviewed.
