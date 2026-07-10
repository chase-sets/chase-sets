import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type {
  ProjectionBlockedStream,
  ProjectionBlockedStreamState,
  ProjectionCheckpointStore,
  ProjectionFailureKind,
  ProjectionPoisonEvent,
  ProjectionPoisonState,
} from "@chase-sets/event-core/projector";
import type { GlobalPosition, StreamVersion } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION, globalPositionFromBigInt, parseGlobalPosition } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

type DbCheckpointRow = Readonly<{
  last_global_position: string | number | bigint;
}>;

type DbBlockedStreamRow = Readonly<{
  projection_key: string;
  stream_id: string;
  first_blocked_global_position: string | number | bigint;
  first_blocked_stream_version: string | number | bigint;
  last_seen_global_position: string | number | bigint;
  deferred_event_count: string | number;
  state: string;
}>;

type DbProjectionErrorSummaryRow = Readonly<{
  blocked_stream_count: string | number | bigint;
  poison_event_count: string | number | bigint;
}>;

type DbProjectionPoisonEventRow = Readonly<{
  projection_key: string;
  event_id: string;
  projection_name: string;
  projection_kind: string;
  target_context_name: string | null;
  source_context_name: string | null;
  projection_revision: string | number | bigint | null;
  subscription_version: string | number | bigint | null;
  stream_id: string;
  stream_version: string | number | bigint;
  event_type: string;
  global_position: string | number | bigint;
  failure_kind: string;
  error_message: string | null;
  error_stack: string | null;
  state: string;
  retry_count: string | number | bigint;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  resolved_at: Date | string | null;
}>;

export type PostgresProjectionStoreConfig = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => IsoUtcTimestamp;
}>;

const DEFAULT_CHECKPOINTS_TABLE = "event_projection_checkpoints";
export const PROJECTION_RECOVERY_MARKERS_TABLE = "event_projection_recovery_markers";
const POISON_EVENTS_TABLE = "event_projection_poison_events";
const BLOCKED_STREAMS_TABLE = "event_projection_blocked_streams";

