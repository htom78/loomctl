import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface UpstreamAgentGitServiceServerEnvPlanCliOptions {
  dir?: string;
  report?: string;
}

export interface UpstreamAgentGitServiceServerEnvPlanResult {
  schemaVersion: "upstream-agent-git-service-server-env-plan/v1";
  ok: boolean;
  tokenFree: true;
  provider: "agent-git-service";
  dir: string;
  reportPath?: string;
  guide: {
    path: string;
    exists: boolean;
    ok: boolean;
    sha256?: string;
  };
  upstream?: {
    repository?: string;
    developmentBinary?: string;
    apiBasePath?: string;
    metadataDatabaseEnv?: string;
  };
  requiredServerEnvNames: string[];
  envCheckShellCommands: string[];
  serverStartCommandArgs: string[];
  serverStartShellCommand?: string;
  readinessProbeCommandArgs: string[];
  gates: {
    guideOk: boolean;
    requiredServerEnvNamesPresent: boolean;
    serverStartCommandReady: boolean;
    readinessProbeReady: boolean;
  };
  missing: string[];
  nextActions: string[];
}

export function createUpstreamAgentGitServiceServerEnvPlan(
  options: UpstreamAgentGitServiceServerEnvPlanCliOptions = {},
): UpstreamAgentGitServiceServerEnvPlanResult {
  const dir = resolve(options.dir ?? process.cwd());
  const reportPath = options.report ? resolve(options.report) : undefined;
  const guidePath = join(dir, "upstream-agent-git-service.json");
  const guide = readGuide(guidePath);
  const requiredServerEnvNames = guide.requiredServerEnvNames;
  const upstream = guide.value?.upstream;
  const developmentBinary = stringValue(upstream?.developmentBinary);
  const readinessUrl = readinessProbeUrl(stringValue(guide.value?.targets?.controlPlane?.baseUrl));
  const gates = {
    guideOk: guide.ok,
    requiredServerEnvNamesPresent: requiredServerEnvNames.length > 0,
    serverStartCommandReady: developmentBinary !== undefined,
    readinessProbeReady: readinessUrl !== undefined,
  };
  const missing = [
    ...(gates.guideOk ? [] : ["upstreamAgentGitService.guide"]),
    ...(gates.requiredServerEnvNamesPresent ? [] : ["upstreamAgentGitService.requiredServerEnv"]),
    ...(gates.serverStartCommandReady ? [] : ["upstreamAgentGitService.upstream.developmentBinary"]),
    ...(gates.readinessProbeReady ? [] : ["upstreamAgentGitService.targets.controlPlane.baseUrl"]),
  ];
  const serverStartCommandArgs = developmentBinary ? [developmentBinary] : [];
  const result: UpstreamAgentGitServiceServerEnvPlanResult = {
    schemaVersion: "upstream-agent-git-service-server-env-plan/v1",
    ok: missing.length === 0,
    tokenFree: true,
    provider: "agent-git-service",
    dir,
    ...(reportPath ? { reportPath } : {}),
    guide: {
      path: guidePath,
      exists: guide.exists,
      ok: guide.ok,
      ...(guide.sha256 ? { sha256: guide.sha256 } : {}),
    },
    ...(upstream ? { upstream } : {}),
    requiredServerEnvNames,
    envCheckShellCommands: requiredServerEnvNames.map((name) => `: "\${${name}:?missing ${name}}"`),
    serverStartCommandArgs,
    ...(developmentBinary
      ? { serverStartShellCommand: serverStartShellCommand(requiredServerEnvNames, developmentBinary) }
      : {}),
    readinessProbeCommandArgs: readinessUrl ? ["curl", "-fsS", readinessUrl] : [],
    gates,
    missing,
    nextActions: serverEnvPlanNextActions(missing),
  };
  return result;
}

function readGuide(path: string): {
  exists: boolean;
  ok: boolean;
  sha256?: string;
  value?: Guide;
  requiredServerEnvNames: string[];
} {
  if (!existsSync(path)) return { exists: false, ok: false, requiredServerEnvNames: [] };
  try {
    const text = readFileSync(path, "utf8");
    const value = guideValue(JSON.parse(text) as unknown);
    if (!value) return { exists: true, ok: false, sha256: sha256Hex(text), requiredServerEnvNames: [] };
    return {
      exists: true,
      ok: true,
      sha256: sha256Hex(text),
      value,
      requiredServerEnvNames: requiredServerEnvNames(value),
    };
  } catch {
    return { exists: true, ok: false, requiredServerEnvNames: [] };
  }
}

