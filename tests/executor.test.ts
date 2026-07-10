import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import { createCoderExecutor } from "../src/harness/coder-executor.js";
import { createDockerExecutor } from "../src/harness/docker-executor.js";
import { createLocalExecutor, createProcessSession } from "../src/harness/executor.js";
import { createToolRuntime } from "../src/harness/tools.js";

const execFileAsync = promisify(execFile);

async function tempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${name}-`));
}

function expectedDockerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid === "number" && uid > 0) {
    return `${uid}:${typeof gid === "number" && gid > 0 ? gid : uid}`;
  }
  return "1000:1000";
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("local executor confines file operations and commands to workspace cwd", async () => {
  const cwd = await tempDir("loom-executor");
  const executor = createLocalExecutor({ cwd });

  assert.deepEqual(executor.describeWorkspace?.(), { kind: "local", cwd });

  await executor.writeFile("nested/file.txt", "hello\n");
  assert.equal(await executor.readFile("nested/file.txt"), "hello\n");
  assert.equal(await readFile(join(cwd, "nested", "file.txt"), "utf8"), "hello\n");
  await executor.moveFile?.("nested/file.txt", "renamed/file.txt");
  assert.equal(await executor.readFile("renamed/file.txt"), "hello\n");
  await assert.rejects(() => readFile(join(cwd, "nested", "file.txt"), "utf8"), { code: "ENOENT" });
  const root = await executor.inspectPath("");
  assert.equal(root.kind, "directory");
  assert.ok(root.entries.some((entry) => entry.name === "renamed" && entry.kind === "directory"));
  const nestedFile = await executor.inspectPath("renamed/file.txt");
  assert.equal(nestedFile.kind, "file");
  assert.equal(nestedFile.path, "renamed/file.txt");
  assert.equal(nestedFile.size, 6);

  const command = await executor.runCommand("pwd && test -f renamed/file.txt && printf ok", 120_000);
  assert.equal(command.exitCode, 0);
  assert.match(command.stdout, /ok$/);
  assert.match(command.stdout, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  await assert.rejects(() => executor.readFile("../outside.txt"), /escapes workspace/);
  await assert.rejects(() => executor.writeFile("../outside.txt", "nope"), /escapes workspace/);
  await assert.rejects(() => executor.moveFile?.("renamed/file.txt", "../outside.txt"), /escapes workspace/);
});

test("local executor rejects symlink escapes from workspace file APIs", async () => {
  const cwd = await tempDir("loom-executor-symlink");
  const outside = await tempDir("loom-executor-outside");
  await writeFile(join(outside, "secret.txt"), "secret\n", "utf8");
  await writeFile(join(cwd, "inside.txt"), "inside\n", "utf8");
  await symlink(outside, join(cwd, "outside-link"), "dir");
  const executor = createLocalExecutor({ cwd });

  await assert.rejects(() => executor.inspectPath("outside-link/secret.txt"), /escapes workspace/);
  await assert.rejects(() => executor.readFile("outside-link/secret.txt"), /escapes workspace/);
  await assert.rejects(() => executor.writeFile("outside-link/secret.txt", "owned\n"), /escapes workspace/);
  await assert.rejects(() => executor.moveFile?.("inside.txt", "outside-link/secret.txt"), /escapes workspace/);
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "secret\n");
});

test("process sessions force kill when stop grace expires", async () => {
  const session = createProcessSession(
    execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"],
    { stopGraceMs: 25 },
  );
  const ready = new Promise<void>((resolve) => {
    session.onOutput((event) => {
      if (event.stream === "stdout" && event.data.includes("ready")) resolve();
    });
  });
  const exit = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
    session.onExit(resolve);
  });

  await ready;
  await session.stop();
  const event = await promiseWithTimeout(exit, 1000);

  assert.equal(event.signal, "SIGKILL");
});

test("tool runtime delegates tools to the supplied executor boundary", async () => {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const runtime = createToolRuntime({
    cwd: "/unused",
    verifyCommands: ["test -f delegated.txt"],
    executor: {
      async inspectPath(path: string): Promise<any> {
        return { path, kind: "missing" };
      },
      async readFile(path: string): Promise<string> {
        calls.push(`read:${path}`);
        return files.get(path) ?? "";
      },
      async writeFile(path: string, content: string): Promise<void> {
        calls.push(`write:${path}:${content}`);
        files.set(path, content);
      },
      async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        calls.push(`run:${command}`);
        return { stdout: "delegated", stderr: "", exitCode: 0 };
      },
    },
  });

  const write = await runtime.execute({
    id: "a1",
    toolName: "file.write",
    input: { path: "delegated.txt", content: "via executor" },
  });
  assert.equal(write.ok, true);

  const read = await runtime.execute({
    id: "a2",
    toolName: "file.read",
    input: { path: "delegated.txt" },
  });
  assert.equal(read.output, "via executor");

  const shell = await runtime.execute({
    id: "a3",
    toolName: "shell.exec",
    input: { command: "printf delegated" },
  });
  assert.equal(shell.output, "delegated");

  const verify = await runtime.execute({
    id: "a4",
    toolName: "verify.run",
    input: {},
  });
  assert.equal(verify.ok, true);

  assert.deepEqual(calls, [
    "write:delegated.txt:via executor",
    "read:delegated.txt",
    "run:printf delegated",
    "run:test -f delegated.txt",
  ]);
});

test("tool runtime denies file tools for .loom internals", async () => {
  const calls: string[] = [];
  const runtime = createToolRuntime({
    cwd: "/unused",
    verifyCommands: [],
    executor: {
      async inspectPath(path: string): Promise<any> {
        return { path, kind: "missing" };
      },
      async readFile(path: string): Promise<string> {
        calls.push(`read:${path}`);
        return "";
      },
      async writeFile(path: string): Promise<void> {
        calls.push(`write:${path}`);
      },
      async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        calls.push(`run:${command}`);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  });

  const write = await runtime.execute({
    id: "a1",
    toolName: "file.write",
    input: { path: ".loom/runs/run-1/summary.json", content: "{}\n" },
  });
  const read = await runtime.execute({
    id: "a2",
    toolName: "file.read",
    input: { path: "nested/.loom/events.jsonl" },
  });

  assert.equal(write.ok, false);
  assert.match(write.error ?? "", /reserved for Loom internals/);
  assert.equal(read.ok, false);
  assert.match(read.error ?? "", /reserved for Loom internals/);
  assert.deepEqual(calls, []);
});

test("tool runtime caps file.read maxBytes for bounded observations", async () => {
  const cwd = await tempDir("loom-tools-file-read-cap");
  await writeFile(join(cwd, "large.txt"), "x".repeat(300 * 1024), "utf8");
  const runtime = createToolRuntime({
    cwd,
    verifyCommands: [],
    allowedTools: ["file.read"],
  });

  const read = await runtime.execute({
    id: "a1",
    toolName: "file.read",
    input: { path: "large.txt", maxBytes: 1_000_000 },
  });

  assert.equal(read.ok, true);
  assert.equal(read.output.length, 256 * 1024);
});

test("tool runtime commits through the supplied executor boundary", async () => {
  const calls: string[] = [];
  const runtime = createToolRuntime({
    cwd: "/unused",
    verifyCommands: [],
    allowedTools: ["git.commit"],
    executor: {
      async inspectPath(path: string): Promise<any> {
        return { path, kind: "missing" };
      },
      async readFile(): Promise<string> {
        return "";
      },
      async writeFile(): Promise<void> {},
      async runCommand(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        calls.push(command);
        if (command === "git diff --cached --quiet -- . ':(exclude).loom'") return { stdout: "", stderr: "", exitCode: 1 };
        if (command === "(git reset -q -- .loom 2>/dev/null || true)") return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git commit --only -m 'checkpoint' -- . ':(exclude).loom'") return { stdout: "[main abc1234] checkpoint\n", stderr: "", exitCode: 0 };
        if (command === "git rev-parse --short HEAD") return { stdout: "abc1234\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  });

  const commit = await runtime.execute({
    id: "a1",
    toolName: "git.commit",
    input: { message: "checkpoint" },
  });

  assert.equal(commit.ok, true);
  assert.match(commit.output, /commit abc1234/);
  assert.deepEqual(calls, [
    "git add -A -- . ':(exclude).loom'",
    "(git reset -q -- .loom 2>/dev/null || true)",
    "git diff --cached --quiet -- . ':(exclude).loom'",
    "git commit --only -m 'checkpoint' -- . ':(exclude).loom'",
    "git rev-parse --short HEAD",
  ]);
});

test("tool runtime commit clears staged .loom internals", async () => {
  const cwd = await tempDir("loom-tools-git-commit-loom");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "loom@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Loom Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "# Before\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd });
  await mkdir(join(cwd, ".loom", "runs", "run-internal"), { recursive: true });
  await writeFile(join(cwd, ".loom", "runs", "run-internal", "summary.json"), "{\"secret\":true}\n", "utf8");
  await execFileAsync("git", ["add", ".loom/runs/run-internal/summary.json"], { cwd });
  await writeFile(join(cwd, "README.md"), "# After\n", "utf8");

  const runtime = createToolRuntime({
    cwd,
    verifyCommands: [],
    allowedTools: ["git.commit"],
  });

  const commit = await runtime.execute({
    id: "a1",
    toolName: "git.commit",
    input: { message: "checkpoint" },
  });

  assert.equal(commit.ok, true);
  const committedFiles = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd });
  assert.deepEqual(committedFiles.stdout.split("\n").filter(Boolean), ["README.md"]);
  const stagedFiles = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd });
  assert.equal(stagedFiles.stdout, "");
});

test("tool runtime git.diff excludes tracked .loom internals", async () => {
  const cwd = await tempDir("loom-tools-git-diff");
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "loom@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "Loom Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "# Before\n", "utf8");
  await mkdir(join(cwd, ".loom", "runs", "run-internal"), { recursive: true });
  await writeFile(join(cwd, ".loom", "runs", "run-internal", "summary.json"), "{\"internal\":\"before\"}\n", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd });
  await writeFile(join(cwd, "README.md"), "# After\n", "utf8");
  await writeFile(join(cwd, ".loom", "runs", "run-internal", "summary.json"), "{\"internal\":\"after\"}\n", "utf8");

  const runtime = createToolRuntime({
    cwd,
    verifyCommands: [],
    allowedTools: ["git.diff"],
  });

  const diff = await runtime.execute({
    id: "a1",
    toolName: "git.diff",
    input: {},
  });

  assert.equal(diff.ok, true);
  assert.match(diff.output, /README\.md/);
  assert.doesNotMatch(diff.output, /\.loom/);
  assert.doesNotMatch(diff.output, /internal/);
});

test("docker executor runs commands in a mounted workspace", async () => {
  const cwd = await tempDir("loom-docker-executor");
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createDockerExecutor({
    cwd,
    image: "loom-workspace:test",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "container-ok", stderr: "", exitCode: 0 };
    },
  });

  assert.deepEqual(executor.describeWorkspace?.(), {
    kind: "docker",
    cwd,
    containerCwd: "/workspace",
    image: "loom-workspace:test",
    network: "none",
    cpus: "2",
    memory: "4g",
    pidsLimit: 256,
    readOnlyRootfs: true,
    user: expectedDockerUser(),
  });

  await executor.writeFile("input.txt", "ok\n");
  assert.equal(await readFile(join(cwd, "input.txt"), "utf8"), "ok\n");
  assert.equal(await executor.readFile("input.txt"), "ok\n");

  const result = await executor.runCommand("test -f input.txt && printf container-ok", 42_000);
  assert.equal(result.stdout, "container-ok");
  assert.deepEqual(calls, [
    {
      file: "docker",
      args: [
        "run",
        "--rm",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        expectedDockerUser(),
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--pids-limit",
        "256",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${cwd},target=/workspace`,
        "-w",
        "/workspace",
        "loom-workspace:test",
        "sh",
        "-lc",
        "test -f input.txt && printf container-ok",
      ],
      timeoutMs: 42_000,
    },
  ]);

  await assert.rejects(() => executor.readFile("../outside.txt"), /escapes workspace/);
  await assert.rejects(() => executor.writeFile("../outside.txt", "nope"), /escapes workspace/);
});

