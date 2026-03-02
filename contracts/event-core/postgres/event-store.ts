import { nowIsoUtcTimestamp } from "../../primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "../../primitives/iso-utc-timestamp";
import type { JsonObject } from "../../primitives/json";
import type { EventId } from "../../primitives/typed-ids";
import {
  createEventStoreError,
  EventStoreError,
  type EventStore,
} from "../event-store";
import {
  ZERO_GLOBAL_POSITION,
  globalPositionFromBigInt,
  parseGlobalPosition,
} from "../storage";
import type {
  AppendToStreamInput,
  EventRecordToStore,
  ExpectedStreamVersion,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "../storage";
import type { PgPoolClient, PgTransactionalPool } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

type DbEventRow = Readonly<{
  event_id: string;
  stream_id: string;
  stream_version: number | string;
  global_position: string | number | bigint;
  tenant_id: string;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  occurred_at: Date | string;
  recorded_at: Date | string;
  performed_by_user_id: string;
  for_account_id: string;
  correlation_id: string | null;
  causation_id: string | null;
  command_id: string | null;
}>;

type DbStreamVersionRow = Readonly<{
  current_version: number | string;
}>;

export type PostgresEventStoreConfig = Readonly<{
  pool: PgTransactionalPool;
  eventsTableName?: string;
  streamsTableName?: string;
  now?: () => IsoUtcTimestamp;
  createEventId?: () => EventId;
}>;

const DEFAULT_EVENTS_TABLE = "event_store_events";

const DEFAULT_STREAMS_TABLE = "event_store_streams";

const EVENT_COLUMNS = [
  "event_id",
  "stream_id",
  "stream_version",
  "global_position",
  "tenant_id",
  "event_type",
  "payload",
  "metadata",
  "occurred_at",
  "recorded_at",
  "performed_by_user_id",
  "for_account_id",
  "correlation_id",
  "causation_id",
  "command_id",
].join(", ");

export function createPostgresEventStore(
  config: PostgresEventStoreConfig,
): EventStore {
  const pool = config.pool;
  const eventsTable = assertSqlIdentifier(
    config.eventsTableName ?? DEFAULT_EVENTS_TABLE,
  );
  const streamsTable = assertSqlIdentifier(
    config.streamsTableName ?? DEFAULT_STREAMS_TABLE,
  );
  const now = config.now ?? nowIsoUtcTimestamp;
  const createEventId = config.createEventId ?? createDefaultEventId;

  const upsertStreamSql = `
    INSERT INTO ${streamsTable} (stream_id, current_version, updated_at)
    VALUES ($1, 0, $2)
    ON CONFLICT (stream_id) DO NOTHING
  `;

  const readCurrentVersionSql = `
    SELECT current_version
    FROM ${streamsTable}
    WHERE stream_id = $1
    FOR UPDATE
  `;

  const insertEventSql = `
    INSERT INTO ${eventsTable} (
      event_id,
      stream_id,
      stream_version,
      tenant_id,
      event_type,
      payload,
      metadata,
      occurred_at,
      recorded_at,
      performed_by_user_id,
      for_account_id,
      correlation_id,
      causation_id,
      command_id
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    RETURNING ${EVENT_COLUMNS}
  `;

  const updateStreamVersionSql = `
    UPDATE ${streamsTable}
    SET current_version = $2, updated_at = $3
    WHERE stream_id = $1
  `;

  const readStreamSql = `
    SELECT ${EVENT_COLUMNS}
    FROM ${eventsTable}
    WHERE stream_id = $1
      AND stream_version >= $2
    ORDER BY stream_version ASC
    LIMIT $3
  `;

  const readAllSql = `
    SELECT ${EVENT_COLUMNS}
    FROM ${eventsTable}
    WHERE global_position > $1::bigint
    ORDER BY global_position ASC
    LIMIT $2
  `;

  const readAllByTenantSql = `
    SELECT ${EVENT_COLUMNS}
    FROM ${eventsTable}
    WHERE tenant_id = $1
      AND global_position > $2::bigint
    ORDER BY global_position ASC
    LIMIT $3
  `;

  return {
    appendToStream: async (input) => {
      if (input.events.length === 0) {
        return [];
      }

      try {
        return await withTransaction(pool, async (client) =>
          appendEventsToStream({
            client,
            input,
            now,
            createEventId,
            upsertStreamSql,
            readCurrentVersionSql,
            insertEventSql,
            updateStreamVersionSql,
          }),
        );
      } catch (error) {
        throw normalizeEventStoreError(
          error,
          "Failed to append events to Postgres event store.",
        );
      }
    },

    readStream: async (input: ReadStreamInput) => {
      const fromVersion = assertPositiveInteger(
        input.fromVersion ?? 1,
        "fromVersion",
      );
      const limit = assertPositiveInteger(input.limit ?? 500, "limit");

      try {
        const result = await pool.query<DbEventRow>(readStreamSql, [
          input.streamId,
          fromVersion,
          limit,
        ]);

        return result.rows.map(mapDbEventRow);
      } catch (error) {
        throw normalizeEventStoreError(
          error,
          "Failed to read stream events from Postgres event store.",
        );
      }
    },

    readAll: async (input?: ReadAllInput) => {
      const afterGlobalPosition =
        input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION;
      const limit = assertPositiveInteger(input?.limit ?? 500, "limit");

      try {
        if (input?.tenantId) {
          const result = await pool.query<DbEventRow>(readAllByTenantSql, [
            input.tenantId,
            afterGlobalPosition,
            limit,
          ]);

          return result.rows.map(mapDbEventRow);
        }

        const result = await pool.query<DbEventRow>(readAllSql, [
          afterGlobalPosition,
          limit,
        ]);

        return result.rows.map(mapDbEventRow);
      } catch (error) {
        throw normalizeEventStoreError(
          error,
          "Failed to read global events from Postgres event store.",
        );
      }
    },
  };
}

type AppendInTransactionArgs = Readonly<{
  client: PgPoolClient;
  input: AppendToStreamInput;
  now: () => IsoUtcTimestamp;
  createEventId: () => EventId;
  upsertStreamSql: string;
  readCurrentVersionSql: string;
  insertEventSql: string;
  updateStreamVersionSql: string;
}>;

async function appendEventsToStream(
  args: AppendInTransactionArgs,
): Promise<readonly StoredEvent[]> {
  const now = args.now();

  await args.client.query(args.upsertStreamSql, [args.input.streamId, now]);

  const streamVersionResult = await args.client.query<DbStreamVersionRow>(
    args.readCurrentVersionSql,
    [args.input.streamId],
  );

  if (streamVersionResult.rows.length !== 1) {
    throw createEventStoreError(
      "infrastructure_failure",
      "Stream row not found",
      {
        streamId: args.input.streamId,
      },
    );
  }

  const currentVersion = toNumber(streamVersionResult.rows[0].current_version);

  assertExpectedVersion(
    args.input.streamId,
    args.input.expectedVersion,
    currentVersion,
  );

  const storedEvents: StoredEvent[] = [];
  let nextVersion = currentVersion;

  for (let index = 0; index < args.input.events.length; index += 1) {
    const eventRecord = args.input.events[index];
    nextVersion += 1;
    const storedEvent = await insertSingleEvent({
      client: args.client,
      insertEventSql: args.insertEventSql,
      streamId: args.input.streamId,
      streamVersion: nextVersion,
      event: eventRecord,
      context: args.input.context,
      now,
      createEventId: args.createEventId,
    });

    storedEvents.push(storedEvent);
  }

  await args.client.query(args.updateStreamVersionSql, [
    args.input.streamId,
    nextVersion,
    now,
  ]);

  return storedEvents;
}

type InsertSingleEventArgs = Readonly<{
  client: PgPoolClient;
  insertEventSql: string;
  streamId: string;
  streamVersion: number;
  event: EventRecordToStore;
  context: AppendToStreamInput["context"];
  now: IsoUtcTimestamp;
  createEventId: () => EventId;
}>;

async function insertSingleEvent(
  args: InsertSingleEventArgs,
): Promise<StoredEvent> {
  const result = await args.client.query<DbEventRow>(args.insertEventSql, [
    args.createEventId(),
    args.streamId,
    args.streamVersion,
    args.context.tenantId,
    args.event.eventType,
    args.event.payload,
    args.event.metadata ?? {},
    args.event.occurredAt ?? args.now,
    args.now,
    args.context.audit.performedByUserId,
    args.context.audit.forAccountId,
    args.context.trace?.correlationId ?? null,
    args.context.trace?.causationId ?? null,
    args.context.trace?.commandId ?? null,
  ]);

  if (result.rows.length !== 1) {
    throw createEventStoreError(
      "infrastructure_failure",
      "Failed to insert event row into Postgres event store.",
    );
  }

  return mapDbEventRow(result.rows[0]);
}

function assertExpectedVersion(
  streamId: string,
  expectedVersion: ExpectedStreamVersion,
  currentVersion: number,
): void {
  if (expectedVersion === "any") {
    return;
  }

  if (expectedVersion === "no_stream") {
    if (currentVersion === 0) {
      return;
    }

    throw createEventStoreError(
      "concurrency_conflict",
      "Expected no stream but stream already exists.",
      {
        streamId,
        expectedVersion,
        currentVersion,
      },
    );
  }

  if (expectedVersion !== currentVersion) {
    throw createEventStoreError(
      "concurrency_conflict",
      "Expected stream version does not match current version.",
      {
        streamId,
        expectedVersion,
        currentVersion,
      },
    );
  }
}

async function withTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function normalizeEventStoreError(
  error: unknown,
  message: string,
): EventStoreError {
  if (isEventStoreError(error)) {
    return error;
  }

  if (isPgUniqueViolation(error)) {
    return createEventStoreError(
      "concurrency_conflict",
      "Unique constraint conflict while appending events.",
      {
        postgresCode: error.code,
      },
    );
  }

  return createEventStoreError("infrastructure_failure", message, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

type PgError = Readonly<{
  code?: string;
}>;

function isPgUniqueViolation(error: unknown): error is PgError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as PgError).code === "23505"
  );
}

