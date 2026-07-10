import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("Coder template keeps the workspace container isolation contract", async () => {
  const template = await readFile(join(process.cwd(), "coder-template", "main.tf"), "utf8");

  assert.match(template, /variable\s+"runtime"\s+{[\s\S]*default\s+=\s+"runsc"/);
  assert.match(template, /variable\s+"network"\s+{[\s\S]*default\s+=\s+"loom-net"/);
  assert.match(template, /capabilities\s+{[\s\S]*drop\s+=\s+\["ALL"\]/);
  assert.match(template, /security_opts\s+=\s+\["no-new-privileges:true"\]/);
  assert.match(template, /read_only\s+=\s+true/);
  assert.match(template, /tmpfs\s+=\s+{[\s\S]*"\/tmp"\s+=\s+"rw,noexec,nosuid,size=64m"/);
  assert.match(template, /data\s+"coder_parameter"\s+"pids_limit"\s+{[\s\S]*default\s+=\s+256/);
  assert.match(template, /docker update --pids-limit \$\{data\.coder_parameter\.pids_limit\.value\} \$\{self\.name\}/);
  assert.match(template, /cpu_shares\s+=\s+data\.coder_parameter\.cpus\.value\s+\*\s+1024/);
  assert.match(template, /memory\s+=\s+data\.coder_parameter\.memory_gb\.value\s+\*\s+1024/);
  assert.match(template, /networks_advanced\s+{[\s\S]*name\s+=\s+var\.network/);
});

test("Coder template wires central brain ingest into each workspace", async () => {
  const template = await readFile(join(process.cwd(), "coder-template", "main.tf"), "utf8");

  assert.match(template, /variable\s+"brain_ingest_url_template"\s+{[\s\S]*default\s+=\s+""/);
  assert.match(template, /variable\s+"brain_ingest_token"\s+{[\s\S]*sensitive\s+=\s+true/);
  assert.match(template, /tenant_key\s+=\s+data\.coder_workspace_owner\.me\.name/);
  assert.match(template, /brain_ingest_url\s+=\s+var\.brain_ingest_url_template\s+==\s+""\s+\?\s+""\s+:\s+replace\(var\.brain_ingest_url_template,\s+"\{tenant\}",\s+local\.tenant_key\)/);
  assert.match(template, /LOOM_BRAIN_INGEST_URL\s+=\s+local\.brain_ingest_url/);
  assert.match(template, /LOOM_BRAIN_INGEST_TOKEN\s+=\s+var\.brain_ingest_token/);
  assert.match(template, /LOOM_BRAIN_CLIENT_ID\s+=\s+"\$\{local\.tenant_key\}\/\$\{data\.coder_workspace\.me\.name\}"/);
});

test("Coder workspace image bakes tools needed by the read-only rootfs", async () => {
  const dockerfile = await readFile(join(process.cwd(), "coder-template", "build", "Dockerfile"), "utf8");

  assert.match(dockerfile, /npm ci && npm run build && npm link/);
  assert.match(dockerfile, /code-server\.dev\/install\.sh/);
});
