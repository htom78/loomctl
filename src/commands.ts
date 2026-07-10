import { execa } from "execa";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { LoomConfig } from "./config.js";
import { createWorkspaceRunArgs } from "./provisioner.js";

/**
 * Create a per-developer persistent workspace: a container + a persistent volume + its own $HOME.
 * The persistent volume keeps ~/.claude (session store) alive between runs → native --resume just works.
 * Thin docker wrapper — no orchestration logic here.
 */
export async function workspaceCreate(cfg: LoomConfig, name: string): Promise<void> {
  await execa(
    "docker",
    workspaceCreateArgs(cfg, name, { gatewayKey: process.env[cfg.gatewayKeyEnv] }),
    { stdio: "inherit", reject: false },
  );
}

export interface WorkspaceCreateArgsOptions {
  gatewayKey?: string;
}

export function workspaceCreateArgs(cfg: LoomConfig, name: string, options: WorkspaceCreateArgsOptions = {}): string[] {
  return createWorkspaceRunArgs(cfg, {
    user: name,
    authMode: cfg.defaultAuthMode,
    gatewayKey: options.gatewayKey,
  });
}

/** Clone a Gitea project into the workspace. Thin git wrapper. */
export async function projectAdd(cfg: LoomConfig, repo: string): Promise<void> {
  const target = projectCloneTarget(cfg, repo);
  mkdirSync(cfg.workspaceRoot, { recursive: true });
  await execa("git", ["clone", target.repo, target.dest], { stdio: "inherit", reject: false });
}

export function projectCloneTarget(cfg: LoomConfig, repo: string): { repo: string; name: string; dest: string } {
  const safeRepo = safeGitCloneSource(repo);
  const name = safePathSegment(projectNameFromRepo(safeRepo), "project name");
  return { repo: safeRepo, name, dest: join(cfg.workspaceRoot, name) };
}

/** Install a Claude Code Stop hook that feeds each run's outcome to the brain. */
export function hooksInstall(): void {
  const dir = join(homedir(), ".claude");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const settings: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(settingsPath, JSON.stringify(withLoomStopHook(settings), null, 2), "utf8");
  console.log(`Installed Stop hook → loom-stop-hook in ${settingsPath}`);
}

export function withLoomStopHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const stopHooks = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];
  if (!stopHooks.some(hasLoomStopHook)) {
    stopHooks.push({ hooks: [{ type: "command", command: "loom-stop-hook" }] });
  }
  return { ...settings, hooks: { ...hooks, Stop: stopHooks } };
}

function safeGitCloneSource(value: string): string {
  const repo = value.trim();
  if (!repo || repo.includes("\0") || repo.startsWith("-")) {
    throw new Error(`project repo is not safe: ${value}`);
  }
  return repo;
}

function projectNameFromRepo(repo: string): string {
  const withoutTrailingSlash = repo.replace(/[\/\\]+$/, "");
  const withoutGitSuffix = withoutTrailingSlash.replace(/\.git$/i, "");
  return withoutGitSuffix.split(/[\/\\]/).pop() ?? "";
}

function safePathSegment(value: string, field: string): string {
  const segment = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(segment)) {
    throw new Error(`${field} must match [A-Za-z0-9][A-Za-z0-9_.-]{0,62}`);
  }
  return segment;
}

function hasLoomStopHook(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => isRecord(hook) && hook.type === "command" && hook.command === "loom-stop-hook");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
