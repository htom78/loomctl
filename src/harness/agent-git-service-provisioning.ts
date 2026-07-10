import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  createAgentGitServiceAgent,
  grantAgentGitServiceRepoAccess,
  parseAgentGitServiceRepoRef,
  type AgentGitServiceAgentRegistration,
  type AgentGitServiceRepoAccessGrant,
  type AgentGitServiceRepoPermission,
  type CreateAgentGitServiceAgentOptions,
  type GrantAgentGitServiceRepoAccessOptions,
} from "./agent-git-service.js";

export const AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH = ".loom/control-plane/agent-git-service/provisioning.json";

export interface AgentGitServiceProjectProvisioningReceipt {
  schemaVersion: 1;
  provider: "agent-git-service";
  tenant: string;
  project: string;
  baseUrl: string;
  repo: string;
  agentLogin: string;
  agentRepoFullName: string;
  permission: AgentGitServiceRepoPermission;
  grantStatus: AgentGitServiceRepoAccessGrant["status"];
  grantInvitationId?: string;
  grantUrl?: string;
  tokenEnvName: string;
  tokenMaterial: "returned-only";
  provisionedAt: string;
}

export interface ProvisionAgentGitServiceProjectAgentOptions {
  workspaceRoot: string;
  tenant: string;
  project: string;
  baseUrl: string;
  adminToken: string;
  repo: string;
  agentPrefixLogin?: string;
  defaultRepoName?: string;
  permission?: AgentGitServiceRepoPermission;
  tokenEnvName: string;
  now?: () => Date;
  createAgent?: (options: CreateAgentGitServiceAgentOptions) => Promise<AgentGitServiceAgentRegistration>;
  grantRepoAccess?: (options: GrantAgentGitServiceRepoAccessOptions) => Promise<AgentGitServiceRepoAccessGrant>;
}

export interface AgentGitServiceProjectProvisioningResult {
  receipt: AgentGitServiceProjectProvisioningReceipt;
  receiptPath: string;
  agentToken: string;
}

export async function provisionAgentGitServiceProjectAgent(
  options: ProvisionAgentGitServiceProjectAgentOptions,
): Promise<AgentGitServiceProjectProvisioningResult> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const tenant = requireProvisioningName(options.tenant, "tenant");
  const project = requireProvisioningProject(options.project);
  const baseUrl = requireUrl(options.baseUrl, "baseUrl");
  const repo = requireAgentGitServiceRepo(options.repo);
  const adminToken = requireSingleLineString(options.adminToken, "adminToken");
  const permission = options.permission ?? "write";
  const tokenEnvName = requireEnvName(options.tokenEnvName, "tokenEnvName");
  const agentPrefixLogin = requireSingleLineString(options.agentPrefixLogin ?? `loom-${tenant}-${project}`, "agentPrefixLogin");
  const defaultRepoName = requireProvisioningName(options.defaultRepoName ?? project, "defaultRepoName");
  const projectRoot = join(workspaceRoot, tenant, project);

  await requireDirectory(projectRoot, `project not found: ${tenant}/${project}`);

  const createAgent = options.createAgent ?? createAgentGitServiceAgent;
  const grantRepoAccess = options.grantRepoAccess ?? grantAgentGitServiceRepoAccess;
  const registration = await createAgent({
    baseUrl,
    prefixLogin: agentPrefixLogin,
    defaultRepoName,
  });
  const grant = await grantRepoAccess({
    baseUrl,
    token: adminToken,
    repo,
    agentLogin: registration.login,
    permission,
  });

  const receipt = compactObject({
    schemaVersion: 1 as const,
    provider: "agent-git-service" as const,
    tenant,
    project,
    baseUrl,
    repo,
    agentLogin: registration.login,
    agentRepoFullName: registration.repoFullName,
    permission: grant.permission,
    grantStatus: grant.status,
    grantInvitationId: grant.invitationId,
    grantUrl: grant.url,
    tokenEnvName,
    tokenMaterial: "returned-only" as const,
    provisionedAt: (options.now ?? (() => new Date()))().toISOString(),
  }) as AgentGitServiceProjectProvisioningReceipt;
  const receiptPath = agentGitServiceProjectProvisioningReceiptPath(workspaceRoot, tenant, project);

  await mkdir(dirname(receiptPath), { recursive: true });
  await writeJsonFileAtomic(receiptPath, receipt);
  return { receipt, receiptPath, agentToken: registration.token };
}