function isEventStoreError(error: unknown): error is EventStoreError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function mapDbEventRow(row: DbEventRow): StoredEvent {
  return {
    eventId: row.event_id as EventId,
    streamId: row.stream_id,
    streamVersion: toNumber(row.stream_version),
    globalPosition: coerceDbGlobalPosition(
      row.global_position,
      "global_position",
    ),
    tenantId: row.tenant_id as StoredEvent["tenantId"],
    eventType: row.event_type,
    payload: toJsonObject(row.payload, "payload"),
    metadata: toJsonObject(row.metadata ?? {}, "metadata"),
    occurredAt: toIsoUtcTimestamp(row.occurred_at),
    recordedAt: toIsoUtcTimestamp(row.recorded_at),
    performedByUserId:
      row.performed_by_user_id as StoredEvent["performedByUserId"],
    forAccountId:
      row.for_account_id as StoredEvent["forAccountId"],
    correlationId: row.correlation_id
      ? (row.correlation_id as StoredEvent["correlationId"])
      : undefined,
    causationId: row.causation_id
      ? (row.causation_id as StoredEvent["causationId"])
      : undefined,
    commandId: row.command_id
      ? (row.command_id as StoredEvent["commandId"])
      : undefined,
  };
}

function coerceDbGlobalPosition(
  value: string | number | bigint,
  fieldName: string,
): GlobalPosition {
  if (typeof value === "string") {
    try {
      return parseGlobalPosition(value);
    } catch {
      throw new Error(
        `Expected "${fieldName}" to be a canonical unsigned base-10 string.`,
      );
    }
  }

  if (typeof value === "bigint") {
    if (value < BigInt(0)) {
      throw new Error(`Expected "${fieldName}" to be non-negative.`);
    }

    return globalPositionFromBigInt(value);
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Expected "${fieldName}" to be a non-negative safe integer when returned as a number.`,
    );
  }

  return globalPositionFromBigInt(BigInt(value));
}

function toJsonObject(value: unknown, fieldName: string): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new Error(`Expected "${fieldName}" to be a JSON object.`);
}

function toIsoUtcTimestamp(value: Date | string): IsoUtcTimestamp {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp value "${String(value)}".`);
  }

  return date.toISOString() as IsoUtcTimestamp;
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not convert "${String(value)}" to number.`);
  }

  return parsed;
}

function assertPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}

function createDefaultEventId(): EventId {
  const timestampPart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `evt_${timestampPart}${randomPart}` as EventId;
}
