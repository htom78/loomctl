import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";

import { createOpenAiCompatibleAgent } from "../src/harness/model-agent.js";

test("OpenAI-compatible model agent posts loop state and parses JSON step", async () => {
  let requestPath = "";
  let authHeader = "";
  let requestBody: any;

  const server = createServer(async (req, res) => {
    requestPath = req.url ?? "";
    authHeader = req.headers.authorization ?? "";
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                message: "write the file",
                plan: "write model.txt, then ask the harness to verify",
                actions: [
                  {
                    toolName: "file.write",
                    input: { path: "model.txt", content: "from model\n" },
                  },
                ],
                finish: false,
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      apiKey: "test-key",
    });

    const step = await agent.next({
      goal: "create model.txt",
      events: [
        {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-26T00:00:00.000Z",
          type: "user_message",
          data: { content: "create model.txt" },
        },
      ],
    });

    assert.equal(requestPath, "/v1/chat/completions");
    assert.equal(authHeader, "Bearer test-key");
    assert.equal(requestBody.model, "test-model");
    assert.equal(requestBody.response_format.type, "json_object");
    assert.match(requestBody.messages[0].content, /JSON AgentStep/);
    assert.match(requestBody.messages[0].content, /plan/);
    assert.match(requestBody.messages[1].content, /create model.txt/);
    assert.equal(step.message, "write the file");
    assert.equal(step.plan, "write model.txt, then ask the harness to verify");
    assert.equal(step.actions?.[0].toolName, "file.write");
    assert.equal(step.finish, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent can request and parse AgentStep tool calls", async () => {
  let requestBody: any;

  const server = createServer(async (req, res) => {
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-agent-step",
                  type: "function",
                  function: {
                    name: "agent_step",
                    arguments: JSON.stringify({
                      message: "write through tool call",
                      plan: "use the model tool-call protocol",
                      actions: [
                        {
                          toolName: "file.write",
                          input: { path: "tool-call.txt", content: "from tool call\n" },
                        },
                      ],
                      finish: false,
                    }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      protocol: "tool-call",
    });

    const step = await agent.next({ goal: "create tool-call.txt", events: [] });

    assert.equal(requestBody.response_format, undefined);
    assert.equal(requestBody.tools[0].type, "function");
    assert.equal(requestBody.tools[0].function.name, "agent_step");
    assert.equal(requestBody.tool_choice.function.name, "agent_step");
    assert.equal(step.message, "write through tool call");
    assert.equal(step.plan, "use the model tool-call protocol");
    assert.equal(step.actions?.[0].toolName, "file.write");
    assert.deepEqual(step.actions?.[0].input, { path: "tool-call.txt", content: "from tool call\n" });
    assert.equal(step.finish, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent describes only policy-allowed JSON tools", async () => {
  let requestBody: any;

  const server = createServer(async (req, res) => {
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ message: "done", finish: true }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
    });

    await agent.next({
      goal: "respect run policy",
      events: [
        {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-26T00:00:00.000Z",
          type: "run_policy",
          data: { allowedTools: ["file.read", "file.write", "verify.run"] },
        },
      ],
    });

    assert.match(requestBody.messages[0].content, /file\.read\|file\.write\|verify\.run/);
    assert.doesNotMatch(requestBody.messages[0].content, /shell\.exec/);
    assert.doesNotMatch(requestBody.messages[0].content, /git\.commit/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent constrains tool-call schema to policy tools", async () => {
  let requestBody: any;

  const server = createServer(async (req, res) => {
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-agent-step",
                  type: "function",
                  function: {
                    name: "agent_step",
                    arguments: JSON.stringify({ message: "done", finish: true }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      protocol: "tool-call",
    });

    await agent.next({
      goal: "respect tool-call policy",
      events: [
        {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-26T00:00:00.000Z",
          type: "run_policy",
          data: { allowedTools: ["file.read", "verify.run", "git.pr"] },
        },
      ],
    });

    const toolName = requestBody.tools[0].function.parameters.properties.actions.items.properties.toolName;
    assert.deepEqual(toolName.enum, ["file.read", "verify.run"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent omits actions schema when no action tools are allowed", async () => {
  let requestBody: any;

  const server = createServer(async (req, res) => {
    requestBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-agent-step",
                  type: "function",
                  function: {
                    name: "agent_step",
                    arguments: JSON.stringify({ message: "blocked", finish: true }),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      protocol: "tool-call",
    });

    await agent.next({
      goal: "respect empty action policy",
      events: [
        {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-26T00:00:00.000Z",
          type: "run_policy",
          data: { allowedTools: ["git.pr"] },
        },
      ],
    });

    const properties = requestBody.tools[0].function.parameters.properties;
    assert.equal("actions" in properties, false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent emits bounded model usage events", async () => {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-litellm-response-cost": "0.001234" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-usage-1",
        model: "gateway-model",
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_tokens: 18,
        },
        choices: [
          {
            message: {
              content: JSON.stringify({ message: "done", finish: true }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      apiKey: "test-key",
    });
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const step = await agent.next({
      goal: "record usage",
      events: [],
      emitEvent: async (type, data) => {
        auditEvents.push({ type, data });
      },
    });

    assert.equal(step.finish, true);
    assert.deepEqual(auditEvents, [
      {
        type: "model_usage",
        data: {
          model: "test-model",
          responseModel: "gateway-model",
          requestId: "chatcmpl-usage-1",
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
          costUsd: 0.001234,
          attempt: 1,
        },
      },
    ]);
    assert.equal(JSON.stringify(auditEvents).includes("test-key"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent rejects invalid AgentStep action schema", async () => {
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                message: "invalid action",
                actions: [{ toolName: "file.write", input: "not an object" }],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
    });

    await assert.rejects(
      () => agent.next({ goal: "reject invalid model step", events: [] }),
      /AgentStep actions\[0\]\.input must be an object/,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent includes bounded protocol diagnostics", async () => {
  const rawContent = `not json ${"x".repeat(2600)}`;
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: rawContent,
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
      apiKey: "test-key",
    });

    await assert.rejects(
      () => agent.next({ goal: "reject invalid model step", events: [] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /model response was not valid JSON/);
        assert.equal((error as any).kind, "model_agent_protocol");
        assert.equal((error as any).details.model, "test-model");
        assert.match((error as any).details.responseExcerpt, /^not json/);
        assert.equal((error as any).details.responseExcerpt.length, 2003);
        assert.equal(JSON.stringify((error as any).details).includes("test-key"), false);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("OpenAI-compatible model agent retries protocol failures once with audit diagnostics", async () => {
  let calls = 0;
  const requestBodies: any[] = [];
  const server = createServer(async (req, res) => {
    calls += 1;
    requestBodies.push(JSON.parse(await readBody(req)));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: calls === 1
                ? "not json"
                : JSON.stringify({ message: "repaired", finish: true }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);

  try {
    const agent = createOpenAiCompatibleAgent({
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "test-model",
    });
    const auditEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const step = await agent.next({
      goal: "repair invalid model response",
      events: [],
      emitEvent: async (type, data) => {
        auditEvents.push({ type, data });
      },
    });

    assert.equal(calls, 2);
    assert.equal(step.message, "repaired");
    assert.equal(step.finish, true);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].type, "agent_retry");
    assert.equal(auditEvents[0].data.kind, "model_agent_protocol");
    assert.equal(auditEvents[0].data.model, "test-model");
    assert.equal(auditEvents[0].data.attempt, 1);
    assert.equal(auditEvents[0].data.nextAttempt, 2);
    assert.match(String(auditEvents[0].data.reason), /model response was not valid JSON/);
    assert.match(JSON.stringify(auditEvents[0].data.details), /not json/);
    assert.match(requestBodies[1].messages.at(-1).content, /Return exactly one valid JSON AgentStep/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
