export const HARNESS_VISION_LOCK_TARGET = "multi-user online sandbox development platform with an auditable harness loop";

export const HARNESS_VISION_LOCK_TARGET_MARKERS = ["multi-user online sandbox", "harness loop"] as const;

export const HARNESS_VISION_LOCK_CAPABILITIES = [
  "multi-user-tenants",
  "isolated-persistent-sandboxes",
  "browser-control-plane",
  "gitea-forgejo-truth-layer",
  "litellm-model-gateway",
  "event-sourced-harness-loop",
  "verification-gated-finish",
  "brain-skill-evolution",
  "human-gated-side-effects",
] as const;

export const HARNESS_VISION_LOCK = {
  target: HARNESS_VISION_LOCK_TARGET,
  mvpIsScopeReduction: false,
  capabilities: HARNESS_VISION_LOCK_CAPABILITIES,
} as const;

export type HarnessVisionLockCapability = typeof HARNESS_VISION_LOCK_CAPABILITIES[number];

export const ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS = ["file.read", "file.write", "git.diff", "git.commit", "verify.run", "shell.exec"] as const;

export type OnlineSandboxRequiredServerTool = typeof ONLINE_SANDBOX_REQUIRED_SERVER_TOOLS[number];

export const ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES = [
  "profile-readiness",
  "project-contract-vision-lock",
  "multi-user-isolation",
  "role-based-auth",
  "isolated-persistent-workspace",
  "auditable-harness-loop",
  "workspace-command",
  "workspace-session",
  "online-surfaces",
  "workspace-collaboration",
  "vas-lite-learning",
  "human-gates",
  "policy-escalation",
  "handoff-followup",
  "run-controls",
] as const;

export type OnlineSandboxGoldenPathCapability = typeof ONLINE_SANDBOX_GOLDEN_PATH_CAPABILITIES[number];
