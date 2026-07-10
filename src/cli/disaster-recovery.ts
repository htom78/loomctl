import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Command } from "commander";

import {
  createPlatformBackup,
  decodePlatformBackupKey,
  restorePlatformBackup,
  runPlatformDisasterRecoveryDrill,
} from "../harness/disaster-recovery.js";

interface PlatformBackupCliOptions {
  out: string;
  workspaceRoot: string;
  postgresUrlEnv: string;
  postgresSchema: string;
  redisUrlEnv: string;
  redisPrefix: string;
  encryptionKeyEnv: string;
  encryptionKeyId?: string;
  pgDumpCommand: string;
  pgRestoreCommand: string;
  tarCommand: string;
  confirmQuiesced: boolean;
  report?: string;
}

interface PlatformRestoreCliOptions {
  dir: string;
  workspaceRoot: string;
  postgresUrlEnv: string;
  redisUrlEnv: string;
  redisPrefix: string;
  encryptionKeyEnv: string;
  pgRestoreCommand: string;
  tarCommand: string;
  approveMutating: boolean;
  allowInPlace?: boolean;
  report?: string;
}

export function registerDisasterRecoveryCommands(harness: Command): void {
  harness
    .command("platform-backup")
    .description("create an encrypted PostgreSQL, Redis, and workspace backup")
    .requiredOption("--out <dir>", "new backup output directory")
    .option("--workspace-root <path>", "tenant workspace root", process.cwd())
    .option("--postgres-url-env <name>", "env var containing the source PostgreSQL URL", "LOOM_POSTGRES_URL")
    .option("--postgres-schema <name>", "PostgreSQL schema to back up", "loom")
    .option("--redis-url-env <name>", "env var containing the source Redis URL", "LOOM_REDIS_URL")
    .option("--redis-prefix <prefix>", "Redis key prefix to back up", "loom")
    .option("--encryption-key-env <name>", "env var containing a base64 32-byte backup key", "LOOM_BACKUP_ENCRYPTION_KEY")
    .option("--encryption-key-id <id>", "non-secret backup key identifier")
    .option("--pg-dump-command <path>", "pg_dump executable", "pg_dump")
    .option("--pg-restore-command <path>", "pg_restore executable used to inspect the archive", "pg_restore")
    .option("--tar-command <path>", "tar executable", "tar")
    .option("--confirm-quiesced", "confirm harness writes are stopped for a consistent snapshot", false)
    .option("--report <path>", "write the token-free backup result JSON")
    .action(async (options: PlatformBackupCliOptions) => {
      await runPlatformBackupCli(options);
    });

  harness
    .command("platform-restore")
    .description("verify or restore an encrypted platform backup into isolated targets")
    .requiredOption("--dir <dir>", "backup directory")
    .requiredOption("--workspace-root <path>", "new destination workspace root")
    .option("--postgres-url-env <name>", "env var containing the target PostgreSQL URL", "LOOM_RESTORE_POSTGRES_URL")
    .option("--redis-url-env <name>", "env var containing the target Redis URL", "LOOM_RESTORE_REDIS_URL")
    .requiredOption("--redis-prefix <prefix>", "new target Redis prefix")
    .option("--encryption-key-env <name>", "env var containing the backup key", "LOOM_BACKUP_ENCRYPTION_KEY")
    .option("--pg-restore-command <path>", "pg_restore executable", "pg_restore")
    .option("--tar-command <path>", "tar executable", "tar")
    .option("--approve-mutating", "apply the restore; omitted means dry-run", false)
    .option("--allow-in-place", "allow explicitly approved in-place targets", false)
    .option("--report <path>", "write the token-free restore result JSON")
    .action(async (options: PlatformRestoreCliOptions) => {
      await runPlatformRestoreCli(options, false);
    });

  harness
    .command("platform-drill")
    .description("run and report an isolated disaster-recovery restore drill")
    .requiredOption("--dir <dir>", "backup directory")
    .requiredOption("--workspace-root <path>", "new drill workspace root")
    .option("--postgres-url-env <name>", "env var containing the drill PostgreSQL URL", "LOOM_RESTORE_POSTGRES_URL")
    .option("--redis-url-env <name>", "env var containing the drill Redis URL", "LOOM_RESTORE_REDIS_URL")
    .requiredOption("--redis-prefix <prefix>", "new drill Redis prefix")
    .option("--encryption-key-env <name>", "env var containing the backup key", "LOOM_BACKUP_ENCRYPTION_KEY")
    .option("--pg-restore-command <path>", "pg_restore executable", "pg_restore")
    .option("--tar-command <path>", "tar executable", "tar")
    .option("--approve-mutating", "confirm the drill may write isolated targets", false)
    .option("--report <path>", "write the token-free drill result JSON")
    .action(async (options: PlatformRestoreCliOptions) => {
      await runPlatformRestoreCli(options, true);
    });
}