test("docker executor can target an explicit sandbox network", async () => {
  const cwd = await tempDir("loom-docker-network");
  const calls: Array<{ args: string[] }> = [];
  const executor = createDockerExecutor({
    cwd,
    image: "loom-workspace:test",
    network: "loom-egress",
    commandRunner: async (_file, args) => {
      calls.push({ args });
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });

  await executor.runCommand("printf ok");

  assert.equal(calls.length, 1);
  const networkIndex = calls[0].args.indexOf("--network");
  assert.ok(networkIndex >= 0);
  assert.equal(calls[0].args[networkIndex + 1], "loom-egress");
});

test("docker executor can mount a persistent home directory", async () => {
  const cwd = await tempDir("loom-docker-home-workspace");
  const home = await tempDir("loom-docker-home");
  let dockerArgs: string[] = [];
  const executor = createDockerExecutor({
    cwd,
    home,
    image: "loom-workspace:test",
    commandRunner: async (_file, args) => {
      dockerArgs = args;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });

  assert.deepEqual(executor.describeWorkspace?.(), {
    kind: "docker",
    cwd,
    containerCwd: "/workspace",
    home,
    containerHome: "/home/dev",
    image: "loom-workspace:test",
    network: "none",
    cpus: "2",
    memory: "4g",
    pidsLimit: 256,
    readOnlyRootfs: true,
    user: expectedDockerUser(),
  });

  await executor.runCommand("printf ok");

  assert.ok(dockerArgs.includes(`type=bind,source=${cwd},target=/workspace`));
  assert.ok(dockerArgs.includes(`type=bind,source=${home},target=/home/dev`));
});

test("docker executor runs commands as a non-root container user", async () => {
  const cwd = await tempDir("loom-docker-user");
  let dockerArgs: string[] = [];
  const executor = createDockerExecutor({
    cwd,
    image: "loom-workspace:test",
    commandRunner: async (_file, args) => {
      dockerArgs = args;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });

  await executor.runCommand("id -u");

  const userIndex = dockerArgs.indexOf("--user");
  assert.ok(userIndex >= 0);
  assert.equal(dockerArgs[userIndex + 1], expectedDockerUser());
  assert.doesNotMatch(dockerArgs[userIndex + 1], /^(?:0|root)(?::|$)/);
});

test("docker executor rejects root container users", async () => {
  const cwd = await tempDir("loom-docker-root-user");

  for (const user of ["0", "0:0", "root", "root:root", "1000:0"]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", user }),
      /docker user must not be root/,
    );
  }
});

test("docker executor rejects unsafe image references", async () => {
  const cwd = await tempDir("loom-docker-unsafe-image");

  assert.throws(
    () => createDockerExecutor({ cwd, image: "   " }),
    /docker executor image is required/,
  );

  for (const image of ["--privileged", "-bad", "loom workspace:test", "loom\0workspace:test"]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image }),
      /docker image reference is not safe/,
    );
  }
});

