import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { HARNESS_VISION_LOCK } from "../src/harness/profile-contract.js";
import { projectTemplateContractStatus, readProjectTemplateMetadata, seedProjectTemplate } from "../src/harness/project-templates.js";

test("vas-lite project template inherits the shared harness vision lock", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "loom-project-template-vision-"));

  await seedProjectTemplate(projectRoot, {
    tenant: "alice",
    project: "lesson-vas",
    template: "vas-lite",
  });

  const metadata = await readProjectTemplateMetadata(projectRoot, { tenant: "alice", project: "lesson-vas" });

  assert.equal(metadata?.contract?.objective, HARNESS_VISION_LOCK.target);
  assert.deepEqual(projectTemplateContractStatus(metadata), { ok: true, missing: [] });

  const stored = JSON.parse(await readFile(join(projectRoot, ".loom", "project.json"), "utf8"));
  assert.equal(stored.contract.objective, HARNESS_VISION_LOCK.target);
});
