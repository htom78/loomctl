import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCommandAgent, createScriptedAgent, createScriptedAgentFromSteps } from "../src/harness/agents.js";
import { appendRunEvent, createRunStore, readRunEvents } from "../src/harness/run-store.js";
import { runHarness } from "../src/harness/loop.js";
import { createToolRuntime } from "../src/harness/tools.js";

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

test("run store appends ordered JSONL events", async () => {
  const rootDir = await tempDir("loom-events");
  const store = await createRunStore({
    rootDir,
    runId: "run-1",
    goal: "write a file",
  });

  await store.append("user_message", { content: "create hello.txt" });
  await store.append("assistant_message", { content: "I will write the file" });

  const events = await readRunEvents(store.runDir);
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 1);
  assert.equal(events[0].type, "user_message");
  assert.equal(events[1].seq, 2);
  assert.equal(events[1].type, "assistant_message");
});

test("run store continues sequence after external appends", async () => {
  const rootDir = await tempDir("loom-events-external");
  const store = await createRunStore({
    rootDir,
    runId: "run-1",
    goal: "write a file",
  });

  await store.append("user_message", { content: "create hello.txt" });
  await appendRunEvent(store.runDir, "user_message", { content: "reviewer note", kind: "comment" });
  await store.append("assistant_message", { content: "continuing after note" });

  const events = await readRunEvents(store.runDir);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(store.count(), 3);
});

test("run store preserves a single sequence under concurrent append callers", async () => {
  const rootDir = await tempDir("loom-events-concurrent");
  const store = await createRunStore({
    rootDir,
    runId: "run-concurrent",
    goal: "record concurrent events",
  });

  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    appendRunEvent(store.runDir, "observation", { index }),
  ));

  const events = await readRunEvents(store.runDir);
  assert.equal(events.length, 40);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.deepEqual(events.map((event) => (event.data as { index: number }).index).sort((left, right) => left - right), Array.from({ length: 40 }, (_, index) => index));
});

test("harness loop pauses when run control requests a hold", async () => {
  const cwd = await tempDir("loom-loop-pause");
  const runRoot = await tempDir("loom-runs-pause");
  let calls = 0;

  const summary = await runHarness({
    runId: "run-pause",
    goal: "pause before the second agent step",
    cwd,
    runRoot,
    verifyCommands: [],
    maxIterations: 5,
    agent: {
      async next() {
        calls += 1;
        return { message: `agent step ${calls}` };
      },
    },
    control: {
      async shouldPause(events) {
        return events.some((event) => event.type === "assistant_message")
          ? { reason: "reviewer requested a hold", actor: "reviewer", role: "viewer", clientId: "tab-1", eventSeq: 4 }
          : undefined;
      },
    },
  });

  assert.equal(summary.status, "paused");
  assert.equal(calls, 1);
  const events = await readRunEvents(summary.runDir);
  assert.ok(events.some((event) =>
    event.type === "pause" &&
    (event.data as any).reason === "reviewer requested a hold" &&
    (event.data as any).actor === "reviewer" &&
    (event.data as any).role === "viewer" &&
    (event.data as any).clientId === "tab-1" &&
    (event.data as any).eventSeq === 4
  ));
  assert.ok(events.some((event) => event.type === "finish" && (event.data as any).status === "paused"));
  assert.equal(events.filter((event) => event.type === "assistant_message").length, 1);
});

