import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 8080);
const bodyLimit = 1_048_576;

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return json(response, 200, { ok: true });
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    return json(response, 404, { error: { message: "not found" } });
  }
  try {
    const body = JSON.parse((await readBody(request)).toString("utf8"));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const prompt = JSON.stringify(messages);
    const observed = prompt.includes('"type":"observation"');
    const step = observed
      ? {
          message: "staging proof completed",
          plan: "Finish after observing the workspace write.",
          actions: [],
          finish: true,
        }
      : {
          message: "write staging proof",
          plan: "Write one deterministic file through the sandbox tool boundary.",
          actions: [{
            toolName: "file.write",
            input: { path: "LITELLM_PROOF.txt", content: "real LiteLLM staging\n" },
          }],
          finish: false,
        };
    const content = JSON.stringify(step);
    return json(response, 200, {
      id: `chatcmpl-stage-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "loom-stage-upstream",
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
        completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
        total_tokens: Math.max(2, Math.ceil((prompt.length + content.length) / 4)),
      },
    });
  } catch (error) {
    return json(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, {
      error: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}).listen(port, "0.0.0.0");

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > bodyLimit) {
      const error = new Error("request body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}
