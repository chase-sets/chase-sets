import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { eventCorePostgresSchemaSql, type PgTransactionalPool } from "@chase-sets/event-core-postgres";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;
const PROJECTION_STATUS_REFRESH_CONCURRENCY = 4;
const SUBSCRIPTION_APPLICATION_LEDGER_RETAIN_APPLIED_EVENTS = 10_000n;
export const SUBSCRIPTION_CHECKPOINTS_TABLE = "event_subscription_checkpoints";
export const PROJECTION_GROUP_REVISIONS_TABLE = "event_projection_group_revisions";
export const PROJECTION_GROUP_GENERATIONS_TABLE = "event_projection_group_generations";
export const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${label} did not become ready after ${MAX_RETRIES} attempts.`, { cause: error });
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

export async function bootstrapContextDatabase(
  module: Pick<BcApiModule, "contextName" | "schemaSql">,
  pool: PgTransactionalPool,
): Promise<void> {
  await waitForDatabase(pool, module.contextName);
  await pool.query(composeModuleSchemaSql(module));
}

export function composeModuleSchemaSql(module: Pick<BcApiModule, "schemaSql">): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  const moduleSchemaSql = module.schemaSql.trim();
  const normalizedModuleSchemaSql = moduleSchemaSql.startsWith(eventCoreSchemaSql)
    ? moduleSchemaSql.slice(eventCoreSchemaSql.length).trim()
    : moduleSchemaSql;

  return [eventCoreSchemaSql, eventSubscriptionSchemaSql.trim(), normalizedModuleSchemaSql]
    .filter((schemaSql) => schemaSql.length > 0)
    .join("\n\n");
}

export function composeSchemaSql(modules: readonly Pick<BcApiModule, "schemaSql">[]): string {
  const eventCoreSchemaSql = eventCorePostgresSchemaSql.trim();
  let eventCoreIncluded = false;

  const schemaParts = modules
    .map((module) => module.schemaSql.trim())
    .map((schemaSql) => {
      if (!schemaSql.startsWith(eventCoreSchemaSql)) {
        return schemaSql;
      }

      if (!eventCoreIncluded) {
        eventCoreIncluded = true;
        return schemaSql;
      }

      return schemaSql.slice(eventCoreSchemaSql.length).trim();
    })
    .filter((schemaSql) => schemaSql.length > 0);

  return schemaParts.join("\n\n");
}