test("harness loop resumes from existing events without replaying scripted steps", async () => {
  const cwd = await tempDir("loom-loop-resume");
  const runRoot = await tempDir("loom-runs-resume");

  const paused = await runHarness({
    runId: "run-resume",
    goal: "resume scripted work",
    cwd,
    runRoot,
    verifyCommands: [],
    maxIterations: 5,
    agent: createScriptedAgentFromSteps([
      { message: "first step" },
      { message: "second step", finish: true },
    ]),
    control: {
      async shouldPause(events) {
        return events.some((event) => event.type === "assistant_message")
          ? { reason: "pause before second step" }
          : undefined;
      },
    },
  });
  assert.equal(paused.status, "paused");

  const resumed = await runHarness({
    runId: "run-resume",
    goal: "resume scripted work",
    cwd,
    runRoot,
    verifyCommands: [],
    maxIterations: 5,
    agent: createScriptedAgentFromSteps([
      { message: "first step" },
      { message: "second step", finish: true },
    ]),
    resume: true,
    startedAt: paused.startedAt,
    requester: { actor: "dev-user", role: "developer", clientId: "resume-tab" },
  });

  assert.equal(resumed.status, "passed");
  assert.equal(resumed.startedAt, paused.startedAt);
  const events = await readRunEvents(resumed.runDir);
  assert.ok(events.some((event) =>
    event.type === "resume" &&
    (event.data as any).actor === "dev-user" &&
    (event.data as any).role === "developer" &&
    (event.data as any).clientId === "resume-tab"
  ));
  assert.deepEqual(
    events.filter((event) => event.type === "assistant_message").map((event) => (event.data as any).content),
    ["first step", "second step"],
  );
  assert.ok(events.some((event) => event.type === "finish" && (event.data as any).status === "paused"));
  assert.ok(events.some((event) => event.type === "finish" && (event.data as any).status === "passed"));
});

test("tool runtime executes file, shell, and verification tools inside cwd", async () => {
  const cwd = await tempDir("loom-tools");
  const runtime = createToolRuntime({
    cwd,
    verifyCommands: ["test -f generated.txt"],
  });

  const write = await runtime.execute({
    id: "a1",
    toolName: "file.write",
    input: { path: "generated.txt", content: "hello\n" },
  });
  assert.equal(write.ok, true);

  const read = await runtime.execute({
    id: "a2",
    toolName: "file.read",
    input: { path: "generated.txt" },
  });
  assert.equal(read.ok, true);
  assert.match(read.output, /hello/);

  const shell = await runtime.execute({
    id: "a3",
    toolName: "shell.exec",
    input: { command: "printf tool-ok" },
  });
  assert.equal(shell.ok, true);
  assert.equal(shell.output, "tool-ok");

  const verify = await runtime.execute({
    id: "a4",
    toolName: "verify.run",
    input: {},
  });
  assert.equal(verify.ok, true);
  assert.equal(verify.exitCode, 0);
});

test("tool runtime denies tools outside the allowed set", async () => {
  const cwd = await tempDir("loom-tools-policy");
  const runtime = createToolRuntime({
    cwd,
    verifyCommands: [],
    allowedTools: ["file.write"],
  });

  const denied = await runtime.execute({
    id: "a1",
    toolName: "shell.exec",
    input: { command: "printf denied > should-not-exist.txt" },
  });

  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /not allowed/);
});

test("harness loop runs scripted actions and finishes only after verification passes", async () => {
  const cwd = await tempDir("loom-loop");
  const runRoot = await tempDir("loom-runs");
  const scriptPath = join(cwd, "script.json");
  await writeFile(
    scriptPath,
    JSON.stringify([
      {
        message: "create the requested file",
        plan: "write hello.txt before requesting verification",
        actions: [
          {
            toolName: "file.write",
            input: { path: "hello.txt", content: "hello from loom\n" },
          },
        ],
      },
      { message: "ready to finish", finish: true },
    ]),
    "utf8",
  );

  const result = await runHarness({
    goal: "create hello.txt",
    cwd,
    runRoot,
    verifyCommands: ["test -f hello.txt"],
    agent: await createScriptedAgent(scriptPath),
    skills: ["coding"],
  });

  assert.equal(result.status, "passed");
  assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "hello from loom\n");

  const events = await readRunEvents(result.runDir);
  assert.ok(events.some((event) => event.type === "action"));
  assert.ok(events.some((event) => event.type === "observation"));
  assert.ok(events.some((event) => event.type === "verification"));
  assert.ok(events.some((event) => event.type === "finish"));
  const assistantMessages = events.filter((event) => event.type === "assistant_message");
  assert.equal(assistantMessages[0]?.data.plan, "write hello.txt before requesting verification");
  assert.deepEqual(
    assistantMessages.map((event) => ({ actionCount: event.data.actionCount, finishRequested: event.data.finishRequested })),
    [
      { actionCount: 1, finishRequested: false },
      { actionCount: 0, finishRequested: true },
    ],
  );
});

