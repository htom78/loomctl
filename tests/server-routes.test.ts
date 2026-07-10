import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHarnessServerRoutes } from "../src/harness/server-routes.js";

test("server route dispatcher preserves priority and returns domain ownership", async () => {
  const visited: string[] = [];
  const match = await dispatchHarnessServerRoutes([
    { domain: "policy", name: "first", handle: async () => { visited.push("first"); return false; } },
    { domain: "runs", name: "second", handle: async () => { visited.push("second"); return true; } },
    { domain: "workspace", name: "third", handle: async () => { visited.push("third"); return true; } },
  ]);

  assert.deepEqual(visited, ["first", "second"]);
  assert.deepEqual(match, { domain: "runs", name: "second" });
});
