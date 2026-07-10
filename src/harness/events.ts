export type HarnessEventType =
  | "user_message"
  | "run_metadata"
  | "run_policy"
  | "workspace_prepare"
  | "agent_retry"
  | "model_usage"
  | "assistant_message"
  | "action"
  | "observation"
  | "verification"
  | "evaluation"
  | "reviewer"
  | "review_gate"
  | "review_claim"
  | "deployment_gate"
  | "resume"
  | "pause"
  | "external_effect"
  | "cancel"
  | "finish"
  | "error";

export interface HarnessEvent<T = unknown> {
  runId: string;
  seq: number;
  ts: string;
  type: HarnessEventType;
  data: T;
}

export interface ToolAction {
  id?: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolObservation {
  actionId: string;
  toolName: string;
  ok: boolean;
  output: string;
  exitCode?: number;
  error?: string;
}

export interface VerificationResult {
  ok: boolean;
  output: string;
  exitCode: number;
  commands: string[];
}

export type EvaluationResult = VerificationResult;
export type ReviewerResult = VerificationResult;

export type HarnessStatus = "passed" | "failed" | "error" | "review_required" | "deployment_required" | "paused" | "cancelled";

export type ProjectRunPolicyField = "preset" | "presetInput" | "reviewRequired" | "deploymentRequired";

export interface ProjectRunPolicyEvidence {
  source: "project.runPolicy";
  fields: ProjectRunPolicyField[];
  preset?: string;
  presetInput?: Record<string, unknown>;
  reviewRequired?: boolean;
  deploymentRequired?: boolean;
}

export interface ProjectContractEvidence {
  source: "project.contract";
  objective?: string;
  constraints?: string[];
  successCriteria?: string[];
}

export interface ProjectContractPatch {
  objective?: string;
  constraints?: string[];
  successCriteria?: string[];
}

export interface ProjectContractStatusEvidence {
  source: "project.contractStatus";
  ok: boolean;
  missing: string[];
}

export interface RunMetadata {
  tenant?: string;
  project?: string;
  issue?: string;
  repo?: string;
  branch?: string;
  baseBranch?: string;
  runPreset?: string;
  runPresetInput?: Record<string, unknown>;
  projectRunPolicy?: ProjectRunPolicyEvidence;
  projectContract?: ProjectContractEvidence;
  projectContractStatus?: ProjectContractStatusEvidence;
  agentMode?: "script" | "command" | "model";
  model?: string;
  modelProtocol?: "json" | "tool-call";
  handoffSourceRunId?: string;
  handoffSourceProject?: string;
  handoffSourceStatus?: string;
  handoffSourceGoal?: string;
  handoffSourceCheckpointVersion?: string;
  handoffSourceProjectContract?: ProjectContractEvidence;
  handoffSourceProjectContractStatus?: ProjectContractStatusEvidence;
  handoffSourceReplayUrl?: string;
  handoffSourceHandoffPackageUrl?: string;
  handoffSourceControlPlaneProvider?: string;
  handoffSourceControlPlaneCommentId?: string;
  handoffSourceControlPlaneCommentUrl?: string;
  handoffSourceGiteaCommentId?: string;
  handoffSourceGiteaCommentUrl?: string;
  issueUrl?: string;
  dashboardUrl?: string;
  summaryUrl?: string;
  pullRequestIndex?: number;
  pullRequestUrl?: string;
}

export interface ReviewGate {
  required: boolean;
  status: "pending" | "approved" | "rejected";
  note?: string;
  merged?: boolean;
  contractPatch?: ProjectContractPatch;
  claim?: ReviewClaim;
}

export interface ReviewClaim {
  actor?: string;
  role?: string;
  clientId?: string;
  claimedAt: string;
}

export interface DeploymentGate {
  required: boolean;
  status: "pending" | "approved" | "rejected";
  note?: string;
}

export interface RunErrorSummary {
  message: string;
  phase?: string;
  iteration?: number;
  kind?: string;
  details?: Record<string, unknown>;
}

export interface RunRequesterSummary {
  actor?: string;
  role?: string;
  clientId?: string;
}

export interface RunModelUsageSummary {
  requestCount: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface RunSummary {
  runId: string;
  goal: string;
  status: HarnessStatus;
  skills: string[];
  metadata?: RunMetadata;
  requester?: RunRequesterSummary;
  review?: ReviewGate;
  deployment?: DeploymentGate;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  runDir: string;
  verification: VerificationResult | null;
  evaluation?: EvaluationResult | null;
  reviewer?: ReviewerResult | null;
  modelUsage?: RunModelUsageSummary;
  error?: RunErrorSummary;
}