test("harness loop exposes run context env to shell actions", async () => {
  const cwd = await tempDir("loom-loop-run-env");
  const runRoot = await tempDir("loom-runs-env");
  const result = await runHarness({
    runId: "run-env",
    goal: "write run context env",
    cwd,
    runRoot,
    verifyCommands: ["test -f run-env.txt"],
    allowedTools: ["shell.exec", "verify.run"],
    agent: createScriptedAgentFromSteps([
      {
        message: "record run context",
        actions: [
          {
            toolName: "shell.exec",
            input: { command: "printf '%s\\n%s\\n%s\\n' \"$LOOM_RUN_ID\" \"$LOOM_RUN_ROOT\" \"$LOOM_RUN_DIR\" > run-env.txt" },
          },
        ],
      },
      { message: "finish", finish: true },
    ]),
  });

  assert.equal(result.status, "passed");
  assert.equal(await readFile(join(cwd, "run-env.txt"), "utf8"), `run-env\n${runRoot}\n${result.runDir}\n`);
});

test("harness loop records run metadata in the event log and summary", async () => {
  const cwd = await tempDir("loom-loop-metadata");
  const runRoot = await tempDir("loom-runs-metadata");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "done", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "link this run",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: await createScriptedAgent(scriptPath),
    metadata: {
      tenant: "alice",
      project: "default",
      issue: "team/app#42",
      repo: "https://git.example/team/app.git",
      branch: "task/42",
      summaryUrl: "https://loom.example/tenants/alice/runs/run-1?project=default",
    },
  });

  assert.equal(result.metadata?.issue, "team/app#42");
  assert.equal(result.metadata?.summaryUrl, "https://loom.example/tenants/alice/runs/run-1?project=default");

  const events = await readRunEvents(result.runDir);
  const metadata = events.find((event) => event.type === "run_metadata");
  assert.equal(metadata?.data.issue, "team/app#42");
  assert.equal(metadata?.data.branch, "task/42");
});

test("harness loop records requester identity in the run summary without model key envs", async () => {
  const cwd = await tempDir("loom-loop-requester");

  const summary = await runHarness({
    goal: "requester visible in summary",
    cwd,
    verifyCommands: [],
    agent: createScriptedAgentFromSteps([{ message: "finish", finish: true }]),
    requester: { actor: "dev-user", role: "developer", clientId: "tab-1", modelKeyEnv: "LOOM_DEV_KEY" },
  });

  assert.equal(summary.status, "passed");
  assert.deepEqual(summary.requester, { actor: "dev-user", role: "developer", clientId: "tab-1" });
  assert.equal(JSON.stringify(summary).includes("LOOM_DEV_KEY"), false);
});

test("harness loop records the effective tool policy", async () => {
  const cwd = await tempDir("loom-loop-policy-audit");
  const runRoot = await tempDir("loom-runs-policy-audit");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "done", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "audit allowed tools",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: await createScriptedAgent(scriptPath),
    allowedTools: ["file.read", "file.write", "git.diff", "verify.run"],
  });

  const events = await readRunEvents(result.runDir);
  const policy = events.find((event) => String(event.type) === "run_policy");
  assert.deepEqual(policy?.data.allowedTools, ["file.read", "file.write", "git.diff", "verify.run"]);
});