test("docker executor rejects unsafe resource limits", async () => {
  const cwd = await tempDir("loom-docker-unsafe-resources");

  for (const cpus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "0", "-1", "NaN", "abc", "1 --privileged"]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", cpus }),
      /docker cpus must be a positive number/,
    );
  }

  for (const memory of ["", "0", "0m", "-1g", "abc", "1g\0", "1g --privileged"]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", memory }),
      /docker memory must be a Docker memory size/,
    );
  }

  for (const pidsLimit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", pidsLimit }),
      /docker pids limit must be a positive integer/,
    );
  }
});

test("docker executor normalizes resource limits", async () => {
  const cwd = await tempDir("loom-docker-resources");
  let dockerArgs: string[] = [];
  const executor = createDockerExecutor({
    cwd,
    image: "loom-workspace:test",
    cpus: 0.5,
    memory: "512m",
    pidsLimit: 64,
    commandRunner: async (_file, args) => {
      dockerArgs = args;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });

  assert.deepEqual(executor.describeWorkspace?.(), {
    kind: "docker",
    cwd,
    containerCwd: "/workspace",
    image: "loom-workspace:test",
    network: "none",
    cpus: "0.5",
    memory: "512m",
    pidsLimit: 64,
    readOnlyRootfs: true,
    user: expectedDockerUser(),
  });

  await executor.runCommand("printf ok");

  assert.equal(dockerArgs[dockerArgs.indexOf("--cpus") + 1], "0.5");
  assert.equal(dockerArgs[dockerArgs.indexOf("--memory") + 1], "512m");
  assert.equal(dockerArgs[dockerArgs.indexOf("--pids-limit") + 1], "64");
});

test("docker executor rejects writable rootfs overrides", async () => {
  const cwd = await tempDir("loom-docker-writable-rootfs");

  assert.throws(
    () => createDockerExecutor({ cwd, image: "loom-workspace:test", readOnlyRootfs: false }),
    /docker executor requires a read-only rootfs/,
  );
});

test("docker executor rejects unsafe tmpfs overrides", async () => {
  const cwd = await tempDir("loom-docker-unsafe-tmpfs");

  for (const tmpfs of [
    "",
    "--privileged",
    "/workspace:rw,noexec,nosuid,size=64m",
    "/tmp:rw,exec,nosuid,size=64m",
    "/tmp:rw,noexec,suid,size=64m",
    "/tmp:rw,noexec,nosuid,size=0m",
    "/tmp:rw,noexec,nosuid,size=64m,mode=777",
    "/tmp:rw,noexec,nosuid,size=64m\0",
  ]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", tmpfs }),
      /docker tmpfs must be a bounded \/tmp mount/,
    );
  }
});

