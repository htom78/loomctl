import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PLANE_PROVIDER_BOUNDARY,
  CONTROL_PLANE_PROVIDER_CATALOG,
  DEFAULT_CONTROL_PLANE_PROVIDER,
  SERVE_CONTROL_PLANE_PROVIDERS,
  controlPlaneProviderCatalogEntry,
} from "../src/harness/control-plane.js";
import { agentGitServiceControlPlaneProvider } from "../src/harness/agent-git-service.js";
import {
  CONTROL_PLANE_PROVIDER_ADAPTERS,
  controlPlaneProviderAdapter,
} from "../src/harness/control-plane-registry.js";
import { giteaControlPlaneProvider } from "../src/harness/gitea.js";

test("control-plane provider catalog exposes agent-git-service as a serve-enabled candidate", () => {
  assert.equal(DEFAULT_CONTROL_PLANE_PROVIDER, "gitea-forgejo");
  assert.deepEqual(SERVE_CONTROL_PLANE_PROVIDERS, ["gitea-forgejo", "agent-git-service"]);

  assert.deepEqual(Object.keys(CONTROL_PLANE_PROVIDER_CATALOG).sort(), [
    "agent-git-service",
    "gitea-forgejo",
  ]);

  const gitea = controlPlaneProviderCatalogEntry("gitea-forgejo");
  assert.ok(gitea);
  assert.equal(gitea.status, "default");
  assert.equal(gitea.enabledForServe, true);
  assert.deepEqual(gitea.boundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);

  const agentGitService = controlPlaneProviderCatalogEntry("agent-git-service");
  assert.ok(agentGitService);
  assert.equal(agentGitService.status, "candidate");
  assert.equal(agentGitService.enabledForServe, true);
  assert.equal(agentGitService.adapterModule, "./agent-git-service.js");
  assert.deepEqual(agentGitService.boundary, [...CONTROL_PLANE_PROVIDER_BOUNDARY]);
  assert.ok(agentGitService.boundary.includes("workspace-branch-lease"));
  assert.equal(agentGitService.apiBasePath, "/api/v3");
  assert.deepEqual(agentGitService.discoveryEndpoints, ["/api/v3", "/api/v3/meta", "/api/v3/rate_limit"]);
  assert.ok(agentGitService.nativeCapabilities.includes("agent-identities"));
  assert.ok(agentGitService.nativeCapabilities.includes("issue-workspace-presence"));
  assert.ok(agentGitService.nativeCapabilities.includes("wiki-memory"));
  assert.deepEqual(agentGitService.adoptionStages.map((stage) => stage.name), [
    "adapter-seed",
    "operator-provisioning",
    "cutover-rehearsal",
    "tenant-default-cutover",
  ]);
  assert.equal(agentGitService.adoptionStages[0]?.state, "available");
  assert.equal(agentGitService.adoptionStages[3]?.state, "gated");
  assert.ok(agentGitService.adoptionStages[3]?.evidence.includes("repeat-platform-readiness-smoke"));
  assert.deepEqual(agentGitService.blockedBy, []);
});

test("control-plane provider adapters expose runtime contracts that match the catalog", () => {
  const providers = [giteaControlPlaneProvider, agentGitServiceControlPlaneProvider];

  assert.deepEqual(providers.map((provider) => provider.contract.provider), SERVE_CONTROL_PLANE_PROVIDERS);

  for (const provider of providers) {
    const catalog = controlPlaneProviderCatalogEntry(provider.contract.provider);
    assert.ok(catalog);
    assert.equal(provider.contract.apiBasePath, catalog.apiBasePath);
    assert.deepEqual(provider.contract.discoveryEndpoints, catalog.discoveryEndpoints);
    assert.deepEqual(provider.contract.nativeCapabilities, catalog.nativeCapabilities);
    assert.equal(provider.contract.boundary.includes("issue-comments"), true);
    assert.equal(provider.contract.boundary.includes("pull-requests"), true);
    assert.equal(provider.contract.boundary.includes("workspace-branch-lease"), true);
  }
});

test("control-plane provider registry resolves every serve-enabled adapter by catalog name", () => {
  assert.deepEqual(Object.keys(CONTROL_PLANE_PROVIDER_ADAPTERS).sort(), [...SERVE_CONTROL_PLANE_PROVIDERS].sort());

  for (const name of SERVE_CONTROL_PLANE_PROVIDERS) {
    const provider = controlPlaneProviderAdapter(name);
    assert.ok(provider);
    assert.equal(provider.contract.provider, name);
    assert.equal(provider, CONTROL_PLANE_PROVIDER_ADAPTERS[name]);
  }

  assert.equal(controlPlaneProviderAdapter("missing-provider"), undefined);
});