test("harness loop records the default effective tool policy", async () => {
  const cwd = await tempDir("loom-loop-default-policy-audit");
  const runRoot = await tempDir("loom-runs-default-policy-audit");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "done", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "audit default tools",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: await createScriptedAgent(scriptPath),
  });

  const events = await readRunEvents(result.runDir);
  const policy = events.find((event) => String(event.type) === "run_policy");
  assert.deepEqual(policy?.data.allowedTools, ["file.read", "file.write", "shell.exec", "git.diff", "git.commit", "verify.run"]);
});

test("harness loop can require human review after verification passes", async () => {
  const cwd = await tempDir("loom-loop-review");
  const runRoot = await tempDir("loom-runs-review");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "ready for review", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "prepare reviewable change",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: await createScriptedAgent(scriptPath),
    reviewRequired: true,
  });

  assert.equal(result.status, "review_required");
  assert.deepEqual(result.review, { required: true, status: "pending" });

  const events = await readRunEvents(result.runDir);
  assert.ok(events.some((event) => event.type === "review_gate" && event.data.status === "pending"));
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish?.data.status, "review_required");
});

test("harness loop records reviewer command evidence before human review gates", async () => {
  const cwd = await tempDir("loom-loop-reviewer-pass");
  const runRoot = await tempDir("loom-runs-reviewer-pass");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "ready for reviewer", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "prepare reviewer-assisted change",
    cwd,
    runRoot,
    verifyCommands: ["true"],
    evaluationCommands: ["true"],
    reviewerCommands: ["printf reviewer-note"],
    agent: await createScriptedAgent(scriptPath),
    reviewRequired: true,
  });

  assert.equal(result.status, "review_required");
  assert.equal(result.reviewer?.ok, true);
  assert.equal(result.reviewer?.exitCode, 0);
  assert.deepEqual(result.reviewer?.commands, ["printf reviewer-note"]);
  assert.match(result.reviewer?.output ?? "", /reviewer-note/);

  const events = await readRunEvents(result.runDir);
  const reviewerIndex = events.findIndex((event) => String(event.type) === "reviewer");
  const reviewGateIndex = events.findIndex((event) => event.type === "review_gate");
  assert.ok(reviewerIndex > 0);
  assert.ok(reviewGateIndex > reviewerIndex);
  assert.equal(events[reviewerIndex].data.ok, true);
});

test("harness loop can require deployment approval after verification passes", async () => {
  const cwd = await tempDir("loom-loop-deployment");
  const runRoot = await tempDir("loom-runs-deployment");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "ready for deployment", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "prepare deployable change",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: await createScriptedAgent(scriptPath),
    deploymentRequired: true,
  });

  assert.equal(result.status, "deployment_required");
  assert.deepEqual(result.deployment, { required: true, status: "pending" });

  const events = await readRunEvents(result.runDir);
  assert.ok(events.some((event) => event.type === "deployment_gate" && event.data.status === "pending"));
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish?.data.status, "deployment_required");
});

test("harness loop fails when evaluator commands reject a verified run", async () => {
  const cwd = await tempDir("loom-loop-evaluation-fail");
  const runRoot = await tempDir("loom-runs-evaluation-fail");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "ready for evaluation", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "prepare independently evaluated change",
    cwd,
    runRoot,
    verifyCommands: ["true"],
    evaluationCommands: ["printf evaluator-rejected >&2; exit 42"],
    agent: await createScriptedAgent(scriptPath),
    reviewRequired: true,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.verification?.ok, true);
  assert.equal(result.evaluation?.ok, false);
  assert.equal(result.evaluation?.exitCode, 42);
  assert.deepEqual(result.evaluation?.commands, ["printf evaluator-rejected >&2; exit 42"]);
  assert.equal(result.review, undefined);

  const events = await readRunEvents(result.runDir);
  assert.ok(events.some((event) => event.type === "verification" && event.data.ok === true));
  assert.ok(events.some((event) => event.type === "evaluation" && event.data.ok === false));
  assert.equal(events.some((event) => event.type === "review_gate"), false);
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish?.data.status, "failed");
});