interface Guide {
  schemaVersion: "upstream-agent-git-service-staging-guide/v1";
  tokenFree: true;
  upstream: {
    repository?: string;
    developmentBinary?: string;
    apiBasePath?: string;
    metadataDatabaseEnv?: string;
  };
  requiredServerEnv?: Array<{
    name?: string;
    purpose?: string;
  }>;
  targets?: {
    controlPlane?: {
      provider?: string;
      baseUrl?: string;
      tokenEnv?: string;
    };
  };
}

function guideValue(value: unknown): Guide | undefined {
  const record = objectRecord(value);
  if (record?.schemaVersion !== "upstream-agent-git-service-staging-guide/v1" || record.tokenFree !== true) {
    return undefined;
  }
  const upstream = objectRecord(record.upstream);
  return {
    schemaVersion: "upstream-agent-git-service-staging-guide/v1",
    tokenFree: true,
    upstream: {
      repository: stringValue(upstream?.repository),
      developmentBinary: stringValue(upstream?.developmentBinary),
      apiBasePath: stringValue(upstream?.apiBasePath),
      metadataDatabaseEnv: stringValue(upstream?.metadataDatabaseEnv),
    },
    requiredServerEnv: Array.isArray(record.requiredServerEnv)
      ? record.requiredServerEnv.map(objectRecord).filter((item): item is Record<string, unknown> => item !== undefined).map((item) => ({
          name: stringValue(item.name),
          purpose: stringValue(item.purpose),
        }))
      : undefined,
    targets: {
      controlPlane: {
        provider: stringValue(objectRecord(objectRecord(record.targets)?.controlPlane)?.provider),
        baseUrl: stringValue(objectRecord(objectRecord(record.targets)?.controlPlane)?.baseUrl),
        tokenEnv: stringValue(objectRecord(objectRecord(record.targets)?.controlPlane)?.tokenEnv),
      },
    },
  };
}

function requiredServerEnvNames(guide: Guide): string[] {
  const declared = guide.requiredServerEnv
    ?.map((item) => item.name)
    .filter((name): name is string => name !== undefined && isEnvName(name)) ?? [];
  const fallback = stringValue(guide.upstream.metadataDatabaseEnv);
  return Array.from(new Set(declared.length > 0 ? declared : fallback && isEnvName(fallback) ? [fallback] : []))
    .sort();
}

function serverStartShellCommand(envNames: string[], developmentBinary: string): string {
  const envAssignments = envNames.map((name) => `${name}="\${${name}:?missing ${name}}"`);
  return [...envAssignments, shellQuote(developmentBinary)].join(" ");
}

function readinessProbeUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api\/v3$/, "") + "/readyz";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function serverEnvPlanNextActions(missing: string[]): string[] {
  if (missing.includes("upstreamAgentGitService.guide")) {
    return ["Regenerate the AGS cutover bundle so upstream-agent-git-service.json is present and token-free, then rerun upstream-agent-git-service-server-env-plan."];
  }
  if (missing.includes("upstreamAgentGitService.requiredServerEnv")) {
    return ["Add requiredServerEnv entries to upstream-agent-git-service.json, then rerun upstream-agent-git-service-server-env-plan."];
  }
  if (missing.includes("upstreamAgentGitService.upstream.developmentBinary")) {
    return ["Restore upstream.developmentBinary in upstream-agent-git-service.json, then rerun upstream-agent-git-service-server-env-plan."];
  }
  if (missing.includes("upstreamAgentGitService.targets.controlPlane.baseUrl")) {
    return ["Restore targets.controlPlane.baseUrl in upstream-agent-git-service.json, then rerun upstream-agent-git-service-server-env-plan."];
  }
  return ["Export the required server env names where gh-server runs, start upstream agent-git-service with serverStartShellCommand, wait for readinessProbeCommandArgs to pass, then rerun upstream-agent-git-service-handoff and platform-staging-prerequisites."];
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
