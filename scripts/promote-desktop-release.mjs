#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const channel = process.argv[2];
const versionTag = process.argv[3];
if (!(["stable", "beta"].includes(channel)) || !/^desktop-(stable|beta)-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionTag)) {
  throw new Error("usage: promote-desktop-release.mjs <stable|beta> <desktop-channel-vVERSION>");
}

const rollingTag = `desktop-${channel}`;
const work = mkdtempSync(join(tmpdir(), "loom-desktop-promotion-"));
const nextDir = join(work, "next");
const previousDir = join(work, "previous");
mkdirSync(nextDir);
mkdirSync(previousDir);
run("gh", ["release", "download", versionTag, "--pattern", "latest.json", "--dir", nextDir]);

if (!releaseExists(rollingTag)) {
  const args = ["release", "create", rollingTag, "--title", `Loom Desktop ${channel} channel`, "--notes", "Signed rolling update metadata. Installers remain on immutable version releases."];
  if (channel === "beta") args.push("--prerelease");
  run("gh", args);
}

let previous;
if (releaseAssets(rollingTag).includes("latest.json")) {
  run("gh", ["release", "download", rollingTag, "--pattern", "latest.json", "--dir", previousDir]);
  previous = JSON.parse(readFileSync(join(previousDir, "latest.json"), "utf8"));
}
const next = JSON.parse(readFileSync(join(nextDir, "latest.json"), "utf8"));
if (typeof next.version !== "string" || !next.platforms || typeof next.platforms !== "object") {
  throw new Error("version release contains an invalid updater manifest");
}

const rollback = {
  schemaVersion: "loom-desktop-rollback/v1",
  channel,
  currentVersion: next.version,
  currentTag: versionTag,
  previousVersion: typeof previous?.version === "string" && previous.version !== next.version ? previous.version : undefined,
  previousTag: typeof previous?.version === "string" && previous.version !== next.version
    ? `desktop-${channel}-v${previous.version}`
    : undefined,
  publishedAt: new Date().toISOString(),
};
const rollbackPath = join(nextDir, "rollback.json");
writeFileSync(rollbackPath, `${JSON.stringify(rollback, null, 2)}\n`, "utf8");
if (rollback.previousVersion) {
  writeFileSync(join(nextDir, "rollback-latest.json"), `${JSON.stringify(previous, null, 2)}\n`, "utf8");
}

const assets = [join(nextDir, "latest.json"), rollbackPath];
if (rollback.previousVersion) assets.push(join(nextDir, "rollback-latest.json"));
run("gh", ["release", "upload", rollingTag, ...assets, "--clobber"]);
process.stdout.write(`${JSON.stringify(rollback)}\n`);

function releaseExists(tag) {
  try { run("gh", ["release", "view", tag, "--json", "tagName"]); return true; }
  catch { return false; }
}

function releaseAssets(tag) {
  const value = JSON.parse(run("gh", ["release", "view", tag, "--json", "assets"]));
  return Array.isArray(value.assets) ? value.assets.map((asset) => asset.name) : [];
}

function run(command, args) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}
