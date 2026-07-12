import { execFileSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configuredRoot = process.env.LOOM_STAGING_WORKSPACE_ROOT?.trim();
const workspaceRoot = resolve(configuredRoot || "/tmp/loom-staging-workspaces");

if (workspaceRoot === "/" || /[,\n\r\0]/.test(workspaceRoot)) {
  throw new Error(`unsafe staging workspace root: ${workspaceRoot}`);
}

const created = await mkdir(workspaceRoot, { recursive: true });
if (!configuredRoot || created) {
  await chmod(workspaceRoot, 0o777);
}

execFileSync("docker", ["compose", "-f", "deploy/staging/compose.yml", "up", "-d", "--build"], {
  cwd: root,
  env: { ...process.env, LOOM_STAGING_WORKSPACE_ROOT: workspaceRoot },
  stdio: "inherit",
});
