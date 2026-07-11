# Authentication and Credential Rotation

Loom accepts policy/API keys and OIDC bearer tokens at the same tenant access
boundary. Existing `--tenant-token`, `--tenant-key`, and policy files remain
compatible when OIDC is enabled.

## OIDC SSO

Configure issuer and audience together:

```bash
loom harness doctor \
  --workspace-root /data/workspaces \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --oidc-issuer https://identity.example.com \
  --oidc-audience loom-harness

loom harness serve \
  --workspace-root /data/workspaces \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --oidc-issuer https://identity.example.com \
  --oidc-audience loom-harness
```

By default Loom reads `/.well-known/openid-configuration` from the issuer and
uses its `jwks_uri`. `--oidc-jwks-url` can pin an explicit endpoint. HTTP is
rejected unless `--oidc-allow-insecure-http` is set for local development.

The default claims are:

| Claim | Meaning |
|---|---|
| `loom_tenant` | one tenant string or an array of tenant strings |
| `preferred_username` | audit actor; `sub` is the fallback |
| `loom_role` | exactly `admin`, `developer`, or `viewer` |

Override them with `--oidc-tenant-claim`, `--oidc-actor-claim`, and
`--oidc-role-claim`. Tokens must have a valid asymmetric signature, `iss`,
`aud`, `exp`, and `sub`. OIDC access tokens are accepted from the Authorization
header or `x-loom-tenant-token`; they are intentionally not accepted in stream
query parameters.

`/readyz` fails closed when discovery or JWKS loading fails. `/status` exposes
only issuer, audience, claim names, and bounded health counters. It never
returns tokens, signing keys, or raw provider errors.

`loom harness platform-preflight` performs the same discovery/JWKS check and
adds an `identity` gate whenever OIDC is configured.

## API Key Rotation

Policy API keys are SHA-256 hashed on disk. New keys have a stable `keyId`,
creation time, optional expiry, and an `active` status in sanitized responses.
The plaintext token is returned only by create or rotate.

Create a key:

```http
POST /tenants/alice/policy/api-keys
Authorization: Bearer <admin credential>
Content-Type: application/json

{
  "actor": "alice-ci",
  "role": "developer",
  "expiresAt": "2026-10-01T00:00:00Z"
}
```

Rotate it with a one-hour overlap:

```http
POST /tenants/alice/policy/api-keys/rotate
Authorization: Bearer <admin credential>
Content-Type: application/json

{
  "keyId": "key_current",
  "overlapSeconds": 3600
}
```

The old key remains valid until the overlap expires and the new response
contains `rotatedFromId`. Use `overlapSeconds: 0` for immediate replacement.
After clients have moved, revoke a specific key:

```http
POST /tenants/alice/policy/api-keys/revoke
Authorization: Bearer <admin credential>
Content-Type: application/json

{ "keyId": "key_replaced" }
```

Every create, rotation, and revoke is tenant-audited without plaintext key
material. Keep at least one separately managed admin credential for break-glass
access, and test it before rotating the last normal admin key.

## Control-plane webhook secret

The issue-comment webhook signature (`x-hub-signature-256`) is verified with a
single server-wide secret (`--control-plane-webhook-secret-env`). This is safe
when every tenant's control plane is the same operator-run Gitea/Forgejo (or
AGS) instance you configured — the expected deployment.

Do **not** reuse one harness secret across tenants that each run their own,
independently administered Git service. Anyone who can read the webhook secret
in their own service could then forge signature-valid `issue_comment` events for
another tenant's runs. If tenants bring their own control planes, give each a
distinct harness deployment (and secret), or gate webhook ingestion behind a
per-tenant trust boundary.
