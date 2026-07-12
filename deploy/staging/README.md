# Two-instance staging

This stack exercises the distributed harness state path with two HTTP servers,
PostgreSQL metadata/audit storage, Redis leases/queues, and a shared workspace
directory.

```bash
# Linux only: export LOOM_DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
npm run staging:up
npm run staging:smoke
npm run staging:down
```

`staging:up` creates `/tmp/loom-staging-workspaces` and mounts that same
absolute path into both harness containers so their Docker executor can bind it
into child sandboxes. Set `LOOM_STAGING_WORKSPACE_ROOT` to use another
pre-writable absolute path.

The smoke script verifies readiness, cross-instance file conflicts and presence,
resumable terminal events, peer run control, atomic tenant run capacity,
queued-run takeover after `harness-a` stops, cross-instance audit visibility,
tenant auth isolation, viewer mutation denial, and 100 concurrent status reads.
It restarts `harness-a` before exiting.

The staging servers use the Docker executor with a read-only rootfs, dropped
capabilities, a bounded network, and a persistent shared workspace directory.
The Docker socket is mounted only so the harness can launch short-lived
tenant/run sandboxes; this stack is still a developer staging environment and
must not be exposed externally. External staging must override all three token
env vars and use the Coder executor/profile described in the main platform
cutover bundle.
