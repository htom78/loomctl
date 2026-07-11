import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("production-check fails closed with a token-free report when required configuration is missing", () => {
  let error: { stdout?: Buffer | string; status?: number } | undefined;
  try {
    execFileSync(process.execPath, ["scripts/production-check.mjs"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "production" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (caught) {
    error = caught as typeof error;
  }
  assert.equal(error?.status, 1);
  const report = JSON.parse(String(error?.stdout));
  assert.equal(report.schemaVersion, "loom-production-check/v1");
  assert.equal(report.tokenFree, true);
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check: { name: string }) => check.name === "LOOM_POSTGRES_URL")?.ok, false);
  assert.equal(String(error?.stdout).includes("admin-secret"), false);
  assert.equal(String(error?.stdout).includes("Bearer "), false);
});
