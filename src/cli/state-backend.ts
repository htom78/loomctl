import { createPostgresRedisStateBackend, type PlatformStateBackend } from "../harness/storage/index.js";

export interface StateBackendCliOptions {
  stateBackend?: string;
  statePostgresUrlEnv?: string;
  statePostgresSchema?: string;
  stateRedisUrlEnv?: string;
  stateRedisPrefix?: string;
}

export interface StateBackendFlagIssue {
  flag: string;
  message: string;
}

export async function createStateBackendFromCliOptions(options: StateBackendCliOptions): Promise<PlatformStateBackend | undefined> {
  const backend = parseStateBackendFlag(options.stateBackend);
  if (backend === "file") return undefined;
  const postgresEnv = safeEnvName(options.statePostgresUrlEnv ?? "LOOM_POSTGRES_URL", "--state-postgres-url-env");
  const redisEnv = safeEnvName(options.stateRedisUrlEnv ?? "LOOM_REDIS_URL", "--state-redis-url-env");
  const postgresUrl = process.env[postgresEnv];
  const redisUrl = process.env[redisEnv];
  if (!postgresUrl) throw new Error(`missing PostgreSQL state URL env: ${postgresEnv}`);
  if (!redisUrl) throw new Error(`missing Redis state URL env: ${redisEnv}`);
  return createPostgresRedisStateBackend({
    postgres: {
      connectionString: postgresUrl,
      schema: options.statePostgresSchema ?? "loom",
    },
    redis: {
      url: redisUrl,
      prefix: options.stateRedisPrefix ?? "loom",
    },
  });
}

export function stateBackendFlagIssues(options: StateBackendCliOptions): StateBackendFlagIssue[] {
  return [
    stateBackendFlagIssue(options.stateBackend),
    stateEnvNameFlagIssue(options.statePostgresUrlEnv, "--state-postgres-url-env"),
    stateEnvNameFlagIssue(options.stateRedisUrlEnv, "--state-redis-url-env"),
    statePostgresSchemaFlagIssue(options.statePostgresSchema),
    stateRedisPrefixFlagIssue(options.stateRedisPrefix),
  ].filter((issue): issue is StateBackendFlagIssue => issue !== undefined);
}

export function parseStateBackendFlag(value: string | undefined): "file" | "postgres-redis" {
  const backend = (value ?? "file").trim();
  if (backend === "file" || backend === "postgres-redis") return backend;
  throw new Error("--state-backend must be one of: file, postgres-redis");
}

function safeEnvName(value: string, flag: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`${flag} must be a safe environment variable name`);
  return value;
}

function stateBackendFlagIssue(value: string | undefined): StateBackendFlagIssue | undefined {
  const backend = (value ?? "file").trim();
  if (backend === "file" || backend === "postgres-redis") return undefined;
  return { flag: "--state-backend", message: "--state-backend must be one of: file, postgres-redis." };
}

function stateEnvNameFlagIssue(value: string | undefined, flag: string): StateBackendFlagIssue | undefined {
  if (value === undefined || /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return undefined;
  return { flag, message: `${flag} must be a safe environment variable name.` };
}

function statePostgresSchemaFlagIssue(value: string | undefined): StateBackendFlagIssue | undefined {
  if (value === undefined || /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) return undefined;
  return { flag: "--state-postgres-schema", message: "--state-postgres-schema must be a safe PostgreSQL identifier." };
}

function stateRedisPrefixFlagIssue(value: string | undefined): StateBackendFlagIssue | undefined {
  if (value === undefined || /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) return undefined;
  return { flag: "--state-redis-prefix", message: "--state-redis-prefix must be a safe Redis key prefix." };
}
