# Loom Desktop production distribution

Loom Desktop is a thin Tauri 2 client. The server remains authoritative for
tenant admission, run state, harness execution, verification, review gates,
audit, sandbox isolation, and queued work.

## Security boundary

- The WebView can navigate only to packaged content (or the fixed Vite origin in
  debug builds); new windows and arbitrary remote navigation are denied.
- Loom HTTP and authenticated SSE run through the Rust `reqwest` bridge. The
  bridge fixes every request to the configured server origin and path prefix,
  rejects secret-bearing query parameters, limits methods/headers/body sizes,
  disables redirects, and returns only selected response headers.
- API/OIDC access tokens are stored in the operating-system credential store.
  Profile metadata in `localStorage` is explicitly allowlisted and contains no
  credentials.
- Custom CA PEM chains add trust roots to the normal platform/WebPKI set. There
  is no option to disable hostname or certificate verification.
- OIDC uses the system browser, Authorization Code, PKCE S256, state, nonce, a
  ten-minute callback lifetime, and the exact `loom://auth/callback` shape.
- Diagnostics contain only timestamp, category, optional HTTP status, app/OS
  versions, and a bounded panic location. Crash upload is off by default and
  requires an explicit HTTPS endpoint.

## Release topology

Run **Desktop Release** from GitHub Actions with `beta` or `stable`. The
official `tauri-apps/tauri-action@v1` publishes immutable version releases:

```text
desktop-beta-v0.1.0
desktop-stable-v0.1.0
```

A dedicated job creates one draft immutable release and passes its release ID
to every platform job, avoiding concurrent release-creation races. After every
requested job passes its native package/signature check, the finalizer publishes
that release and updates the rolling `desktop-beta` or `desktop-stable` release
with:

- `latest.json`: current signed updater manifest;
- `rollback-latest.json`: previous signed updater manifest, when available;
- `rollback.json`: bounded current/previous channel metadata.

Linux publication is an explicit workflow input and must remain disabled until
both macOS and Windows release gates are stable.

## Required GitHub secrets

Updater signing is configured:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

macOS requires a Developer ID Application certificate and notarization account:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Windows requires a current OV/EV code-signing identity exported as PFX:

- `WINDOWS_CERTIFICATE`
- `WINDOWS_CERTIFICATE_PASSWORD`

The workflow fails before building if any required signing identity is absent.
It does not publish unsigned fallback installers.

## Verification gates

Repository CI runs the production frontend build, Rust security tests, and a
Linux AppImage/deb build. It validates package metadata, extracts and starts the
AppImage under Xvfb, and uploads both packages as a workflow artifact. The
cross-platform workflow repeats the desktop API golden path, profile persistence
tests, and Rust tests. It also builds and uploads unsigned `.app`/DMG packages on
macOS ARM/Intel and NSIS installers on Windows ARM/x64; Linux retains a native
binary compatibility job because its packages are covered by repository CI.

The separate **Desktop Installed-App E2E** workflow builds and installs an
instrumented Linux deb, then uses WebdriverIO with `tauri-driver` to test the
packaged application against deterministic local OIDC and Loom fixtures. It
covers OIDC Authorization Code + PKCE through the real deep-link handler, SSE
reconnect and sequence recovery, review approval, terminal execution, and
credential-store persistence after a native process restart. The current Linux
installed-app gate passes in
[run 29200854687](https://github.com/htom78/loomctl/actions/runs/29200854687).
The WebDriver Rust plugin, WebView bridge, and capability are all feature-gated;
normal CI fails if production frontend or Rust dependency output contains that
instrumentation.

The separate **Desktop Updater Signing Verification** workflow uses the
repository updater identity to build a real AppImage updater. Tauri rejects a
private key that does not match the public key embedded in the application, and
an independent verifier checks the generated `.sig` while also proving that a
single-byte artifact modification is rejected. The gate passes in
[run 29201931618](https://github.com/htom78/loomctl/actions/runs/29201931618).
It verifies signing integrity, not update installation or rollback behavior.

Release jobs additionally require:

- macOS `codesign --verify`, Gatekeeper `spctl --assess`, and notarization staple
  validation;
- Windows `Get-AuthenticodeSignature` returning `Valid` for every installer;
- updater artifacts signed by the repository updater key;
- successful channel promotion only after all requested platform jobs pass.

If any platform verification fails, the finalizer deletes the draft instead of
publishing a partial release.

Final production acceptance is intentionally not inferred from CI. Install the
published artifacts on clean machines, run the normal `npm run
production:check` readiness gate, and complete sign-in, SSE reconnect,
terminal reconnect, review/deployment decisions, external Coder/preview links,
restart/keychain persistence, update, and rollback against a TLS reverse proxy
backed by OIDC, Coder, PostgreSQL, and Redis. Record the release URLs and
platform security-check output before checking the Phase 3 acceptance gate.
