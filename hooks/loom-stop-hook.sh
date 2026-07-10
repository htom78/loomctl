#!/usr/bin/env bash
# Claude Code "Stop" hook → feeds one run signal to the loom brain.
# Reads the hook payload on stdin; derives an outcome; sends a RunSignal to the central
# harness brain endpoint when configured, otherwise pipes it to local `loom brain ingest`.
set -euo pipefail
cat >/dev/null   # consume the hook payload (session/cwd/etc.).

fallback_project="$(basename "$(pwd)")"

# Outcome heuristic — replace with your real gate (reviewer sub-agent verdict, CI, etc.).
if make test >/dev/null 2>&1 || npm test >/dev/null 2>&1; then outcome=pass; else outcome=fail; fi

signal="$(
  LOOM_FALLBACK_PROJECT="$fallback_project" LOOM_OUTCOME="$outcome" node <<'NODE'
const fs = require("node:fs");

function readNativeGoalContext() {
  const candidates = [process.env.LOOM_NATIVE_GOAL_CONTEXT, ".loom/native-goal.json"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch (error) {
      if (error && error.code !== "ENOENT") continue;
    }
  }
  return {};
}

function stringField(record, field) {
  return typeof record[field] === "string" && record[field].trim() ? record[field] : undefined;
}

function stringArrayField(record, field) {
  return Array.isArray(record[field])
    ? record[field].map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean)
    : [];
}

function envList(name) {
  return process.env[name]
    ? process.env[name].split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean)
    : [];
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

const skillsPath = ".claude/active-skills";
const nativeGoal = readNativeGoalContext();
const fileSkills = fs.existsSync(skillsPath)
  ? fs.readFileSync(skillsPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  : [];
const nativeSkills = uniqueStrings(envList("LOOM_SKILLS")
  .concat(envList("LOOM_NATIVE_GOAL_SKILLS"), stringArrayField(nativeGoal, "skills")));
const signal = {
  ts: new Date().toISOString(),
  project: stringField(nativeGoal, "project") || process.env.LOOM_FALLBACK_PROJECT,
  skills: fileSkills.length ? fileSkills : nativeSkills,
  outcome: process.env.LOOM_OUTCOME,
};
for (const [field, envName] of Object.entries({
  runId: "LOOM_RUN_ID",
  runDir: "LOOM_RUN_DIR",
  status: "LOOM_STATUS",
  issue: "LOOM_ISSUE",
  issueUrl: "LOOM_ISSUE_URL",
  dashboardUrl: "LOOM_DASHBOARD_URL",
  summaryUrl: "LOOM_SUMMARY_URL",
  reviewSummaryUrl: "LOOM_REVIEW_SUMMARY_URL",
  handoffPackageUrl: "LOOM_HANDOFF_PACKAGE_URL",
  handoffFollowupsUrl: "LOOM_HANDOFF_FOLLOWUPS_URL",
  failureKind: "LOOM_FAILURE_KIND",
  notes: "LOOM_BRAIN_NOTES",
})) {
  if (process.env[envName]) signal[field] = process.env[envName];
}
for (const field of ["runId", "issue", "issueUrl"]) {
  if (!signal[field]) {
    const value = stringField(nativeGoal, field);
    if (value) signal[field] = value;
  }
}
if (!signal.runDir) {
  const cwd = stringField(nativeGoal, "cwd");
  if (cwd) signal.runDir = cwd;
}
if (!signal.status) signal.status = signal.outcome === "pass" ? "passed" : "failed";
for (const [field, envName] of Object.entries({
  modelRequestCount: "LOOM_MODEL_REQUEST_COUNT",
  modelPromptTokens: "LOOM_MODEL_PROMPT_TOKENS",
  modelCompletionTokens: "LOOM_MODEL_COMPLETION_TOKENS",
  modelTotalTokens: "LOOM_MODEL_TOTAL_TOKENS",
})) {
  if (!process.env[envName]) continue;
  const value = Number(process.env[envName]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${envName} must be a non-negative integer`);
  }
  signal[field] = value;
}
if (process.env.LOOM_MODEL_COST_USD) {
  const value = Number(process.env.LOOM_MODEL_COST_USD);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("LOOM_MODEL_COST_USD must be a non-negative number");
  }
  signal.modelCostUsd = value;
}
if (process.env.LOOM_BRAIN_CLIENT_ID) signal.clientId = process.env.LOOM_BRAIN_CLIENT_ID;
console.log(JSON.stringify(signal));
NODE
)"

if [[ -n "${LOOM_BRAIN_INGEST_URL:-}" ]]; then
  if [[ -n "${LOOM_BRAIN_INGEST_TOKEN:-}" ]]; then
    curl -fsS -X POST "${LOOM_BRAIN_INGEST_URL}" \
      -H "content-type: application/json" \
      -H "authorization: Bearer ${LOOM_BRAIN_INGEST_TOKEN}" \
      --data-binary "$signal" >/dev/null
  else
    curl -fsS -X POST "${LOOM_BRAIN_INGEST_URL}" \
      -H "content-type: application/json" \
      --data-binary "$signal" >/dev/null
  fi
else
  printf '%s\n' "$signal" | loom brain ingest
fi
