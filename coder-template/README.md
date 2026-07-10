# loom — Coder workspace template

Run loom inside **Coder**-provisioned, per-tenant, gVisor-isolated workspaces. Coder is the
shell + provisioner (web IDE/terminal/SSH, auth, lifecycle, idle-stop); loom is just the
in-workspace CLI + the brain. The matrix still emerges via the shared Gitea board.

## Prerequisites (on the Coder host)
- Coder server running (`coder server`).
- Docker with **gVisor** installed if `runtime = "runsc"` (the default). Set `runtime = ""` for plain runc, or `kata-fc` for Firecracker microVMs.
- Docker CLI available to Terraform provisioning; the template applies the pids cap with `docker update --pids-limit`.
- Set `docker_socket` when Docker is not exposed at the provider default, for example
  `unix:///Users/<user>/.docker/run/docker.sock` with Docker Desktop on macOS.
- A user-defined service network `loom-net` containing LiteLLM + Gitea. Workspaces never join it directly.
- Gitea/Forgejo (board + `_skills` repo) and the LiteLLM gateway up.
- The workspace and allow-list egress images built from the `loomctl/` repository root:
  `docker build -t loom/coder-workspace:latest -f coder-template/build/Dockerfile .`
  `docker build -t loom/coder-egress:latest -f coder-template/build/egress.Dockerfile coder-template/build`

## Push the template
```bash
coder templates push loom -d .
# set per-deployment vars (docker_socket, gateway_url, gitea_url, skills_repo_url, runtime, network,
# coder_upstream, coder_proxy_port, gateway_upstream, gitea_upstream,
# brain_ingest_url_template) via a loom.auto.tfvars or the Coder UI.
# gateway_key and brain_ingest_token should come from secrets.
```

For central brain ingest:

```hcl
brain_ingest_url_template = "http://harness.internal:8787/tenants/{tenant}/brain/signals"
brain_ingest_token        = "dev-secret"
```

When loom creates missing workspaces through the Coder executor, pass Coder rich parameters non-interactively:

```bash
loom harness serve \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --executor-template loom \
  --executor-template-param auth_mode=gateway \
  --executor-template-param cpus=2 \
  --executor-template-param memory_gb=4 \
  --executor-template-param pids_limit=256
```

Tenant policy `executorTemplateParameters` can set per-tenant non-secret values such as
`auth_mode=subscription`; resource limits still override `cpus`, `memory_gb`, and `pids_limit`.

## What each tenant gets
- A persistent, isolated workspace (own volume at /home/dev → `~/.claude` + subscription login persist → native `--resume` works).
- A hardened container: `runsc` by default, dropped capabilities, no-new-privileges, read-only rootfs, bounded `/tmp`, pids cap, and hard CPU/memory caps.
- An internal per-workspace network with no host or tenant-to-tenant route. A 128 MB unprivileged sidecar proxies only fixed Coder, Gitea, and LiteLLM TCP targets.
- Web VS Code + web terminal + SSH (Coder).
- `loom project add / goal / brain`, the native `/goal` loop, and the brain Stop hook — preconfigured.
- **Auth mode** parameter: `gateway` (central API key injected) or `subscription` (nothing injected — `claude login` with your own seat, persists in your volume; never shared).

## Where the brain runs
Per-workspace: the template renders `brain_ingest_url_template` by replacing `{tenant}` with the Coder workspace owner, injects `LOOM_BRAIN_INGEST_URL`, `LOOM_BRAIN_INGEST_TOKEN`, and `LOOM_BRAIN_CLIENT_ID`, then the Stop hook calls the central `POST /tenants/:tenant/brain/signals` endpoint. If `brain_ingest_url_template` is empty, the hook falls back to local `loom brain ingest` when the workspace writes directly to the shared `_skills` repo. Centrally: run `loom harness serve --ingest-brain` for online signal intake, and run `loomd serve --git-sync` **outside** the workspaces (Coder host / a small service) to pull `_skills` and do `brain score` / `brain propose` → skill-improvement PRs with linked recent failure samples.

## The pattern (why this shape)
- native `/goal` absorbed wanman's loop,
- Gitea absorbed agent-git-service's control plane,
- **Coder absorbs loomd's provisioner + shell.**
Each time: delegate the mature heavy thing, keep only the brain.