test("docker executor accepts bounded tmpfs overrides", async () => {
  const cwd = await tempDir("loom-docker-safe-tmpfs");
  let dockerArgs: string[] = [];
  const executor = createDockerExecutor({
    cwd,
    image: "loom-workspace:test",
    tmpfs: "/tmp:rw,noexec,nosuid,size=128m",
    commandRunner: async (_file, args) => {
      dockerArgs = args;
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  });

  await executor.runCommand("printf ok");

  assert.equal(dockerArgs[dockerArgs.indexOf("--tmpfs") + 1], "/tmp:rw,noexec,nosuid,size=128m");
});

test("docker executor rejects workspace paths that are unsafe for bind mounts", async () => {
  const cwd = await tempDir("loom-docker,bad-mount");

  assert.throws(
    () => createDockerExecutor({ cwd, image: "loom-workspace:test" }),
    /docker workspace path is not safe to bind mount/,
  );
});

test("docker executor rejects home paths that are unsafe for bind mounts", async () => {
  const cwd = await tempDir("loom-docker-home-workspace");
  const home = await tempDir("loom-docker,bad-home");

  assert.throws(
    () => createDockerExecutor({ cwd, home, image: "loom-workspace:test" }),
    /docker home path is not safe to bind mount/,
  );
});

test("docker executor rejects unsafe docker network modes", async () => {
  const cwd = await tempDir("loom-docker-unsafe-network");

  for (const network of ["host", "bridge", "container:other"]) {
    assert.throws(
      () => createDockerExecutor({ cwd, image: "loom-workspace:test", network }),
      /unsafe docker network mode/,
    );
  }
});

test("coder executor runs tools through coder ssh in a remote cwd", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: args.join(" "), stderr: "", exitCode: 0 };
    },
  });

  assert.deepEqual(executor.describeWorkspace?.(), {
    kind: "coder",
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    baseBranch: "origin/main",
  });

  await executor.writeFile("src/input.txt", "hello\n");
  await executor.moveFile?.("src/input.txt", "dest/input.txt");
  await executor.readFile("src/input.txt", 12);
  await executor.runCommand("test -f src/input.txt && printf remote-ok", 42_000);

  assert.equal(calls.length, 4);
  assert.equal(calls[0].file, "coder");
  assert.deepEqual(calls[0].args.slice(0, 4), ["ssh", "alice-dev", "--", "sh"]);
  assert.match(calls[0].args[5], /cd '\/home\/dev\/projects\/app'/);
  assert.match(calls[0].args[5], /mkdir -p -- 'src'/);
  assert.match(calls[0].args[5], /base64 -d > 'src\/input\.txt'/);
  assert.deepEqual(calls[1].args.slice(0, 4), ["ssh", "alice-dev", "--", "sh"]);
  assert.match(calls[1].args[5], /mkdir -p -- 'dest'/);
  assert.match(calls[1].args[5], /mv -- 'src\/input\.txt' 'dest\/input\.txt'/);
  assert.deepEqual(calls[2].args.slice(0, 4), ["ssh", "alice-dev", "--", "sh"]);
  assert.match(calls[2].args[5], /head -c 12 -- 'src\/input\.txt'/);
  assert.deepEqual(calls[3], {
    file: "coder",
    args: [
      "ssh",
      "alice-dev",
      "--",
      "sh",
      "-lc",
      "cd '/home/dev/projects/app' && sh -lc 'test -f src/input.txt && printf remote-ok'",
    ],
    timeoutMs: 42_000,
  });

  assert.equal(executor.describePath?.("src/input.txt"), "src/input.txt");
  await assert.rejects(() => executor.readFile("../outside.txt"), /escapes workspace/);
  await assert.rejects(() => executor.writeFile("/absolute.txt", "nope"), /escapes workspace/);
  await assert.rejects(() => executor.moveFile?.("src/input.txt", "/absolute.txt"), /escapes workspace/);
});

