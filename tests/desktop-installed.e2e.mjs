import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { browser, $ } from "@wdio/globals";
import { LOOM_CLIENT_CAPABILITIES } from "../packages/loom-api/dist/index.js";

const ACCESS_TOKEN = `installed-e2e-${randomUUID()}`;
const PROFILE_KEY = "loom.desktop.profiles.v2";
const PROJECT = "installed-e2e";
const RUN_ID = "run-installed-e2e";

describe("installed Loom Desktop", () => {
  let fixture;
  let profileId;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    if (profileId) {
      await browser.tauri.execute(
        ({ core }, id) => core.invoke("delete_secret", { profileId: id }),
        profileId,
      ).catch(() => undefined);
    }
    await browser.execute((key) => localStorage.removeItem(key), PROFILE_KEY).catch(() => undefined);
    await fixture.close();
  });

  it("completes OIDC, SSE reconnect, review, terminal, and credential restart", async () => {
    await setInput("Server URL", fixture.loomUrl);
    await $("button=OIDC").click();
    await setInput("Issuer URL", fixture.issuer);
    await setInput("Client ID", "loom-installed-e2e");

    await browser.waitUntil(async () => {
      const profiles = await browser.execute((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), PROFILE_KEY);
      profileId = profiles[0]?.id;
      return Boolean(profileId && profiles[0]?.authMode === "oidc");
    }, { timeoutMsg: "OIDC profile metadata was not persisted" });

    const start = await browser.tauri.execute(
      ({ core }, request) => core.invoke("start_oidc_login", { request }),
      {
        profileId,
        issuer: fixture.issuer,
        clientId: "loom-installed-e2e",
        scopes: "openid profile",
      },
    );
    const authorization = await fetch(start.authorizationUrl, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    const callbackUrl = authorization.headers.get("location");
    assert.match(callbackUrl ?? "", /^loom:\/\/auth\/callback\?code=/);

    await browser.tauri.triggerDeeplink(callbackUrl);
    await $(".health.ok").waitForDisplayed({ timeout: 20_000 });
    await $("button=installed-e2e").waitForDisplayed();

    const runRow = await $("//button[contains(@class,'run-row')][contains(.,'Installed app E2E run')]");
    await runRow.click();
    await $("//div[contains(@class,'event-row')][contains(.,'#1')]").waitForDisplayed();
    await $("//div[contains(@class,'event-row')][contains(.,'#2')]").waitForDisplayed({ timeout: 20_000 });
    assert.deepEqual(fixture.streamAfter.slice(0, 2), [0, 1]);

    await $("button=Approve").click();
    await browser.waitUntil(async () => (await runRow.getText()).includes("passed"), {
      timeoutMsg: "review approval did not update the run",
    });

    await $("aria/Terminal").click();
    const commandInput = await $("input[placeholder='Run one-shot workspace command']");
    await commandInput.waitForDisplayed();
    await commandInput.setValue("printf installed-e2e");
    await $(".command-runner button").click();
    await $(".command-result").waitForDisplayed();
    assert.match(await $(".command-result").getText(), /installed-e2e/);

    const storage = await browser.execute(() => Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter(Boolean)
        .map((key) => [key, localStorage.getItem(key)]),
    ));
    assert.equal(JSON.stringify(storage).includes(ACCESS_TOKEN), false);

    await browser.reloadSession();
    await $(".health.ok").waitForDisplayed({ timeout: 20_000 });
    const credentialPersisted = await browser.tauri.execute(
      async ({ core }, id) => Boolean(await core.invoke("load_secret", { profileId: id })),
      profileId,
    );
    assert.equal(credentialPersisted, true);
  });
});

async function setInput(label, value) {
  const input = await $(`//label[contains(normalize-space(.),'${label}')]/input`);
  await input.waitForDisplayed();
  await input.setValue(value);
}

