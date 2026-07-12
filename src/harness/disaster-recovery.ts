import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { execa } from "execa";
import { Pool } from "pg";
import { createClient, RESP_TYPES } from "redis";

export interface PlatformBackupOptions {
  outDir: string;
  workspaceRoot: string;
  postgresUrl: string;
  postgresSchema?: string;
  redisUrl: string;
  redisPrefix?: string;
  encryptionKey: string | Buffer;
  encryptionKeyId?: string;
  quiesced: boolean;
  now?: () => number;
  pgDumpCommand?: string;
  pgRestoreCommand?: string;
  tarCommand?: string;
}

export interface PlatformRestoreOptions {
  backupDir: string;
  destinationWorkspaceRoot: string;
  postgresUrl: string;
  redisUrl: string;
  redisPrefix: string;
  encryptionKey: string | Buffer;
  approveMutating?: boolean;
  allowInPlace?: boolean;
  now?: () => number;
  pgRestoreCommand?: string;
  tarCommand?: string;
}

export interface PlatformBackupArtifact {
  file: string;
  plaintextBytes: number;
  plaintextSha256: string;
  encryptedBytes: number;
  encryptedSha256: string;
  iv: string;
  authTag: string;
}

export interface PlatformBackupManifest {
  schemaVersion: "platform-disaster-recovery-backup/v1";
  backupId: string;
  createdAt: string;
  quiesced: true;
  source: {
    workspaceArchiveRoot: string;
    postgres: { database: string; schema: string; documentCount: number; eventCount: number; objectCount: number };
    redis: { prefix: string; keyCount: number };
    workspace: { entryCount: number };
  };
  encryption: {
    algorithm: "aes-256-gcm";
    keyId: string;
  };
  artifacts: {
    postgres: PlatformBackupArtifact;
    redis: PlatformBackupArtifact;
    workspace: PlatformBackupArtifact;
  };
  integrity: {
    algorithm: "hmac-sha256";
    manifestHmac: string;
  };
}

export interface PlatformBackupResult {
  schemaVersion: "platform-disaster-recovery-backup-result/v1";
  ok: true;
  backupDir: string;
  manifestPath: string;
  manifest: PlatformBackupManifest;
}

export interface PlatformRestoreResult {
  schemaVersion: "platform-disaster-recovery-restore/v1";
  ok: boolean;
  mode: "dry-run" | "restore";
  applied: boolean;
  backupId: string;
  backupCreatedAt: string;
  startedAt: string;
  endedAt: string;
  rpoSeconds: number;
  rtoSeconds: number;
  gates: {
    manifestIntegrity: boolean;
    artifactsDecrypted: boolean;
    postgresArchive: boolean;
    redisArchive: boolean;
    workspaceArchive: boolean;
    isolatedTargets: boolean;
    postgresRestored: boolean;
    redisRestored: boolean;
    workspaceRestored: boolean;
  };
  counts: {
    postgres: { documents: number; events: number; objects: number };
    redisKeys: number;
    redisRestoredKeys: number;
    redisExpiredKeysSkipped: number;
    workspaceEntries: number;
  };
  targets: {
    postgresDatabase: string;
    redisPrefix: string;
    workspaceRoot: string;
  };
}

export interface PlatformDisasterRecoveryDrillResult extends Omit<PlatformRestoreResult, "schemaVersion" | "mode" | "applied"> {
  schemaVersion: "platform-disaster-recovery-drill/v1";
  mode: "restore";
  applied: true;
}

interface PreparedRestore {
  manifest: PlatformBackupManifest;
  tempDir: string;
  postgresPath: string;
  redisPath: string;
  workspacePath: string;
  postgresObjectCount: number;
  redisKeyCount: number;
  workspaceEntries: string[];
}

const MANIFEST_FILE = "manifest.json";
const POSTGRES_PLAIN_FILE = "postgres.dump";
const REDIS_PLAIN_FILE = "redis.ndjson";
const WORKSPACE_PLAIN_FILE = "workspaces.tar";

