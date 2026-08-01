# `enhance(codespace): add remote development environments`

This adds first-class Codespaces support to Gitea. Users can create Dev Container-based development environments from repository branches, commits, and pull requests; review the selected runtime environment, repository permissions, and injected secrets before creation; and manage lifecycle actions, logs, endpoints, resource usage, and auto-stop settings from Gitea.

Gitea acts as the authorization and lifecycle control plane, while separately deployed Codespace Managers provision and operate the development environments. Managers claim leased operations through authenticated RPC, and runtime access uses scoped credentials and short-lived open tokens. This keeps workload infrastructure outside Gitea web nodes while preserving Gitea's repository permissions and user ownership boundaries.

The change also adds site and personal Manager registration, environment-tag selection, administrator governance and reconciliation, scoped repository tokens, Codespace secrets, SSH authentication, and configuration for production deployments.

The accompanying Manager implementation is available at [ExplodingDragon/gitea-codespace](https://github.com/ExplodingDragon/gitea-codespace), and the shared protocol module is maintained at [ExplodingDragon/codespace-proto-go](https://github.com/ExplodingDragon/codespace-proto-go).

I'm still working on the design and evaluating the implementation. You can find the current details here ([zh-CN](https://github.com/ExplodingDragon/gitea-dev)).

## Developer verification

Use a Linux host with Incus initialized and a working storage pool and managed network. Run Gitea with Codespaces enabled and configure its public URL so it is reachable from the Incus instances; `localhost` clone URLs will point back to the instance and cannot reach Gitea.

Build the accompanying Manager, copy its example YAML, and set the Gateway public addresses, Incus endpoint, storage pool, network, and one environment tag for the local deployment:

```bash
git clone https://github.com/ExplodingDragon/gitea-codespace.git
cd gitea-codespace
cp examples/config.example.yaml codespace.yaml
go build -o gitea-codespace .
```

Create a site registration token from **Site Administration > Codespace Managers**, or a personal token from **User Settings > Codespaces > Managers**. Register and start the Manager; the registration command prompts for the Gitea URL and token:

```bash
./gitea-codespace register --config codespace.yaml
./gitea-codespace serve --config codespace.yaml
```

Open a repository's **Code > Codespaces** tab and create an environment from either a repository `devcontainer.json` or the platform default. A successful end-to-end check reaches the **Running** state, streams grouped operation logs, opens the browser IDE, accepts the displayed SSH command, exposes a declared port, and completes stop, resume, and delete actions.

## Screenshots

### Codespace overview and runtime access

![Codespace overview with SSH access, forwarded ports, runtime details, and resource usage](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE_20260801_173005.png)

### Web IDE

![A Gitea repository opened in the browser-based VS Code environment](https://raw.githubusercontent.com/ExplodingDragon/gitea-dev/main/pr/%E5%B1%8F%E5%B9%95%E6%88%AA%E5%9B%BE_20260801_172443.png)

<!-- Add a before-and-after comparison of the repository Code menu. -->
<!-- Add the creation review page showing the environment, Dev Container configuration, repository access, and secrets. -->
<!-- Add the Manager administration pages. -->

----
AI Disclosure:

This PR was designed and implemented using ChatGPT 5.5 xhigh. All generated code has been manually reviewed by a human.

---
Close https://github.com/go-gitea/gitea/issues/27766
Close https://github.com/go-gitea/gitea/issues/33904