async function startFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = publicKey.export({ format: "jwk" });
  Object.assign(publicJwk, { alg: "RS256", kid: "loom-e2e", use: "sig" });
  let issuer = "";
  let oidcRequest;
  let runStatus = "running";
  let command;
  const streamAfter = [];
  const openStreams = new Set();

  const oidcServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      return sendJson(response, {
        issuer,
        authorization_endpoint: `${issuer}authorize`,
        token_endpoint: `${issuer}token`,
        jwks_uri: `${issuer}jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile"],
        claims_supported: ["iss", "sub", "aud", "exp", "iat", "nonce"],
      });
    }
    if (url.pathname === "/jwks") return sendJson(response, { keys: [publicJwk] });
    if (url.pathname === "/authorize") {
      oidcRequest = {
        state: required(url.searchParams, "state"),
        nonce: required(url.searchParams, "nonce"),
        challenge: required(url.searchParams, "code_challenge"),
        clientId: required(url.searchParams, "client_id"),
      };
      response.writeHead(302, {
        location: `loom://auth/callback?code=installed-e2e-code&state=${encodeURIComponent(oidcRequest.state)}`,
      });
      return response.end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const body = new URLSearchParams(await readBody(request));
      assert.equal(body.get("code"), "installed-e2e-code");
      assert.equal(body.get("client_id"), oidcRequest.clientId);
      const challenge = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
      assert.equal(challenge, oidcRequest.challenge);
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt(privateKey, { iss: issuer, sub: "installed-e2e-user", aud: oidcRequest.clientId, exp: now + 300, iat: now, nonce: oidcRequest.nonce });
      return sendJson(response, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 300, id_token: idToken });
    }
    sendJson(response, { error: "not_found" }, 404);
  });
  issuer = `${await listen(oidcServer)}/`;

  const loomServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return sendJson(response, { error: "unauthorized" }, 401);
    const route = `/tenants/alice/runs/${RUN_ID}`;
    if (url.pathname === "/tenants/alice/status") {
      return sendJson(response, {
        tenant: "alice",
        api: { version: "v1", capabilities: [...LOOM_CLIENT_CAPABILITIES] },
        server: { startedAt: new Date().toISOString(), uptimeMs: 1, runWorkspaceIsolation: "run" },
        readiness: { ok: true, missing: [] },
        resources: { activeRuns: 1, queuedRuns: 0, activeWorkspaceSessions: 0 },
        policy: { allowedTools: ["shell.exec"] },
      });
    }
    if (url.pathname === "/tenants/alice/projects") return sendJson(response, [{ project: PROJECT }]);
    if (url.pathname === "/tenants/alice/runs") return sendJson(response, [runSummary(runStatus)]);
    if (url.pathname === `${route}/workspace`) {
      return sendJson(response, { tenant: "alice", project: PROJECT, runId: RUN_ID, route: "run", cwd: "/workspace" });
    }
    if (url.pathname === `${route}/events/stream`) {
      const after = Number(url.searchParams.get("after") ?? 0);
      streamAfter.push(after);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (after === 0) {
        response.end(sse({ seq: 1, type: "start", at: new Date().toISOString(), data: { message: "installed app stream" } }));
      } else {
        runStatus = "review_required";
        response.write(sse({ seq: 2, type: "review_required", at: new Date().toISOString(), data: { message: "human review" } }));
        openStreams.add(response);
        response.on("close", () => openStreams.delete(response));
      }
      return;
    }
    if (url.pathname === `${route}/review` && request.method === "POST") {
      runStatus = "passed";
      return sendJson(response, runSummary(runStatus));
    }
    if (url.pathname === `${route}/presence`) return sendJson(response, request.method === "GET" ? [] : { clientId: "desktop-e2e", label: "Desktop E2E", lastSeenAt: new Date().toISOString() });
    if (url.pathname === `${route}/sessions` && request.method === "GET") return sendJson(response, []);
    if (url.pathname === `${route}/commands` && request.method === "GET") return sendJson(response, command ? [command] : []);
    if (url.pathname === `${route}/commands` && request.method === "POST") {
      const input = JSON.parse(await readBody(request));
      command = {
        commandId: "command-installed-e2e", tenant: "alice", project: PROJECT, runId: RUN_ID, route: "run",
        command: input.command, stdout: "installed-e2e", stderr: "", exitCode: 0,
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      };
      return sendJson(response, command);
    }
    sendJson(response, { error: "not_found", path: url.pathname }, 404);
  });
  const loomUrl = await listen(loomServer);

  return {
    issuer,
    loomUrl,
    streamAfter,
    async close() {
      for (const response of openStreams) response.end();
      await Promise.all([close(loomServer), close(oidcServer)]);
    },
  };
}

function runSummary(status) {
  return {
    runId: RUN_ID,
    tenant: "alice",
    project: PROJECT,
    goal: "Installed app E2E run",
    status,
    createdAt: "2026-07-12T00:00:00.000Z",
    startedAt: "2026-07-12T00:00:01.000Z",
  };
}

function jwt(privateKey, claims) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "loom-e2e", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function sse(event) {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function required(values, name) {
  const value = values.get(name);
  assert.ok(value, `OIDC ${name} is required`);
  return value;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
