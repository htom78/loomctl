import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { execa } from "execa";

const scriptPath = resolve("scripts/upstream-agent-git-service-local.sh");
const pinnedRef = "9ab722e07b0797b67da05ecb72ad3c0feae6abd3";

test("upstream AGS local integration script has valid bash syntax", async () => {
  const result = await execa("bash", ["-n", scriptPath], { reject: false });
  assert.equal(result.exitCode, 0, result.stderr);
});

test("upstream AGS local doctor emits a token-free red report without prerequisites", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-upstream-ags-script-"));
  const sourceDir = join(root, "missing-source");
  const reportDir = join(root, "reports");
  await mkdir(sourceDir, { recursive: true });

  const secretDsn = "secret-user:secret-password@tcp(db.internal:4000)/ags";
  const result = await execa("bash", [scriptPath, "doctor"], {
    reject: false,
    env: {
      ...process.env,
      DB_DSN: secretDsn,
      LOOM_AGS_SOURCE_DIR: sourceDir,
      LOOM_AGS_REPORT_DIR: reportDir,
      LOOM_AGS_DOCKER_BIN: "loom-test-missing-docker",
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.includes(secretDsn), false);
  assert.equal(result.stdout.includes("secret-password"), false);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schemaVersion, "loom-local-upstream-agent-git-service-doctor/v1");
  assert.equal(body.ok, false);
  assert.equal(body.tokenFree, true);
  assert.equal(body.targetClass, "local-upstream-e2e");
  assert.equal(body.externalStagingEligible, false);
  assert.equal(body.upstream.pinnedRef, pinnedRef);
  assert.equal(body.upstream.sourcePinned, false);
  assert.equal(body.runtime.dockerCli, false);
  assert.equal(body.database.envName, "DB_DSN");
  assert.equal(body.database.configured, true);
  assert.ok(body.missing.includes("runtime.dockerCli"));
  assert.ok(body.missing.includes("upstream.sourcePinned"));

  const written = JSON.parse(await readFile(join(reportDir, "doctor.json"), "utf8"));
  assert.deepEqual(written, body);
  assert.equal(JSON.stringify(written).includes(secretDsn), false);
});
