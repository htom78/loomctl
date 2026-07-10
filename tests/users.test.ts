import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addUser, getUser, listUsers } from "../src/users.js";

test("loomd users reject unsafe tenant names", () => {
  withStateDir(() => {
    for (const name of ["", "../alice", "alice/bob", "-alice", ".alice", "alice bob"]) {
      assert.throws(
        () => addUser({ name, authMode: "subscription" }),
        /tenant name/,
      );
      assert.throws(
        () => getUser(name),
        /tenant name/,
      );
    }
  });
});

test("loomd users persist safe tenant names", () => {
  withStateDir(() => {
    addUser({ name: "alice-1", authMode: "gateway", gatewayKeyEnv: "LOOM_KEY_ALICE" });

    assert.deepEqual(listUsers(), [
      { name: "alice-1", authMode: "gateway", gatewayKeyEnv: "LOOM_KEY_ALICE" },
    ]);
    assert.deepEqual(getUser("alice-1"), {
      name: "alice-1",
      authMode: "gateway",
      gatewayKeyEnv: "LOOM_KEY_ALICE",
    });
  });
});

function withStateDir(fn: () => void): void {
  const previous = process.env.LOOM_STATE_DIR;
  process.env.LOOM_STATE_DIR = mkdtempSync(join(tmpdir(), "loomd-users-"));
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.LOOM_STATE_DIR;
    else process.env.LOOM_STATE_DIR = previous;
  }
}
