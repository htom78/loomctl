import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

async function waitForServeUrl(proc: ReturnType<typeof execa>, timeoutMs = 20_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serve did not announce a url in time")), timeoutMs);
    proc.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes('"url"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`harness serve shuts down gracefully on ${signal}`, async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-graceful-"));
    // Spawn node directly (not via npx) so the process under test is the harness
    // itself — its own exit code, not a wrapper's, reflects graceful shutdown.
    const proc = execa(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      "harness",
      "serve",
      "--workspace-root",
      workspaceRoot,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--allow-unsafe-local-executor",
    ], { cwd: process.cwd(), reject: false });

    try {
      await waitForServeUrl(proc);
      proc.kill(signal);
      const result = await proc;
      // The signal handler exits 0 (clean drain), not via the killing signal.
      assert.equal(result.exitCode, 0, `expected clean exit, got ${result.exitCode}/${result.signal}; stderr: ${result.stderr}`);
      assert.match(result.stderr, /draining and shutting down/);
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }
  });
}
