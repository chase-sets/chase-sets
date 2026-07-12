import { randomUUID } from "node:crypto";
import { createPgPool } from "./pool";
import { eventCorePostgresSchemaSql } from "./schema";
import { assertSqlIdentifier } from "./sql-identifier";
import type { PgTransactionalPool } from "./types";

type EndablePool = PgTransactionalPool & Readonly<{ end: () => Promise<void> }>;

export type IsolatedPostgresTestSchema = Readonly<{
  schemaName: string;
  pool: PgTransactionalPool;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}>;

export async function createIsolatedPostgresTestSchema(
  adminDatabaseUrl: string,
  scope: string,
): Promise<IsolatedPostgresTestSchema> {
  const schemaName = createSchemaName(scope);
  const adminPool = createPgPool(adminDatabaseUrl) as EndablePool;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
  } finally {
    await adminPool.end();
  }

  const pool = createPgPool(withSearchPath(adminDatabaseUrl, schemaName)) as EndablePool;

  try {
    await pool.query(eventCorePostgresSchemaSql);
  } catch (error) {
    await pool.end().catch(() => undefined);
    await dropSchema(adminDatabaseUrl, schemaName);
    throw error;
  }

  return {
    schemaName,
    pool,
    reset: () => resetEventCorePostgresSchema(pool),
    close: async () => {
      await pool.end();
      await dropSchema(adminDatabaseUrl, schemaName);
    },
  };
}

function createSchemaName(scope: string): string {
  const normalizedScope = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

  return assertSqlIdentifier(`m61_i2850_${normalizedScope}_${suffix}`);
}

function withSearchPath(databaseUrl: string, schemaName: string): string {
  const url = new URL(databaseUrl);

  url.searchParams.set("options", `-c search_path=${schemaName}`);
  return url.toString();
}

async function resetEventCorePostgresSchema(pool: PgTransactionalPool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      event_projection_blocked_streams,
      event_projection_poison_events,
      event_projection_checkpoints,
      event_store_aggregate_snapshots,
      event_store_events,
      event_store_streams
    RESTART IDENTITY CASCADE
  `);
}

async function dropSchema(adminDatabaseUrl: string, schemaName: string): Promise<void> {
  const adminPool = createPgPool(adminDatabaseUrl) as EndablePool;

  try {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  } finally {
    await adminPool.end();
  }
}
