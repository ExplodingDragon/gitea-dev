GO ?= go

.PHONY: run
run:
	cd codespace && $(GO) run .

.PHONY: test
test:
	$(MAKE) -C codespace test
	$(MAKE) -C codespace-proto-go test
