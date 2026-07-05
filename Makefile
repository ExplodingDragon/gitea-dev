GO ?= go

.PHONY: go-list
go-list:
	$(GO) list gitea.dev/codespace/cmd/gitea-codespace
	$(GO) list gitea.dev/codespace/internal/app
	$(GO) list gitea.dev/codespace-proto-go/codespace/v1

.PHONY: go-run
go-run:
	$(GO) run ./codespace/cmd/gitea-codespace

.PHONY: go-test
go-test:
	$(GO) test ./codespace/...

.PHONY: go-list-local
go-list-local:
	$(GO) list ./codespace/...
	$(GO) list ./codespace-proto-go/...
