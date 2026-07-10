import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type TenantAuditEventType =
  | "project_created"
  | "project_source_defaults_updated"
  | "project_default_skills_updated"
  | "project_run_policy_updated"
  | "project_contract_updated"
  | "vas_case_created"
  | "vas_case_claimed"
  | "vas_case_reviewed"
  | "run_created"
  | "queued_run_recovered"
  | "queued_run_recovery_failed"
  | "run_started"
  | "run_finished"
  | "run_handoff_followup_created"
  | "run_handoff_followup_denied"
  | "run_comment_added"
  | "run_issue_comments_synced"
  | "run_resumed"
  | "run_cancelled"
  | "run_abandoned"
  | "run_review_claimed"
  | "review_decided"
  | "deployment_decided"
  | "brain_signal_ingested"
  | "workspace_file_written"
  | "workspace_file_moved"
  | "workspace_file_deleted"
  | "workspace_file_conflicted"
  | "workspace_commit_created"
  | "workspace_pull_request_created"
  | "workspace_command_ran"
  | "workspace_session_started"
  | "workspace_session_input_sent"
  | "workspace_session_stopped"
  | "workspace_session_exited"
  | "stale_run_auto_abandoned"
  | "tenant_policy_updated"
  | "tenant_api_key_created"
  | "tenant_api_key_revoked"
  | "tenant_control_plane_restore_dry_run"
  | "operator_target_input_template_written"
  | "operator_real_staging_target_input_written"
  | "operator_real_staging_targets_applied"
  | "operator_bundle_refreshed"
  | "operator_github_actions_target_input_written"
  | "operator_ci_artifact_imported"
  | "operator_ags_evidence_synced"
  | "operator_ags_evidence_imported"
  | "operator_approvals_exported"
  | "operator_handoff_packet_exported"
  | "operator_cockpit_loop_execution_blocked"
  | "operator_cockpit_loop_executed"
  | "agent_git_service_project_agent_provisioned"
  | "agent_git_service_tenant_provisioning_plan_applied"
  | "agent_git_service_wiki_memory_updated"
  | "agent_git_service_wiki_memory_failed"
  | "tenant_policy_escalation_requested"
  | "tenant_policy_escalation_decided";

export type TenantRole = "admin" | "developer" | "viewer";

export interface TenantAuditActor {
  actor: string;
  role: TenantRole;
}

export interface TenantAuditEvent<T = unknown> {
  tenant: string;
  seq: number;
  ts: string;
  type: TenantAuditEventType;
  actor?: string;
  role?: TenantRole;
  data: T;
}

export type TenantAuditAppender = <T>(tenant: string, type: TenantAuditEventType, data: T, actor?: TenantAuditActor) => Promise<TenantAuditEvent<T>>;

export function createTenantAuditAppender(workspaceRoot: string): TenantAuditAppender {
  const queues = new Map<string, Promise<void>>();
  return async <T>(tenant: string, type: TenantAuditEventType, data: T, actor?: TenantAuditActor): Promise<TenantAuditEvent<T>> => {
    let observed: TenantAuditEvent<T> | undefined;
    const previous = queues.get(tenant) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      observed = await appendTenantAuditEvent(workspaceRoot, tenant, type, data, actor);
    });
    queues.set(tenant, next.then(() => undefined, () => undefined));
    await next;
    return observed as TenantAuditEvent<T>;
  };
}

export async function readTenantAuditEvents(workspaceRoot: string, tenant: string): Promise<TenantAuditEvent[]> {
  try {
    const raw = await readFile(tenantAuditLogPath(workspaceRoot, tenant), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        const event = readTenantAuditLine(line, tenant);
        return event ? [event] : [];
      });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

function readTenantAuditLine(line: string, tenant: string): TenantAuditEvent | undefined {
  try {
    const event = JSON.parse(line) as TenantAuditEvent;
    if (!isTenantAuditEvent(event, tenant)) return undefined;
    return event;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isTenantAuditEvent(value: unknown, tenant: string): value is TenantAuditEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return event.tenant === tenant
    && Number.isInteger(event.seq)
    && typeof event.ts === "string"
    && typeof event.type === "string"
    && "data" in event;
}

async function appendTenantAuditEvent<T>(
  workspaceRoot: string,
  tenant: string,
  type: TenantAuditEventType,
  data: T,
  actor?: TenantAuditActor,
): Promise<TenantAuditEvent<T>> {
  const events = await readTenantAuditEvents(workspaceRoot, tenant);
  const event: TenantAuditEvent<T> = {
    tenant,
    seq: events.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
    ts: new Date().toISOString(),
    type,
    actor: actor?.actor,
    role: actor?.role,
    data,
  };
  await mkdir(tenantAuditDir(workspaceRoot, tenant), { recursive: true });
  await appendFile(tenantAuditLogPath(workspaceRoot, tenant), JSON.stringify(event) + "\n", "utf8");
  return event;
}

function tenantAuditDir(workspaceRoot: string, tenant: string): string {
  return join(workspaceRoot, tenant, ".loom");
}

function tenantAuditLogPath(workspaceRoot: string, tenant: string): string {
  return join(tenantAuditDir(workspaceRoot, tenant), "audit.jsonl");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
