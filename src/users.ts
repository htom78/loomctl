import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AuthMode } from "./provisioner.js";
import { assertTenantName } from "./tenant.js";

export interface UserRecord {
  name: string;
  authMode: AuthMode;
  /** gateway mode only: env var (on the loomd host) holding this tenant's virtual key. */
  gatewayKeyEnv?: string;
}

const registryPath = () =>
  join(process.env.LOOM_STATE_DIR ?? join(homedir(), ".loomd"), "users.json");

export function listUsers(): UserRecord[] {
  const p = registryPath();
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as UserRecord[]).map((user) => ({
    ...user,
    name: assertTenantName(user.name),
  }));
}

export function getUser(name: string): UserRecord | undefined {
  const safeName = assertTenantName(name);
  return listUsers().find((u) => u.name === safeName);
}

export function addUser(rec: UserRecord): void {
  const safeRecord = { ...rec, name: assertTenantName(rec.name) };
  const users = listUsers().filter((u) => u.name !== safeRecord.name);
  users.push(safeRecord);
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(users, null, 2), "utf8");
}
