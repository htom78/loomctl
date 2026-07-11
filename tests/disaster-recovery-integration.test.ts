import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Pool } from "pg";
import { createClient } from "redis";

import {
  createPlatformBackup,
  restorePlatformBackup,
  runPlatformDisasterRecoveryDrill,
} from "../src/harness/disaster-recovery.js";
import { createPostgresRedisStateBackend } from "../src/harness/storage/index.js";

const postgresUrl = process.env.LOOM_TEST_POSTGRES_URL;
const redisUrl = process.env.LOOM_TEST_REDIS_URL;

test("encrypted platform backup restores PostgreSQL, Redis, and workspaces into isolated targets", {
  skip: !postgresUrl || !redisUrl ? "LOOM_TEST_POSTGRES_URL and LOOM_TEST_REDIS_URL are required" : false,
}, async () => {
  const suffix = `${Date.now()}_${process.pid}`;
  const schema = `loom_dr_${suffix}`;
  const sourcePrefix = `loom-dr-source-${suffix}`;
  const targetPrefix = `loom-dr-target-${suffix}`;
  const targetDatabase = `loom_dr_restore_${suffix}`;
  const targetUrl = new URL(postgresUrl!);
  targetUrl.pathname = `/${targetDatabase}`;
  const root = await mkdtemp(join(tmpdir(), "loom-dr-integration-"));
  const workspaceRoot = join(root, "workspaces");
  const restoredWorkspaceRoot = join(root, "restored-workspaces");
  const backupDir = join(root, "backup");
  const encryptionKey = randomBytes(32);
  const postgresCommands = await postgresTestCommands(root);
  const backupNow = Date.now();
  let targetDatabaseCreated = false;

  const backend = await createPostgresRedisStateBackend({
    postgres: { connectionString: postgresUrl, schema },
    redis: { url: redisUrl!, prefix: sourcePrefix },
  });
  try {
    await backend.documents.put("tenant-policy", "alice", { allowedTools: ["file.read"] });
    await backend.events.append("tenant-audit:alice", { type: "project_created" });
    await backend.leases.acquire("run:alice:one", "server-a", 120_000, { runId: "one" });
    await backend.queues.enqueue("harness-runs", "run-one", { tenant: "alice", project: "demo" });
    await mkdir(join(workspaceRoot, "alice", "demo"), { recursive: true });
    await writeFile(join(workspaceRoot, "alice", "demo", "hello.txt"), "restored\n", "utf8");
  } finally {
    await backend.close();
  }

  const adminPool = new Pool({ connectionString: postgresUrl });
  try {
    const backup = await createPlatformBackup({
      outDir: backupDir,
      workspaceRoot,
      postgresUrl: postgresUrl!,
      postgresSchema: schema,
      redisUrl: redisUrl!,
      redisPrefix: sourcePrefix,
      encryptionKey,
      encryptionKeyId: "integration-test-key",
      quiesced: true,
      pgDumpCommand: postgresCommands.pgDumpCommand,
      pgRestoreCommand: postgresCommands.pgRestoreCommand,
      now: () => backupNow,
    });
    assert.equal(backup.ok, true);
    assert.equal(backup.manifest.source.postgres.documentCount, 1);
    assert.equal(backup.manifest.source.postgres.eventCount, 1);
    assert.ok(backup.manifest.source.redis.keyCount >= 4);
    assert.ok(backup.manifest.source.workspace.entryCount >= 4);
    // The manifest keeps the non-secret source database name (derived from the
    // actual test URL, not a hardcoded one) but never the connection credentials.
    const sourceUrl = new URL(postgresUrl!);
    const sourceDatabaseName = sourceUrl.pathname.replace(/^\//, "");
    assert.equal(backup.manifest.source.postgres.database, sourceDatabaseName);
    if (sourceUrl.username) {
      assert.equal(JSON.stringify(backup.manifest).includes(`${sourceUrl.username}:${sourceUrl.password}@`), false);
    }
    await assert.rejects(() => access(join(backupDir, "postgres.dump")));
    await assert.rejects(() => access(join(backupDir, "redis.ndjson")));
    await assert.rejects(() => access(join(backupDir, "workspaces.tar")));

    await adminPool.query(`CREATE DATABASE "${targetDatabase}"`);
    targetDatabaseCreated = true;

    const dryRun = await restorePlatformBackup({
      backupDir,
      destinationWorkspaceRoot: restoredWorkspaceRoot,
      postgresUrl: targetUrl.toString(),
      redisUrl: redisUrl!,
      redisPrefix: targetPrefix,
      encryptionKey,
      pgRestoreCommand: postgresCommands.pgRestoreCommand,
    });
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.applied, false);
    assert.equal(dryRun.gates.manifestIntegrity, true);
    assert.equal(dryRun.gates.isolatedTargets, true);
    assert.equal(dryRun.gates.postgresRestored, false);

    await assert.rejects(() => restorePlatformBackup({
      backupDir,
      destinationWorkspaceRoot: restoredWorkspaceRoot,
      postgresUrl: targetUrl.toString(),
      redisUrl: redisUrl!,
      redisPrefix: targetPrefix,
      encryptionKey: randomBytes(32),
      pgRestoreCommand: postgresCommands.pgRestoreCommand,
    }), /manifest integrity/);

    const drill = await runPlatformDisasterRecoveryDrill({
      backupDir,
      destinationWorkspaceRoot: restoredWorkspaceRoot,
      postgresUrl: targetUrl.toString(),
      redisUrl: redisUrl!,
      redisPrefix: targetPrefix,
      encryptionKey,
      approveMutating: true,
      pgRestoreCommand: postgresCommands.pgRestoreCommand,
      now: () => backupNow + 180_000,
    });
    assert.equal(drill.schemaVersion, "platform-disaster-recovery-drill/v1");
    assert.equal(drill.ok, true);
    assert.equal(drill.applied, true);
    assert.equal(drill.counts.redisExpiredKeysSkipped, 1);
    assert.equal(drill.counts.redisRestoredKeys, backup.manifest.source.redis.keyCount - 1);
    assert.deepEqual(drill.gates, {
      manifestIntegrity: true,
      artifactsDecrypted: true,
      postgresArchive: true,
      redisArchive: true,
      workspaceArchive: true,
      isolatedTargets: true,
      postgresRestored: true,
      redisRestored: true,
      workspaceRestored: true,
    });

    const restoredPool = new Pool({ connectionString: targetUrl.toString() });
    try {
      const document = await restoredPool.query(`SELECT value FROM "${schema}".documents WHERE namespace = 'tenant-policy' AND key = 'alice'`);
      assert.deepEqual(document.rows[0].value, { allowedTools: ["file.read"] });
      assert.equal(Number((await restoredPool.query(`SELECT COUNT(*) FROM "${schema}".events`)).rows[0].count), 1);
    } finally {
      await restoredPool.end();
    }

    const redis = createClient({ url: redisUrl! });
    await redis.connect();
    try {
      const targetKeys: string[] = [];
      for await (const batch of redis.scanIterator({ MATCH: `${targetPrefix}:*`, COUNT: 100 })) targetKeys.push(...batch.map(String));
      assert.equal(targetKeys.length, drill.counts.redisRestoredKeys);
    } finally {
      await redis.quit();
    }
    assert.equal(await readFile(join(restoredWorkspaceRoot, "alice", "demo", "hello.txt"), "utf8"), "restored\n");
  } finally {
    if (targetDatabaseCreated) await adminPool.query(`DROP DATABASE IF EXISTS "${targetDatabase}" WITH (FORCE)`);
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
    await deleteRedisPrefix(redisUrl!, sourcePrefix);
    await deleteRedisPrefix(redisUrl!, targetPrefix);
  }
});