test("coder executor guards remote file APIs with realpath checks", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      if (args[5].includes("loom-inspect-path")) {
        return { stdout: "missing\tdest/input.txt\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.writeFile("src/input.txt", "hello\n");
  await executor.moveFile?.("src/input.txt", "dest/input.txt");
  await executor.readFile("dest/input.txt");
  await executor.inspectPath("dest/input.txt");
  await executor.deleteFile?.("dest/input.txt");

  assert.equal(calls.length, 5);
  assert.match(calls[0].args[5], /loom-safe-path/);
  assert.doesNotMatch(calls[0].args[5], /; &&/);
  assert.match(calls[0].args[5], /loom_safe_writable_path 'src\/input\.txt'/);
  assert.match(calls[1].args[5], /loom_safe_existing_path 'src\/input\.txt' && loom_safe_writable_path 'dest\/input\.txt'/);
  assert.match(calls[2].args[5], /loom_safe_existing_path 'dest\/input\.txt' && cat -- 'dest\/input\.txt'/);
  assert.match(calls[3].args[5], /loom_safe_inspect_path 'dest\/input\.txt' && : loom-inspect-path/);
  assert.match(calls[4].args[5], /loom_safe_existing_path 'dest\/input\.txt' && rm -f -- 'dest\/input\.txt'/);
});

test("coder executor terminates shell options for dash-prefixed file paths", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      if (args[5].includes("loom-inspect-path")) {
        return { stdout: "missing\t-moved.txt\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.readFile("-note.txt", 12);
  await executor.writeFile("-note.txt", "hello\n");
  await executor.moveFile?.("-note.txt", "-moved.txt");
  await executor.inspectPath("-moved.txt");
  await executor.deleteFile?.("-moved.txt");

  assert.match(calls[0].args[5], /head -c 12 -- '-note\.txt'/);
  assert.match(calls[1].args[5], /mkdir -p -- '\.'/);
  assert.match(calls[2].args[5], /mv -- '-note\.txt' '-moved\.txt'/);
  assert.match(calls[3].args[5], /stat -c %s -- '-moved\.txt'/);
  assert.match(calls[3].args[5], /find -- '-moved\.txt'/);
  assert.match(calls[4].args[5], /rm -f -- '-moved\.txt'/);
});

test("coder executor can expose configured browser IDE and preview URLs", async () => {
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    ideUrl: "https://coder.example.com/@alice/alice-dev/apps/code-server",
    previewUrl: "https://coder.example.com/@alice/alice-dev/apps/preview",
  });

  assert.deepEqual(executor.describeWorkspace?.(), {
    kind: "coder",
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    baseBranch: "origin/main",
    ideUrl: "https://coder.example.com/@alice/alice-dev/apps/code-server",
    previewUrl: "https://coder.example.com/@alice/alice-dev/apps/preview",
  });
});

