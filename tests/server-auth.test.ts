import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import {
  createOidcAuthenticator,
  hashTenantApiToken,
  sanitizeTenantApiKey,
  tenantApiKeyMatches,
} from "../src/harness/server-auth.js";
import { createHarnessHttpServer } from "../src/harness/server.js";

test("OIDC authenticator discovers JWKS and maps tenant access claims", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const provider = await startOidcProvider({ ...jwk, kid: "test-key", alg: "RS256", use: "sig" });
  const authenticator = createOidcAuthenticator({
    issuer: provider.issuer,
    audience: "loom-harness",
    allowInsecureHttp: true,
  });

  try {
    const health = await authenticator.ensureReady();
    assert.equal(health.ready, true);
    assert.equal(health.failureCount, 0);
    assert.equal(health.jwksUrl, `${provider.issuer}/jwks`);

    const token = await new SignJWT({
      loom_tenant: "alice",
      loom_role: "developer",
      preferred_username: "eno",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(provider.issuer)
      .setAudience("loom-harness")
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    assert.deepEqual(await authenticator.authenticate(token, "alice"), {
      tenant: "alice",
      actor: "eno",
      role: "developer",
      subject: "user-123",
    });
    await assert.rejects(() => authenticator.authenticate(token, "bob"), /invalid OIDC token/);
  } finally {
    await closeServer(provider.server);
  }
});

test("OIDC health fails closed without leaking provider errors", async () => {
  const provider = createServer((_req, res) => {
    res.writeHead(503, { "content-type": "text/plain" }).end("postgres://secret-host/private");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const authenticator = createOidcAuthenticator({
    issuer: `http://127.0.0.1:${address.port}`,
    audience: "loom-harness",
    allowInsecureHttp: true,
    requestTimeoutMs: 500,
  });

  try {
    const health = await authenticator.ensureReady();
    assert.equal(health.ready, false);
    assert.equal(health.failureKind, "discovery");
    assert.equal(health.failureCount, 1);
    assert.equal(JSON.stringify(health).includes("secret-host"), false);
  } finally {
    await closeServer(provider);
  }
});

test("OIDC readiness detects JWKS refresh failure while cached keys remain usable", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  let failJwks = false;
  let now = Date.parse("2026-07-10T00:00:00.000Z");
  const provider = await startOidcProvider(
    { ...jwk, kid: "refresh-key", alg: "RS256", use: "sig" },
    () => failJwks,
  );
  const authenticator = createOidcAuthenticator({
    issuer: provider.issuer,
    audience: "loom-harness",
    allowInsecureHttp: true,
    refreshIntervalMs: 1_000,
    now: () => now,
  });
  const token = await new SignJWT({
    loom_tenant: "alice",
    loom_role: "viewer",
    preferred_username: "cached-user",
  })
    .setProtectedHeader({ alg: "RS256", kid: "refresh-key" })
    .setIssuer(provider.issuer)
    .setAudience("loom-harness")
    .setSubject("cached-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  try {
    assert.equal((await authenticator.ensureReady()).ready, true);
    failJwks = true;
    now += 1_001;
    const failed = await authenticator.ensureReady();
    assert.equal(failed.ready, false);
    assert.equal(failed.failureKind, "jwks");
    assert.equal((await authenticator.authenticate(token, "alice")).actor, "cached-user");

    failJwks = false;
    now += 1_001;
    const recovered = await authenticator.ensureReady();
    assert.equal(recovered.ready, true);
    assert.equal(recovered.failureCount, 1);
  } finally {
    await closeServer(provider.server);
  }
});

test("tenant API keys enforce activation and expiry without exposing hashes", () => {
  const token = "loom_test_secret";
  const key = {
    id: "key_test",
    tokenHash: hashTenantApiToken(token),
    actor: "eno",
    role: "admin" as const,
    createdAt: "2026-07-10T00:00:00.000Z",
    notBefore: "2026-07-10T00:01:00.000Z",
    expiresAt: "2026-07-10T00:02:00.000Z",
  };

  assert.equal(tenantApiKeyMatches(key, token, Date.parse("2026-07-10T00:00:59.999Z")), false);
  assert.equal(tenantApiKeyMatches(key, token, Date.parse("2026-07-10T00:01:00.000Z")), true);
  assert.equal(tenantApiKeyMatches(key, token, Date.parse("2026-07-10T00:02:00.000Z")), false);
  const sanitized = sanitizeTenantApiKey(key, Date.parse("2026-07-10T00:01:30.000Z"));
  assert.equal(sanitized.active, true);
  assert.equal("tokenHash" in sanitized, false);
  assert.equal(JSON.stringify(sanitized).includes(token), false);
});

test("OIDC endpoints require HTTPS unless explicitly enabled for local development", () => {
  assert.throws(() => createOidcAuthenticator({
    issuer: "http://identity.example.test",
    audience: "loom-harness",
  }), /must use HTTPS/);
});

test("harness HTTP authentication accepts OIDC for tenant scope but not the global operator views", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const provider = await startOidcProvider({ ...jwk, kid: "http-key", alg: "RS256", use: "sig" });
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-oidc-http-"));
  const harness = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [{ token: "operator-admin-key", actor: "ops", role: "admin" }],
    },
    oidcAuth: {
      issuer: provider.issuer,
      audience: "loom-harness",
      allowInsecureHttp: true,
    },
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const address = harness.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const token = await new SignJWT({
    loom_tenant: "alice",
    loom_role: "admin",
    preferred_username: "oidc-admin",
  })
    .setProtectedHeader({ alg: "RS256", kid: "http-key" })
    .setIssuer(provider.issuer)
    .setAudience("loom-harness")
    .setSubject("admin-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const developerToken = await new SignJWT({
    loom_tenant: "alice",
    loom_role: "developer",
    preferred_username: "oidc-developer",
  })
    .setProtectedHeader({ alg: "RS256", kid: "http-key" })
    .setIssuer(provider.issuer)
    .setAudience("loom-harness")
    .setSubject("developer-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  try {
    assert.equal((await fetch(`${baseUrl}/tenants/alice/access`)).status, 401);
    const accessResponse = await fetch(`${baseUrl}/tenants/alice/access`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(accessResponse.status, 200);
    assert.deepEqual(await accessResponse.json(), {
      tenant: "alice",
      actor: "oidc-admin",
      role: "admin",
      authenticated: true,
    });

    // OIDC identities are tenant-scoped: even a role=admin JWT must NOT reach the
    // cross-tenant global /status or /metrics operator views. A tenant developer
    // JWT is likewise rejected (rejection happens before any role check).
    assert.equal((await fetch(`${baseUrl}/status`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/status`, {
      headers: { authorization: `Bearer ${developerToken}` },
    })).status, 401);

    // The OIDC admin keeps full access to its own tenant status.
    assert.equal((await fetch(`${baseUrl}/tenants/alice/status`, {
      headers: { authorization: `Bearer ${token}` },
    })).status, 200);

    // A startup-configured operator key reads the global views, which report
    // OIDC provider readiness without leaking the token.
    const statusResponse = await fetch(`${baseUrl}/status`, {
      headers: { authorization: "Bearer operator-admin-key" },
    });
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.server.identity.oidc.ready, true);
    assert.equal(status.server.identity.oidc.issuer, provider.issuer);
    assert.equal(JSON.stringify(status).includes(token), false);

    const metrics = await (await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: "Bearer operator-admin-key" },
    })).text();
    assert.match(metrics, /^loom_harness_oidc_ready 1$/m);
  } finally {
    await Promise.all([closeServer(harness), closeServer(provider.server)]);
  }
});

test("tenant API key rotation supports zero-downtime overlap and targeted revocation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-key-rotation-"));
  const harness = createHarnessHttpServer({
    workspaceRoot,
    allowUnsafeLocalExecutor: true,
    tenantApiKeys: {
      alice: [{ token: "admin-key", actor: "admin", role: "admin" }],
    },
  });
  await new Promise<void>((resolve) => harness.listen(0, "127.0.0.1", resolve));
  const address = harness.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createdResponse = await fetch(`${baseUrl}/tenants/alice/policy/api-keys`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-key" },
      body: JSON.stringify({ actor: "developer", role: "developer", token: "old-developer-key-000000000000" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.match(created.apiKey.id, /^key_/);
    assert.equal(created.apiKey.active, true);
    assert.equal(JSON.stringify(created.policy).includes("old-developer-key-000000000000"), false);
    assert.equal((await tenantAccess(baseUrl, "old-developer-key-000000000000")).status, 200);

    const rotatedResponse = await fetch(`${baseUrl}/tenants/alice/policy/api-keys/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-key" },
      body: JSON.stringify({
        keyId: created.apiKey.id,
        token: "new-developer-key-000000000000",
        overlapSeconds: 0,
      }),
    });
    assert.equal(rotatedResponse.status, 201);
    const rotated = await rotatedResponse.json();
    assert.equal(rotated.previousApiKey.id, created.apiKey.id);
    assert.equal(rotated.previousApiKey.active, false);
    assert.equal(rotated.apiKey.rotatedFromId, created.apiKey.id);
    assert.equal(rotated.apiKey.active, true);
    assert.equal(rotated.token, "new-developer-key-000000000000");
    assert.equal((await tenantAccess(baseUrl, "old-developer-key-000000000000")).status, 401);
    assert.equal((await tenantAccess(baseUrl, "new-developer-key-000000000000")).status, 200);

    const revokedResponse = await fetch(`${baseUrl}/tenants/alice/policy/api-keys/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin-key" },
      body: JSON.stringify({ keyId: rotated.apiKey.id }),
    });
    assert.equal(revokedResponse.status, 200);
    assert.equal((await revokedResponse.json()).revoked, 1);
    assert.equal((await tenantAccess(baseUrl, "new-developer-key-000000000000")).status, 401);

    const auditResponse = await fetch(`${baseUrl}/tenants/alice/audit`, {
      headers: { authorization: "Bearer admin-key" },
    });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json();
    assert.ok(audit.some((event: { type: string }) => event.type === "tenant_api_key_rotated"));
    assert.equal(JSON.stringify(audit).includes("old-developer-key-000000000000"), false);
    assert.equal(JSON.stringify(audit).includes("new-developer-key-000000000000"), false);
  } finally {
    await closeServer(harness);
  }
});

async function startOidcProvider(
  jwk: Record<string, unknown>,
  failJwks: () => boolean = () => false,
): Promise<{ server: Server; issuer: string }> {
  let issuer = "";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      if (failJwks()) {
        res.writeHead(503).end(JSON.stringify({ error: "secret provider outage" }));
        return;
      }
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  issuer = `http://127.0.0.1:${address.port}`;
  return { server, issuer };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function tenantAccess(baseUrl: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/tenants/alice/access`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
