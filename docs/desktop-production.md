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

After every platform job passes its native signature check, the promotion job
updates the rolling `desktop-beta` or `desktop-stable` release with:

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
native no-bundle Tauri build on Linux. The cross-platform workflow repeats the
desktop API golden path, profile persistence tests, Rust tests, and native build
on macOS ARM/Intel, Windows ARM/x64, and Linux.

Release jobs additionally require:

- macOS `codesign --verify`, Gatekeeper `spctl --assess`, and notarization staple
  validation;
- Windows `Get-AuthenticodeSignature` returning `Valid` for every installer;
- updater artifacts signed by the repository updater key;
- successful channel promotion only after all requested platform jobs pass.

Final production acceptance is intentionally not inferred from CI. Install the
published artifacts on clean machines, run the normal `npm run
production:check` readiness gate, and complete sign-in, SSE reconnect,
terminal reconnect, review/deployment decisions, external Coder/preview links,
restart/keychain persistence, update, and rollback against a TLS reverse proxy
backed by OIDC, Coder, PostgreSQL, and Redis. Record the release URLs and
platform security-check output before checking the Phase 3 acceptance gate.
