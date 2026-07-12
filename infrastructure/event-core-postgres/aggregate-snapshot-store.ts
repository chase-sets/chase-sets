import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type {
  AggregateSnapshotStore,
  AggregateSnapshotToStore,
  StoredAggregateSnapshot,
} from "@chase-sets/event-core/aggregate-snapshot-store";
import { observeEventStoreOperation } from "@chase-sets/observability";
import type { PgQueryable } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

type DbAggregateSnapshotRow = Readonly<{
  stream_id: string;
  stream_version: number | string;
  schema_version: number | string;
  state: unknown;
  updated_at: Date | string;
}>;

export type PostgresAggregateSnapshotStoreConfig = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => IsoUtcTimestamp;
}>;

const DEFAULT_AGGREGATE_SNAPSHOTS_TABLE = "event_store_aggregate_snapshots";

/**
 * Postgres-backed `AggregateSnapshotStore`. The table is a pure
 * load-time cache -- `event_store_events` stays canonical -- so this
 * implementation is intentionally simple: one row per stream, replaced in
 * place, never written inside the same transaction as an event append (the
 * repository calls `save` write-behind, after a command has already
 * committed; see `contracts/event-core/aggregate-repository-internal.ts`).
 */
export function createPostgresAggregateSnapshotStore<State>(
  config: PostgresAggregateSnapshotStoreConfig,
): AggregateSnapshotStore<State> {
  const tableName = assertSqlIdentifier(config.tableName ?? DEFAULT_AGGREGATE_SNAPSHOTS_TABLE);
  const now = config.now ?? nowIsoUtcTimestamp;

  const loadLatestSql = `
    SELECT stream_id, stream_version, schema_version, state, updated_at
    FROM ${tableName}
    WHERE stream_id = $1
  `;

  // "last write loses" against a newer stored snapshot: a superseded
  // write-behind save (e.g. an in-flight request that lost a race with a
  // later command on the same stream) must never regress the cached version
  // backwards. Snapshots are a pure cache, so this is safe either way.
  const upsertSql = `
    INSERT INTO ${tableName} (stream_id, stream_version, schema_version, state, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (stream_id) DO UPDATE SET
      stream_version = EXCLUDED.stream_version,
      schema_version = EXCLUDED.schema_version,
      state = EXCLUDED.state,
      updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.stream_version > ${tableName}.stream_version
  `;

  return {
    loadLatest: async (streamId) =>
      observeEventStoreOperation("aggregate_snapshot_load", {}, async () => {
        const result = await config.db.query<DbAggregateSnapshotRow>(loadLatestSql, [streamId]);
        const row = result.rows[0];
        return row ? mapAggregateSnapshotRow<State>(row) : null;
      }),

    save: async (snapshot: AggregateSnapshotToStore<State>) =>
      observeEventStoreOperation("aggregate_snapshot_save", {}, async () => {
        await config.db.query(upsertSql, [
          snapshot.streamId,
          snapshot.streamVersion,
          snapshot.schemaVersion,
          snapshot.state,
          now(),
        ]);
      }),
  };
}

function mapAggregateSnapshotRow<State>(row: DbAggregateSnapshotRow): StoredAggregateSnapshot<State> {
  return {
    streamId: row.stream_id,
    streamVersion: toNumber(row.stream_version, "stream_version"),
    schemaVersion: toNumber(row.schema_version, "schema_version"),
    state: row.state as State,
    updatedAt: toIsoUtcTimestamp(row.updated_at),
  };
}

function toNumber(value: number | string, fieldName: string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not convert aggregate snapshot "${fieldName}" to number.`);
  }

  return parsed;
}

function toIsoUtcTimestamp(value: Date | string): IsoUtcTimestamp {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid aggregate snapshot timestamp value "${String(value)}".`);
  }

  return date.toISOString() as IsoUtcTimestamp;
}
