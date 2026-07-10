import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runPlatformOperatorCockpitRunner } from "../src/harness/platform-operator-cockpit-runner.js";

test("operator cockpit runner refuses unresolved command placeholders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "loom-operator-cockpit-placeholder-"));
  const markerPath = join(dir, "executed.txt");
  const nextPath = join(dir, "operator-cockpit-next.json");
  await writeFile(nextPath, `${JSON.stringify({
    schemaVersion: "platform-operator-cockpit-next/v1",
    tokenFree: true,
    phase: "prepare-pre-serve",
    state: "ready-to-run",
    pendingStepCount: 1,
    missingInputCount: 0,
    commandRefCount: 1,
    currentStepId: "github-actions",
    currentBlockingGroupId: "github-actions",
    currentStepMissingInputCount: 0,
    commandRef: {
      label: "placeholder-command",
      command: `${process.execPath} -e <github-run-id>`,
      commandArgs: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed")`,
        "<github-run-id>",
      ],
    },
  }, null, 2)}\n`, "utf8");

  const result = await runPlatformOperatorCockpitRunner({ dir, next: nextPath, execute: true });

  assert.equal(result.ok, false);
  assert.equal(result.mode, "needs-input");
  assert.deepEqual(result.missing, ["commandRef.placeholder.github-run-id"]);
  assert.equal(result.execution?.requested, true);
  assert.equal(existsSync(markerPath), false);
  assert.equal(existsSync(join(dir, ".loom", "operator-cockpit-runner.lock")), false);
});
