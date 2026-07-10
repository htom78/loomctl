import { resolve } from "node:path";
import { execa } from "execa";

import { createLocalExecutor, createProcessSession, safeWorkspaceEnv, type CommandResult, type WorkspaceExecutionOptions, type WorkspaceExecutor, type WorkspaceSession } from "./executor.js";

export type DockerCommandRunner = (file: string, args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<CommandResult>;

export interface DockerExecutorOptions {
  cwd: string;
  home?: string;
  image: string;
  dockerBin?: string;
  network?: string;
  cpus?: string | number;
  memory?: string;
  pidsLimit?: number;
  user?: string;
  tmpfs?: string;
  readOnlyRootfs?: boolean;
  commandRunner?: DockerCommandRunner;
}

interface DockerRunArgsOptions {
  cwd: string;
  mountSource: string;
  homeMountSource?: string;
  image: string;
  network?: string;
  cpus: string;
  memory: string;
  pidsLimit: number;
  user: string;
  tmpfs: string;
  interactive?: boolean;
  command: string;
  env?: Record<string, string>;
}

const DEFAULT_DOCKER_NETWORK = "none";
const DEFAULT_DOCKER_CPUS = "2";
const DEFAULT_DOCKER_MEMORY = "4g";
const DEFAULT_DOCKER_PIDS_LIMIT = 256;
const DEFAULT_DOCKER_TMPFS = "/tmp:rw,noexec,nosuid,size=64m";
const DEFAULT_DOCKER_USER = "1000:1000";
const CONTAINER_HOME = "/home/dev";

export function createDockerExecutor(options: DockerExecutorOptions): WorkspaceExecutor {
  const image = safeDockerImage(options.image);
  const cwd = resolve(options.cwd);
  const network = safeDockerNetwork(options.network);
  const cpus = safeDockerCpus(options.cpus);
  const memory = safeDockerMemory(options.memory);
  const pidsLimit = safeDockerPidsLimit(options.pidsLimit);
  const user = safeDockerUser(options.user ?? currentHostDockerUser());
  const readOnlyRootfs = safeDockerReadOnlyRootfs(options.readOnlyRootfs);
  const tmpfs = safeDockerTmpfs(options.tmpfs);
  const mountSource = safeDockerBindSource(cwd, "workspace");
  const home = options.home ? resolve(options.home) : undefined;
  const homeMountSource = home ? safeDockerBindSource(home, "home") : undefined;
  const local = createLocalExecutor({ cwd });
  const dockerBin = options.dockerBin ?? "docker";
  const commandRunner = options.commandRunner ?? runProcess;

  return {
    inspectPath: local.inspectPath,
    readFile: local.readFile,
    writeFile: local.writeFile,
    deleteFile: local.deleteFile,
    moveFile: local.moveFile,
    describePath: local.describePath,

    describeWorkspace() {
      return {
        kind: "docker",
        cwd,
        containerCwd: "/workspace",
        ...(home ? { home, containerHome: CONTAINER_HOME } : {}),
        image,
        network: network ?? DEFAULT_DOCKER_NETWORK,
        cpus,
        memory,
        pidsLimit,
        user,
        readOnlyRootfs,
      };
    },

    async runCommand(command: string, timeoutMs = 120_000, signal?: AbortSignal, execution?: WorkspaceExecutionOptions): Promise<CommandResult> {
      const env = safeWorkspaceEnv(execution?.env);
      const args = dockerRunArgs({ ...options, cwd, mountSource, homeMountSource, image, network, cpus, memory, pidsLimit, user, tmpfs, command, env });
      return commandRunner(dockerBin, args, timeoutMs, signal);
    },

    startSession(command: string, execution?: WorkspaceExecutionOptions): WorkspaceSession {
      const env = safeWorkspaceEnv(execution?.env);
      const args = dockerRunArgs({ ...options, cwd, mountSource, homeMountSource, image, network, cpus, memory, pidsLimit, user, tmpfs, command, interactive: true, env });
      return createProcessSession(dockerBin, args);
    },
  };
}

function safeDockerImage(value: string): string {
  const image = value.trim();
  if (!image) {
    throw new Error("docker executor image is required");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(image)) {
    throw new Error(`docker image reference is not safe: ${value}`);
  }
  return image;
}

function safeDockerNetwork(value: string | undefined): string | undefined {
  const network = value?.trim();
  if (!network) return undefined;
  if (network === "none") return network;
  if (network === "host" || network === "bridge" || network.startsWith("container:")) {
    throw new Error(`unsafe docker network mode: ${network}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(network)) {
    throw new Error(`docker network must be a named sandbox network: ${network}`);
  }
  return network;
}

function currentHostDockerUser(): string {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid === "number" && uid > 0) {
    return `${uid}:${typeof gid === "number" && gid > 0 ? gid : uid}`;
  }
  return DEFAULT_DOCKER_USER;
}

function safeDockerUser(value: string): string {
  const user = value.trim();
  if (!user || user.includes("\0") || user.startsWith("-") || !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(user)) {
    throw new Error(`docker user is not safe: ${value}`);
  }
  const [name, group] = user.split(":");
  if (name === "0" || name === "root" || group === "0" || group === "root") {
    throw new Error(`docker user must not be root: ${value}`);
  }
  return user;
}

function safeDockerCpus(value: string | number | undefined): string {
  if (value === undefined) return DEFAULT_DOCKER_CPUS;
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) {
    throw new Error(`docker cpus must be a positive number: ${value}`);
  }
  const cpus = Number(raw);
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error(`docker cpus must be a positive number: ${value}`);
  }
  return String(cpus);
}

function safeDockerMemory(value: string | undefined): string {
  if (value === undefined) return DEFAULT_DOCKER_MEMORY;
  const memory = value.trim().toLowerCase();
  if (!/^[1-9][0-9]*[bkmg]?$/.test(memory)) {
    throw new Error(`docker memory must be a Docker memory size like 512m or 4g: ${value}`);
  }
  return memory;
}

function safeDockerPidsLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DOCKER_PIDS_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`docker pids limit must be a positive integer: ${value}`);
  }
  return value;
}

function safeDockerReadOnlyRootfs(value: boolean | undefined): true {
  if (value === false) {
    throw new Error("docker executor requires a read-only rootfs");
  }
  return true;
}

function safeDockerTmpfs(value: string | undefined): string {
  const tmpfs = (value ?? DEFAULT_DOCKER_TMPFS).trim().toLowerCase();
  if (!/^\/tmp:rw,noexec,nosuid,size=[1-9][0-9]*[bkmg]?$/.test(tmpfs)) {
    throw new Error(`docker tmpfs must be a bounded /tmp mount: ${value}`);
  }
  return tmpfs;
}

function safeDockerBindSource(value: string, kind: "workspace" | "home"): string {
  if (value.includes("\0") || value.includes(",") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`docker ${kind} path is not safe to bind mount: ${value}`);
  }
  return value;
}

function dockerRunArgs(options: DockerRunArgsOptions): string[] {
  const args = ["run", "--rm"];
  if (options.interactive) args.push("-i");
  args.push(
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    options.user ?? DEFAULT_DOCKER_USER,
  );
  args.push("--read-only");
  if (options.homeMountSource) args.push("-e", `HOME=${CONTAINER_HOME}`);
  for (const [name, value] of Object.entries(options.env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    args.push("-e", `${name}=${value}`);
  }
  args.push(
    "--tmpfs",
    options.tmpfs,
    "--pids-limit",
    String(options.pidsLimit),
    "--cpus",
    options.cpus,
    "--memory",
    options.memory,
    "--network",
    options.network ?? DEFAULT_DOCKER_NETWORK,
    "--mount",
    `type=bind,source=${options.mountSource},target=/workspace`,
  );
  if (options.homeMountSource) {
    args.push("--mount", `type=bind,source=${options.homeMountSource},target=${CONTAINER_HOME}`);
  }
  args.push("-w", "/workspace", options.image, "sh", "-lc", options.command);
  return args;
}

async function runProcess(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
  const result = await execa(file, args, {
    timeout: timeoutMs,
    cancelSignal: signal,
    reject: false,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
}
