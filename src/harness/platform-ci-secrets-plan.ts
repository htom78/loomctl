import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

export interface PlatformCiSecretsPlanCliOptions {
  dir?: string;
  repo?: string;
  ghBin?: string;
  report?: string;
}

export interface PlatformCiSecretsPlanResult {
  schemaVersion: "platform-ci-secrets-plan/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  reportPath?: string;
  repo?: string;
  ghBin: string;
  app: "actions";
  externalSecrets: {
    path: string;
    exists: boolean;
    ok: boolean;
  };
  requiredEnvNames: string[];
  verifyCommandArgs: string[];
  secretSetCommandArgs: string[][];
  secretSetShellCommands: string[];
  gates: {
    externalSecretsOk: boolean;
    requiredEnvNamesPresent: boolean;
  };
  missing: string[];
  nextActions: string[];
}

export function createPlatformCiSecretsPlan(
  options: PlatformCiSecretsPlanCliOptions = {},
): PlatformCiSecretsPlanResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const ghBin = options.ghBin ?? "gh";
  const externalSecretsPath = join(dir, "external-secrets.json");
  const externalSecrets = readExternalSecrets(externalSecretsPath);
  const requiredEnvNames = externalSecrets.requiredEnvNames;
  const verifyCommandArgs = [
    ghBin,
    "secret",
    "list",
    "--app",
    "actions",
    ...(options.repo ? ["--repo", options.repo] : []),
    "--json",
    "name",
  ];
  const secretSetCommandArgs = requiredEnvNames.map((name) => [
    ghBin,
    "secret",
    "set",
    name,
    "--app",
    "actions",
    ...(options.repo ? ["--repo", options.repo] : []),
  ]);
  const gates = {
    externalSecretsOk: externalSecrets.ok,
    requiredEnvNamesPresent: requiredEnvNames.length > 0,
  };
  const missing = [
    ...(gates.externalSecretsOk ? [] : ["bundle.externalSecrets"]),
    ...(gates.requiredEnvNamesPresent ? [] : ["secrets.requiredEnv"]),
  ];

  return {
    schemaVersion: "platform-ci-secrets-plan/v1",
    ok: missing.length === 0,
    tokenFree: true,
    provider: "github-actions",
    dir,
    ...(reportPath ? { reportPath } : {}),
    ...(options.repo ? { repo: options.repo } : {}),
    ghBin,
    app: "actions",
    externalSecrets: {
      path: externalSecretsPath,
      exists: externalSecrets.exists,
      ok: externalSecrets.ok,
    },
    requiredEnvNames,
    verifyCommandArgs,
    secretSetCommandArgs,
    secretSetShellCommands: secretSetCommandArgs.map((args, index) =>
      secretSetShellCommand(requiredEnvNames[index] ?? "", args)
    ),
    gates,
    missing,
    nextActions: secretsPlanNextActions(missing),
  };
}

function readExternalSecrets(path: string): { exists: boolean; ok: boolean; requiredEnvNames: string[] } {
  if (!existsSync(path)) return { exists: false, ok: false, requiredEnvNames: [] };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const record = objectRecord(value);
    if (record?.schemaVersion !== "platform-external-secrets/v1" || record.tokenFree !== true || !Array.isArray(record.requiredEnv)) {
      return { exists: true, ok: false, requiredEnvNames: [] };
    }
    const requiredEnvNames = Array.from(new Set(record.requiredEnv
      .map((item) => stringValue(objectRecord(item)?.name))
      .filter((name): name is string => name !== undefined && isEnvName(name))))
      .sort();
    return { exists: true, ok: true, requiredEnvNames };
  } catch {
    return { exists: true, ok: false, requiredEnvNames: [] };
  }
}

function secretSetShellCommand(envName: string, commandArgs: string[]): string {
  return `printf '%s' "\${${envName}:?missing ${envName}}" | ${shellJoin(commandArgs)}`;
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function secretsPlanNextActions(missing: string[]): string[] {
  if (missing.includes("bundle.externalSecrets")) {
    return ["Regenerate the cutover bundle so external-secrets.json is a token-free platform-external-secrets/v1 manifest, then rerun platform-ci-secrets-plan."];
  }
  if (missing.includes("secrets.requiredEnv")) {
    return ["Add requiredEnv entries to external-secrets.json, then rerun platform-ci-secrets-plan."];
  }
  return ["Export the required env names in the operator shell, run each secretSetShellCommands entry, then rerun platform-ci-handoff-preflight."];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isEnvName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
