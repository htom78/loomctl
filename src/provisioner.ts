import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { LoomConfig } from "./config.js";
import { assertTenantName } from "./tenant.js";

export type AuthMode = "gateway" | "subscription";

export interface ProvisionOpts {
  user: string;
  authMode: AuthMode;
  /** Only used in gateway mode. NEVER a subscription credential. */
  gatewayKey?: string;
}

export interface TenantSession {
  id: string;
  startedAt: string;
  pid: number;
}

export interface TenantActivity {
  user: string;
  activeSessions: number;
  lastActiveAt?: string;
  idleForMs?: number;
}

export interface DockerContainerStatus {
  name: string;
  status: string;
  runningFor: string;
}

export interface TenantWorkspaceStatus {
  user: string;
  container: string;
  status: string;
  runningFor: string;
  activeSessions: number;
  lastActiveAt?: string;
  idleForMs?: number;
}

interface TenantSessionOptions {
  now?: () => Date;
  pid?: number;
}

interface TenantActivityReadOptions {
  now?: () => Date;
  isPidAlive?: (pid: number) => boolean;
}

interface StopIdleTenantsOptions extends TenantActivityReadOptions {
  containerExists?: (user: string) => Promise<boolean>;
  stopTenant?: (user: string) => Promise<void>;
  log?: (message: string) => void;
}

interface TenantWorkspaceStatusOptions extends TenantActivityReadOptions {
  dockerContainers?: () => Promise<DockerContainerStatus[]>;
}

const DEFAULT_PIDS_LIMIT = 256;
const DEFAULT_TMPFS = "/tmp:rw,noexec,nosuid,size=64m";

const containerName = (user: string) => `loom-${assertTenantName(user)}`;
const volumeName = (user: string) => `loom-home-${assertTenantName(user)}`;
const stateDir = () => process.env.LOOM_STATE_DIR ?? join(homedir(), ".loomd");
const tenantStateKey = (user: string) => encodeURIComponent(assertTenantName(user));
const activityDir = () => join(stateDir(), "activity");
const activityPath = (user: string) => join(activityDir(), `${tenantStateKey(user)}.json`);
const sessionsDir = () => join(stateDir(), "sessions");
const tenantSessionsDir = (user: string) => join(sessionsDir(), tenantStateKey(user));
const tenantSessionPath = (user: string, sessionId: string) => join(tenantSessionsDir(user), `${sessionId}.json`);

export async function exists(user: string): Promise<boolean> {
  const { stdout } = await execa("docker", ["ps", "-aq", "-f", `name=^${containerName(user)}$`], { reject: false });
  return stdout.trim().length > 0;
}

/** First entry → create (container + persistent volume). Later → just start. */
export async function ensureUp(cfg: LoomConfig, o: ProvisionOpts): Promise<void> {
  if (await exists(o.user)) {
    await execa("docker", ["start", containerName(o.user)], { stdio: "inherit", reject: false });
  } else {
    await create(cfg, o);
  }
}

async function create(cfg: LoomConfig, o: ProvisionOpts): Promise<void> {
  await execa("docker", createWorkspaceRunArgs(cfg, o), { stdio: "inherit", reject: false });
}

export function createWorkspaceRunArgs(cfg: LoomConfig, o: ProvisionOpts): string[] {
  const network = safeDockerNetwork(cfg.network);
  const pidsLimit = "pidsLimit" in cfg.resources && typeof cfg.resources.pidsLimit === "number"
    ? cfg.resources.pidsLimit
    : DEFAULT_PIDS_LIMIT;
  const args = [
    "run", "-d",
    "--name", containerName(o.user),
    "--restart", "unless-stopped",
    // persistent volume → ~/.claude session store survives → native --resume works per tenant
    "-v", `${volumeName(o.user)}:/home/dev`,
    "-w", "/home/dev/projects",
    // resource caps + hardening
    "--cpus", String(cfg.resources.cpus),
    "--memory", cfg.resources.memory,
    "--pids-limit", String(pidsLimit),
    "--read-only",
    "--tmpfs", DEFAULT_TMPFS,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    // network reaches gateway + gitea, but tenant containers cannot reach each other
    "--network", network,
  ];

  // isolation tier: runc (plain) | runsc (gVisor) | kata-fc (Firecracker microVM)
  if (cfg.runtime !== "runc") args.push("--runtime", cfg.runtime);

  if (o.authMode === "gateway") {
    // API billing via the central gateway; per-tenant virtual key.
    args.push("-e", `ANTHROPIC_BASE_URL=${cfg.gatewayUrl}`);
    args.push("-e", `ANTHROPIC_AUTH_TOKEN=${o.gatewayKey ?? ""}`);
  }
  // subscription mode: inject NOTHING. The tenant runs `claude login` once inside their OWN
  // container; the login lives only in THEIR volume (~/.claude). loomd never stores, copies,
  // or shares a subscription credential across tenants — by construction there is no shared path.
  args.push("-e", `LOOM_AUTH_MODE=${o.authMode}`);

  args.push(cfg.workspaceImage, "sleep", "infinity");
  return args;
}

