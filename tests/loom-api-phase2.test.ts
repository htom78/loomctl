import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LoomApiError, LoomClient, type WorkspaceSessionEvent } from "../packages/loom-api/src/index.js";
import { createHarnessHttpServer } from "../src/harness/server.js";

test("Loom API Phase 2 client preserves server authority across files, presence, sessions, VAS, and Brain", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "loom-api-phase2-"));
  const ingested: unknown[] = [];
  const server = createHarnessHttpServer({
    allowUnsafeLocalExecutor: true,
    workspaceRoot,
    tenantTokens: { alice: "phase2-secret" },
    allowedTools: ["file.read", "file.write", "shell.exec", "git.diff"],
    brainSignalIngest: async (signal: unknown) => { ingested.push(signal); },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const client = new LoomClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "phase2-secret" });
    await client.createProject("alice", "phase2-workbench");
    const route = { tenant: "alice", project: "phase2-workbench" };

    const original = await client.writeWorkspaceFile(route, "notes.txt", "version one\n", undefined, "editor-a");
    assert.equal(original.kind, "file");
    await client.updatePresence(route, "editor-a", "Editor A", "file:notes.txt");
    await delay(10);
    const current = await client.writeWorkspaceFile(route, "notes.txt", "version two\n", original.updatedAt, "editor-a");
    assert.equal(current.kind, "file");

    await assert.rejects(
      client.writeWorkspaceFile(route, "notes.txt", "stale edit\n", original.updatedAt, "editor-b"),
      (error) => {
        assert.ok(error instanceof LoomApiError);
        assert.equal(error.status, 409);
        const body = error.body as { activeEditors?: Array<{ clientId: string }> };
        assert.ok(body.activeEditors?.some((entry) => entry.clientId === "editor-a"));
        return true;
      },
    );

    const presence = await client.presence(route);
    assert.ok(presence.some((entry) => entry.clientId === "editor-a" && entry.focus === "file:notes.txt"));
    const brain = await client.brainSignals("alice", "phase2-workbench");
    assert.ok(brain.signals.some((signal) => signal.source === "workspace_conflict" && signal.path === "notes.txt"));

    assert.equal(current.kind, "file");
    const moved = await client.moveWorkspaceFile(route, "notes.txt", "archive/notes.txt", current.updatedAt, "editor-a");
    assert.equal(moved.kind, "file");
    assert.equal(moved.path, "archive/notes.txt");
    await client.deleteWorkspaceFile(route, moved.path, moved.updatedAt, "editor-a");
    await assert.rejects(client.workspaceFiles(route, moved.path), (error) => error instanceof LoomApiError && error.status === 404);

    const session = await client.createWorkspaceSession(route, "sh", "terminal-a");
    const events: WorkspaceSessionEvent[] = [];
    const watching = client.watchWorkspaceSession(route, session.sessionId, {
      reconnect: false,
      onEvent(event) { events.push(event); },
    });
    await delay(30);
    await client.sendWorkspaceSessionInput(route, session.sessionId, "printf 'phase2-terminal\\n'\nexit\n", "terminal-a");
    await withTimeout(watching, 5_000, "workspace session stream did not close");
    assert.ok(events.some((event) => event.type === "stdout" && event.data?.includes("phase2-terminal")));
    assert.ok(events.some((event) => event.type === "exit"));
    const sessions = await client.workspaceSessions(route);
    assert.ok(sessions.some((entry) => entry.sessionId === session.sessionId && entry.status === "exited"));

    const command = await client.runWorkspaceCommand(route, "printf phase2-command", "command-a");
    assert.equal(command.stdout, "phase2-command");
    assert.ok((await client.workspaceCommands(route)).some((entry) => entry.commandId === command.commandId));

    await client.createProject("alice", "phase2-vas", "vas-lite");
    const createdCase = await client.createVasCase("alice", "phase2-vas", {
      caseId: "desktop-case",
      title: "Desktop case",
      source: { kind: "desktop-test" },
      clientId: "reviewer-a",
    });
    assert.equal(createdCase.status, "needs_review");
    assert.ok((await client.vasReviewQueue("alice", "phase2-vas")).cases.some((entry) => entry.id === "desktop-case"));
    assert.equal((await client.vasCaseArtifacts("alice", "phase2-vas", "desktop-case")).caseId, "desktop-case");
    assert.equal((await client.vasReviewPackage("alice", "phase2-vas", "desktop-case")).case.id, "desktop-case");
    await client.claimVasCase("alice", "phase2-vas", "desktop-case", "claim", "reviewer-a");
    const reviewed = await client.reviewVasCase("alice", "phase2-vas", "desktop-case", {
      decision: "approved",
      note: "Phase 2 evidence is complete.",
      corrections: ["Keep CAS evidence visible."],
      learnings: ["Reconnect terminals from server sequence numbers."],
      clientId: "reviewer-a",
    });
    assert.equal(reviewed.status, "reviewed");
    const learnings = await client.vasLearnings("alice", "phase2-vas");
    assert.ok(learnings.learnings.some((entry) => entry.caseId === "desktop-case" && /Reconnect terminals/.test(entry.text)));
    assert.equal(ingested.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
