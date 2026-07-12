import assert from "node:assert/strict";
import test from "node:test";
import { BoundedMetadataCache, type CacheStorage } from "../apps/desktop/src/cache.js";

class TestStorage implements CacheStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("desktop metadata cache is bounded, expiring, and rejects secret-shaped data", () => {
  const storage = new TestStorage();
  const cache = new BoundedMetadataCache(storage, 1_000, 2, 100);

  assert.equal(cache.set("one", { project: "one" }, 1_000), true);
  assert.equal(cache.set("two", { project: "two" }, 1_001), true);
  assert.equal(cache.set("three", { project: "three" }, 1_002), true);
  assert.equal(cache.get("one", 1_010), undefined);
  assert.deepEqual(cache.get<{ project: string }>("three", 1_010)?.value, { project: "three" });
  assert.equal(cache.get("two", 1_102), undefined);

  assert.equal(cache.set("unsafe", { nested: { authorization: "Bearer secret" } }, 1_003), false);
  assert.equal(cache.get("unsafe", 1_004), undefined);

  const tiny = new BoundedMetadataCache(new TestStorage(), 60, 10, 100);
  assert.equal(tiny.set("too-large", { value: "x".repeat(200) }, 1_000), false);
});
