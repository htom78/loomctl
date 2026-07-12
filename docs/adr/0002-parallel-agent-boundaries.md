# 0002 — Parallel-agent boundaries and branch discipline

- Status: accepted
- Date: 2026-07-12

## Context

Two agents work this repo concurrently on the same account from different
machines: one on the native desktop client, one on the kernel/backend. Both had
been committing straight to `main`. The result was constant "remote has moved"
churn — every push required a rebase, and direct pushes to a shared branch risk
overwriting or silently dropping the other side's commits.

There are no other branches and no pull requests; `main` is the single line of
history. That is the problem, not an accident of timing.

## Decision

### 1. Ownership lanes

Each agent stays in its lane. ~90% of changes then have zero overlap.

| Area | Owner |
| --- | --- |
| `apps/desktop/**` | Desktop agent |
| `packages/loom-api/**` | Desktop agent (typed client) |
| `src/harness/**`, `src/cli/**` | Kernel/backend agent |
| `deploy/**`, `tests/**`, `scripts/**` | Kernel/backend agent |

Do not edit the other lane's files. If a change needs both, coordinate on a PR
rather than pushing across the boundary.

### 2. Shared files — pull before touching

These are edited by both sides and must not be changed without a fresh
`git pull --rebase origin main` immediately before:

- `package.json` (root — scripts and workspaces)
- `package-lock.json`
- `src/index.ts` (top-level command registration)
- `docs/adr/**`

### 3. No direct pushes to `main`

Every change goes through a branch and a PR:

```
git checkout -b feat/<lane>-<slug>
# ...work...
git pull --rebase origin main      # before work and again before push
gh pr create
```

The PR is the explicit merge checkpoint that replaces two blind `git push`
commands racing on `main`.

### 4. `@loom/api` is the contract seam

`@loom/api` is the only place the two lanes genuinely couple: the desktop client
consumes it, the harness server must produce data that matches it. Any change to
its types or interfaces (`RunSummary`, `LoomClient`, DTOs) must be called out
explicitly in the PR description so the other lane can keep the server/client
contract in sync.

### 5. Atomic commits

One thing per commit, `feat` / `fix` / `chore` / `refactor` / `docs` prefix.

## Consequences

- Cross-lane edits stop; rebase churn drops to the shared-files set only.
- `main` gains a review checkpoint instead of being a free-for-all.
- Contract changes to `@loom/api` become visible instead of silently breaking
  the opposite lane.
- Slight overhead: a branch + PR per change instead of committing to `main`.
  Worth it once more than one agent touches the repo.