async function deleteRedisPrefix(url: string, prefix: string): Promise<void> {
  const redis = createClient({ url });
  await redis.connect();
  try {
    const keys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) keys.push(...batch.map(String));
    if (keys.length) await redis.del(keys);
  } finally {
    await redis.quit();
  }
}

async function postgresTestCommands(root: string): Promise<{ pgDumpCommand?: string; pgRestoreCommand?: string }> {
  const container = process.env.LOOM_TEST_POSTGRES_CONTAINER;
  if (!container) return {};
  assert.match(container, /^[A-Za-z0-9_.-]+$/);
  const pgDumpCommand = join(root, "pg-dump-wrapper.cjs");
  const pgRestoreCommand = join(root, "pg-restore-wrapper.cjs");
  const envSetup = `
const pgEnv = ["PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGSSLCERT", "PGSSLKEY", "PGSSLROOTCERT", "PGAPPNAME"]
  .flatMap((name) => process.env[name] === undefined ? [] : [name + "=" + process.env[name]]);
pgEnv.push("PGHOST=/var/run/postgresql", "PGPORT=5432");`;
  await writeFile(pgDumpCommand, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
${envSetup}
const input = process.argv.slice(2);
const fileArg = input.find((arg) => arg.startsWith("--file="));
if (!fileArg) process.exit(2);
const args = input.filter((arg) => arg !== fileArg);
const result = spawnSync("docker", ["exec", "-i", ${JSON.stringify(container)}, "env", ...pgEnv, "pg_dump", ...args], { encoding: null });
if (result.stderr?.length) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
fs.writeFileSync(fileArg.slice("--file=".length), result.stdout);
`, "utf8");
  await writeFile(pgRestoreCommand, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
${envSetup}
const input = process.argv.slice(2);
const archive = input.at(-1);
if (!archive || archive.startsWith("--")) process.exit(2);
const args = input.slice(0, -1);
const result = spawnSync("docker", ["exec", "-i", ${JSON.stringify(container)}, "env", ...pgEnv, "pg_restore", ...args], { input: fs.readFileSync(archive), encoding: null });
if (result.stdout?.length) process.stdout.write(result.stdout);
if (result.stderr?.length) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
`, "utf8");
  await Promise.all([chmod(pgDumpCommand, 0o755), chmod(pgRestoreCommand, 0o755)]);
  return { pgDumpCommand, pgRestoreCommand };
}
