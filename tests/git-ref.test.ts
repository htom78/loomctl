import assert from "node:assert/strict";
import test from "node:test";

import { safeGitRef } from "../src/harness/git-ref.js";

test("safeGitRef accepts normal branch refs", () => {
  assert.equal(safeGitRef("task/42", "branch"), "task/42");
  assert.equal(safeGitRef("origin/main", "baseBranch"), "origin/main");
  assert.equal(safeGitRef("release_2026.06", "branch"), "release_2026.06");
});

test("safeGitRef rejects unsafe path components", () => {
  assert.throws(() => safeGitRef("task/.hidden", "branch"), /branch is not a safe git ref/);
  assert.throws(() => safeGitRef("task/foo.lock/bar", "branch"), /branch is not a safe git ref/);
  assert.throws(() => safeGitRef("task/foo./bar", "branch"), /branch is not a safe git ref/);
});