export function createPostgresProjectionStore(config: PostgresProjectionStoreConfig): ProjectionCheckpointStore {
  const tableName = assertSqlIdentifier(config.tableName ?? DEFAULT_CHECKPOINTS_TABLE);
  const poisonEventsTable = assertSqlIdentifier(POISON_EVENTS_TABLE);
  const blockedStreamsTable = assertSqlIdentifier(BLOCKED_STREAMS_TABLE);
  const now = config.now ?? nowIsoUtcTimestamp;

  const readCheckpointSql = `
    SELECT checkpoint.last_global_position
    FROM ${tableName} AS checkpoint
    INNER JOIN ${PROJECTION_RECOVERY_MARKERS_TABLE} AS recovery
      ON recovery.projection_kind = 'projector'
     AND recovery.projection_key = checkpoint.projector_name
     AND recovery.last_global_position >= checkpoint.last_global_position
    WHERE checkpoint.projector_name = $1
  `;

  const upsertCheckpointSql = `
    WITH saved_checkpoint AS (
      INSERT INTO ${tableName} (projector_name, last_global_position, updated_at)
      VALUES ($1, $2::bigint, $3)
      ON CONFLICT (projector_name)
      DO UPDATE SET
        last_global_position = CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM ${PROJECTION_RECOVERY_MARKERS_TABLE} AS recovery
            WHERE recovery.projection_kind = 'projector'
              AND recovery.projection_key = ${tableName}.projector_name
              AND recovery.last_global_position >= ${tableName}.last_global_position
          ) THEN EXCLUDED.last_global_position
          ELSE GREATEST(${tableName}.last_global_position, EXCLUDED.last_global_position)
        END,
        updated_at = EXCLUDED.updated_at
      RETURNING projector_name, last_global_position, updated_at
    )
    INSERT INTO ${PROJECTION_RECOVERY_MARKERS_TABLE} (
      projection_kind,
      projection_key,
      last_global_position,
      updated_at
    )
    SELECT 'projector', projector_name, last_global_position, updated_at
    FROM saved_checkpoint
    ON CONFLICT (projection_kind, projection_key)
    DO UPDATE SET
      last_global_position = GREATEST(
        ${PROJECTION_RECOVERY_MARKERS_TABLE}.last_global_position,
        EXCLUDED.last_global_position
      ),
      updated_at = EXCLUDED.updated_at
  `;

  const readBlockedStreamSql = `
    SELECT
      projection_key,
      stream_id,
      first_blocked_global_position,
      first_blocked_stream_version,
      last_seen_global_position,
      deferred_event_count,
      state
    FROM ${blockedStreamsTable}
    WHERE projection_key = $1
      AND stream_id = $2
      AND state IN ('blocked', 'retrying')
  `;

  const listBlockedStreamsSql = `
    SELECT
      projection_key,
      stream_id,
      first_blocked_global_position,
      first_blocked_stream_version,
      last_seen_global_position,
      deferred_event_count,
      state
    FROM ${blockedStreamsTable}
    WHERE projection_key = $1
      AND state IN ('blocked', 'retrying')
    ORDER BY first_blocked_global_position ASC, stream_id ASC
  `;

  const upsertPoisonEventSql = `
    INSERT INTO ${poisonEventsTable} (
      projection_key,
      event_id,
      projection_name,
      projection_kind,
      target_context_name,
      source_context_name,
      projection_revision,
      subscription_version,
      stream_id,
      stream_version,
      event_type,
      global_position,
      failure_kind,
      error_message,
      error_stack,
      state,
      retry_count,
      first_seen_at,
      last_seen_at,
      resolved_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12::bigint, $13, $14, $15, 'blocked', 0, $16, $16, NULL
    )
    ON CONFLICT (projection_key, event_id)
    DO UPDATE SET
      projection_name = EXCLUDED.projection_name,
      projection_kind = EXCLUDED.projection_kind,
      target_context_name = EXCLUDED.target_context_name,
      source_context_name = EXCLUDED.source_context_name,
      projection_revision = EXCLUDED.projection_revision,
      subscription_version = EXCLUDED.subscription_version,
      stream_id = EXCLUDED.stream_id,
      stream_version = EXCLUDED.stream_version,
      event_type = EXCLUDED.event_type,
      global_position = EXCLUDED.global_position,
      failure_kind = EXCLUDED.failure_kind,
      error_message = EXCLUDED.error_message,
      error_stack = EXCLUDED.error_stack,
      state = 'blocked',
      last_seen_at = EXCLUDED.last_seen_at,
      resolved_at = NULL
  `;

  const upsertBlockedStreamSql = `
    INSERT INTO ${blockedStreamsTable} (
      projection_key,
      stream_id,
      first_blocked_global_position,
      first_blocked_stream_version,
      last_seen_global_position,
      deferred_event_count,
      state,
      updated_at
    ) VALUES ($1, $2, $3::bigint, $4::bigint, $3::bigint, 0, 'blocked', $5)
    ON CONFLICT (projection_key, stream_id)
    DO UPDATE SET
      first_blocked_global_position = LEAST(
        ${blockedStreamsTable}.first_blocked_global_position,
        EXCLUDED.first_blocked_global_position
      ),
      first_blocked_stream_version = LEAST(
        ${blockedStreamsTable}.first_blocked_stream_version,
        EXCLUDED.first_blocked_stream_version
      ),
      last_seen_global_position = GREATEST(
        ${blockedStreamsTable}.last_seen_global_position,
        EXCLUDED.last_seen_global_position
      ),
      state = 'blocked',
      updated_at = EXCLUDED.updated_at
  `;

  const recordDeferredBlockedStreamSql = `
    INSERT INTO ${blockedStreamsTable} (
      projection_key,
      stream_id,
      first_blocked_global_position,
      first_blocked_stream_version,
      last_seen_global_position,
      deferred_event_count,
      state,
      updated_at
    ) VALUES ($1, $2, $3::bigint, $4::bigint, $3::bigint, 1, 'blocked', $5)
    ON CONFLICT (projection_key, stream_id)
    DO UPDATE SET
      last_seen_global_position = GREATEST(
        ${blockedStreamsTable}.last_seen_global_position,
        EXCLUDED.last_seen_global_position
      ),
      deferred_event_count = ${blockedStreamsTable}.deferred_event_count + 1,
      state = 'blocked',
      updated_at = EXCLUDED.updated_at
  `;

  const projectionErrorSummarySql = `
    SELECT
      (
        SELECT COUNT(*)
        FROM ${blockedStreamsTable}
        WHERE projection_key = $1
          AND state IN ('blocked', 'retrying')
      ) AS blocked_stream_count,
      (
        SELECT COUNT(*)
        FROM ${poisonEventsTable}
        WHERE projection_key = $1
          AND state IN ('blocked', 'retrying')
      ) AS poison_event_count
  `;

  const listPoisonEventsSql = `
    SELECT
      projection_key,
      event_id,
      projection_name,
      projection_kind,
      target_context_name,
      source_context_name,
      projection_revision,
      subscription_version,
      stream_id,
      stream_version,
      event_type,
      global_position,
      failure_kind,
      error_message,
      error_stack,
      state,
      retry_count,
      first_seen_at,
      last_seen_at,
      resolved_at
    FROM ${poisonEventsTable}
    WHERE projection_key = $1
      AND state IN ('blocked', 'retrying')
    ORDER BY global_position ASC, event_id ASC
    LIMIT $2
  `;

  const markBlockedStreamRetryingSql = `
    UPDATE ${blockedStreamsTable}
    SET state = 'retrying',
        updated_at = $3
    WHERE projection_key = $1
      AND stream_id = $2
      AND state IN ('blocked', 'retrying')
  `;

  const markBlockedStreamPoisonEventsRetryingSql = `
    UPDATE ${poisonEventsTable}
    SET state = 'retrying',
        retry_count = retry_count + 1,
        last_seen_at = $3
    WHERE projection_key = $1
      AND stream_id = $2
      AND state IN ('blocked', 'retrying')
  `;

  const resolveBlockedStreamSql = `
    UPDATE ${blockedStreamsTable}
    SET state = 'resolved',
        updated_at = $3
    WHERE projection_key = $1
      AND stream_id = $2
  `;

  const resolveBlockedStreamPoisonEventsSql = `
    UPDATE ${poisonEventsTable}
    SET state = 'resolved',
        resolved_at = $3,
        last_seen_at = $3
    WHERE projection_key = $1
      AND stream_id = $2
      AND state IN ('blocked', 'retrying')
  `;

  const clearProjectionBlockedStreamsSql = `
    UPDATE ${blockedStreamsTable}
    SET state = 'resolved',
        updated_at = $2
    WHERE projection_key = $1
      AND state IN ('blocked', 'retrying')
  `;

  const clearProjectionPoisonEventsSql = `
    UPDATE ${poisonEventsTable}
    SET state = 'resolved',
        resolved_at = $2,
        last_seen_at = $2
    WHERE projection_key = $1
      AND state IN ('blocked', 'retrying')
  `;

  return {
    loadCheckpoint: async (projectorName) => {
      const result = await config.db.query<DbCheckpointRow>(readCheckpointSql, [projectorName]);

      if (result.rows.length === 0) {
        return ZERO_GLOBAL_POSITION;
      }

      return coerceDbGlobalPosition(result.rows[0].last_global_position, "last_global_position");
    },

    saveCheckpoint: async (projectorName, globalPosition) => {
      await config.db.query(upsertCheckpointSql, [projectorName, globalPosition, now()]);
    },

    loadBlockedStream: async (projectionKey, streamId) => {
      const result = await config.db.query<DbBlockedStreamRow>(readBlockedStreamSql, [projectionKey, streamId]);
      const row = result.rows[0];

      return row ? mapBlockedStreamRow(row) : null;
    },

    recordPoisonEvent: async (input) => {
      const timestamp = now();

      await config.db.query(upsertPoisonEventSql, [
        input.projectionKey,
        input.eventId,
        input.projectionName,
        input.projectionKind,
        input.targetContextName ?? null,
        input.sourceContextName ?? null,
        input.projectionRevision ?? null,
        input.subscriptionVersion ?? null,
        input.streamId,
        input.streamVersion,
        input.eventType,
        input.globalPosition,
        input.failureKind,
        input.errorMessage,
        input.errorStack ?? null,
        timestamp,
      ]);

      await config.db.query(upsertBlockedStreamSql, [
        input.projectionKey,
        input.streamId,
        input.globalPosition,
        input.streamVersion,
        timestamp,
      ]);
    },

    recordDeferredBlockedStreamEvent: async (input) => {
      await config.db.query(recordDeferredBlockedStreamSql, [
        input.projectionKey,
        input.streamId,
        input.globalPosition,
        input.streamVersion,
        now(),
      ]);
    },

    loadProjectionErrorSummary: async (projectionKey) => {
      const result = await config.db.query<DbProjectionErrorSummaryRow>(projectionErrorSummarySql, [projectionKey]);
      const row = result.rows[0];

      return {
        blockedStreamCount: row ? coerceDbCount(row.blocked_stream_count, "blocked_stream_count") : 0,
        poisonEventCount: row ? coerceDbCount(row.poison_event_count, "poison_event_count") : 0,
      };
    },

    listBlockedStreams: async (projectionKey) => {
      const result = await config.db.query<DbBlockedStreamRow>(listBlockedStreamsSql, [projectionKey]);

      return result.rows.map(mapBlockedStreamRow);
    },

    listPoisonEvents: async (projectionKey, limit = 50) => {
      const result = await config.db.query<DbProjectionPoisonEventRow>(listPoisonEventsSql, [
        projectionKey,
        assertPositiveLimit(limit),
      ]);

      return result.rows.map(mapPoisonEventRow);
    },

    markBlockedStreamRetrying: async (projectionKey, streamId) => {
      const timestamp = now();
      await config.db.query(markBlockedStreamRetryingSql, [projectionKey, streamId, timestamp]);
      await config.db.query(markBlockedStreamPoisonEventsRetryingSql, [projectionKey, streamId, timestamp]);
    },

    resolveBlockedStream: async (projectionKey, streamId) => {
      const timestamp = now();
      await config.db.query(resolveBlockedStreamSql, [projectionKey, streamId, timestamp]);
      await config.db.query(resolveBlockedStreamPoisonEventsSql, [projectionKey, streamId, timestamp]);
    },

    clearProjectionErrors: async (projectionKey) => {
      const timestamp = now();
      await config.db.query(clearProjectionBlockedStreamsSql, [projectionKey, timestamp]);
      await config.db.query(clearProjectionPoisonEventsSql, [projectionKey, timestamp]);
    },
  };
}

