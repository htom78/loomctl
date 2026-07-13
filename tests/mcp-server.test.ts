import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end over a real MCP stdio session: spawn `loom mcp`, drive it with the
// SDK client, and assert the `run` tool runs the kernel and reports the gate.
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((c) => c.type === "text");
  assert.ok(block?.text, "expected a text content block");
  return block.text;
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "src/index.ts"), "mcp"],
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client({ name: "loom-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("mcp server exposes a run tool and runs the kernel loop with a passing gate", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "run"), "run tool should be listed");

    const cwd = await mkdtemp(join(tmpdir(), "loom-mcp-pass-"));
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

    const result = (await client.callTool({
      name: "run",
      arguments: { goal: "mcp smoke", cwd, script: scriptPath, verify: ["true"] },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.notEqual(result.isError, true);
    const summary = JSON.parse(firstText(result));
    assert.equal(summary.status, "passed");
    assert.equal(summary.metadata.tenant, "local");
  });
});

test("mcp run reports the failing verification gate as an error", async () => {
  await withClient(async (client) => {
    const cwd = await mkdtemp(join(tmpdir(), "loom-mcp-fail-"));
    const scriptPath = join(cwd, "script.json");
    await writeFile(scriptPath, JSON.stringify([{ message: "finish", finish: true }]), "utf8");

    const result = (await client.callTool({
      name: "run",
      arguments: { goal: "mcp fail", cwd, script: scriptPath, verify: ["false"] },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    assert.equal(result.isError, true);
    const summary = JSON.parse(firstText(result));
    assert.equal(summary.status, "failed");
  });
});