export async function createPlatformBackup(options: PlatformBackupOptions): Promise<PlatformBackupResult> {
  if (!options.quiesced) throw new Error("backup requires an operator-confirmed quiesced harness");
  const now = options.now ?? Date.now;
  const createdAt = new Date(now()).toISOString();
  const outDir = resolve(options.outDir);
  const workspaceRoot = resolve(options.workspaceRoot);
  assertOutsideWorkspace(outDir, workspaceRoot);
  const schema = postgresIdentifier(options.postgresSchema ?? "loom");
  const redisPrefix = statePrefix(options.redisPrefix ?? "loom");
  const key = encryptionKey(options.encryptionKey);
  const keyId = options.encryptionKeyId?.trim() || createHash("sha256").update(key).digest("hex").slice(0, 16);
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(keyId)) throw new Error("backup encryption key id must be a safe identifier");
  const postgresUrl = postgresConnection(options.postgresUrl);
  const redisUrl = redisConnection(options.redisUrl);
  await ensureDirectoryExists(workspaceRoot, "workspace root");
  await mkdir(outDir, { recursive: false, mode: 0o700 });

  const postgresPlain = join(outDir, POSTGRES_PLAIN_FILE);
  const redisPlain = join(outDir, REDIS_PLAIN_FILE);
  const workspacePlain = join(outDir, WORKSPACE_PLAIN_FILE);
  const pgDumpCommand = options.pgDumpCommand ?? "pg_dump";
  const pgRestoreCommand = options.pgRestoreCommand ?? "pg_restore";
  const tarCommand = options.tarCommand ?? "tar";

  let postgresArtifact: PlatformBackupArtifact;
  let redisArtifact: PlatformBackupArtifact;
  let workspaceArtifact: PlatformBackupArtifact;
  let postgresCounts: { documentCount: number; eventCount: number };
  let postgresObjectCount: number;
  let redisKeyCount: number;
  let workspaceEntries: string[];

  try {
    postgresCounts = await postgresStateCounts(postgresUrl, schema);
    await runCommand(pgDumpCommand, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--schema=${schema}`,
      `--file=${postgresPlain}`,
    ], postgresCommandEnv(postgresUrl));
    await chmod(postgresPlain, 0o600);
    postgresObjectCount = await postgresArchiveObjectCount(pgRestoreCommand, postgresPlain);
    postgresArtifact = await encryptArtifact(postgresPlain, `${POSTGRES_PLAIN_FILE}.enc`, key);

    redisKeyCount = await writeRedisBackup(redisUrl, redisPrefix, redisPlain, createdAt);
    await chmod(redisPlain, 0o600);
    redisArtifact = await encryptArtifact(redisPlain, `${REDIS_PLAIN_FILE}.enc`, key);

    await runCommand(tarCommand, ["-C", dirname(workspaceRoot), "-cf", workspacePlain, basename(workspaceRoot)]);
    await chmod(workspacePlain, 0o600);
    workspaceEntries = await workspaceArchiveEntries(tarCommand, workspacePlain, basename(workspaceRoot));
    workspaceArtifact = await encryptArtifact(workspacePlain, `${WORKSPACE_PLAIN_FILE}.enc`, key);
  } finally {
    await Promise.all([postgresPlain, redisPlain, workspacePlain].map((path) => unlink(path).catch(() => undefined)));
  }

  const unsigned = {
    schemaVersion: "platform-disaster-recovery-backup/v1" as const,
    backupId: randomUUID(),
    createdAt,
    quiesced: true as const,
    source: {
      workspaceArchiveRoot: basename(workspaceRoot),
      postgres: {
        database: postgresDatabaseName(postgresUrl),
        schema,
        ...postgresCounts,
        objectCount: postgresObjectCount,
      },
      redis: { prefix: redisPrefix, keyCount: redisKeyCount },
      workspace: { entryCount: workspaceEntries.length },
    },
    encryption: { algorithm: "aes-256-gcm" as const, keyId },
    artifacts: {
      postgres: postgresArtifact,
      redis: redisArtifact,
      workspace: workspaceArtifact,
    },
  };
  const manifest: PlatformBackupManifest = {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      manifestHmac: createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex"),
    },
  };
  const manifestPath = join(outDir, MANIFEST_FILE);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    schemaVersion: "platform-disaster-recovery-backup-result/v1",
    ok: true,
    backupDir: outDir,
    manifestPath,
    manifest,
  };
}

export async function restorePlatformBackup(options: PlatformRestoreOptions): Promise<PlatformRestoreResult> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const key = encryptionKey(options.encryptionKey);
  const targetPostgres = postgresConnection(options.postgresUrl);
  const targetRedis = redisConnection(options.redisUrl);
  const targetPrefix = statePrefix(options.redisPrefix);
  const destinationWorkspaceRoot = resolve(options.destinationWorkspaceRoot);
  const prepared = await prepareRestore(resolve(options.backupDir), key, options.pgRestoreCommand ?? "pg_restore", options.tarCommand ?? "tar");

  try {
    const sourceDatabase = prepared.manifest.source.postgres.database;
    const targetDatabase = postgresDatabaseName(targetPostgres);
    const isolatedTargets = Boolean(options.allowInPlace) || (
      sourceDatabase !== targetDatabase &&
      prepared.manifest.source.redis.prefix !== targetPrefix &&
      !samePath(destinationWorkspaceRoot, resolve(options.backupDir))
    );
    if (!isolatedTargets) {
      throw new Error("restore targets must use a different PostgreSQL database and Redis prefix unless allowInPlace is set");
    }
    await assertWorkspaceRestoreTarget(destinationWorkspaceRoot, Boolean(options.allowInPlace));

    const mode = options.approveMutating ? "restore" : "dry-run";
    let postgresRestored = false;
    let redisRestored = false;
    let workspaceRestored = false;
    let redisRestoredKeys = 0;
    let redisExpiredKeysSkipped = 0;
    if (options.approveMutating) {
      await runCommand(options.pgRestoreCommand ?? "pg_restore", [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        `--dbname=${postgresDatabaseName(targetPostgres)}`,
        prepared.postgresPath,
      ], postgresCommandEnv(targetPostgres));
      const targetCounts = await postgresStateCounts(targetPostgres, prepared.manifest.source.postgres.schema);
      postgresRestored = targetCounts.documentCount === prepared.manifest.source.postgres.documentCount &&
        targetCounts.eventCount === prepared.manifest.source.postgres.eventCount;

      const restoredRedis = await restoreRedisBackup(
        targetRedis,
        prepared.redisPath,
        prepared.manifest.source.redis.prefix,
        targetPrefix,
        now,
      );
      redisRestoredKeys = restoredRedis.restored;
      redisExpiredKeysSkipped = restoredRedis.expiredSkipped;
      redisRestored = redisRestoredKeys + redisExpiredKeysSkipped === prepared.manifest.source.redis.keyCount;

      await restoreWorkspaceArchive(
        options.tarCommand ?? "tar",
        prepared.workspacePath,
        prepared.manifest.source.workspaceArchiveRoot,
        destinationWorkspaceRoot,
        prepared.tempDir,
        Boolean(options.allowInPlace),
      );
      workspaceRestored = await countWorkspaceEntries(destinationWorkspaceRoot) === prepared.manifest.source.workspace.entryCount;
      if (!postgresRestored || !redisRestored || !workspaceRestored) {
        throw new Error("restored component counts do not match the backup manifest");
      }
    }

    const endedAtMs = now();
    return {
      schemaVersion: "platform-disaster-recovery-restore/v1",
      ok: true,
      mode,
      applied: Boolean(options.approveMutating),
      backupId: prepared.manifest.backupId,
      backupCreatedAt: prepared.manifest.createdAt,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      rpoSeconds: Math.max(0, (startedAtMs - Date.parse(prepared.manifest.createdAt)) / 1_000),
      rtoSeconds: Math.max(0, (endedAtMs - startedAtMs) / 1_000),
      gates: {
        manifestIntegrity: true,
        artifactsDecrypted: true,
        postgresArchive: true,
        redisArchive: true,
        workspaceArchive: true,
        isolatedTargets,
        postgresRestored: options.approveMutating ? postgresRestored : false,
        redisRestored: options.approveMutating ? redisRestored : false,
        workspaceRestored: options.approveMutating ? workspaceRestored : false,
      },
      counts: {
        postgres: {
          documents: prepared.manifest.source.postgres.documentCount,
          events: prepared.manifest.source.postgres.eventCount,
          objects: prepared.postgresObjectCount,
        },
        redisKeys: prepared.redisKeyCount,
        redisRestoredKeys,
        redisExpiredKeysSkipped,
        workspaceEntries: prepared.workspaceEntries.length,
      },
      targets: {
        postgresDatabase: targetDatabase,
        redisPrefix: targetPrefix,
        workspaceRoot: destinationWorkspaceRoot,
      },
    };
  } finally {
    await rm(prepared.tempDir, { recursive: true, force: true });
  }
}

export async function runPlatformDisasterRecoveryDrill(
  options: PlatformRestoreOptions & { approveMutating: true },
): Promise<PlatformDisasterRecoveryDrillResult> {
  const restored = await restorePlatformBackup(options);
  return {
    ...restored,
    schemaVersion: "platform-disaster-recovery-drill/v1",
    mode: "restore",
    applied: true,
  };
}

export function decodePlatformBackupKey(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("backup encryption key must be base64");
  }
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32) throw new Error("backup encryption key must decode to 32 bytes");
  return key;
}

async function prepareRestore(
  backupDir: string,
  key: Buffer,
  pgRestoreCommand: string,
  tarCommand: string,
): Promise<PreparedRestore> {
  const manifest = platformBackupManifest(await readJson(join(backupDir, MANIFEST_FILE)));
  verifyManifestHmac(manifest, key);
  const tempDir = await mkdtemp(join(tmpdir(), "loom-dr-restore-"));
  try {
    const postgresPath = join(tempDir, POSTGRES_PLAIN_FILE);
    const redisPath = join(tempDir, REDIS_PLAIN_FILE);
    const workspacePath = join(tempDir, WORKSPACE_PLAIN_FILE);
    await decryptArtifact(backupDir, manifest.artifacts.postgres, postgresPath, key);
    await decryptArtifact(backupDir, manifest.artifacts.redis, redisPath, key);
    await decryptArtifact(backupDir, manifest.artifacts.workspace, workspacePath, key);
    const postgresObjectCount = await postgresArchiveObjectCount(pgRestoreCommand, postgresPath);
    if (postgresObjectCount !== manifest.source.postgres.objectCount) throw new Error("PostgreSQL archive object count mismatch");
    const redisKeyCount = await validateRedisBackup(redisPath, manifest.source.redis.prefix);
    if (redisKeyCount !== manifest.source.redis.keyCount) throw new Error("Redis archive key count mismatch");
    const workspaceEntries = await workspaceArchiveEntries(tarCommand, workspacePath, manifest.source.workspaceArchiveRoot);
    if (workspaceEntries.length !== manifest.source.workspace.entryCount) throw new Error("workspace archive entry count mismatch");
    return {
      manifest,
      tempDir,
      postgresPath,
      redisPath,
      workspacePath,
      postgresObjectCount,
      redisKeyCount,
      workspaceEntries,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function encryptArtifact(path: string, file: string, key: Buffer): Promise<PlatformBackupArtifact> {
  const plaintext = await fileDigest(path);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encryptedPath = join(dirname(path), file);
  await pipeline(createReadStream(path), cipher, createWriteStream(encryptedPath, { mode: 0o600 }));
  const encrypted = await fileDigest(encryptedPath);
  return {
    file,
    plaintextBytes: plaintext.bytes,
    plaintextSha256: plaintext.sha256,
    encryptedBytes: encrypted.bytes,
    encryptedSha256: encrypted.sha256,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

async function decryptArtifact(backupDir: string, artifact: PlatformBackupArtifact, outPath: string, key: Buffer): Promise<void> {
  const encryptedPath = resolve(backupDir, artifact.file);
  if (!encryptedPath.startsWith(`${resolve(backupDir)}${sep}`)) throw new Error("backup artifact path escapes the backup directory");
  const encrypted = await fileDigest(encryptedPath);
  if (encrypted.bytes !== artifact.encryptedBytes || encrypted.sha256 !== artifact.encryptedSha256) {
    throw new Error("encrypted backup artifact integrity mismatch");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(artifact.iv, "base64"));
  decipher.setAuthTag(Buffer.from(artifact.authTag, "base64"));
  await pipeline(createReadStream(encryptedPath), decipher, createWriteStream(outPath, { mode: 0o600 }));
  const plaintext = await fileDigest(outPath);
  if (plaintext.bytes !== artifact.plaintextBytes || plaintext.sha256 !== artifact.plaintextSha256) {
    throw new Error("decrypted backup artifact integrity mismatch");
  }
}

async function writeRedisBackup(url: string, prefix: string, path: string, createdAt: string): Promise<number> {
  const scanClient = createClient({ url });
  const dumpClient = createClient({ url }).withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  await Promise.all([scanClient.connect(), dumpClient.connect()]);
  const handle = await open(path, "wx", 0o600);
  try {
    const keys: string[] = [];
    for await (const batch of scanClient.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) keys.push(...batch.map(String));
    keys.sort((left, right) => left.localeCompare(right));
    await handle.write(`${JSON.stringify({ schemaVersion: "loom-redis-backup/v1", createdAt, prefix })}\n`, undefined, "utf8");
    let written = 0;
    for (const key of keys) {
      const dump = await dumpClient.dump(key);
      if (!dump) continue;
      const ttlMs = await scanClient.pTTL(key);
      await handle.write(`${JSON.stringify({ key, ttlMs: Math.max(0, ttlMs), dump: Buffer.from(dump).toString("base64") })}\n`, undefined, "utf8");
      written += 1;
    }
    return written;
  } finally {
    await handle.close();
    await Promise.all([
      scanClient.quit().catch(() => scanClient.disconnect()),
      dumpClient.quit().catch(() => dumpClient.disconnect()),
    ]);
  }
}

async function validateRedisBackup(path: string, expectedPrefix: string): Promise<number> {
  let count = 0;
  for await (const entry of redisBackupEntries(path, expectedPrefix)) {
    if (entry.kind === "key") count += 1;
  }
  return count;
}

async function restoreRedisBackup(
  url: string,
  path: string,
  sourcePrefix: string,
  targetPrefix: string,
  now: () => number,
): Promise<{ restored: number; expiredSkipped: number }> {
  const client = createClient({ url });
  await client.connect();
  try {
    const existing: string[] = [];
    for await (const batch of client.scanIterator({ MATCH: `${targetPrefix}:*`, COUNT: 500 })) existing.push(...batch.map(String));
    if (existing.length) await client.del(existing);
    let restored = 0;
    let expiredSkipped = 0;
    let backupCreatedAtMs: number | undefined;
    for await (const entry of redisBackupEntries(path, sourcePrefix)) {
      if (entry.kind === "header") {
        backupCreatedAtMs = Date.parse(entry.createdAt);
        continue;
      }
      const ttlMs = entry.ttlMs === 0
        ? 0
        : Math.max(0, (backupCreatedAtMs as number) + entry.ttlMs - now());
      if (entry.ttlMs > 0 && ttlMs === 0) {
        expiredSkipped += 1;
        continue;
      }
      const targetKey = `${targetPrefix}${entry.key.slice(sourcePrefix.length)}`;
      await client.restore(targetKey, ttlMs, Buffer.from(entry.dump, "base64"), { REPLACE: true });
      restored += 1;
    }
    return { restored, expiredSkipped };
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}

async function* redisBackupEntries(
  path: string,
  expectedPrefix: string,
): AsyncGenerator<{ kind: "header"; createdAt: string } | { kind: "key"; key: string; ttlMs: number; dump: string }> {
  const content = await readFile(path, "utf8");
  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Redis backup is empty");
  const header = JSON.parse(lines[0]) as Record<string, unknown>;
  if (
    header.schemaVersion !== "loom-redis-backup/v1" ||
    header.prefix !== expectedPrefix ||
    typeof header.createdAt !== "string" ||
    !Number.isFinite(Date.parse(header.createdAt))
  ) {
    throw new Error("Redis backup header is invalid");
  }
  yield { kind: "header", createdAt: header.createdAt };
  const observed = new Set<string>();
  for (const line of lines.slice(1)) {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (typeof value.key !== "string" || !value.key.startsWith(`${expectedPrefix}:`) || observed.has(value.key)) {
      throw new Error("Redis backup key is invalid");
    }
    if (!Number.isInteger(value.ttlMs) || Number(value.ttlMs) < 0 || typeof value.dump !== "string") {
      throw new Error("Redis backup record is invalid");
    }
    observed.add(value.key);
    yield { kind: "key", key: value.key, ttlMs: Number(value.ttlMs), dump: value.dump };
  }
}

async function postgresStateCounts(connectionString: string, schema: string): Promise<{ documentCount: number; eventCount: number }> {
  const pool = new Pool({ connectionString });
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*)::bigint FROM "${schema}".documents) AS documents,
        (SELECT COUNT(*)::bigint FROM "${schema}".events) AS events
    `);
    return {
      documentCount: Number(result.rows[0].documents),
      eventCount: Number(result.rows[0].events),
    };
  } finally {
    await pool.end();
  }
}

