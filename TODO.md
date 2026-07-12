# Loom Roadmap / To Do

This file tracks work that is approved but not yet implemented. Completed
platform behavior remains documented in `README.md`, `VISION.md`, and `docs/`.

## Desktop Client Decision Lock

Build **Loom Desktop** as a thin, cross-platform control client for the existing
Loom HTTP control plane. It owns the agent workflow and human gates; Coder and
VS Code continue to own the full development environment.

The client must not move the harness loop, tenant admission, verification,
audit, model routing, or sandbox execution onto the user's machine.

Target shape:

```text
Loom Desktop (Tauri 2)
  -> typed Loom API client
  -> HTTP + authenticated fetch-based SSE
  -> Loom server
     -> PostgreSQL / Redis
     -> Docker / Coder executor
     -> Gitea / Forgejo / agent-git-service
     -> LiteLLM and Brain

Deep coding work
  -> Open in Coder / VS Code
```

### Open-source components

- [Tauri 2](https://github.com/tauri-apps/tauri) for the desktop shell,
  installers, notifications, deep links, and signed updates.
- [xterm.js](https://github.com/xtermjs/xterm.js) for workspace terminals.
- [Monaco Editor](https://github.com/microsoft/monaco-editor) for bounded text
  editing only, after the core client is stable.
- [Coder](https://github.com/coder/coder) and its VS Code integration for the
  full IDE/workspace experience.
- OpenHands, Eclipse Theia IDE, and GitHub Desktop are UX/packaging references,
  not codebases to fork or new platform dependencies.

Do not build another VS Code distribution, fork OpenHands, or adopt Theia as
the application foundation unless this decision is explicitly revisited.

## Phase 0 - Client Contract

Estimated effort: 1-2 person-weeks.

- [ ] Extract a framework-neutral `packages/loom-api` TypeScript package from
      the hand-written Dashboard and Workbench API calls.
- [ ] Define request, response, error, and SSE event schemas for the client-used
      API surface.
- [ ] Add `apiVersion` and capability negotiation to server and tenant status.
- [ ] Implement reconnecting SSE over `fetch` + `ReadableStream` so credentials
      remain in the `Authorization` header instead of query strings.
- [ ] Keep the existing browser Dashboard and Workbench using the same SDK or
      contract fixtures so client and browser behavior cannot drift.
- [ ] Add contract tests for version mismatch, reconnect-after-sequence,
      duplicate event suppression, and unsupported capabilities.

Acceptance gate:

- [ ] A standalone test client can authenticate, list projects/runs, create an
      idempotent run, follow its event stream, and reconnect without losing or
      duplicating events.
- [ ] No API token appears in URLs, logs, crash output, audit, or run evidence.

## Phase 1 - Loom Desktop MVP

Estimated effort: 4-6 person-weeks after Phase 0.

- [ ] Create `apps/desktop` with Tauri 2, React, and TypeScript.
- [ ] Support multiple named Loom server profiles and tenant selection.
- [ ] Store API credentials in OS-native secure storage; never use WebView
      `localStorage` for long-lived credentials.
- [ ] Implement system-browser OIDC Authorization Code + PKCE login with a
      signed `loom://auth/callback` deep link.
- [ ] Implement project and run lists, run creation, queue state, event timeline,
      replay, comments, pause, resume, cancel, and abandon controls.
- [ ] Implement review claims, review decisions, deployment gates, diff,
      handoff package, and PR evidence views.
- [ ] Open Coder IDE/preview URLs and Coder/VS Code workspace links externally.
- [ ] Add native notifications for run completion, failed verification,
      pending review, and pending deployment.
- [ ] Add macOS and Windows development builds and smoke tests.

Acceptance gate:

- [ ] A developer can complete the golden path from sign-in to reviewed PR
      without using the embedded browser Dashboard.
- [ ] Closing/restarting the client preserves profiles but does not expose
      credentials in files, WebView storage, logs, or diagnostics.

## Phase 2 - Development Workbench

Estimated effort: 4-6 person-weeks.

- [ ] Integrate xterm.js with existing session create/input/stop and resumable
      event-stream endpoints.
- [ ] Add workspace/run file tree, safe text create/edit/move/delete, optimistic
      version checks, and conflict recovery.
- [ ] Add Monaco for bounded text editing and diff inspection; keep full IDE
      features in Coder/VS Code.
- [ ] Add command/session history, reopen actions, collaborator presence, and
      same-file editing warnings.
- [ ] Add VAS review queue, case artifacts, review packages, learning decisions,
      and Brain signal views.
- [ ] Add bounded offline metadata cache; queued mutations remain server-owned
      and are never fabricated locally.

Acceptance gate:

- [ ] Terminal reconnect, file conflict, multi-user presence, and cross-server
      run-control tests pass against the two-instance PostgreSQL/Redis staging
      stack.

## Phase 3 - Production Distribution

Estimated effort: 3-5 person-weeks.

- [ ] Enforce a minimal Tauri capability allowlist and strict Content Security
      Policy; reject arbitrary remote navigation and untrusted deep links.
- [ ] Support enterprise custom CAs without disabling TLS verification.
- [ ] Add scrubbed client diagnostics and opt-in crash reporting.
- [ ] Add signed update channels (`beta` and `stable`) with rollback metadata.
- [ ] Add macOS signing/notarization and Apple Silicon/Intel artifacts.
- [ ] Add Windows code signing and x64/arm64 installers.
- [ ] Add Linux AppImage/deb builds after macOS and Windows are stable.
- [ ] Add cross-platform end-to-end tests for login, SSE reconnect, terminal,
      review gate, update verification, and credential persistence.
- [ ] Publish artifacts through GitHub Releases using the official Tauri action.

Acceptance gate:

- [ ] Signed installers pass platform security checks and connect successfully
      to production-shaped Loom through a reverse proxy using OIDC, Coder,
      PostgreSQL/Redis, and the standard production readiness gate.

## Delivery Estimate

Assumption: one experienced frontend engineer and one platform engineer.

| Deliverable | Estimated effort |
|---|---:|
| Desktop shell demonstration | 1-2 person-weeks |
| Daily-usable MVP | 5-8 person-weeks cumulative |
| Full development workbench | 9-14 person-weeks cumulative |
| Signed three-platform release | 12-19 person-weeks cumulative |

The estimates include implementation and automated tests, but not external
identity-provider procurement, Apple/Windows signing-account lead time, or
enterprise rollout coordination.

## Non-goals

- No local execution of tenant harness workloads.
- No local copy of model, control-plane, or workspace credentials beyond the
  minimum user session credential held in OS-native secure storage.
- No desktop-owned queue, run state, verification result, or audit authority.
- No complete IDE, extension marketplace, language server fleet, or local Git
  implementation in the MVP.
- No mobile client in this roadmap; mobile requires a separate interaction and
  credential-lifecycle design.

