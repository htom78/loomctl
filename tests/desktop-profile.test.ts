import assert from "node:assert/strict";
import test from "node:test";
import { readProfiles, writeProfiles, type KeyValueStorage, type Profile } from "../apps/desktop/src/profile-store.js";

class TestStorage implements KeyValueStorage {
  values = new Map<string, string>();
  get value(): string { return [...this.values.values()].at(-1) ?? ""; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("desktop profiles persist only explicit non-secret connection metadata", () => {
  const storage = new TestStorage();
  const profile: Profile & { token?: string; password?: string } = {
    id: "profile-12345678",
    name: "Enterprise Loom",
    baseUrl: "https://loom.example.com",
    tenant: "alice",
    authMode: "oidc",
    caPem: "-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----",
    oidcIssuer: "https://identity.example.com",
    oidcClientId: "loom-desktop",
    token: "must-not-persist",
    password: "must-not-persist",
  };

  writeProfiles([profile], storage);
  assert.equal(storage.value.includes("must-not-persist"), false);
  assert.equal(storage.value.includes("token"), false);
  assert.equal(storage.value.includes("password"), false);
  assert.deepEqual(readProfiles(storage)[0], {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    tenant: profile.tenant,
    authMode: "oidc",
    caPem: profile.caPem,
    oidcIssuer: profile.oidcIssuer,
    oidcClientId: profile.oidcClientId,
    oidcAudience: undefined,
    oidcScopes: undefined,
    crashReporting: false,
    crashEndpoint: undefined,
  });
});

test("desktop profiles migrate v1 connection metadata without credentials", () => {
  const storage = new TestStorage();
  storage.setItem("loom.desktop.profiles.v1", JSON.stringify([{
    id: "legacy-profile-1234",
    name: "Legacy Loom",
    baseUrl: "https://loom.example.com",
    tenant: "alice",
  }]));
  assert.equal(readProfiles(storage)[0]?.authMode, "token");
});