function safeDockerNetwork(value: string): string {
  const network = value.trim();
  if (network === "host" || network === "bridge" || network.startsWith("container:")) {
    throw new Error(`unsafe docker network mode: ${network}`);
  }
  if (network !== "none" && !/^[A-Za-z0-9_.-]+$/.test(network)) {
    throw new Error(`docker network must be none or a named sandbox network: ${network}`);
  }
  return network;
}

/** SSH ForceCommand target: drop the authenticated tenant into their own container. */
export async function enter(user: string): Promise<number> {
  const session = beginTenantSession(user);
  try {
    const { exitCode } = await execa(
      "docker",
      ["exec", "-it", containerName(user), "bash", "-l"],
      { stdio: "inherit", reject: false },
    );
    return exitCode ?? 1;
  } finally {
    endTenantSession(user, session.id);
  }
}

export async function stop(user: string): Promise<void> {
  await execa("docker", ["stop", containerName(user)], { stdio: "inherit", reject: false });
}

export async function ps(users: ReadonlyArray<{ name: string }> = []): Promise<void> {
  console.log(formatTenantWorkspaceStatuses(await listTenantWorkspaceStatuses(users)));
}

export function beginTenantSession(user: string, options: TenantSessionOptions = {}): TenantSession {
  const session: TenantSession = {
    id: randomUUID(),
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    pid: options.pid ?? process.pid,
  };
  mkdirSync(tenantSessionsDir(user), { recursive: true });
  writeFileSync(tenantSessionPath(user, session.id), JSON.stringify(session, null, 2), "utf8");
  return session;
}