export function agentGitServiceProjectProvisioningReceiptPath(
  workspaceRoot: string,
  tenant: string,
  project: string,
): string {
  return join(
    resolve(workspaceRoot),
    requireProvisioningName(tenant, "tenant"),
    requireProvisioningProject(project),
    ...AGENT_GIT_SERVICE_PROJECT_PROVISIONING_RECEIPT_PATH.split("/"),
  );
}

export async function readAgentGitServiceProjectProvisioningReceipt(
  workspaceRoot: string,
  tenant: string,
  project: string,
): Promise<AgentGitServiceProjectProvisioningReceipt | undefined> {
  try {
    return agentGitServiceProjectProvisioningReceiptFromUnknown(
      JSON.parse(await readFile(agentGitServiceProjectProvisioningReceiptPath(workspaceRoot, tenant, project), "utf8")),
      { tenant, project },
    );
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function agentGitServiceProjectProvisioningReceiptFromUnknown(
  value: unknown,
  expected: { tenant: string; project: string },
): AgentGitServiceProjectProvisioningReceipt | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== 1 || value.provider !== "agent-git-service") return undefined;
  if (value.tenant !== expected.tenant || value.project !== expected.project) return undefined;
  if (
    typeof value.baseUrl !== "string" ||
    typeof value.repo !== "string" ||
    typeof value.agentLogin !== "string" ||
    typeof value.agentRepoFullName !== "string" ||
    !isAgentGitServiceRepoPermission(value.permission) ||
    (value.grantStatus !== "granted" && value.grantStatus !== "invited") ||
    typeof value.tokenEnvName !== "string" ||
    value.tokenMaterial !== "returned-only" ||
    typeof value.provisionedAt !== "string"
  ) {
    return undefined;
  }
  if (value.grantInvitationId !== undefined && typeof value.grantInvitationId !== "string") return undefined;
  if (value.grantUrl !== undefined && typeof value.grantUrl !== "string") return undefined;
  return value as unknown as AgentGitServiceProjectProvisioningReceipt;
}

async function requireDirectory(path: string, message: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error(message);
  } catch (error) {
    if (isNotFound(error)) throw new Error(message);
    throw error;
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

function requireAgentGitServiceRepo(value: string): string {
  const repo = requireSingleLineString(value, "repo");
  parseAgentGitServiceRepoRef(repo);
  return repo;
}

function requireUrl(value: string, field: string): string {
  const url = requireSingleLineString(value, field);
  new URL(url);
  return url.replace(/\/+$/, "");
}

function requireProvisioningProject(value: string): string {
  const project = requireProvisioningName(value, "project");
  if (project === ".loom") throw new Error("project is reserved.");
  return project;
}

function requireProvisioningName(value: string, field: string): string {
  const name = requireSingleLineString(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  return name;
}

function requireEnvName(value: string, field: string): string {
  const name = requireSingleLineString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${field} must be an environment variable name.`);
  }
  return name;
}

function requireSingleLineString(value: string, field: string): string {
  const text = value.trim();
  if (!text || /[\0\r\n]/.test(text)) throw new Error(`${field} must be a non-empty single-line string.`);
  return text;
}

function isAgentGitServiceRepoPermission(value: unknown): value is AgentGitServiceRepoPermission {
  return value === "read" || value === "write" || value === "admin";
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
