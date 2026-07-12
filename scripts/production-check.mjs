#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const envFile = process.argv[2];
if (envFile) process.loadEnvFile(resolve(root, envFile));
const checks = [];
const check = (name, ok, details = {}) => checks.push({ name, ok, ...details });
const required = (name, details = {}) => {
  const ok = Boolean(process.env[name]?.trim());
  check(name, ok, { required: true, ...details });
  return ok;
};
const requiredConnection = (name) => {
  const value = process.env[name]?.trim();
  const ok = Boolean(value && !value.includes("CHANGE_ME"));
  check(name, ok, { required: true, kind: "connection" });
  return ok;
};
const requiredSecret = (name) => {
  const value = process.env[name]?.trim();
  const ok = Boolean(value && value !== "CHANGE_ME");
  check(name, ok, { required: true, kind: "secret" });
  return ok;
};
const requiredSecretEnv = (name) => {
  const envName = process.env[name];
  const validName = typeof envName === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envName);
  const value = validName ? process.env[envName]?.trim() : undefined;
  const ok = Boolean(value && value !== "CHANGE_ME");
  check(`${name}->value`, ok, { required: true, kind: "secret-env", envName: validName ? envName : undefined });
  return ok;
};
const requiredHttpsUrl = (name) => {
  const value = process.env[name];
  let ok = false;
  try {
    const parsed = new URL(value ?? "");
    ok = parsed.protocol === "https:" || (parsed.protocol === "http:" && process.env.LOOM_ALLOW_INSECURE_PRODUCTION_HTTP === "1");
  } catch {}
  check(name, ok, { required: true, kind: "https-url" });
  return ok;
};

check("build", existsSync(resolve(root, "dist/index.js")), { required: true, hint: "run npm run build" });
required("LOOM_WORKSPACE_ROOT", { kind: "path" });
requiredConnection("LOOM_POSTGRES_URL");
requiredSecret("LOOM_POSTGRES_PASSWORD");
requiredConnection("LOOM_REDIS_URL");
requiredHttpsUrl("LOOM_MODEL_BASE_URL");
required("LOOM_MODEL_KEY_ENV", { kind: "env-name" });
required("LOOM_CODER_WORKSPACE", { kind: "template" });
required("LOOM_CODER_WORKTREE_CWD", { kind: "template" });
required("LOOM_CODER_IDE_URL", { kind: "url-template" });
required("LOOM_CODER_PREVIEW_URL", { kind: "url-template" });
requiredHttpsUrl("LOOM_CONTROL_PLANE_URL");
required("LOOM_CONTROL_PLANE_TOKEN_ENV", { kind: "env-name" });
requiredSecretEnv("LOOM_CONTROL_PLANE_TOKEN_ENV");
required("LOOM_CONTROL_PLANE_WEBHOOK_SECRET_ENV", { kind: "env-name" });
requiredSecretEnv("LOOM_CONTROL_PLANE_WEBHOOK_SECRET_ENV");
requiredHttpsUrl("LOOM_OIDC_ISSUER");
required("LOOM_OIDC_AUDIENCE");
required("LOOM_OPERATOR_TOKEN_ENV", { kind: "env-name" });
requiredSecretEnv("LOOM_OPERATOR_TOKEN_ENV");
requiredSecretEnv("LOOM_MODEL_KEY_ENV");

const preflightOk = checks.every((item) => item.ok);
let doctor = { ok: false, skipped: true };
if (preflightOk) {
  const operatorEnv = process.env.LOOM_OPERATOR_TOKEN_ENV;
  const args = [
    "dist/index.js", "harness", "doctor",
    "--profile", "platform-readiness",
    "--workspace-root", process.env.LOOM_WORKSPACE_ROOT,
    "--state-backend", "postgres-redis",
    "--state-postgres-url-env", "LOOM_POSTGRES_URL",
    "--state-redis-url-env", "LOOM_REDIS_URL",
    "--executor", "coder",
    "--executor-workspace", process.env.LOOM_CODER_WORKSPACE,
    "--executor-worktree-cwd", process.env.LOOM_CODER_WORKTREE_CWD,
    "--executor-ide-url", process.env.LOOM_CODER_IDE_URL,
    "--executor-preview-url", process.env.LOOM_CODER_PREVIEW_URL,
    "--model-base-url", process.env.LOOM_MODEL_BASE_URL,
    "--model-key-env", process.env.LOOM_MODEL_KEY_ENV,
    "--control-plane-url", process.env.LOOM_CONTROL_PLANE_URL,
    "--control-plane-token-env", process.env.LOOM_CONTROL_PLANE_TOKEN_ENV,
    "--tenant-control-plane-token-env", `production=${process.env.LOOM_CONTROL_PLANE_TOKEN_ENV}`,
    "--control-plane-pr",
    "--control-plane-merge",
    "--control-plane-comment",
    "--control-plane-comment-sync",
    "--control-plane-webhook-secret-env", process.env.LOOM_CONTROL_PLANE_WEBHOOK_SECRET_ENV,
    "--ingest-brain",
    "--allow-tool", "git.pr",
    "--oidc-issuer", process.env.LOOM_OIDC_ISSUER,
    "--oidc-audience", process.env.LOOM_OIDC_AUDIENCE,
    "--tenant-key-env", `production=${operatorEnv}:operator:admin`,
  ];
  try {
    doctor = JSON.parse(execFileSync(process.execPath, args, { cwd: root, env: process.env, encoding: "utf8" }));
  } catch (error) {
    try { doctor = JSON.parse(error?.stdout?.toString?.() ?? ""); } catch { doctor = { ok: false, error: "doctor did not return JSON" }; }
  }
}

const report = {
  schemaVersion: "loom-production-check/v1",
  tokenFree: true,
  preflight: { ok: preflightOk },
  checks,
  doctor,
  ok: preflightOk && doctor.ok === true,
};
const reportPath = process.env.LOOM_PRODUCTION_CHECK_REPORT;
if (reportPath) {
  const path = resolve(reportPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
