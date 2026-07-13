import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

// The top-level `loom run` is the single-user front door to the harness kernel.
// These lock its contract: it runs the loop locally and the verification gate
// decides the exit code (passed -> 0, failed -> 1).
const FINISH_SCRIPT = JSON.stringify([{ message: "finish", finish: true }]);

async function loomRun(cwd: string, scriptPath: string, verify: string, extra: string[] = []): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  // Run from the repo (so `--import tsx` resolves) and point the workspace at the
  // temp dir via --cwd; setting execa's cwd to the temp dir would break tsx resolution.
  const result = await execa(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src/index.ts"), "run", "single-user smoke", "--cwd", cwd, "--script", scriptPath, "--verify", verify, ...extra],
    { reject: false },
  );
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

test("loom run passes the verification gate and exits 0", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-run-pass-"));
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, FINISH_SCRIPT, "utf8");

  const { exitCode, stdout } = await loomRun(cwd, scriptPath, "true");
  assert.equal(exitCode, 0);
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "passed");
  assert.equal(summary.metadata.tenant, "local");
  assert.equal(summary.verification.ok, true);
});

test("loom run --watch streams events to stderr while stdout stays clean JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-run-watch-"));
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, FINISH_SCRIPT, "utf8");

  const { exitCode, stdout, stderr } = await loomRun(cwd, scriptPath, "true", ["--watch"]);
  assert.equal(exitCode, 0);
  // stderr carries the live event stream...
  assert.match(stderr, /verify/);
  assert.match(stderr, /finish/);
  // ...while stdout remains the parseable summary.
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "passed");
});

test("loom run fails the verification gate and exits 1", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-run-fail-"));
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, FINISH_SCRIPT, "utf8");

  const { exitCode, stdout } = await loomRun(cwd, scriptPath, "false");
  assert.equal(exitCode, 1);
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, "failed");
  assert.equal(summary.verification.ok, false);
});
