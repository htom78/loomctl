import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { browser } from "@wdio/globals";

const BASE_URL = requiredEnv("LOOM_DESKTOP_E2E_UPDATE_BASE_URL");
const APPLICATION = requiredEnv("LOOM_DESKTOP_E2E_BINARY");
const FORWARD_ARTIFACT = requiredEnv("LOOM_DESKTOP_E2E_FORWARD_ARTIFACT");
const FORWARD_IMAGE = requiredEnv("LOOM_DESKTOP_E2E_FORWARD_IMAGE");
const FORWARD_SIGNATURE = requiredEnv("LOOM_DESKTOP_E2E_FORWARD_SIGNATURE");
const ROLLBACK_ARTIFACT = requiredEnv("LOOM_DESKTOP_E2E_ROLLBACK_ARTIFACT");
const ROLLBACK_IMAGE = requiredEnv("LOOM_DESKTOP_E2E_ROLLBACK_IMAGE");
const ROLLBACK_SIGNATURE = requiredEnv("LOOM_DESKTOP_E2E_ROLLBACK_SIGNATURE");

describe("installed Loom Desktop updater", () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("installs a signed update and rolls back after restart", async () => {
    const forwardHash = await sha256(FORWARD_IMAGE);
    const rollbackHash = await sha256(ROLLBACK_IMAGE);
    assert.notEqual(forwardHash, rollbackHash);
    assert.equal(await sha256(APPLICATION), rollbackHash);

    const forward = await invoke("check_update", { channel: "stable", allowRollback: false });
    assert.deepEqual(pickVersion(forward), {
      version: "0.2.0",
      currentVersion: "0.1.0",
      rollback: false,
    });
    await installUpdate(forwardHash);

    await restart();
    const rollback = await invoke("check_update", { channel: "stable", allowRollback: true });
    assert.deepEqual(pickVersion(rollback), {
      version: "0.1.0",
      currentVersion: "0.2.0",
      rollback: true,
    });
    assert.deepEqual(await invoke("rollback_metadata", { channel: "stable" }), {
      schemaVersion: "loom-desktop-rollback/v1",
      channel: "stable",
      currentVersion: "0.2.0",
      currentTag: "desktop-stable-v0.2.0",
      previousVersion: "0.1.0",
      previousTag: "desktop-stable-v0.1.0",
      publishedAt: "2026-07-13T00:00:00.000Z",
    });
    await installUpdate(rollbackHash);

    await restart();
    const restored = await invoke("check_update", { channel: "stable", allowRollback: false });
    assert.deepEqual(pickVersion(restored), {
      version: "0.2.0",
      currentVersion: "0.1.0",
      rollback: false,
    });
  });
});

async function startFixture() {
  const forwardSignature = (await readFile(FORWARD_SIGNATURE, "utf8")).trim();
  const rollbackSignature = (await readFile(ROLLBACK_SIGNATURE, "utf8")).trim();
  const origin = new URL(BASE_URL);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/stable/latest.json") {
      return sendJson(response, manifest("0.2.0", "/artifacts/forward", forwardSignature));
    }
    if (url.pathname === "/stable/rollback-latest.json") {
      return sendJson(response, manifest("0.1.0", "/artifacts/rollback", rollbackSignature));
    }
    if (url.pathname === "/stable/rollback.json") {
      return sendJson(response, {
        schemaVersion: "loom-desktop-rollback/v1",
        channel: "stable",
        currentVersion: "0.2.0",
        currentTag: "desktop-stable-v0.2.0",
        previousVersion: "0.1.0",
        previousTag: "desktop-stable-v0.1.0",
        publishedAt: "2026-07-13T00:00:00.000Z",
      });
    }
    if (url.pathname === "/artifacts/forward") return sendFile(response, FORWARD_ARTIFACT);
    if (url.pathname === "/artifacts/rollback") return sendFile(response, ROLLBACK_ARTIFACT);
    response.writeHead(404).end();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, resolve);
  });
  return {
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function manifest(version, path, signature) {
  return {
    version,
    notes: `Loom Desktop ${version} updater E2E`,
    pub_date: "2026-07-13T00:00:00Z",
    url: new URL(path, BASE_URL).href,
    signature,
  };
}

async function sendFile(response, path) {
  try {
    const metadata = await stat(path);
    response.writeHead(200, {
      "content-length": metadata.size,
      "content-type": "application/octet-stream",
    });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(500).end();
  }
}

function sendJson(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

async function invoke(command, args = {}) {
  return browser.execute(
    async (name, payload) => window.__TAURI__.core.invoke(name, payload),
    command,
    args,
  );
}

async function restart() {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await browser.reloadSession();
  await browser.waitUntil(async () => (await browser.getTitle()) === "Loom Desktop", {
    timeout: 20_000,
    timeoutMsg: "updated desktop process did not restart",
  });
}

async function installUpdate(expectedHash) {
  let installed;
  try {
    installed = await invoke("install_update");
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  if (installed !== undefined) assert.equal(installed, true);
  await waitForHash(expectedHash);
}

async function waitForHash(expected) {
  const deadline = Date.now() + Number(process.env.LOOM_DESKTOP_E2E_UPDATE_TIMEOUT_MS ?? 30_000);
  while (Date.now() < deadline) {
    if (await sha256(APPLICATION).catch(() => "") === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("installed application hash did not change");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function pickVersion(update) {
  assert.ok(update);
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    rollback: update.rollback,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
