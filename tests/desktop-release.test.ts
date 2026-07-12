import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildRollbackMetadata,
  promotionVersion,
  staleRollbackAssets,
  validateDesktopUpdaterManifest,
} from "../scripts/desktop-release-lib.mjs";

const repository = "htom78/loomctl";
const tag = "desktop-stable-v0.2.0";

test("desktop release workflow serializes updater JSON and verifies the draft", () => {
  const workflow = readFileSync(".github/workflows/desktop-release.yml", "utf8");
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /verify-desktop-release\.mjs/);
});

test("desktop release verifier requires every signed platform asset on the immutable tag", () => {
  const fixture = releaseFixture(true);
  validateDesktopUpdaterManifest(fixture);

  delete fixture.manifest.platforms["windows-aarch64"];
  assert.throws(() => validateDesktopUpdaterManifest(fixture), /windows-aarch64/);
});

test("desktop release verifier rejects unpinned URLs and missing signature assets", () => {
  const unpinned = releaseFixture(false);
  unpinned.manifest.platforms["darwin-aarch64"].url = unpinned.manifest.platforms["darwin-aarch64"].url.replace(tag, "desktop-stable");
  assert.throws(() => validateDesktopUpdaterManifest(unpinned), /not pinned/);

  const missingSignature = releaseFixture(false);
  missingSignature.assets = missingSignature.assets.filter((asset) => asset.name !== "Loom_Desktop_0.2.0_aarch64.app.tar.gz.sig");
  assert.throws(() => validateDesktopUpdaterManifest(missingSignature), /artifact and signature/);
});

test("desktop release verifier accepts asset-ID URLs only for the same release", () => {
  const fixture = releaseFixture(false);
  fixture.manifest.platforms["darwin-aarch64"].url = `https://api.github.com/repos/${repository}/releases/assets/1`;
  validateDesktopUpdaterManifest(fixture);

  fixture.manifest.platforms["darwin-aarch64"].url = `https://api.github.com/repos/${repository}/releases/assets/999`;
  assert.throws(() => validateDesktopUpdaterManifest(fixture), /artifact and signature/);
});

test("desktop promotion creates bounded first-release and consecutive rollback metadata", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const next = manifest("0.2.0");
  const first = buildRollbackMetadata("stable", tag, next, undefined, now);
  assert.equal(first.previousVersion, undefined);
  assert.equal(first.previousTag, undefined);

  const consecutive = buildRollbackMetadata("stable", tag, next, manifest("0.1.0"), now);
  assert.equal(consecutive.previousVersion, "0.1.0");
  assert.equal(consecutive.previousTag, "desktop-stable-v0.1.0");
  assert.equal(consecutive.publishedAt, now.toISOString());
});

test("desktop promotion rejects drift and removes stale rollback assets", () => {
  assert.throws(() => promotionVersion("stable", "desktop-beta-v0.2.0"), /usage/);
  assert.throws(
    () => buildRollbackMetadata("stable", tag, manifest("0.1.0"), undefined),
    /invalid updater manifest/,
  );
  const rollback = buildRollbackMetadata("stable", tag, manifest("0.2.0"), manifest("0.2.0"));
  assert.deepEqual(staleRollbackAssets(["latest.json", "rollback-latest.json"], rollback), ["rollback-latest.json"]);
});

function releaseFixture(includeLinux: boolean) {
  const targetAssets = {
    "darwin-aarch64": "Loom_Desktop_0.2.0_aarch64.app.tar.gz",
    "darwin-x86_64": "Loom_Desktop_0.2.0_x64.app.tar.gz",
    "windows-aarch64": "Loom_Desktop_0.2.0_arm64.msi.zip",
    "windows-x86_64": "Loom_Desktop_0.2.0_x64.msi.zip",
    ...(includeLinux ? { "linux-x86_64": "Loom_Desktop_0.2.0_amd64.AppImage.tar.gz" } : {}),
  };
  const assets = Object.values(targetAssets)
    .flatMap((asset) => [asset, `${asset}.sig`])
    .map((name, index) => ({ id: index + 1, name }));
  return {
    manifest: {
      version: "0.2.0",
      platforms: Object.fromEntries(Object.entries(targetAssets).map(([target, asset]) => [target, {
        signature: `signature-${target}`,
        url: `https://github.com/${repository}/releases/download/${tag}/${asset}`,
      }])),
    },
    expectedVersion: "0.2.0",
    expectedTag: tag,
    repository,
    includeLinux,
    assets,
  };
}

function manifest(version: string) {
  return { version, platforms: { "linux-x86_64": { signature: "signature", url: "https://example.test/artifact" } } };
}