test("coder executor rejects unsafe browser IDE URLs", async () => {
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      ideUrl: "javascript:alert(1)",
    }),
    /ideUrl must be an http or https URL/,
  );

  for (const ideUrl of [
    "https://alice:secret@coder.example.com/@alice/alice-dev/apps/code-server",
    "https://coder.example.com/@alice/alice-dev/apps/code-server#token=secret",
    "https://coder.example.com/@alice/alice-dev/apps/code-server?token=secret",
    "https://coder.example.com/@alice/alice-dev/apps/code-server?access_key=secret",
    "https://coder.example.com/@alice/alice-dev/apps/code-server?auth=secret",
    "https://coder.example.com/@alice/alice-dev/apps/code-server?password=secret",
  ]) {
    assert.throws(
      () => createCoderExecutor({
        workspace: "alice-dev",
        remoteCwd: "/home/dev/projects/app",
        ideUrl,
      }),
      /ideUrl must not include credentials, fragments, or secret-bearing query parameters/,
    );
  }

  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      previewUrl: "javascript:alert(1)",
    }),
    /previewUrl must be an http or https URL/,
  );

  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      previewUrl: "https://coder.example.com/@alice/alice-dev/apps/preview?auth=secret",
    }),
    /previewUrl must not include credentials, fragments, or secret-bearing query parameters/,
  );
});

test("coder executor rejects unsafe workspace identifiers", () => {
  for (const workspace of ["--help", "alice dev", "alice\tdev", "alice\ndev", "alice\0dev"]) {
    assert.throws(
      () => createCoderExecutor({
        workspace,
        remoteCwd: "/home/dev/projects/app",
      }),
      /workspace is not safe/,
    );
  }
});

test("coder executor rejects dangerous remote workspace paths", () => {
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/",
    }),
    /remoteCwd must not be the filesystem root/,
  );
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      repoCwd: "/",
      repo: "https://git.example/team/app.git",
      branch: "task/demo",
    }),
    /repoCwd must not be the filesystem root/,
  );
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app\0owned",
    }),
    /remoteCwd contains an invalid NUL byte/,
  );
});

test("coder executor can inspect remote workspace files", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      const command = args[5];
      if (command.includes("src/index.ts")) {
        return { stdout: "file\tsrc/index.ts\t24\t2026-06-26T00:00:00.000Z", stderr: "", exitCode: 0 };
      }
      return {
        stdout: [
          "directory\t",
          "entry\tREADME.md\tREADME.md\tfile\t10\t2026-06-26T00:00:00.000Z",
          "entry\tsrc\tsrc\tdirectory\t0\t2026-06-26T00:00:00.000Z",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const root = await executor.inspectPath("");
  assert.equal(root.kind, "directory");
  assert.deepEqual(
    root.entries.map((entry) => ({ name: entry.name, path: entry.path, kind: entry.kind, size: entry.size })),
    [
      { name: "README.md", path: "README.md", kind: "file", size: 10 },
      { name: "src", path: "src", kind: "directory", size: undefined },
    ],
  );

  const file = await executor.inspectPath("src/index.ts");
  assert.deepEqual(file, {
    path: "src/index.ts",
    kind: "file",
    size: 24,
    updatedAt: "2026-06-26T00:00:00.000Z",
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].args[5], /cd '\/home\/dev\/projects\/app'/);
  assert.match(calls[0].args[5], /loom-inspect-path/);
  assert.match(calls[1].args[5], /src\/index\.ts/);
});

test("coder executor fails file tools when remote commands fail", async () => {
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async () => ({ stdout: "", stderr: "remote denied", exitCode: 13 }),
  });

  await assert.rejects(() => executor.readFile("missing.txt"), /remote denied/);
  await assert.rejects(() => executor.writeFile("missing.txt", "nope"), /remote denied/);
});

