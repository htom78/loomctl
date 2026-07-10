# Real Dependency Staging

This stack runs real PostgreSQL, Redis, Gitea, and LiteLLM releases on a
dedicated Docker network. The harness and official Coder server run as host
processes so the Coder Terraform provisioner can reach Docker Desktop on macOS.
On Linux, the same dependencies can be paired with a containerized Coder
deployment.

The deterministic OpenAI-compatible upstream exists only to prove LiteLLM
proxying, virtual-key authentication, usage accounting, and the harness model
protocol without spending against a provider. It is not evidence for an
external paid-model target.

## Required Environment

Create an ignored env file such as `.codex-tmp/real-staging.env` containing:

```bash
LOOM_STAGE_POSTGRES_PASSWORD=<random-url-safe-value>
LOOM_STAGE_REDIS_PASSWORD=<random-url-safe-value>
LOOM_STAGE_LITELLM_MASTER_KEY=sk-<random-value>
LOOM_STAGE_LITELLM_SALT_KEY=<random-value>
LOOM_STAGE_GITEA_SECRET_KEY=<random-value>
LOOM_STAGE_GITEA_INTERNAL_TOKEN=<random-value>
LOOM_STAGE_GITEA_LFS_JWT_SECRET=<random-value>
LOOM_STAGE_GITEA_OAUTH2_JWT_SECRET=<random-value>
```

Do not commit this file or place values on command lines.

## Start Dependencies

```bash
docker compose \
  --env-file .codex-tmp/real-staging.env \
  -f deploy/real-staging/compose.yml \
  up -d
```

Host ports bind to loopback only:

| Service | URL |
|---|---|
| PostgreSQL | `127.0.0.1:55433` |
| Redis | `127.0.0.1:56380` |
| Gitea | `http://127.0.0.1:33001` |
| LiteLLM | `http://127.0.0.1:34000` |

The explicit Docker network is `loom-real-stage`; Coder workspace templates
must use that network to reach `gitea:3000` and `litellm:4000`.

## Scope Of Proof

This stack can prove:

- PostgreSQL durable state and audit;
- Redis queue, lease, and capacity coordination;
- Gitea repository, issue, comment, and pull-request handoff;
- LiteLLM proxy and virtual-key behavior;
- Coder-created Docker workspaces and run-scoped worktrees;
- two harness instances sharing distributed state.

It cannot prove non-loopback DNS/TLS, cloud security groups, managed database
PITR, gVisor on Docker Desktop, or an external paid model. Those remain strict
external-staging gates.
