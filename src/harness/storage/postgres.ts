import { Pool, type PoolConfig, type QueryResultRow } from "pg";

import {
  StateConflictError,
  assertStateName,
  type DocumentStore,
  type EventStore,
  type PutDocumentOptions,
  type StoredDocument,
  type StoredEvent,
} from "./contracts.js";

export interface PostgresStateOptions {
  connectionString?: string;
  pool?: Pool;
  schema?: string;
  poolConfig?: PoolConfig;
}

export interface PostgresMetadataStore {
  kind: "postgres";
  pool: Pool;
  documents: DocumentStore;
  events: EventStore;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresMetadataStore(options: PostgresStateOptions = {}): PostgresMetadataStore {
  const pool = options.pool ?? new Pool({
    ...options.poolConfig,
    ...(options.connectionString ? { connectionString: options.connectionString } : {}),
  });
  const ownsPool = !options.pool;
  const schema = options.schema ?? "loom";
  postgresIdentifier(schema);
  return {
    kind: "postgres",
    pool,
    documents: createPostgresDocumentStore(pool, schema),
    events: createPostgresEventStore(pool, schema),
    migrate: () => migratePostgresState(pool, schema),
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}

export async function migratePostgresState(pool: Pool, schema = "loom"): Promise<void> {
  const safeSchema = postgresIdentifier(schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`loom-state-migration:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${safeSchema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${safeSchema}.documents (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        version BIGINT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, key)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${safeSchema}.events (
        stream TEXT NOT NULL,
        seq BIGINT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        value JSONB NOT NULL,
        PRIMARY KEY (stream, seq)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS loom_events_stream_ts_idx ON ${safeSchema}.events (stream, ts)`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresDocumentStore(pool: Pool, schema = "loom"): DocumentStore {
  const table = `${postgresIdentifier(schema)}.documents`;
  return {
    async get<T>(namespace: string, key: string): Promise<StoredDocument<T> | undefined> {
      validateDocumentKey(namespace, key);
      const result = await pool.query(`
        SELECT namespace, key, version, value, updated_at
        FROM ${table}
        WHERE namespace = $1 AND key = $2
      `, [namespace, key]);
      return result.rows[0] ? documentFromRow<T>(result.rows[0]) : undefined;
    },
    async put<T>(namespace: string, key: string, value: T, options: PutDocumentOptions = {}): Promise<StoredDocument<T>> {
      validateDocumentKey(namespace, key);
      const expected = options.expectedVersion;
      if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
        throw new Error("expectedVersion must be a non-negative integer");
      }
      try {
        if (expected === 0) {
          const inserted = await pool.query(`
            INSERT INTO ${table} (namespace, key, version, value)
            VALUES ($1, $2, 1, $3::jsonb)
            RETURNING namespace, key, version, value, updated_at
          `, [namespace, key, JSON.stringify(value)]);
          return documentFromRow<T>(inserted.rows[0]);
        }
        if (expected !== undefined) {
          const updated = await pool.query(`
            UPDATE ${table}
            SET version = version + 1, value = $3::jsonb, updated_at = NOW()
            WHERE namespace = $1 AND key = $2 AND version = $4
            RETURNING namespace, key, version, value, updated_at
          `, [namespace, key, JSON.stringify(value), expected]);
          if (!updated.rows[0]) throw documentConflict(namespace, key, expected);
          return documentFromRow<T>(updated.rows[0]);
        }
        const upserted = await pool.query(`
          INSERT INTO ${table} (namespace, key, version, value)
          VALUES ($1, $2, 1, $3::jsonb)
          ON CONFLICT (namespace, key) DO UPDATE
          SET version = ${table}.version + 1, value = EXCLUDED.value, updated_at = NOW()
          RETURNING namespace, key, version, value, updated_at
        `, [namespace, key, JSON.stringify(value)]);
        return documentFromRow<T>(upserted.rows[0]);
      } catch (error) {
        if (postgresErrorCode(error) === "23505") throw documentConflict(namespace, key, expected ?? 0);
        throw error;
      }
    },
    async delete(namespace: string, key: string, options: PutDocumentOptions = {}): Promise<boolean> {
      validateDocumentKey(namespace, key);
      const expected = options.expectedVersion;
      const result = expected === undefined
        ? await pool.query(`DELETE FROM ${table} WHERE namespace = $1 AND key = $2`, [namespace, key])
        : await pool.query(`DELETE FROM ${table} WHERE namespace = $1 AND key = $2 AND version = $3`, [namespace, key, expected]);
      if (expected !== undefined && result.rowCount === 0) {
        const current = await pool.query(`SELECT version FROM ${table} WHERE namespace = $1 AND key = $2`, [namespace, key]);
        if (current.rows[0] || expected !== 0) throw documentConflict(namespace, key, expected);
      }
      return (result.rowCount ?? 0) > 0;
    },
    async list<T>(namespace: string, prefix = ""): Promise<Array<StoredDocument<T>>> {
      assertStateName(namespace, "namespace");
      if (prefix) assertStateName(prefix, "prefix");
      const result = await pool.query(`
        SELECT namespace, key, version, value, updated_at
        FROM ${table}
        WHERE namespace = $1 AND key LIKE $2 ESCAPE '\\'
        ORDER BY key ASC
      `, [namespace, `${escapeLike(prefix)}%`]);
      return result.rows.map((row) => documentFromRow<T>(row));
    },
  };
}

export function createPostgresEventStore(pool: Pool, schema = "loom"): EventStore {
  const table = `${postgresIdentifier(schema)}.events`;
  return {
    async append<T>(stream: string, value: T): Promise<StoredEvent<T>> {
      assertStateName(stream, "event stream");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [stream]);
        const inserted = await client.query(`
          INSERT INTO ${table} (stream, seq, value)
          SELECT $1, COALESCE(MAX(seq), 0) + 1, $2::jsonb
          FROM ${table}
          WHERE stream = $1
          RETURNING stream, seq, ts, value
        `, [stream, JSON.stringify(value)]);
        await client.query("COMMIT");
        return eventFromRow<T>(inserted.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async read<T>(stream: string, afterSeq = 0, limit = 10_000): Promise<Array<StoredEvent<T>>> {
      assertStateName(stream, "event stream");
      if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error("afterSeq must be a non-negative integer");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("limit must be between 1 and 100000");
      const result = await pool.query(`
        SELECT stream, seq, ts, value
        FROM ${table}
        WHERE stream = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3
      `, [stream, afterSeq, limit]);
      return result.rows.map((row) => eventFromRow<T>(row));
    },
  };
}

function documentFromRow<T>(row: QueryResultRow): StoredDocument<T> {
  return {
    namespace: String(row.namespace),
    key: String(row.key),
    version: Number(row.version),
    value: row.value as T,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function eventFromRow<T>(row: QueryResultRow): StoredEvent<T> {
  return {
    stream: String(row.stream),
    seq: Number(row.seq),
    ts: new Date(row.ts).toISOString(),
    value: row.value as T,
  };
}

function validateDocumentKey(namespace: string, key: string): void {
  assertStateName(namespace, "namespace");
  assertStateName(key, "document key");
}

function documentConflict(namespace: string, key: string, expected: number): StateConflictError {
  return new StateConflictError(`document version conflict: ${namespace}/${key}; expected ${expected}`);
}

function postgresIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error("PostgreSQL schema must be a safe identifier");
  return `"${value}"`;
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
