import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where everything points. Loaded from ./loom.config.json (else env/defaults). */
export interface LoomConfig {
  /** LiteLLM gateway — Anthropic-compatible base URL. Central billing lives here. */
  gatewayUrl: string;
  /** Env var name holding THIS developer's virtual key (per-member budget). */
  gatewayKeyEnv: string;
  /** Self-hosted control plane (Gitea/Forgejo). */
  giteaUrl: string;
  /** Per-dev workspace root; each project is a dir under here. */
  workspaceRoot: string;
  /** Git-backed skills + brain store (.brain/ lives inside). */
  skillsRepo: string;
  /** Which native CLI to delegate the loop to. */
  engine: "claude" | "codex";
  /** Model routing by tier — swap models by editing this, nothing else. */
  models: { default: string; reasoning?: string; cheap?: string };

  // --- multi-tenant (loomd) ---
  /** Container runtime / isolation tier. runc=plain docker, runsc=gVisor, kata-fc=Firecracker microVM. */
  runtime: "runc" | "runsc" | "kata-fc";
  /** Per-tenant resource caps. */
  resources: { cpus: number; memory: string; pidsLimit?: number };
  /** User-defined docker network reachable to gateway+gitea, NOT between tenant containers. */
  network: string;
  /** Per-tenant workspace image (has git + native CLI + loom preinstalled). */
  workspaceImage: string;
  /** Stop a tenant container after this many idle minutes (volume persists). */
  idleStopMinutes: number;
  /** Default auth mode for new tenants. gateway=API key via LiteLLM; subscription=user's own login. */
  defaultAuthMode: "gateway" | "subscription";
}

const DEFAULTS: LoomConfig = {
  gatewayUrl: process.env.LOOM_GATEWAY_URL ?? "http://localhost:4000",
  gatewayKeyEnv: "LOOM_GATEWAY_KEY",
  giteaUrl: process.env.LOOM_GITEA_URL ?? "http://localhost:3000",
  workspaceRoot: process.env.LOOM_WORKSPACE_ROOT ?? join(homedir(), "projects"),
  skillsRepo: process.env.LOOM_SKILLS_REPO ?? join(homedir(), "projects", "_skills"),
  engine: (process.env.LOOM_ENGINE as "claude" | "codex") ?? "claude",
  models: { default: "kimi-k2.6", reasoning: "glm-5.1", cheap: "deepseek-v4" },
  runtime: (process.env.LOOM_RUNTIME as LoomConfig["runtime"]) ?? "runsc",
  resources: { cpus: 2, memory: "4g" },
  network: process.env.LOOM_NETWORK ?? "loom-net",
  workspaceImage: process.env.LOOM_WORKSPACE_IMAGE ?? "loom/workspace:latest",
  idleStopMinutes: 60,
  defaultAuthMode: (process.env.LOOM_AUTH_MODE as LoomConfig["defaultAuthMode"]) ?? "gateway",
};

export function loadConfig(): LoomConfig {
  const path = join(process.cwd(), "loom.config.json");
  if (existsSync(path)) {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<LoomConfig>) };
  }
  return DEFAULTS;
}