async function postgresArchiveObjectCount(command: string, path: string): Promise<number> {
  const result = await runCommand(command, ["--list", path]);
  return result.stdout.split("\n").filter((line) => line.trim() && !line.trimStart().startsWith(";")).length;
}

async function workspaceArchiveEntries(command: string, path: string, root: string): Promise<string[]> {
  const result = await runCommand(command, ["-tf", path]);
  const entries = result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.split("/").includes("..") || (entry !== root && !entry.startsWith(`${root}/`))) {
      throw new Error("workspace archive contains an unsafe path");
    }
  }
  return entries;
}

async function restoreWorkspaceArchive(
  command: string,
  archivePath: string,
  archiveRoot: string,
  destination: string,
  tempDir: string,
  allowInPlace: boolean,
): Promise<void> {
  const extractDir = join(tempDir, "workspace-extract");
  await mkdir(extractDir, { recursive: false, mode: 0o700 });
  await runCommand(command, ["-xf", archivePath, "-C", extractDir]);
  const extractedRoot = join(extractDir, archiveRoot);
  await ensureDirectoryExists(extractedRoot, "restored workspace archive root");
  await mkdir(dirname(destination), { recursive: true });
  if (allowInPlace) {
    await cp(extractedRoot, destination, { recursive: true, force: true, preserveTimestamps: true });
  } else {
    try {
      await rename(extractedRoot, destination);
    } catch (error) {
      if (!isCrossDevice(error)) throw error;
      await cp(extractedRoot, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
  }
}

async function countWorkspaceEntries(root: string): Promise<number> {
  let count = 1;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) count += (await countWorkspaceEntries(join(root, entry.name))) - 1;
  }
  return count;
}

