import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("Coder template keeps the workspace container isolation contract", async () => {
  const template = await readFile(join(process.cwd(), "coder-template", "main.tf"), "utf8");

  assert.match(template, /variable\s+"docker_socket"\s+{[\s\S]*default\s+=\s+""/);
  assert.match(template, /provider\s+"docker"\s+{[\s\S]*host\s+=\s+var\.docker_socket/);
  assert.match(template, /data\s+"coder_provisioner"\s+"me"/);
  assert.match(template, /arch\s+=\s+data\.coder_provisioner\.me\.arch/);
  assert.match(template, /variable\s+"runtime"\s+{[\s\S]*default\s+=\s+"runsc"/);
  assert.match(template, /variable\s+"network"\s+{[\s\S]*default\s+=\s+"loom-net"/);
  assert.match(template, /capabilities\s+{[\s\S]*drop\s+=\s+\["ALL"\]/);
  assert.match(template, /security_opts\s+=\s+\["no-new-privileges:true"\]/);
  assert.match(template, /read_only\s+=\s+true/);
  assert.match(template, /tmpfs\s+=\s+{[\s\S]*"\/tmp"\s+=\s+"rw,noexec,nosuid,size=64m"/);
  assert.match(template, /data\s+"coder_parameter"\s+"pids_limit"\s+{[\s\S]*default\s+=\s+256/);
  assert.match(template, /docker update --pids-limit \$\{data\.coder_parameter\.pids_limit\.value\} \$\{self\.name\}/);
  assert.match(template, /cpus\s+=\s+tostring\(data\.coder_parameter\.cpus\.value\)/);
  assert.doesNotMatch(template, /cpu_shares\s+=/);
  assert.match(template, /memory\s+=\s+data\.coder_parameter\.memory_gb\.value\s+\*\s+1024/);
  assert.match(template, /mkdir -p \/home\/dev\/\.cache\/coder-agent/);
  assert.match(template, /export TMPDIR=\/home\/dev\/\.cache\/coder-agent/);
  assert.match(template, /replace\(coder_agent\.main\.init_script,[\s\S]*"egress"/);

  const workspace = template.slice(template.indexOf('resource "docker_container" "workspace"'));
  assert.match(workspace, /networks_advanced\s+{[\s\S]*name\s+=\s+docker_network\.workspace\.name/);
  assert.doesNotMatch(workspace, /name\s+=\s+var\.network/);
  assert.doesNotMatch(workspace, /host\.docker\.internal/);
});

test("Coder template isolates tenant networks behind a fixed-target egress proxy", async () => {
  const template = await readFile(join(process.cwd(), "coder-template", "main.tf"), "utf8");

  assert.match(template, /resource\s+"docker_network"\s+"workspace"\s+{[\s\S]*internal\s+=\s+true/);
  assert.match(template, /resource\s+"docker_container"\s+"egress"/);
  assert.match(template, /image\s+=\s+var\.egress_image/);
  assert.match(template, /socat TCP-LISTEN:\$\{var\.coder_proxy_port\}[\s\S]*TCP:\$\{var\.coder_upstream\}/);
  assert.match(template, /socat TCP-LISTEN:\$\{var\.gitea_proxy_port\}[\s\S]*TCP:\$\{var\.gitea_upstream\}/);
  assert.match(template, /socat TCP-LISTEN:\$\{var\.gateway_proxy_port\}[\s\S]*TCP:\$\{var\.gateway_upstream\}/);
  assert.match(template, /aliases\s+=\s+\["egress"\]/);
  assert.match(template, /networks_advanced\s+{[\s\S]*name\s+=\s+var\.network/);
  assert.match(template, /docker_container"\s+"egress"[\s\S]*capabilities\s+{[\s\S]*drop\s+=\s+\["ALL"\]/);
  assert.match(template, /depends_on\s+=\s+\[docker_container\.egress\]/);
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

  assert.match(dockerfile, /COPY \. \/opt\/loomctl/);
  assert.match(dockerfile, /npm ci && npm run build && npm link/);
  assert.match(dockerfile, /code-server\.dev\/install\.sh/);
  assert.doesNotMatch(dockerfile, /\bsudo\b/);
});

test("Coder egress image is minimal, unprivileged, and digest-pinned", async () => {
  const dockerfile = await readFile(join(process.cwd(), "coder-template", "build", "egress.Dockerfile"), "utf8");

  assert.match(dockerfile, /^FROM alpine@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /apk add --no-cache socat/);
  assert.match(dockerfile, /^USER 65534:65534$/m);
});

test("Coder workspace build context excludes local credentials", async () => {
  const dockerignore = await readFile(join(process.cwd(), ".dockerignore"), "utf8");
  const patterns = new Set(
    dockerignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  for (const required of [".codex-tmp", ".secrets", "secrets", ".env", ".env.*", "*.key", "*.pem", "*.log"]) {
    assert.ok(patterns.has(required), `missing secret exclusion: ${required}`);
  }
});
