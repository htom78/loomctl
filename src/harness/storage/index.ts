import type { PlatformStateBackend } from "./contracts.js";
import { createFileStateBackend, type FileStateBackendOptions } from "./file.js";
import { createPostgresMetadataStore, type PostgresStateOptions } from "./postgres.js";
import { createRedisCoordinationStore, type RedisCoordinationOptions } from "./redis.js";

export * from "./contracts.js";
export * from "./file.js";
export * from "./postgres.js";
export * from "./redis.js";

export interface PostgresRedisStateBackendOptions {
  postgres: PostgresStateOptions;
  redis: RedisCoordinationOptions;
}

export async function createPostgresRedisStateBackend(
  options: PostgresRedisStateBackendOptions,
): Promise<PlatformStateBackend> {
  const metadata = createPostgresMetadataStore(options.postgres);
  try {
    await metadata.migrate();
    const coordination = await createRedisCoordinationStore(options.redis);
    return {
      kind: "postgres-redis",
      documents: metadata.documents,
      events: metadata.events,
      leases: coordination.leases,
      capacityLeases: coordination.capacityLeases,
      queues: coordination.queues,
      close: async () => {
        await Promise.all([metadata.close(), coordination.close()]);
      },
    };
  } catch (error) {
    await metadata.close().catch(() => undefined);
    throw error;
  }
}

export function createLocalFileStateBackend(options: FileStateBackendOptions): PlatformStateBackend {
  return createFileStateBackend(options);
}
