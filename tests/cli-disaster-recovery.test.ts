import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

test("platform disaster-recovery commands expose encrypted backup and safe restore controls", async () => {
  for (const command of ["platform-backup", "platform-restore", "platform-drill"]) {
    const result = await execa("npx", ["tsx", "src/index.ts", "harness", command, "--help"], {
      cwd: process.cwd(),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /--encryption-key-env/);
    assert.match(result.stdout, /--workspace-root/);
    if (command === "platform-backup") assert.match(result.stdout, /--confirm-quiesced/);
    else assert.match(result.stdout, /--approve-mutating/);
  }
});

test("platform-backup refuses a live snapshot before touching dependencies or leaking env values", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-cli-dr-backup-"));
  const outDir = join(root, "backup");
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "platform-backup",
      "--out",
      outDir,
      "--workspace-root",
      root,
      "--postgres-url-env",
      "LOOM_TEST_DR_POSTGRES_URL",
      "--redis-url-env",
      "LOOM_TEST_DR_REDIS_URL",
      "--encryption-key-env",
      "LOOM_TEST_DR_KEY",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOOM_TEST_DR_POSTGRES_URL: "postgres://user:postgres-secret@db/private",
        LOOM_TEST_DR_REDIS_URL: "redis://:redis-secret@cache:6379",
        LOOM_TEST_DR_KEY: Buffer.alloc(32, 7).toString("base64"),
      },
      reject: false,
    },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /quiesced harness/);
  assert.equal(result.stderr.includes("postgres-secret"), false);
  assert.equal(result.stderr.includes("redis-secret"), false);
  await assert.rejects(() => access(outDir));
});

test("platform-drill requires explicit mutating approval before reading target credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "loom-cli-dr-drill-"));
  const result = await execa(
    "npx",
    [
      "tsx",
      "src/index.ts",
      "harness",
      "platform-drill",
      "--dir",
      join(root, "missing-backup"),
      "--workspace-root",
      join(root, "restore"),
      "--redis-prefix",
      "loom-drill",
    ],
    { cwd: process.cwd(), reject: false },
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "platform-drill requires --approve-mutating");
});
