import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformBackup, decodePlatformBackupKey } from "../src/harness/disaster-recovery.js";

test("backup encryption keys must be exactly 32 bytes of base64 data", () => {
  const encoded = Buffer.alloc(32, 3).toString("base64");
  assert.deepEqual(decodePlatformBackupKey(encoded), Buffer.alloc(32, 3));
  assert.throws(() => decodePlatformBackupKey("not base64"), /must be base64/);
  assert.throws(() => decodePlatformBackupKey(Buffer.alloc(31).toString("base64")), /32 bytes/);
});

test("platform backup requires quiescence before filesystem or dependency access", async () => {
  await assert.rejects(() => createPlatformBackup({
    outDir: "/path/that/must/not/be-created",
    workspaceRoot: "/path/that/must/not/be-read",
    postgresUrl: "postgres://user:secret@invalid/database",
    redisUrl: "redis://invalid:6379",
    encryptionKey: Buffer.alloc(32),
    quiesced: false,
  }), /operator-confirmed quiesced harness/);
});