export function endTenantSession(user: string, sessionId: string, options: TenantSessionOptions = {}): void {
  try {
    unlinkSync(tenantSessionPath(user, sessionId));
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  writeTenantActivity(user, (options.now ?? (() => new Date()))().toISOString());
}

export function readTenantActivity(user: string, options: TenantActivityReadOptions = {}): TenantActivity {
  const now = (options.now ?? (() => new Date()))();
  const staleEndedAt = pruneStaleTenantSessions(user, options.isPidAlive ?? pidIsAlive);
  const lastActiveAt = updateLastActiveAt(user, staleEndedAt);
  const activeSessions = readTenantSessionRecords(user).length;
  const lastActiveTime = lastActiveAt ? Date.parse(lastActiveAt) : NaN;
  return {
    user,
    activeSessions,
    lastActiveAt,
    idleForMs: Number.isFinite(lastActiveTime) ? Math.max(0, now.getTime() - lastActiveTime) : undefined,
  };
}

export async function stopIdleTenants(
  cfg: LoomConfig,
  users: ReadonlyArray<{ name: string }>,
  options: StopIdleTenantsOptions = {},
): Promise<string[]> {
  const idleMs = cfg.idleStopMinutes * 60_000;
  if (!Number.isFinite(idleMs) || idleMs <= 0) return [];

  const now = options.now ?? (() => new Date());
  const containerExists = options.containerExists ?? exists;
  const stopTenant = options.stopTenant ?? stop;
  const stopped: string[] = [];

  for (const user of users) {
    const activity = readTenantActivity(user.name, { now, isPidAlive: options.isPidAlive });
    if (activity.activeSessions > 0 || activity.idleForMs === undefined || activity.idleForMs < idleMs) continue;
    if (!(await containerExists(user.name))) continue;

    await stopTenant(user.name);
    stopped.push(user.name);
    options.log?.(`idle GC stopped ${user.name} after ${Math.round(activity.idleForMs / 60_000)} idle minutes`);
  }

  return stopped;
}

export async function listTenantWorkspaceStatuses(
  users: ReadonlyArray<{ name: string }>,
  options: TenantWorkspaceStatusOptions = {},
): Promise<TenantWorkspaceStatus[]> {
  const containers = await (options.dockerContainers ?? dockerContainerStatuses)();
  const containerByUser = new Map<string, DockerContainerStatus>();
  const usersByName = new Map(users.map((user) => [user.name, user]));

  for (const container of containers) {
    if (!container.name.startsWith("loom-")) continue;
    const rawUser = container.name.slice("loom-".length);
    let user: string;
    try {
      user = assertTenantName(rawUser);
    } catch {
      continue;
    }
    containerByUser.set(user, container);
    if (!usersByName.has(user)) usersByName.set(user, { name: user });
  }

  return [...usersByName.keys()].sort().map((user) => {
    const safeUser = assertTenantName(user);
    const container = containerByUser.get(safeUser);
    const activity = readTenantActivity(safeUser, { now: options.now, isPidAlive: options.isPidAlive });
    return {
      user: safeUser,
      container: container?.name ?? containerName(safeUser),
      status: container?.status ?? "missing",
      runningFor: container?.runningFor ?? "-",
      activeSessions: activity.activeSessions,
      lastActiveAt: activity.lastActiveAt,
      idleForMs: activity.idleForMs,
    };
  });
}

export function formatTenantWorkspaceStatuses(rows: TenantWorkspaceStatus[]): string {
  const header = "USER\tCONTAINER\tSTATUS\tRUNNING_FOR\tACTIVE_SESSIONS\tLAST_ACTIVE\tIDLE_FOR";
  const body = rows.map((row) => [
    row.user,
    row.container,
    row.status,
    row.runningFor,
    String(row.activeSessions),
    row.lastActiveAt ?? "-",
    row.idleForMs === undefined ? "-" : formatDuration(row.idleForMs),
  ].join("\t"));
  return [header, ...body].join("\n");
}

async function dockerContainerStatuses(): Promise<DockerContainerStatus[]> {
  const { stdout } = await execa(
    "docker",
    ["ps", "-a", "--filter", "name=loom-", "--format", "{{.Names}}\t{{.Status}}\t{{.RunningFor}}"],
    { reject: false },
  );
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [name, status, runningFor] = line.split("\t");
      return { name, status, runningFor };
    })
    .filter((row) => row.name);
}

function writeTenantActivity(user: string, lastActiveAt: string): void {
  mkdirSync(activityDir(), { recursive: true });
  writeFileSync(activityPath(user), JSON.stringify({ lastActiveAt }, null, 2), "utf8");
}

function updateLastActiveAt(user: string, staleEndedAt?: string): string | undefined {
  const current = readLastActiveAt(user);
  if (!staleEndedAt) return current;
  if (current && current >= staleEndedAt) return current;
  writeTenantActivity(user, staleEndedAt);
  return staleEndedAt;
}

function readLastActiveAt(user: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(activityPath(user), "utf8")) as { lastActiveAt?: unknown };
    return typeof parsed.lastActiveAt === "string" ? parsed.lastActiveAt : undefined;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

function readTenantSessionRecords(user: string): TenantSession[] {
  try {
    return readdirSync(tenantSessionsDir(user))
      .filter((name) => name.endsWith(".json"))
      .map((name) => readTenantSessionRecord(join(tenantSessionsDir(user), name)))
      .filter((session): session is TenantSession => session !== undefined);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

function readTenantSessionRecord(path: string): TenantSession | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TenantSession>;
    if (typeof parsed.id !== "string" || typeof parsed.startedAt !== "string" || typeof parsed.pid !== "number") {
      return undefined;
    }
    return { id: parsed.id, startedAt: parsed.startedAt, pid: parsed.pid };
  } catch {
    return undefined;
  }
}

function pruneStaleTenantSessions(user: string, isPidAlive: (pid: number) => boolean): string | undefined {
  let staleEndedAt: string | undefined;
  try {
    for (const name of readdirSync(tenantSessionsDir(user))) {
      if (!name.endsWith(".json")) continue;
      const path = join(tenantSessionsDir(user), name);
      const session = readTenantSessionRecord(path);
      if (session && isPidAlive(session.pid)) continue;
      try {
        unlinkSync(path);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      if (session?.startedAt && (!staleEndedAt || session.startedAt > staleEndedAt)) {
        staleEndedAt = session.startedAt;
      }
    }
  } catch (error) {
    if (isNotFoundError(error)) return staleEndedAt;
    throw error;
  }
  return staleEndedAt;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function isNotFoundError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}
