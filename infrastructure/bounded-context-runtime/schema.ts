import type { BcApiModule, BcSchemaMigration } from "@chase-sets/bounded-context-module";
import {
  eventCorePostgresSchemaSql,
  type PgPoolClient,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";

const DATABASE_RETRY_DELAY_MS = 1_000;
const DATABASE_MAX_RETRIES = 30;
const SCHEMA_BOOTSTRAP_LOCK_INITIAL_RETRY_DELAY_MS = 500;
const SCHEMA_BOOTSTRAP_LOCK_MAX_RETRY_DELAY_MS = 5_000;
export const SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS = 600_000;
export const SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_SETTING = "5s";
const PROJECTION_STATUS_REFRESH_CONCURRENCY = 4;
const SUBSCRIPTION_APPLICATION_LEDGER_RETAIN_APPLIED_EVENTS = 10_000n;
export const SUBSCRIPTION_CHECKPOINTS_TABLE = "event_subscription_checkpoints";
export const PROJECTION_GROUP_REVISIONS_TABLE = "event_projection_group_revisions";
export const PROJECTION_GROUP_GENERATIONS_TABLE = "event_projection_group_generations";
export const SCHEMA_MIGRATIONS_TABLE = "bounded_context_schema_migrations";
export const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_BOOTSTRAP_ADVISORY_LOCK_ID = "739134880509551001";

const eventStoreEventsBackfillSql = `UPDATE event_store_events
SET stream_context_name = split_part(stream_id, '.', 1),
    stream_category = regexp_replace(stream_id, '-[^-]*$', '')
WHERE stream_context_name IS NULL
   OR stream_category IS NULL;`;

const eventStoreEventsContextNotNullSql = `ALTER TABLE event_store_events
  ALTER COLUMN stream_context_name SET NOT NULL,
  ALTER COLUMN stream_category SET NOT NULL;`;

const eventStoreEventsIndexStatements = [
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_stream_idx
  ON event_store_events (stream_id, stream_version ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_global_idx
  ON event_store_events (global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_tenant_global_idx
  ON event_store_events (tenant_id, global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_type_idx
  ON event_store_events (event_type);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_type_global_idx
  ON event_store_events (event_type, global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_tenant_type_global_idx
  ON event_store_events (tenant_id, event_type, global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_stream_prefix_global_idx
  ON event_store_events (stream_id text_pattern_ops, global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_context_category_type_global_idx
  ON event_store_events (stream_context_name, stream_category, event_type, global_position ASC);`,
  },
  {
    boot: `CREATE INDEX IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);`,
    concurrent: `CREATE INDEX CONCURRENTLY IF NOT EXISTS event_store_events_context_category_global_idx
  ON event_store_events (stream_context_name, stream_category, global_position ASC);`,
  },
] as const;

const contextBackfillMigration = {
  migrationId: "20260628_event_store_context_columns_backfill",
  description: "Backfill event-store context/category columns and enforce NOT NULL.",
  statements: [eventStoreEventsBackfillSql, eventStoreEventsContextNotNullSql],
};

const concurrentEventStoreIndexesMigration = {
  migrationId: "20260628_event_store_events_concurrent_indexes",
  description: "Create event-store event indexes concurrently outside boot-time schema SQL.",
  statements: eventStoreEventsIndexStatements.map((statement) => statement.concurrent),
};

const contextSchemaMigrations = [contextBackfillMigration, concurrentEventStoreIndexesMigration] as const;
const eventCoreBootstrapSchemaSql = removeEventCoreMigrationStatements(eventCorePostgresSchemaSql.trim());

export const eventSubscriptionSchemaSql = `CREATE TABLE IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE} (
  checkpoint_key text PRIMARY KEY,
  projection_name text NOT NULL,
  source_context_name text NOT NULL,
  subscription_version integer NOT NULL CHECK (subscription_version >= 1),
  last_global_position bigint NOT NULL CHECK (last_global_position >= 0),
  lease_owner_id text NULL,
  lease_fencing_token bigint NULL,
  updated_at timestamptz NOT NULL
);

ALTER TABLE ${SUBSCRIPTION_CHECKPOINTS_TABLE}
  ADD COLUMN IF NOT EXISTS lease_owner_id text NULL,
  ADD COLUMN IF NOT EXISTS lease_fencing_token bigint NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ${SUBSCRIPTION_CHECKPOINTS_TABLE}_projection_source_version_idx
  ON ${SUBSCRIPTION_CHECKPOINTS_TABLE} (projection_name, source_context_name, subscription_version);

CREATE TABLE IF NOT EXISTS ${PROJECTION_GROUP_REVISIONS_TABLE} (
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  projection_revision integer NOT NULL CHECK (projection_revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_context_name, projection_name)
);

CREATE TABLE IF NOT EXISTS ${PROJECTION_GROUP_GENERATIONS_TABLE} (
  target_context_name text NOT NULL,
  projection_name text NOT NULL,
  active_generation bigint NOT NULL DEFAULT 1 CHECK (active_generation >= 1),
  rebuilding_generation bigint NULL CHECK (rebuilding_generation IS NULL OR rebuilding_generation > active_generation),
  previous_generation bigint NULL CHECK (previous_generation IS NULL OR previous_generation >= 1),
  previous_generation_retain_until timestamptz NULL,
  state text NOT NULL CHECK (state IN ('active', 'rebuilding', 'failed')),
  operation_id text NULL,
  started_at timestamptz NULL,
  cutover_at timestamptz NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (target_context_name, projection_name)
);

CREATE INDEX IF NOT EXISTS ${PROJECTION_GROUP_GENERATIONS_TABLE}_state_idx
  ON ${PROJECTION_GROUP_GENERATIONS_TABLE} (state, updated_at DESC);

ALTER TABLE ${PROJECTION_GROUP_GENERATIONS_TABLE}
  ADD COLUMN IF NOT EXISTS previous_generation bigint NULL CHECK (previous_generation IS NULL OR previous_generation >= 1),
  ADD COLUMN IF NOT EXISTS previous_generation_retain_until timestamptz NULL;

CREATE TABLE IF NOT EXISTS event_subscription_applications (
  projection_key text NOT NULL,
  event_id text NOT NULL,
  stream_id text NOT NULL,
  stream_version bigint NOT NULL CHECK (stream_version > 0),
  global_position bigint NOT NULL CHECK (global_position >= 0),
  event_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'applied', 'poison', 'transient')),
  error_message text NULL,
  lease_owner_id text NULL,
  lease_fencing_token bigint NULL,
  started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (projection_key, event_id)
);

ALTER TABLE event_subscription_applications
  ADD COLUMN IF NOT EXISTS lease_owner_id text NULL,
  ADD COLUMN IF NOT EXISTS lease_fencing_token bigint NULL;

CREATE INDEX IF NOT EXISTS event_subscription_applications_projection_position_idx
  ON event_subscription_applications (projection_key, global_position);

CREATE INDEX IF NOT EXISTS event_subscription_applications_projection_status_updated_idx
  ON event_subscription_applications (projection_key, status, updated_at);

CREATE INDEX IF NOT EXISTS event_subscription_applications_status_position_idx
  ON event_subscription_applications (status, global_position);`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(
  pool: { query: (sql: string) => Promise<unknown> },
  label = "Database",
): Promise<void> {
  for (let attempt = 1; attempt <= DATABASE_MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === DATABASE_MAX_RETRIES) {
        throw new Error(`${label} did not become ready after ${DATABASE_MAX_RETRIES} attempts.`, { cause: error });
      }

      await sleep(DATABASE_RETRY_DELAY_MS);
    }
  }
}

export async function bootstrapContextDatabase(
  module: Pick<BcApiModule, "contextName" | "schemaSql" | "schemaMigrations">,
  pool: PgTransactionalPool,
): Promise<void> {
  await waitForDatabase(pool, module.contextName);
  await applyContextSchema(pool, composeModuleSchemaSql(module), module.schemaMigrations ?? []);
}

export function composeModuleSchemaSql(module: Pick<BcApiModule, "schemaSql">): string {
  const eventCoreSchemaSql = eventCoreBootstrapSchemaSql.trim();
  const rawEventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  const moduleSchemaSql = module.schemaSql.trim();
  const normalizedModuleSchemaSql = moduleSchemaSql.startsWith(rawEventCoreSchemaSql)
    ? moduleSchemaSql.slice(rawEventCoreSchemaSql.length).trim()
    : moduleSchemaSql;

  return [eventCoreSchemaSql, eventSubscriptionSchemaSql.trim(), normalizedModuleSchemaSql]
    .filter((schemaSql) => schemaSql.length > 0)
    .join("\n\n");
}

export function composeSchemaSql(modules: readonly Pick<BcApiModule, "schemaSql">[]): string {
  const eventCoreSchemaSql = eventCoreBootstrapSchemaSql.trim();
  const rawEventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  let eventCoreIncluded = false;

  const schemaParts = modules
    .map((module) => module.schemaSql.trim())
    .map((schemaSql) => {
      if (!schemaSql.startsWith(rawEventCoreSchemaSql)) {
        return schemaSql;
      }

      if (!eventCoreIncluded) {
        eventCoreIncluded = true;
        return [eventCoreSchemaSql, schemaSql.slice(rawEventCoreSchemaSql.length).trim()]
          .filter((schemaPart) => schemaPart.length > 0)
          .join("\n\n");
      }

      return schemaSql.slice(rawEventCoreSchemaSql.length).trim();
    })
    .filter((schemaSql) => schemaSql.length > 0);

  return schemaParts.join("\n\n");
}

export async function applyContextSchema(
  pool: PgTransactionalPool,
  schemaSql: string,
  moduleSchemaMigrations: readonly BcSchemaMigration[] = [],
): Promise<void> {
  const client = await pool.connect();
  let operationError: unknown;
  let cleanupError: unknown;
  let lockAcquired = false;

  try {
    await acquireSchemaBootstrapLock(client);
    lockAcquired = true;
    await client.query(`SET lock_timeout TO '${SCHEMA_BOOTSTRAP_LOCK_TIMEOUT_SETTING}'`);
    await client.query(createSchemaMigrationsTableSql());
    await client.query(schemaSql);
    for (const migration of [...contextSchemaMigrations, ...moduleSchemaMigrations]) {
      await applySchemaMigration(client, migration);
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (lockAcquired) {
      await client.query("RESET lock_timeout").catch((error: unknown) => {
        cleanupError ??= error;
      });
      await client
        .query("SELECT pg_advisory_unlock($1::bigint)", [SCHEMA_BOOTSTRAP_ADVISORY_LOCK_ID])
        .catch((error: unknown) => {
          cleanupError ??= error;
        });
    }
    client.release(operationError ?? cleanupError);
  }

  if (operationError) {
    throw operationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
}

async function acquireSchemaBootstrapLock(client: PgPoolClient): Promise<void> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS;
  let attempts = 0;
  let retryDelayMs = SCHEMA_BOOTSTRAP_LOCK_INITIAL_RETRY_DELAY_MS;

  while (Date.now() < deadlineAt) {
    attempts += 1;
    const result = await client.query<Readonly<{ acquired: boolean }>>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [SCHEMA_BOOTSTRAP_ADVISORY_LOCK_ID],
    );
    if (result.rows[0]?.acquired === true) {
      return;
    }

    const remainingBudgetMs = deadlineAt - Date.now();
    if (remainingBudgetMs <= 0) {
      break;
    }

    await sleep(Math.min(retryDelayMs, remainingBudgetMs));
    retryDelayMs = Math.min(retryDelayMs * 2, SCHEMA_BOOTSTRAP_LOCK_MAX_RETRY_DELAY_MS);
  }

  const elapsedMs = Date.now() - startedAt;
  throw new Error(
    `Schema bootstrap lock was not acquired within ${SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS}ms ` +
      `after ${attempts} attempts (elapsed ${elapsedMs}ms, advisory lock ${SCHEMA_BOOTSTRAP_ADVISORY_LOCK_ID}). ` +
      "Another deploy may still be applying schema changes; retry after the older bootstrap finishes or inspect active database sessions if this persists.",
  );
}

function createSchemaMigrationsTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  migration_id text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;
}

async function applySchemaMigration(
  client: PgPoolClient,
  migration: Readonly<{
    migrationId: string;
    description: string;
    statements: readonly string[];
  }>,
): Promise<void> {
  const existing = await client.query(`SELECT 1 FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE migration_id = $1`, [
    migration.migrationId,
  ]);
  if (existing.rows.length > 0) {
    return;
  }

  for (const statement of migration.statements) {
    await client.query(statement);
  }

  await client.query(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (migration_id, description, applied_at)
     VALUES ($1, $2, now())`,
    [migration.migrationId, migration.description],
  );
}

function removeEventCoreMigrationStatements(schemaSql: string): string {
  let result = schemaSql;
  for (const statement of [
    eventStoreEventsBackfillSql,
    eventStoreEventsContextNotNullSql,
    ...eventStoreEventsIndexStatements.map((statement) => statement.boot),
  ]) {
    result = result.replace(statement, "");
  }

  return result
    .split("\n")
    .filter((line, index, lines) => line.trim().length > 0 || lines[index - 1]?.trim().length > 0)
    .join("\n")
    .trim();
}
