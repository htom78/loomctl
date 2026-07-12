# Loom Roadmap / To Do

This file tracks the approved desktop target and its implementation status.
Completed platform behavior remains documented in `README.md`, `VISION.md`,
and `docs/`.

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
- [WebdriverIO Tauri Service](https://github.com/webdriverio-community/wdio-tauri-service)
  for installed desktop application E2E tests. Its bridge is compiled only into
  dedicated E2E packages and must remain absent from production artifacts.
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

- [x] Extract a framework-neutral `packages/loom-api` TypeScript package from
      the hand-written Dashboard and Workbench API calls.
- [x] Define request, response, error, and SSE event schemas for the client-used
      API surface.
- [x] Add `apiVersion` and capability negotiation to server and tenant status.
- [x] Implement reconnecting SSE over `fetch` + `ReadableStream` so credentials
      remain in the `Authorization` header instead of query strings.
- [ ] Move the existing browser Dashboard and Workbench onto the same SDK or
      shared request/response fixtures. The API capability catalog is shared by
      contract test, but browser request behavior is not yet shared.
- [x] Add contract tests for version mismatch, reconnect-after-sequence,
      duplicate event suppression, and unsupported capabilities.

Acceptance gate:

- [x] A standalone test client can authenticate, list projects/runs, create an
      idempotent run, follow its event stream, and reconnect without losing or
      duplicating events.
- [x] No API token appears in URLs, logs, crash output, audit, or run evidence.
      Header-only native transport rejects secret-bearing query parameters;
      desktop crash/diagnostic payloads contain only bounded structured fields.

## Phase 1 - Loom Desktop MVP

Estimated effort: 4-6 person-weeks after Phase 0.

- [x] Create `apps/desktop` with Tauri 2, React, and TypeScript.
- [x] Support multiple named Loom server profiles and tenant selection.
- [x] Store API credentials in OS-native secure storage; never use WebView
      `localStorage` for long-lived credentials.
- [x] Implement system-browser OIDC Authorization Code + PKCE login with a
      signed `loom://auth/callback` deep link.
- [x] Implement project and run lists, run creation, queue state, event timeline,
      comments, pause, resume, and cancel controls.
- [ ] Add replay and abandon controls.
- [x] Implement review and deployment-gate decisions.
- [ ] Add review claims, diff, handoff package, and PR evidence views.
- [x] Open Coder IDE URLs externally with the official Tauri opener plugin.
- [x] Add preview URLs and Coder/VS Code workspace links.
- [x] Add native notifications for run completion, failed verification,
      pending review, and pending deployment.
- [x] Add macOS and Windows development builds and smoke tests. The native
      matrix passes on macOS ARM/Intel and Windows ARM/x64, with Linux included
      as a compatibility gate ([run 29193650909](https://github.com/htom78/loomctl/actions/runs/29193650909)).

Acceptance gate:

- [ ] A developer can complete the golden path from sign-in to reviewed PR
      without using the embedded browser Dashboard.
- [x] Closing/restarting the client preserves profiles but does not expose
      credentials in files, WebView storage, logs, or diagnostics. Installed
      deb, `.app`, and NSIS E2E runs restart the native process, reconnect from
      persisted profile metadata, and read the token from the OS credential
      store on Linux, macOS ARM/Intel, and Windows x64/ARM
      ([run 29203147902](https://github.com/htom78/loomctl/actions/runs/29203147902)).

## Phase 2 - Development Workbench

Estimated effort: 4-6 person-weeks.

- [x] Integrate xterm.js with existing session create/input/stop and resumable
      event-stream endpoints.
- [x] Add workspace/run file tree, safe text create/edit/move/delete, optimistic
      version checks, and conflict recovery.
- [x] Add Monaco for bounded text editing and diff inspection; keep full IDE
      features in Coder/VS Code.
- [x] Add command/session history, reopen actions, collaborator presence, and
      same-file editing warnings.
- [x] Add VAS review queue, case artifacts, review packages, learning decisions,
      and Brain signal views.
- [x] Add bounded offline metadata cache; queued mutations remain server-owned
      and are never fabricated locally.

Acceptance gate:

- [x] Terminal reconnect, file conflict, multi-user presence, and cross-server
      run-control tests pass against the two-instance PostgreSQL/Redis staging
      stack.

## Phase 3 - Production Distribution

Estimated effort: 3-5 person-weeks.

- [x] Enforce a minimal Tauri capability allowlist and strict Content Security
      Policy; reject arbitrary remote navigation and untrusted deep links.
- [x] Support enterprise custom CAs without disabling TLS verification.
- [x] Add scrubbed client diagnostics and opt-in crash reporting.
- [x] Add signed update channels (`beta` and `stable`) with rollback metadata.
      The repository updater identity matches the embedded public key, signs a
      real AppImage updater, passes independent signature verification, and
      rejects a tampered artifact
      ([run 29201931618](https://github.com/htom78/loomctl/actions/runs/29201931618)).
- [ ] Prove signed update installation and rollback against installed artifacts.
      Build instrumented `0.1.0` and `0.2.0` AppImages with the repository
      updater identity, install `0.1.0`, update to `0.2.0` from a feature-gated
      loopback fixture, restart and verify the running version and installed
      file hash, then install the signed rollback, restart, and verify `0.1.0`
      and the original hash are restored. Production builds must retain their
      fixed HTTPS GitHub release endpoints.
- [ ] Add macOS signing/notarization and Apple Silicon/Intel artifacts.
      Unsigned `.app` and DMG packaging passes on both architectures
      ([run 29195378268](https://github.com/htom78/loomctl/actions/runs/29195378268));
      Apple Developer certificate/notarization secrets and a real release are
      still required.
- [ ] Add Windows code signing and x64/arm64 installers.
      Unsigned NSIS packaging passes on both architectures, and certificate
      import/Authenticode checks are ready; a Windows code-signing certificate
      and a real release are still required.
- [x] Add Linux AppImage/deb builds and startup smoke tests. CI validates package
      metadata, extracts the AppImage, keeps it running under Xvfb, and uploads
      both packages ([run 29194779541](https://github.com/htom78/loomctl/actions/runs/29194779541)).
- [ ] Publish Linux release artifacts after macOS and Windows signing gates are
      stable. Linux remains an explicit opt-in on the release workflow.
- [ ] Add cross-platform end-to-end tests for login, SSE reconnect, terminal,
      review gate, update verification, and credential persistence.
      The feature-gated WebdriverIO/Tauri harness installs a Linux deb, macOS
      `.app`, and Windows NSIS package, then exercises real OIDC PKCE through
      each operating system's `loom://` handler, SSE reconnect, review,
      terminal, and credential-store persistence against deterministic
      fixtures. Linux, macOS ARM/Intel, and Windows x64/ARM installed-app jobs
      pass
      ([run 29203147902](https://github.com/htom78/loomctl/actions/runs/29203147902)),
      and normal production bundles exclude WebDriver instrumentation. Signed
      update installation and rollback E2E remain release gates.
- [ ] Publish artifacts through GitHub Releases using the official Tauri action.
      The `tauri-apps/tauri-action@v1` workflow builds into a draft and publishes
      it only after every requested platform verification passes, but no signed
      release may be published until the platform signing secrets pass preflight.

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