test("coder executor prepares the remote workspace before a run", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.();

  assert.deepEqual(calls, [
    {
      file: "coder",
      args: ["start", "--yes", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/projects/app'"],
      timeoutMs: 120_000,
    },
  ]);
});

test("coder executor can create a missing workspace from a template before preparing it", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    template: "loom",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return {
        stdout: "",
        stderr: args[0] === "show" ? "not found" : "",
        exitCode: args[0] === "show" ? 1 : 0,
      };
    },
  });

  await executor.prepare?.();

  assert.deepEqual(calls, [
    {
      file: "coder",
      args: ["show", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["create", "--template", "loom", "--yes", "--use-parameter-defaults", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["start", "--yes", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/projects/app'"],
      timeoutMs: 120_000,
    },
  ]);
});

test("coder executor passes template parameters when creating a missing workspace", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    template: "loom",
    templateParameters: ["auth_mode=subscription", "cpus=4", "memory_gb=8"],
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return {
        stdout: "",
        stderr: args[0] === "show" ? "not found" : "",
        exitCode: args[0] === "show" ? 1 : 0,
      };
    },
  });

  await executor.prepare?.();

  assert.deepEqual(calls, [
    {
      file: "coder",
      args: ["show", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: [
        "create",
        "--template",
        "loom",
        "--yes",
        "--use-parameter-defaults",
        "--parameter",
        "auth_mode=subscription",
        "--parameter",
        "cpus=4",
        "--parameter",
        "memory_gb=8",
        "alice-dev",
      ],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["start", "--yes", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/projects/app'"],
      timeoutMs: 120_000,
    },
  ]);
});

test("coder executor maps resource limits to loom Coder template parameters", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    template: "loom",
    templateParameters: ["auth_mode=gateway", "cpus=1"],
    templateResourceLimits: { cpus: 0.5, memory: "512m", pidsLimit: 64 },
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return {
        stdout: "",
        stderr: args[0] === "show" ? "not found" : "",
        exitCode: args[0] === "show" ? 1 : 0,
      };
    },
  });

  await executor.prepare?.();

  assert.deepEqual(calls[1].args, [
    "create",
    "--template",
    "loom",
    "--yes",
    "--use-parameter-defaults",
    "--parameter",
    "auth_mode=gateway",
    "--parameter",
    "cpus=0.5",
    "--parameter",
    "memory_gb=0.5",
    "--parameter",
    "pids_limit=64",
    "alice-dev",
  ]);
});

test("coder executor rejects unsafe template parameters", () => {
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      template: "loom",
      templateParameters: ["bad name=value"],
    }),
    /template parameter name is not safe/,
  );
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      template: "loom",
      templateParameters: ["missing-value"],
    }),
    /template parameter must be name=value/,
  );

  for (const parameter of [
    "brain_ingest_token=secret",
    "api_key=secret",
    "clientSecret=secret",
    "password=secret",
  ]) {
    assert.throws(
      () => createCoderExecutor({
        workspace: "alice-dev",
        remoteCwd: "/home/dev/projects/app",
        template: "loom",
        templateParameters: [parameter],
      }),
      /template parameter name must not be secret-bearing/,
    );
  }
});

test("coder executor rejects unsafe template identifiers", () => {
  for (const template of ["--help", "loom template", "loom\ttemplate", "loom\ntemplate", "loom\0template"]) {
    assert.throws(
      () => createCoderExecutor({
        workspace: "alice-dev",
        remoteCwd: "/home/dev/projects/app",
        template,
      }),
      /template is not safe/,
    );
  }
});

test("coder executor syncs a remote git project during prepare", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    repo: "https://git.example/team/app.git",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.();

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], {
    file: "coder",
    args: ["start", "--yes", "alice-dev"],
    timeoutMs: 120_000,
  });
  assert.deepEqual(calls[1], {
    file: "coder",
    args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/projects'"],
    timeoutMs: 120_000,
  });
  assert.equal(calls[2].file, "coder");
  assert.deepEqual(calls[2].args.slice(0, 5), ["ssh", "alice-dev", "--", "sh", "-lc"]);
  assert.match(calls[2].args[5], /if \[ -d '\/home\/dev\/projects\/app\/\.git' \]/);
  assert.match(calls[2].args[5], /git fetch --all --prune/);
  assert.match(calls[2].args[5], /git fetch --all --prune; else/);
  assert.match(calls[2].args[5], /git clone 'https:\/\/git\.example\/team\/app\.git' '\/home\/dev\/projects\/app'/);
});