async function assertWorkspaceRestoreTarget(path: string, allowInPlace: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (!allowInPlace || !info.isDirectory()) throw new Error("destination workspace root already exists");
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

function platformBackupManifest(value: unknown): PlatformBackupManifest {
  if (!isRecord(value) || value.schemaVersion !== "platform-disaster-recovery-backup/v1") {
    throw new Error("backup manifest schema is invalid");
  }
  const manifest = value as unknown as PlatformBackupManifest;
  if (!manifest.quiesced || !manifest.backupId || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new Error("backup manifest metadata is invalid");
  }
  if (
    typeof manifest.source?.workspaceArchiveRoot !== "string" ||
    !/^[^/\\\0]{1,255}$/.test(manifest.source.workspaceArchiveRoot) ||
    manifest.source.workspaceArchiveRoot === "." ||
    manifest.source.workspaceArchiveRoot === ".." ||
    typeof manifest.source?.postgres?.database !== "string" ||
    !manifest.source.postgres.database ||
    /[\0\r\n]/.test(manifest.source.postgres.database)
  ) {
    throw new Error("backup manifest source is invalid");
  }
  postgresIdentifier(manifest.source?.postgres?.schema);
  statePrefix(manifest.source?.redis?.prefix);
  for (const count of [
    manifest.source.postgres.documentCount,
    manifest.source.postgres.eventCount,
    manifest.source.postgres.objectCount,
    manifest.source.redis.keyCount,
    manifest.source.workspace.entryCount,
  ]) {
    if (!Number.isInteger(count) || count < 0) throw new Error("backup manifest count is invalid");
  }
  for (const artifact of Object.values(manifest.artifacts ?? {})) validateArtifact(artifact);
  if (
    Object.keys(manifest.artifacts ?? {}).length !== 3 ||
    manifest.encryption?.algorithm !== "aes-256-gcm" ||
    typeof manifest.encryption.keyId !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(manifest.encryption.keyId) ||
    manifest.integrity?.algorithm !== "hmac-sha256"
  ) {
    throw new Error("backup manifest artifacts or integrity are invalid");
  }
  return manifest;
}

function validateArtifact(value: unknown): asserts value is PlatformBackupArtifact {
  if (!isRecord(value) || typeof value.file !== "string" || !/^[A-Za-z0-9_.-]+\.enc$/.test(value.file)) {
    throw new Error("backup artifact metadata is invalid");
  }
  for (const field of ["plaintextBytes", "encryptedBytes"] as const) {
    if (!Number.isInteger(value[field]) || Number(value[field]) < 0) throw new Error("backup artifact size is invalid");
  }
  for (const field of ["plaintextSha256", "encryptedSha256"] as const) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/.test(value[field])) throw new Error("backup artifact hash is invalid");
  }
  if (
    typeof value.iv !== "string" ||
    Buffer.from(value.iv, "base64").length !== 12 ||
    typeof value.authTag !== "string" ||
    Buffer.from(value.authTag, "base64").length !== 16
  ) {
    throw new Error("backup artifact encryption metadata is invalid");
  }
}

