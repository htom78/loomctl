import assert from "node:assert/strict";
import test from "node:test";

import { scrubSecretText, scrubSecretsDeep } from "../src/harness/redact.js";

test("scrubSecretText redacts credentialed URLs, bearer tokens, and inline secrets", () => {
  assert.equal(
    scrubSecretText("clone https://alice:s3cr3t@git.example/repo.git failed"),
    "clone https://[redacted]@git.example/repo.git failed",
  );
  assert.equal(
    scrubSecretText("upstream said Bearer abc.DEF-123~xyz was rejected"),
    "upstream said Bearer [redacted] was rejected",
  );
  assert.equal(scrubSecretText("token=SUPERSECRET rejected"), "token=[redacted] rejected");
  assert.equal(scrubSecretText("api_key: AKIA123 denied"), "api_key: [redacted] denied");
  // Non-secret text untouched.
  assert.equal(scrubSecretText("plain failure, nothing sensitive"), "plain failure, nothing sensitive");
});

test("scrubSecretText bounds very long strings", () => {
  const long = "x".repeat(5000);
  const out = scrubSecretText(long);
  assert.equal(out.length, 2000);
  assert.ok(out.endsWith("..."));
});

test("scrubSecretsDeep recurses and scrubs nested string values", () => {
  const input = {
    message: "fetch https://u:p@host/x",
    meta: { note: "Bearer TOKEN123", count: 5, ok: true },
    list: ["token=AAA", "safe"],
  };
  const out = scrubSecretsDeep(input) as any;
  assert.equal(out.message, "fetch https://[redacted]@host/x");
  assert.equal(out.meta.note, "Bearer [redacted]");
  assert.equal(out.meta.count, 5);
  assert.equal(out.meta.ok, true);
  assert.deepEqual(out.list, ["token=[redacted]", "safe"]);
});

test("scrubSecretsDeep caps recursion depth", () => {
  let nested: any = "token=DEEP";
  for (let i = 0; i < 12; i += 1) nested = { inner: nested };
  const out = scrubSecretsDeep(nested);
  // Somewhere down the chain it stops recursing rather than throwing.
  assert.equal(JSON.stringify(out).includes("[redacted:depth]"), true);
  assert.equal(JSON.stringify(out).includes("DEEP"), false);
});