function mapPoisonEventRow(row: DbProjectionPoisonEventRow): ProjectionPoisonEvent {
  return {
    projectionKey: row.projection_key,
    eventId: row.event_id,
    projectionName: row.projection_name,
    projectionKind: coerceProjectionKind(row.projection_kind),
    targetContextName: row.target_context_name,
    sourceContextName: row.source_context_name,
    projectionRevision: coerceOptionalPositiveInteger(row.projection_revision),
    subscriptionVersion: coerceOptionalPositiveInteger(row.subscription_version),
    streamId: row.stream_id,
    streamVersion: coerceDbStreamVersion(row.stream_version, "stream_version"),
    eventType: row.event_type,
    globalPosition: coerceDbGlobalPosition(row.global_position, "global_position"),
    failureKind: coerceFailureKind(row.failure_kind),
    errorMessage: row.error_message ?? "Projection failed without a recorded error message.",
    errorStack: row.error_stack,
    state: coercePoisonState(row.state),
    retryCount: coerceDbCount(row.retry_count, "retry_count"),
    firstSeenAt: toIsoString(row.first_seen_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    resolvedAt: row.resolved_at === null ? null : toIsoString(row.resolved_at),
  };
}

function mapBlockedStreamRow(row: DbBlockedStreamRow): ProjectionBlockedStream {
  return {
    projectionKey: row.projection_key,
    streamId: row.stream_id,
    firstBlockedGlobalPosition: coerceDbGlobalPosition(
      row.first_blocked_global_position,
      "first_blocked_global_position",
    ),
    firstBlockedStreamVersion: coerceDbStreamVersion(row.first_blocked_stream_version, "first_blocked_stream_version"),
    lastSeenGlobalPosition: coerceDbGlobalPosition(row.last_seen_global_position, "last_seen_global_position"),
    deferredEventCount: coerceDbCount(row.deferred_event_count, "deferred_event_count"),
    state: coerceBlockedStreamState(row.state),
  };
}

function coerceProjectionKind(value: string): ProjectionPoisonEvent["projectionKind"] {
  if (value === "projector" || value === "subscription") {
    return value;
  }

  throw new Error(`Unexpected projection poison event kind "${value}".`);
}

function coerceFailureKind(value: string): ProjectionFailureKind {
  if (value === "poison" || value === "transient") {
    return value;
  }

  throw new Error(`Unexpected projection failure kind "${value}".`);
}

function coercePoisonState(value: string): ProjectionPoisonState {
  if (value === "blocked" || value === "retrying" || value === "resolved" || value === "ignored") {
    return value;
  }

  throw new Error(`Unexpected projection poison event state "${value}".`);
}

function coerceBlockedStreamState(value: string): ProjectionBlockedStreamState {
  if (value === "blocked" || value === "retrying" || value === "resolved") {
    return value;
  }

  throw new Error(`Unexpected projection blocked stream state "${value}".`);
}

function coerceOptionalPositiveInteger(value: string | number | bigint | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function assertPositiveLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("Projection poison event limit must be an integer between 1 and 500.");
  }

  return limit;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function coerceDbGlobalPosition(value: string | number | bigint, fieldName: string): GlobalPosition {
  if (typeof value === "string") {
    try {
      return parseGlobalPosition(value);
    } catch {
      throw new Error(`Expected "${fieldName}" to be a canonical unsigned base-10 string.`);
    }
  }

  if (typeof value === "bigint") {
    if (value < BigInt(0)) {
      throw new Error(`Expected "${fieldName}" to be non-negative.`);
    }

    return globalPositionFromBigInt(value);
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected "${fieldName}" to be a non-negative safe integer when returned as a number.`);
  }

  return globalPositionFromBigInt(BigInt(value));
}

function coerceDbStreamVersion(value: string | number | bigint, fieldName: string): StreamVersion {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected "${fieldName}" to be a positive safe integer.`);
  }

  return parsed;
}

function coerceDbCount(value: string | number | bigint, fieldName: string): number {
  const parsed = typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected "${fieldName}" to be a non-negative safe integer.`);
  }

  return parsed;
}