function verifyManifestHmac(manifest: PlatformBackupManifest, key: Buffer): void {
  const { integrity, ...unsigned } = manifest;
  const expected = createHmac("sha256", key).update(JSON.stringify(unsigned)).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(integrity.manifestHmac) || !safeHexEqual(expected, integrity.manifestHmac)) {
    throw new Error("backup manifest integrity check failed");
  }
}

async function fileDigest(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  const result = await execa(command, args, {
    env: env ? { ...process.env, ...env } : process.env,
    reject: true,
    stdin: "ignore",
  });
  return { stdout: result.stdout };
}

function postgresCommandEnv(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  const env: NodeJS.ProcessEnv = {
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: postgresDatabaseName(connectionString),
    PGCONNECT_TIMEOUT: "10",
  };
  const libpqParameters: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    sslrootcert: "PGSSLROOTCERT",
    application_name: "PGAPPNAME",
  };
  for (const [parameter, name] of Object.entries(libpqParameters)) {
    const value = url.searchParams.get(parameter);
    if (value) env[name] = value;
  }
  return env;
}

function postgresConnection(value: string): string {
  const url = connectionUrl(value, ["postgres:", "postgresql:"], "PostgreSQL URL");
  if (!url.pathname || url.pathname === "/") throw new Error("PostgreSQL URL must include a database");
  return value;
}

function redisConnection(value: string): string {
  connectionUrl(value, ["redis:", "rediss:"], "Redis URL");
  return value;
}

function postgresDatabaseName(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.replace(/^\//, ""));
}

function connectionUrl(value: string, protocols: string[], label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!protocols.includes(url.protocol)) throw new Error(`${label} has an unsupported protocol`);
  return url;
}

function postgresIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error("PostgreSQL schema must be a safe identifier");
  return value;
}

function statePrefix(value: string): string {
  const prefix = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(prefix)) throw new Error("Redis prefix must be a safe identifier");
  return prefix;
}

function encryptionKey(value: string | Buffer): Buffer {
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : decodePlatformBackupKey(value);
  if (key.length !== 32) throw new Error("backup encryption key must be 32 bytes");
  return key;
}

function assertOutsideWorkspace(outDir: string, workspaceRoot: string): void {
  if (samePath(outDir, workspaceRoot) || outDir.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error("backup output directory must be outside the workspace root");
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

async function ensureDirectoryExists(path: string, label: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isCrossDevice(error: unknown): boolean {
  return isRecord(error) && error.code === "EXDEV";
}
