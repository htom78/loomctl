# 0001 — Extract the embedded SPA into a real frontend build

- Status: accepted
- Date: 2026-07-12

## Context

The operator dashboard and workbench UIs live as ~11.4K lines of HTML/CSS/JS
inlined into TypeScript template literals:

- `src/harness/dashboard.ts` — `DASHBOARD_HTML` (~7.8K lines)
- `src/harness/workbench.ts` — `WORKBENCH_HTML` (~3.7K lines)

`src/harness/server/http.ts` imports those constants and serves them verbatim at
`/`, `/dashboard`, and `/workbench`. This works and keeps deployment to a single
binary, but the source is unmaintainable: no build tooling, no module boundaries,
no linting or type-checking of the frontend code, no component reuse, and editing
means hand-patching a giant string.

## Decision

Move the frontend source into a real Vite workspace app at `apps/dashboard/`
(the root `package.json` already declares `workspaces: ["packages/*", "apps/*"]`),
written in **vanilla TypeScript + modules**, not a framework.

- **No React/Vue rewrite.** The existing logic is ~11K lines of imperative
  vanilla JS. A faithful port keeps behavior; a framework rewrite would re-derive
  it and risk regressions for zero user-facing gain.
- **`vite-plugin-singlefile`** inlines all CSS/JS into one self-contained
  `index.html` — no external asset requests, matching the current CSP posture.
- **Codegen preserves single-binary deploy.** `scripts/build-frontend.mjs` reads
  the built `index.html` and writes `src/harness/dashboard.generated.ts` (and the
  workbench equivalent) exporting the HTML as a string constant. `http.ts` keeps
  importing a constant — the serve path does not change.

## Consequences

- Frontend gains: modules, type-checking, dev server, linting, real diffs.
- Deploy is unchanged: still one binary serving inlined HTML.
- Migration is incremental and multi-session. Until every view is ported, the
  **old `dashboard.ts` / `workbench.ts` keep serving production**; the cutover
  (rewire `http.ts` to the generated constants, delete the old files) is the last
  step, done only once the port is faithful.
- The generated `*.generated.ts` files are build artifacts — gitignored, produced
  by the build, never hand-edited.

## Alternatives rejected

- **Framework rewrite (React/Vite):** highest risk, re-implements working logic.
- **Serve built assets from disk at runtime:** breaks single-binary deploy and
  adds a static-asset-path failure mode.
- **Leave it inline:** the status quo; rejected because the source is the single
  worst maintainability liability in the repo.
