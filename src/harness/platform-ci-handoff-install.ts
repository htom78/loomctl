import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const PLATFORM_CI_HANDOFF_WORKFLOW_FILE = "github-actions-staging.yml";
const PLATFORM_CI_HANDOFF_WORKFLOW_INSTALL_DIR = ".github/workflows";

export interface PlatformCiHandoffInstallCliOptions {
  dir?: string;
  repoRoot?: string;
  report?: string;
}

export interface PlatformCiHandoffInstallResult {
  schemaVersion: "platform-ci-handoff-install/v1";
  ok: boolean;
  tokenFree: true;
  provider: "github-actions";
  dir: string;
  repoRoot: string;
  reportPath?: string;
  action: "installed" | "already-current" | "blocked";
  source: {
    path: string;
    exists: boolean;
    sha256?: string;
  };
  destination: {
    path: string;
    existed: boolean;
    previousSha256?: string;
    exists: boolean;
    sha256?: string;
    matchesBundle: boolean;
  };
  missing: string[];
}

export async function installPlatformCiHandoff(
  options: PlatformCiHandoffInstallCliOptions = {},
): Promise<PlatformCiHandoffInstallResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const repoRoot = resolve(options.repoRoot ?? dirname(dir));
  const sourcePath = join(dir, PLATFORM_CI_HANDOFF_WORKFLOW_FILE);
  const destinationPath = join(repoRoot, PLATFORM_CI_HANDOFF_WORKFLOW_INSTALL_DIR, PLATFORM_CI_HANDOFF_WORKFLOW_FILE);
  const reportPath = options.report ? resolve(options.report) : undefined;
  const source = await readTextRef(sourcePath);
  const before = await readTextRef(destinationPath);
  if (!source.exists || source.text === undefined) {
    return {
      schemaVersion: "platform-ci-handoff-install/v1",
      ok: false,
      tokenFree: true,
      provider: "github-actions",
      dir,
      repoRoot,
      ...(reportPath ? { reportPath } : {}),
      action: "blocked",
      source: textRefResult(source),
      destination: {
        path: destinationPath,
        existed: before.exists,
        ...(before.sha256 ? { previousSha256: before.sha256, sha256: before.sha256 } : {}),
        exists: before.exists,
        matchesBundle: false,
      },
      missing: ["githubActions.source"],
    };
  }
  const alreadyCurrent = before.sha256 === source.sha256;
  if (!alreadyCurrent) {
    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, source.text, "utf8");
  }
  const after = await readTextRef(destinationPath);
  const matchesBundle = after.sha256 === source.sha256;
  return {
    schemaVersion: "platform-ci-handoff-install/v1",
    ok: matchesBundle,
    tokenFree: true,
    provider: "github-actions",
    dir,
    repoRoot,
    ...(reportPath ? { reportPath } : {}),
    action: alreadyCurrent ? "already-current" : "installed",
    source: textRefResult(source),
    destination: {
      path: destinationPath,
      existed: before.exists,
      ...(before.sha256 ? { previousSha256: before.sha256 } : {}),
      exists: after.exists,
      ...(after.sha256 ? { sha256: after.sha256 } : {}),
      matchesBundle,
    },
    missing: matchesBundle ? [] : ["githubActions.destination"],
  };
}

async function readTextRef(path: string): Promise<{ path: string; exists: boolean; sha256?: string; text?: string }> {
  if (!existsSync(path)) return { path, exists: false };
  const text = await readFile(path, "utf8");
  return {
    path,
    exists: true,
    sha256: sha256Hex(text),
    text,
  };
}

function textRefResult(ref: { path: string; exists: boolean; sha256?: string }): {
  path: string;
  exists: boolean;
  sha256?: string;
} {
  return {
    path: ref.path,
    exists: ref.exists,
    ...(ref.sha256 ? { sha256: ref.sha256 } : {}),
  };
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