test("harness loop prepares the workspace before executing actions", async () => {
  const cwd = await tempDir("loom-loop-prepare");
  const runRoot = await tempDir("loom-runs-prepare");
  const scriptPath = join(cwd, "script.json");
  const calls: string[] = [];
  await writeFile(
    scriptPath,
    JSON.stringify([
      {
        message: "write through executor",
        actions: [
          {
            toolName: "file.write",
            input: { path: "prepared.txt", content: "ok\n" },
          },
        ],
      },
      { message: "finish", finish: true },
    ]),
    "utf8",
  );

  const result = await runHarness({
    goal: "prepare before writing",
    cwd,
    runRoot,
    verifyCommands: ["test -f prepared.txt"],
    agent: await createScriptedAgent(scriptPath),
    executor: {
      async prepare(): Promise<void> {
        calls.push("prepare");
      },
      async inspectPath(path: string): Promise<any> {
        return { path, kind: "missing" };
      },
      async readFile(path: string): Promise<string> {
        calls.push(`read:${path}`);
        return "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        calls.push(`write:${path}:${content}`);
      },
      async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        calls.push(`run:${command}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["prepare", "write:prepared.txt:ok\n", "run:test -f prepared.txt"]);

  const events = await readRunEvents(result.runDir);
  assert.ok(events.some((event) => event.type === "workspace_prepare" && event.data.status === "passed"));
});

test("harness loop fails the finish gate when verification fails", async () => {
  const cwd = await tempDir("loom-loop-fail");
  const runRoot = await tempDir("loom-runs-fail");
  const scriptPath = join(cwd, "script.json");
  await writeFile(scriptPath, JSON.stringify([{ message: "done", finish: true }]), "utf8");

  const result = await runHarness({
    goal: "create missing.txt",
    cwd,
    runRoot,
    verifyCommands: ["test -f missing.txt"],
    agent: await createScriptedAgent(scriptPath),
    skills: ["coding"],
  });

  assert.equal(result.status, "failed");

  const events = await readRunEvents(result.runDir);
  const verification = events.find((event) => event.type === "verification");
  assert.equal(verification?.data.ok, false);
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish?.data.status, "failed");
});

test("harness loop records agent failure phase and iteration", async () => {
  const cwd = await tempDir("loom-loop-agent-error");
  const runRoot = await tempDir("loom-runs-agent-error");
  let calls = 0;

  const result = await runHarness({
    goal: "surface model failure context",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: {
      async next() {
        calls += 1;
        if (calls === 2) throw new Error("model unavailable");
        return { message: "continue" };
      },
    },
  });

  assert.equal(result.status, "error");
  assert.deepEqual(result.error, {
    message: "model unavailable",
    phase: "agent_next",
    iteration: 2,
  });

  const events = await readRunEvents(result.runDir);
  const error = events.find((event) => event.type === "error");
  assert.equal(error?.data.message, "model unavailable");
  assert.equal(error?.data.phase, "agent_next");
  assert.equal(error?.data.iteration, 2);
});

test("harness loop records agent diagnostic details", async () => {
  const cwd = await tempDir("loom-loop-agent-diagnostics");
  const runRoot = await tempDir("loom-runs-agent-diagnostics");
  const diagnosticError = Object.assign(new Error("model response was not valid JSON: Unexpected token o"), {
    kind: "model_agent_protocol",
    details: { model: "test-model", responseExcerpt: "not json..." },
  });

  const result = await runHarness({
    goal: "surface model protocol diagnostics",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: {
      async next() {
        throw diagnosticError;
      },
    },
  });

  assert.equal(result.status, "error");
  assert.deepEqual(result.error, {
    message: "model response was not valid JSON: Unexpected token o",
    phase: "agent_next",
    iteration: 1,
    kind: "model_agent_protocol",
    details: { model: "test-model", responseExcerpt: "not json..." },
  });

  const events = await readRunEvents(result.runDir);
  const error = events.find((event) => event.type === "error");
  assert.equal(error?.data.kind, "model_agent_protocol");
  assert.deepEqual(error?.data.details, { model: "test-model", responseExcerpt: "not json..." });
});

test("harness loop records agent-emitted retry diagnostics", async () => {
  const cwd = await tempDir("loom-loop-agent-retry-event");
  const runRoot = await tempDir("loom-runs-agent-retry-event");

  const result = await runHarness({
    goal: "record agent retry",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: {
      async next(input) {
        await input.emitEvent?.("agent_retry", {
          reason: "repair invalid model response",
          kind: "model_agent_protocol",
          attempt: 1,
          nextAttempt: 2,
        });
        return { message: "recovered", finish: true };
      },
    },
  });

  assert.equal(result.status, "passed");
  const events = await readRunEvents(result.runDir);
  const retry = events.find((event) => event.type === "agent_retry");
  const assistant = events.find((event) => event.type === "assistant_message");
  assert.equal(retry?.data.kind, "model_agent_protocol");
  assert.equal(retry?.data.nextAttempt, 2);
  assert.ok(retry && assistant && retry.seq < assistant.seq);
});

test("harness loop summarizes agent-emitted model usage", async () => {
  const cwd = await tempDir("loom-loop-model-usage");
  const runRoot = await tempDir("loom-runs-model-usage");

  const result = await runHarness({
    goal: "record model usage",
    cwd,
    runRoot,
    verifyCommands: [],
    agent: {
      async next(input) {
        await input.emitEvent?.("model_usage", {
          model: "test-model",
          requestId: "req-1",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0.0012,
        });
        await input.emitEvent?.("model_usage", {
          model: "test-model",
          requestId: "req-2",
          promptTokens: 8,
          completionTokens: 4,
          totalTokens: 12,
          costUsd: 0.0003,
        });
        return { message: "done", finish: true };
      },
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(result.modelUsage, {
    requestCount: 2,
    promptTokens: 18,
    completionTokens: 9,
    totalTokens: 27,
    costUsd: 0.0015,
  });
  const persisted = JSON.parse(await readFile(join(result.runDir, "summary.json"), "utf8"));
  assert.deepEqual(persisted.modelUsage, result.modelUsage);
});

test("scripted agent rejects invalid action schema before tool execution", async () => {
  const agent = createScriptedAgentFromSteps([
    {
      message: "bad action",
      actions: [{ input: { path: "oops.txt" } } as any],
    },
  ]);

  await assert.rejects(
    () => agent.next({ goal: "reject invalid action", events: [] }),
    /AgentStep actions\[0\]\.toolName must be a non-empty string/,
  );
});

test("command agent rejects non-object AgentStep output", async () => {
  const cwd = await tempDir("loom-command-agent-invalid-step");
  const agent = createCommandAgent("printf '[]'", cwd);

  await assert.rejects(
    () => agent.next({ goal: "reject invalid command step", events: [] }),
    /AgentStep must be an object/,
  );
});

test("harness loop records cancellation phase and iteration", async () => {
  const cwd = await tempDir("loom-loop-cancel-context");
  const runRoot = await tempDir("loom-runs-cancel-context");
  const controller = new AbortController();

  const result = await runHarness({
    goal: "cancel with context",
    cwd,
    runRoot,
    verifyCommands: [],
    signal: controller.signal,
    agent: {
      async next() {
        controller.abort("dashboard stop");
        throw new Error("dashboard stop");
      },
    },
  });

  assert.equal(result.status, "cancelled");

  const events = await readRunEvents(result.runDir);
  const cancel = events.find((event) => event.type === "cancel");
  assert.equal(cancel?.data.reason, "dashboard stop");
  assert.equal(cancel?.data.phase, "agent_next");
  assert.equal(cancel?.data.iteration, 1);
});