async function runPlatformBackupCli(options: PlatformBackupCliOptions): Promise<void> {
  const secrets: string[] = [];
  try {
    const postgresUrl = requiredEnvironmentValue(options.postgresUrlEnv, "--postgres-url-env");
    const redisUrl = requiredEnvironmentValue(options.redisUrlEnv, "--redis-url-env");
    const encryptionKeyValue = requiredEnvironmentValue(options.encryptionKeyEnv, "--encryption-key-env");
    secrets.push(postgresUrl, redisUrl, encryptionKeyValue);
    const result = await createPlatformBackup({
      outDir: options.out,
      workspaceRoot: options.workspaceRoot,
      postgresUrl,
      postgresSchema: options.postgresSchema,
      redisUrl,
      redisPrefix: options.redisPrefix,
      encryptionKey: decodePlatformBackupKey(encryptionKeyValue),
      encryptionKeyId: options.encryptionKeyId,
      quiesced: Boolean(options.confirmQuiesced),
      pgDumpCommand: options.pgDumpCommand,
      pgRestoreCommand: options.pgRestoreCommand,
      tarCommand: options.tarCommand,
    });
    await writeJsonReport(options.report, result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(redactedError(error, secrets));
    process.exitCode = 1;
  }
}

async function runPlatformRestoreCli(options: PlatformRestoreCliOptions, drill: boolean): Promise<void> {
  const secrets: string[] = [];
  try {
    if (drill && !options.approveMutating) throw new Error("platform-drill requires --approve-mutating");
    const postgresUrl = requiredEnvironmentValue(options.postgresUrlEnv, "--postgres-url-env");
    const redisUrl = requiredEnvironmentValue(options.redisUrlEnv, "--redis-url-env");
    const encryptionKeyValue = requiredEnvironmentValue(options.encryptionKeyEnv, "--encryption-key-env");
    secrets.push(postgresUrl, redisUrl, encryptionKeyValue);
    const restoreOptions = {
      backupDir: options.dir,
      destinationWorkspaceRoot: options.workspaceRoot,
      postgresUrl,
      redisUrl,
      redisPrefix: options.redisPrefix,
      encryptionKey: decodePlatformBackupKey(encryptionKeyValue),
      approveMutating: Boolean(options.approveMutating),
      allowInPlace: Boolean(options.allowInPlace),
      pgRestoreCommand: options.pgRestoreCommand,
      tarCommand: options.tarCommand,
    };
    const result = drill
      ? await runPlatformDisasterRecoveryDrill({ ...restoreOptions, approveMutating: true })
      : await restorePlatformBackup(restoreOptions);
    await writeJsonReport(options.report, result);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(redactedError(error, secrets));
    process.exitCode = 1;
  }
}

function requiredEnvironmentValue(envName: string, flag: string): string {
  const name = envName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${flag} must name an environment variable`);
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${flag} environment variable ${name} is not set`);
  return value;
}

async function writeJsonReport(path: string | undefined, value: unknown): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function redactedError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[redacted]");
  const bounded = message.replace(/\s+/g, " ").trim();
  return bounded.length > 500 ? `${bounded.slice(0, 497)}...` : bounded;
}
