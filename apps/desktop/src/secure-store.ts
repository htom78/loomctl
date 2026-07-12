import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./desktop-runtime";

const memory = new Map<string, string>();

export async function saveToken(profileId: string, token: string): Promise<void> {
  if (isTauri()) await invoke("save_secret", { profileId, token });
  else memory.set(profileId, token);
}

export async function loadToken(profileId: string): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("load_secret", { profileId });
  return memory.get(profileId) ?? null;
}

export async function deleteToken(profileId: string): Promise<void> {
  if (isTauri()) await invoke("delete_secret", { profileId });
  else memory.delete(profileId);
}
