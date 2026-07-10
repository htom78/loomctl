import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execa } from "execa";

import { createDockerExecutor } from "../src/harness/docker-executor.js";

const SMOKE_IMAGE = "alpine:3.20";

async function dockerAvailable(): Promise<boolean> {
  try {
    const probe = await execa("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
      reject: false,
    });
    return probe.exitCode === 0 && probe.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

test(
  "docker executor really isolates: non-root, no network, read-only rootfs, rw workspace",
  { skip: hasDocker ? false : "docker daemon is not available" },
  async () => {
    await execa("docker", ["pull", SMOKE_IMAGE], { timeout: 120_000 });

    const cwd = await mkdtemp(join(tmpdir(), "loom-docker-smoke-"));
    await writeFile(join(cwd, "host-file.txt"), "from-host\n", "utf8");
    const executor = createDockerExecutor({ cwd, image: SMOKE_IMAGE });

    // 容器内命令真的在容器里跑,且能看到挂载的 workspace
    const visible = await executor.runCommand("cat host-file.txt", 60_000);
    assert.equal(visible.exitCode, 0);
    assert.equal(visible.stdout.trim(), "from-host");

    // 非 root:argv 断言之外的真容器实证
    const uid = await executor.runCommand("id -u", 60_000);
    assert.equal(uid.exitCode, 0);
    assert.notEqual(uid.stdout.trim(), "0");

    // --network none 生效:对外连接必须失败
    const net = await executor.runCommand(
      "wget -T 2 -q -O /dev/null http://1.1.1.1 2>/dev/null",
      60_000,
    );
    assert.notEqual(net.exitCode, 0);

    // read-only rootfs 生效:根目录不可写
    const rootWrite = await executor.runCommand("touch /rootfs-should-fail 2>/dev/null", 60_000);
    assert.notEqual(rootWrite.exitCode, 0);

    // workspace 挂载可写,且写回宿主可见
    const wsWrite = await executor.runCommand("echo from-container > out.txt", 60_000);
    assert.equal(wsWrite.exitCode, 0);
    const readBack = await executor.readFile("out.txt");
    assert.equal(readBack.trim(), "from-container");
  },
);
