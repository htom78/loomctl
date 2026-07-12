import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("production-check loads a complete env file without exposing secret values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loom-production-check-"));
  const envPath = join(directory, "production.env");
  const secret = "production-check-secret";
  const env = [
    "LOOM_WORKSPACE_ROOT=/data/loom/workspaces",
    `LOOM_POSTGRES_URL=postgres://loom:${secret}@postgres:5432/loom`,
    `LOOM_POSTGRES_PASSWORD=${secret}`,
    "LOOM_REDIS_URL=redis://redis.internal:6379",
    "LOOM_MODEL_BASE_URL=https://litellm.example.com",
    "LOOM_MODEL_KEY_ENV=LOOM_MODEL_KEY",
    `LOOM_MODEL_KEY=${secret}`,
    "LOOM_CODER_WORKSPACE=loom-{tenant}",
    "LOOM_CODER_WORKTREE_CWD=/home/dev/projects/{project}/.worktrees/{runId}",
    "LOOM_CODER_IDE_URL=https://coder.example/@{tenant}/{project}/{runId}",
    "LOOM_CODER_PREVIEW_URL=https://preview.example/{tenant}/{project}/{runId}",
    "LOOM_CONTROL_PLANE_URL=https://git.example.com",
    "LOOM_CONTROL_PLANE_TOKEN_ENV=LOOM_CONTROL_PLANE_TOKEN",
    `LOOM_CONTROL_PLANE_TOKEN=${secret}`,
    "LOOM_CONTROL_PLANE_WEBHOOK_SECRET_ENV=LOOM_GITEA_WEBHOOK_SECRET",
    `LOOM_GITEA_WEBHOOK_SECRET=${secret}`,
    "LOOM_OIDC_ISSUER=https://identity.example.com",
    "LOOM_OIDC_AUDIENCE=loom",
    "LOOM_OPERATOR_TOKEN_ENV=LOOM_OPERATOR_TOKEN",
    `LOOM_OPERATOR_TOKEN=${secret}`,
  ].join("\n");
  await writeFile(envPath, env, "utf8");

  const stdout = execFileSync(process.execPath, ["scripts/production-check.mjs", envPath], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    encoding: "utf8",
  });
  const report = JSON.parse(stdout);
  assert.equal(report.preflight.ok, true);
  assert.equal(report.ok, true);
  assert.equal(stdout.includes(secret), false);

  await writeFile(envPath, env.replaceAll(secret, "CHANGE_ME"), "utf8");
  let placeholderError: { stdout?: Buffer | string; status?: number } | undefined;
  try {
    execFileSync(process.execPath, ["scripts/production-check.mjs", envPath], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "production" },
      encoding: "utf8",
    });
  } catch (caught) {
    placeholderError = caught as typeof placeholderError;
  }
  assert.equal(placeholderError?.status, 1);
  assert.equal(JSON.parse(String(placeholderError?.stdout)).preflight.ok, false);
  assert.equal(String(placeholderError?.stdout).includes("CHANGE_ME"), false);
});

test("production compose wires every checked authentication input", async () => {
  const [compose, example] = await Promise.all([
    readFile("deploy/production/compose.yml", "utf8"),
    readFile("deploy/production/.env.example", "utf8"),
  ]);
  for (const value of [
    "--oidc-issuer",
    "${LOOM_OIDC_ISSUER}",
    "--oidc-audience",
    "${LOOM_OIDC_AUDIENCE}",
    "--control-plane-merge",
    "--control-plane-comment",
    "--tenant-control-plane-token-env",
    "--control-plane-webhook-secret-env",
    "--ingest-brain",
    "git.pr",
    "LOOM_GITEA_WEBHOOK_SECRET",
  ]) assert.ok(compose.includes(value), `production compose is missing ${value}`);
  for (const name of [
    "LOOM_MODEL_KEY",
    "LOOM_POSTGRES_PASSWORD",
    "LOOM_CONTROL_PLANE_TOKEN",
    "LOOM_CONTROL_PLANE_WEBHOOK_SECRET_ENV",
    "LOOM_GITEA_WEBHOOK_SECRET",
  ]) assert.match(example, new RegExp(`^${name}=`, "m"));
});
