#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { validateDesktopUpdaterManifest } from "./desktop-release-lib.mjs";

const [releaseId, tag, version, includeLinuxValue] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
if (!/^\d+$/.test(releaseId ?? "") || !repository || !tag || !version || !["true", "false"].includes(includeLinuxValue)) {
  throw new Error("usage: verify-desktop-release.mjs <release-id> <tag> <version> <true|false>");
}

const assets = JSON.parse(runGh(["api", `repos/${repository}/releases/${releaseId}/assets?per_page=100`]));
if (!Array.isArray(assets)) throw new Error("release assets response is invalid");
const latestAsset = assets.find((asset) => asset.name === "latest.json");
if (!latestAsset?.id) throw new Error("release is missing latest.json");
const manifest = JSON.parse(runGh([
  "api",
  "-H",
  "Accept: application/octet-stream",
  `repos/${repository}/releases/assets/${latestAsset.id}`,
]));
validateDesktopUpdaterManifest({
  manifest,
  expectedVersion: version,
  expectedTag: tag,
  repository,
  includeLinux: includeLinuxValue === "true",
  assets: assets.map((asset) => ({ id: asset.id, name: asset.name })),
});
process.stdout.write(`Verified signed updater manifest for ${tag}\n`);

function runGh(args) {
  return execFileSync("gh", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
