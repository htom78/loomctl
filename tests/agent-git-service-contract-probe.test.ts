import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  compareAgentGitServiceContractReports,
  probeAgentGitServiceContract,
} from "../src/harness/agent-git-service-contract-probe.js";
import { startAgentGitServiceContractServer } from "./support/agent-git-service-contract.js";

test("probeAgentGitServiceContract reports token-free AGS discovery readiness", async () => {
  const ags = await startAgentGitServiceContractServer();

  try {
    const result = await probeAgentGitServiceContract({
      baseUrl: ags.baseUrl,
      token: "secret-token",
    });

    assert.equal(result.ok, true);
    assert.equal(result.schemaVersion, "agent-git-service-contract-probe/v1");
    assert.equal(result.provider, "agent-git-service");
    assert.equal(result.apiBasePath, "/api/v3");
    assert.equal(result.readOnly, true);
    assert.equal(result.authorizationScheme, "Bearer");
    assert.equal(result.baseUrl, ags.baseUrl);
    assert.equal(result.requestsTokenFree, true);
    assert.deepEqual(result.missingEndpoints, []);
    assert.deepEqual(result.invalidEndpoints, []);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.endpoint), [
      "/api/v3",
      "/api/v3/meta",
      "/api/v3/rate_limit",
    ]);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.status), [200, 200, 200]);
    assert.ok(result.nativeCapabilities.includes("agent-identities"));
    assert.ok(result.nativeCapabilities.includes("wiki-memory"));
    assert.doesNotMatch(JSON.stringify(result), /secret-token/);
    assert.deepEqual(ags.requests.map((request) => request.authorization), [
      "Bearer secret-token",
      "Bearer secret-token",
      "Bearer secret-token",
    ]);
  } finally {
    await ags.close();
  }
});

test("probeAgentGitServiceContract marks missing AGS discovery endpoints without leaking tokens", async () => {
  const ags = await startPartialAgentGitServiceServer();

  try {
    const result = await probeAgentGitServiceContract({
      baseUrl: ags.baseUrl,
      token: "another-secret-token",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingEndpoints, ["/api/v3/meta", "/api/v3/rate_limit"]);
    assert.equal(result.endpoints.find((endpoint) => endpoint.endpoint === "/api/v3")?.status, 200);
    assert.equal(result.endpoints.find((endpoint) => endpoint.endpoint === "/api/v3/meta")?.status, 404);
    assert.equal(result.endpoints.find((endpoint) => endpoint.endpoint === "/api/v3/rate_limit")?.status, 404);
    assert.doesNotMatch(JSON.stringify(result), /another-secret-token/);
    assert.deepEqual(ags.requests.map((request) => request.authorization), [
      "Bearer another-secret-token",
      "Bearer another-secret-token",
      "Bearer another-secret-token",
    ]);
  } finally {
    await ags.close();
  }
});

test("probeAgentGitServiceContract rejects empty 200 discovery shells", async () => {
  const ags = await startEmptyDiscoveryAgentGitServiceServer();

  try {
    const result = await probeAgentGitServiceContract({
      baseUrl: ags.baseUrl,
      token: "empty-discovery-secret",
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missingEndpoints, []);
    assert.deepEqual(result.invalidEndpoints, ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"]);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.status), [200, 200, 200]);
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.semanticOk), [false, false, false]);
    assert.ok(result.endpoints.every((endpoint) => endpoint.semanticErrors && endpoint.semanticErrors.length > 0));
    assert.doesNotMatch(JSON.stringify(result), /empty-discovery-secret/);
  } finally {
    await ags.close();
  }
});

test("compareAgentGitServiceContractReports reports token-free upstream drift", async () => {
  const ags = await startAgentGitServiceContractServer();

  try {
    const baseline = await probeAgentGitServiceContract({
      baseUrl: ags.baseUrl,
      token: "baseline-secret-token",
    });
    const candidate = {
      ...baseline,
      baseUrl: "https://upstream.example/api/v3",
      endpoints: baseline.endpoints.map((endpoint) =>
        endpoint.endpoint === "/api/v3/meta"
          ? { ...endpoint, url: "https://upstream.example/api/v3/meta", ok: false, status: 404 }
          : endpoint,
      ),
      missingEndpoints: ["/api/v3/meta"],
      nativeCapabilities: baseline.nativeCapabilities.filter((capability) => capability !== "wiki-memory"),
    };

    const comparison = compareAgentGitServiceContractReports({
      baseline,
      candidate,
    });

    assert.equal(comparison.ok, false);
    assert.equal(comparison.schemaVersion, "agent-git-service-contract-comparison/v1");
    assert.equal(comparison.tokenFree, true);
    assert.equal(comparison.baseline.schemaVersion, "agent-git-service-contract-probe/v1");
    assert.deepEqual(comparison.baseline.invalidEndpoints, []);
    assert.equal(comparison.candidate.baseUrl, "https://upstream.example/api/v3");
    assert.deepEqual(comparison.candidate.invalidEndpoints, []);
    assert.deepEqual(comparison.endpointMismatches, [
      {
        endpoint: "/api/v3/meta",
        baselineOk: true,
        candidateOk: false,
        baselineStatus: 200,
        candidateStatus: 404,
      },
    ]);
    assert.deepEqual(comparison.nativeCapabilities.missing, ["wiki-memory"]);
    assert.doesNotMatch(JSON.stringify(comparison), /baseline-secret-token/);
  } finally {
    await ags.close();
  }
});

async function startPartialAgentGitServiceServer(): Promise<{
  baseUrl: string;
  requests: Array<{ path: string; authorization?: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    requests.push({
      path: url.pathname,
      authorization: req.headers.authorization,
    });
    res.writeHead(url.pathname === "/api/v3" ? 200 : 404, { "content-type": "application/json" });
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("partial AGS server did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  };
}

async function startEmptyDiscoveryAgentGitServiceServer(): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("empty AGS server did not start");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v3`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  };
}
