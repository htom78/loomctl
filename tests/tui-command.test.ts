import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

// `loom tui` draws a full-screen monitor on a TTY; under a pipe (no TTY, as here
// and in CI) it must fall back to line streaming. These lock that fallback: the
// loop runs, events stream to stderr, the summary is clean JSON on stdout, and no
// alternate-screen escape sequence leaks into piped output.
const FINISH_SCRIPT = JSON.stringify([{ message: "finish", finish: true }]);

async function loomTui(cwd: string, scriptPath: string, verify: string) {
  const result = await execa(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src/index.ts"), "tui", "tui smoke", "--cwd", cwd, "--script", scriptPath, "--verify", verify],
    { reject: false },
  );
  return result;
}

test("loom tui falls back to streaming under a pipe and passes the gate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-tui-pass-"));
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, FINISH_SCRIPT, "utf8");

  const result = await loomTui(cwd, scriptPath, "true");
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /finish/);
  assert.doesNotMatch(result.stdout, /\[\?1049/, "alt-screen escape must not leak to piped stdout");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
});

test("loom tui fallback reports the failing gate as exit 1", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loom-tui-fail-"));
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, FINISH_SCRIPT, "utf8");

  const result = await loomTui(cwd, scriptPath, "false");
  assert.equal(result.exitCode, 1);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "failed");
});