test("coder executor can expose workspace env while syncing a remote git project during prepare", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    repo: "https://git.example/team/app.git",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.({ env: { LOOM_AGENT_TOKEN: "agent-secret" } });

  assert.equal(calls.length, 3);
  assert.match(calls[2].args[5], /^env LOOM_AGENT_TOKEN='agent-secret' sh -lc 'if \[ -d/);
  assert.match(calls[2].args[5], /git clone/);
  assert.match(calls[2].args[5], /https:\/\/git\.example\/team\/app\.git/);
  assert.doesNotMatch(calls[1].args[5], /agent-secret/);
});

test("coder executor can expose workspace git credentials while syncing a remote git project during prepare", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    repo: "https://git.example/team/app.git",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.({
    env: { LOOM_AGENT_TOKEN: "agent-secret" },
    gitCredential: { tokenEnvName: "LOOM_AGENT_TOKEN" },
  });

  assert.equal(calls.length, 3);
  assert.match(calls[2].args[5], /: loom-git-credential;/);
  assert.match(calls[2].args[5], /GIT_ASKPASS="\$loom_git_askpass"/);
  assert.match(calls[2].args[5], /GIT_TERMINAL_PROMPT=0/);
  assert.match(calls[2].args[5], /printenv/);
  assert.match(calls[2].args[5], /LOOM_AGENT_TOKEN/);
  assert.match(calls[2].args[5], /git clone/);
  assert.match(calls[2].args[5], /rm -f "\$loom_git_askpass"/);
  assert.doesNotMatch(calls[2].args[5], /https:\/\/x-access-token:/);
});

test("coder executor rejects repo URLs that can be parsed as git flags", () => {
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      repo: "--upload-pack=sh",
    }),
    /repo is not safe/,
  );
  assert.throws(
    () => createCoderExecutor({
      workspace: "alice-dev",
      remoteCwd: "/home/dev/projects/app",
      repo: "https://git.example/team/app.git\0extra",
    }),
    /repo is not safe/,
  );
});

test("coder executor checks out a task branch after syncing the project", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/projects/app",
    repo: "https://git.example/team/app.git",
    branch: "task/issue-123",
    baseBranch: "origin/main",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.();

  assert.equal(calls.length, 4);
  assert.equal(calls[3].file, "coder");
  assert.deepEqual(calls[3].args, [
    "ssh",
    "alice-dev",
    "--",
    "sh",
    "-lc",
    "cd '/home/dev/projects/app' && (git switch 'task/issue-123' || git switch -c 'task/issue-123' 'origin/main')",
  ]);
});

test("coder executor can prepare an isolated git worktree for a run", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/worktrees/run-1",
    repoCwd: "/home/dev/projects/app",
    repo: "https://git.example/team/app.git",
    branch: "task/run-1",
    baseBranch: "origin/main",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.();

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[1], {
    file: "coder",
    args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/projects' '/home/dev/worktrees'"],
    timeoutMs: 120_000,
  });
  assert.match(calls[2].args[5], /git clone 'https:\/\/git\.example\/team\/app\.git' '\/home\/dev\/projects\/app'/);
  assert.deepEqual(calls[3].args, [
    "ssh",
    "alice-dev",
    "--",
    "sh",
    "-lc",
    "if [ -e '/home/dev/worktrees/run-1/.git' ]; then cd '/home/dev/worktrees/run-1' && git fetch --all --prune && git switch 'task/run-1'; else rm -rf '/home/dev/worktrees/run-1' && cd '/home/dev/projects/app' && git worktree add -B 'task/run-1' '/home/dev/worktrees/run-1' 'origin/main'; fi",
  ]);
});

test("coder executor can use a worktree cwd as a scratch directory without a repo", async () => {
  const calls: Array<{ file: string; args: string[]; timeoutMs: number }> = [];
  const executor = createCoderExecutor({
    workspace: "alice-dev",
    remoteCwd: "/home/dev/worktrees/run-1",
    repoCwd: "/home/dev/projects/app",
    commandRunner: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await executor.prepare?.();

  assert.deepEqual(calls, [
    {
      file: "coder",
      args: ["start", "--yes", "alice-dev"],
      timeoutMs: 120_000,
    },
    {
      file: "coder",
      args: ["ssh", "alice-dev", "--", "sh", "-lc", "mkdir -p '/home/dev/worktrees/run-1'"],
      timeoutMs: 120_000,
    },
  ]);
});
