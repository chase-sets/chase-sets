import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventId } from "@chase-sets/primitives/typed-ids";
import {
  createEventStoreError,
  type AppendToStreamsIndependentResult,
  type AppendToStreamsIndependentlyOptions,
  type AppendToStreamsResult,
  type EventStoreError,
  type EventStore,
} from "@chase-sets/event-core/event-store";
import { ZERO_GLOBAL_POSITION, globalPositionFromBigInt, parseGlobalPosition } from "@chase-sets/event-core/storage";
import { observeEventStoreOperation, recordEventStoreAppendAdvisoryLockHold } from "@chase-sets/observability";
import type {
  AppendToStreamInput,
  EventRecordToStore,
  ExpectedStreamVersion,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { isPgRetryableTransientError, withPgTransaction, type PgPoolClient, type PgTransactionalPool } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";
import { buildStreamPrefixFilterSql, streamCategory, streamContextName } from "./stream-prefix-filter";

type DbEventRow = Readonly<{
  event_id: string;
  stream_id: string;
  stream_version: number | string;
  global_position: string | number | bigint;
  tenant_id: string;
  stream_context_name: string;
  stream_category: string;
  event_type: string;
  payload: unknown;
  metadata: unknown;
  occurred_at: Date | string;
  recorded_at: Date | string;
  performed_by_user_id: string;
  for_account_id: string;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  trace_state: string | null;
}>;

type DbStreamVersionRow = Readonly<{
  current_version: number | string;
}>;

export const EVENT_STORE_WAKE_NOTIFICATION_KIND = "event-store.commit";
export const EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION = 1;
export const EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION = 1;
export const DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL = "platform_event_store_commits";
export const DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE = "event-core-postgres";
export const EVENT_STORE_WAKE_NOTIFICATION_MAX_PAYLOAD_BYTES = 4 * 1024;
// Keep event reads bounded to match list and poison-event page hardening.
export const EVENT_STORE_READ_PAGE_SIZE_DEFAULT = 500;
export const EVENT_STORE_READ_PAGE_SIZE_LIMIT = 500;
// Bounds the payload portion of a full 500-event catch-up page to about 32 MiB.
export const EVENT_STORE_MAX_PAYLOAD_BYTES = 64 * 1024;
// Appenders take the shared side; catch-up horizon reads take the exclusive
// side. Every canonical writer and global-position reader uses this same key.
export const EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY = "-8041932795057830931";

export type EventStoreWakeNotificationPayload = Readonly<{
  sourceContextName: string;
  streamCategory: string;
  firstGlobalPosition: GlobalPosition;
  lastGlobalPosition: GlobalPosition;
  eventCount: number;
  eventTypes: readonly string[];
}>;

export type EventStoreWakeNotificationEnvelope = Readonly<{
  schemaVersion: typeof EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION;
  payloadVersion: number;
  kind: typeof EVENT_STORE_WAKE_NOTIFICATION_KIND;
  source: string;
  emittedAt: IsoUtcTimestamp;
  correlationId?: string;
  payload: EventStoreWakeNotificationPayload;
}>;

export type EventStoreWakeNotificationObserver = Readonly<{
  notificationEmitted?: (event: EventStoreWakeNotificationEmittedEvent) => void;
  notificationFailed?: (event: EventStoreWakeNotificationFailedEvent) => void;
  payloadRejected?: (event: EventStoreWakeNotificationPayloadRejectedEvent) => void;
}>;

export type EventStoreWakeNotificationEmittedEvent = Readonly<{
  channel: string;
  sourceContextName: string;
  streamCategory: string;
  firstGlobalPosition: GlobalPosition;
  lastGlobalPosition: GlobalPosition;
  eventCount: number;
  eventTypes: readonly string[];
  payloadBytes: number;
  emittedAt: IsoUtcTimestamp;
  correlationId: string | null;
}>;

export type EventStoreWakeNotificationFailedEvent = Readonly<{
  channel: string;
  sourceContextName: string;
  streamCategory: string;
  firstGlobalPosition: GlobalPosition;
  lastGlobalPosition: GlobalPosition;
  eventCount: number;
  correlationId: string | null;
  error: unknown;
}>;

export type EventStoreWakeNotificationPayloadRejectedEvent = Readonly<{
  channel: string;
  sourceContextName: string;
  streamCategory: string;
  firstGlobalPosition: GlobalPosition;
  lastGlobalPosition: GlobalPosition;
  eventCount: number;
  correlationId: string | null;
  reason: string;
}>;

export type PostgresEventStoreWakeNotificationConfig = Readonly<{
  enabled: boolean;
  channel?: string;
  source?: string;
  maxPayloadBytes?: number;
  observer?: EventStoreWakeNotificationObserver;
}>;

export type PostgresEventStoreConfig = Readonly<{
  pool: PgTransactionalPool;
  eventsTableName?: string;
  streamsTableName?: string;
  now?: () => IsoUtcTimestamp;
  createEventId?: () => EventId;
  wakeNotifications?: PostgresEventStoreWakeNotificationConfig;
}>;

const DEFAULT_EVENTS_TABLE = "event_store_events";

const DEFAULT_STREAMS_TABLE = "event_store_streams";

const EVENT_STORE_ERROR_CODES = new Set(["concurrency_conflict", "payload_too_large", "infrastructure_failure"]);

const POSTGRES_WAKE_NOTIFICATION_CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const SENSITIVE_WAKE_NOTIFICATION_KEY_PATTERN =
  /(^|_|\b)(email|guestEmail|payment|card|pan|cvc|cvv|password|secret|privatePayload|providerPayload|eventPayload|rawPayload|payloadJson|phone|address|tenantId|userId|accountId|streamId)(_|$|\b)/i;

const EVENT_COLUMNS = [
  "event_id",
  "stream_id",
  "stream_version",
  "global_position",
  "tenant_id",
  "stream_context_name",
  "stream_category",
  "event_type",
  "payload",
  "metadata",
  "occurred_at",
  "recorded_at",
  "performed_by_user_id",
  "for_account_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "trace_state",
].join(", ");

export function createPostgresEventStore(config: PostgresEventStoreConfig): EventStore {
  const pool = config.pool;
  const eventsTable = assertSqlIdentifier(config.eventsTableName ?? DEFAULT_EVENTS_TABLE);
  const streamsTable = assertSqlIdentifier(config.streamsTableName ?? DEFAULT_STREAMS_TABLE);
  const now = config.now ?? nowIsoUtcTimestamp;
  const createEventId = config.createEventId ?? createDefaultEventId;
  const wakeNotifications = normalizeEventStoreWakeNotificationConfig(config.wakeNotifications);

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

  const readEventsByIdsSql = `
    SELECT ${EVENT_COLUMNS}
    FROM ${eventsTable}
    WHERE event_id = ANY($1::text[])
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

  return {
    appendToStream: async (input) => {
      if (input.events.length === 0) {
        return [];
      }

      assertEventPayloadSizes([input]);

      return observeEventStoreOperation(
        "append_to_stream",
        {
          event_count: input.events.length,
          event_type: input.events.length === 1 ? input.events[0].eventType : "multiple",
        },
        async () => {
          try {
            return await withPgTransaction(
              pool,
              async (client) =>
                appendEventsToStream({
                  client,
                  input,
                  now,
                  createEventId,
                  upsertStreamSql,
                  readCurrentVersionSql,
                  eventsTable,
                  readEventsByIdsSql,
                  updateStreamVersionSql,
                }),
              {
                afterCommit: wakeNotifications
                  ? (client, storedEvents) =>
                      emitEventStoreWakeNotificationAfterCommit({
                        client,
                        config: wakeNotifications,
                        input,
                        storedEvents,
                        emittedAt: now(),
                      })
                  : undefined,
              },
            );
          } catch (error) {
            throw normalizeEventStoreError(error, "Failed to append events to Postgres event store.");
          }
        },
      );
    },
    appendToStreams: async (inputs) => {
      const appendInputs = inputs.filter((input) => input.events.length > 0);
      if (appendInputs.length === 0) {
        return inputs.map((input) => ({ streamId: input.streamId, storedEvents: [] }));
      }

      assertEventPayloadSizes(appendInputs);

      return observeEventStoreOperation(
        "append_to_streams",
        {
          event_count: appendInputs.reduce((count, input) => count + input.events.length, 0),
          event_type: "multiple",
        },
        async () => {
          try {
            return await withPgTransaction(
              pool,
              async (client) =>
                appendEventsToStreams({
                  client,
                  inputs,
                  now,
                  createEventId,
                  upsertStreamSql,
                  readCurrentVersionSql,
                  eventsTable,
                  readEventsByIdsSql,
                  updateStreamVersionSql,
                }),
              {
                afterCommit: wakeNotifications
                  ? async (client, results) => {
                      for (let index = 0; index < inputs.length; index += 1) {
                        const input = inputs[index];
                        if (!input) {
                          continue;
                        }
                        const storedEvents = results[index]?.storedEvents ?? [];
                        await emitEventStoreWakeNotificationAfterCommit({
                          client,
                          config: wakeNotifications,
                          input,
                          storedEvents,
                          emittedAt: now(),
                        });
                      }
                    }
                  : undefined,
              },
            );
          } catch (error) {
            throw normalizeEventStoreError(error, "Failed to append events to Postgres event store.");
          }
        },
      );
    },
    appendToStreamsIndependently: async (inputs, options) => {
      const appendInputs = inputs.filter((input) => input.events.length > 0);
      if (appendInputs.length === 0) {
        return inputs.map((input) => ({
          streamId: input.streamId,
          outcome: "no_op" as const,
          storedEvents: [],
        }));
      }

      const uniqueStreamIds = new Set(appendInputs.map((input) => input.streamId));
      if (uniqueStreamIds.size !== appendInputs.length) {
        throw new Error("appendToStreamsIndependently does not support the same stream id more than once per batch.");
      }

      assertEventPayloadSizes(appendInputs);

      return observeEventStoreOperation(
        "append_to_streams_independently",
        {
          event_count: appendInputs.reduce((count, input) => count + input.events.length, 0),
          event_type: "multiple",
        },
        async () => {
          const telemetry = options?.telemetry;
          const lockTiming: { acquiredAtMs: number | null } = { acquiredAtMs: null };
          let transactionOutcome: "committed" | "rolled_back" = "rolled_back";

          try {
            const results = await withPgTransaction(
              pool,
              async (client) =>
                appendEventsToStreamsIndependently({
                  client,
                  inputs,
                  now,
                  createEventId,
                  upsertStreamSql,
                  readCurrentVersionSql,
                  eventsTable,
                  readEventsByIdsSql,
                  updateStreamVersionSql,
                  onAdvisoryLockAcquired: () => {
                    lockTiming.acquiredAtMs ??= Date.now();
                  },
                }),
              {
                afterCommit: wakeNotifications
                  ? async (client, committedResults) => {
                      const inputsByStreamId = new Map(inputs.map((input) => [input.streamId, input] as const));
                      for (const result of committedResults) {
                        if (result.outcome !== "appended" || result.storedEvents.length === 0) {
                          continue;
                        }
                        const input = inputsByStreamId.get(result.streamId);
                        if (!input) {
                          continue;
                        }
                        await emitEventStoreWakeNotificationAfterCommit({
                          client,
                          config: wakeNotifications,
                          input,
                          storedEvents: result.storedEvents,
                          emittedAt: now(),
                        });
                      }
                    }
                  : undefined,
              },
            );
            transactionOutcome = "committed";
            return results;
          } catch (error) {
            throw normalizeEventStoreError(error, "Failed to append events to Postgres event store.");
          } finally {
            if (lockTiming.acquiredAtMs !== null) {
              recordEventStoreAppendAdvisoryLockHold({
                durationMs: Date.now() - lockTiming.acquiredAtMs,
                outcome: transactionOutcome,
                holderKind: telemetry?.holderKind ?? "bulk_chunk_append",
                sourceContextName: telemetry?.sourceContextName,
              });
            }
          }
        },
      );
    },

    readStream: async (input: ReadStreamInput) => {
      const fromVersion = assertPositiveInteger(input.fromVersion ?? 1, "fromVersion");
      const limit = assertEventStoreReadPageSize(input.limit ?? EVENT_STORE_READ_PAGE_SIZE_DEFAULT);

      return observeEventStoreOperation("read_stream", { limit }, async () => {
        try {
          const result = await pool.query<DbEventRow>(readStreamSql, [input.streamId, fromVersion, limit]);

          return result.rows.map(mapDbEventRow);
        } catch (error) {
          throw normalizeEventStoreError(error, "Failed to read stream events from Postgres event store.");
        }
      });
    },

    readAll: async (input?: ReadAllInput) => {
      const afterGlobalPosition = input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION;
      const limit = assertEventStoreReadPageSize(input?.limit ?? EVENT_STORE_READ_PAGE_SIZE_DEFAULT);

      return observeEventStoreOperation(
        "read_all",
        {
          limit,
          tenant_scope: input?.tenantId ? "tenant" : "all",
          event_type_filter: input?.eventTypes?.length ? "filtered" : "all",
          stream_prefix_filter: input?.streamPrefixes?.length ? "filtered" : "all",
        },
        async () => {
          try {
            const safeHeadGlobalPosition = await readGapSafeEventStoreHead(pool, eventsTable);
            const result = await pool.query<DbEventRow>(
              buildReadAllSql(eventsTable, input),
              buildReadAllParams({
                afterGlobalPosition,
                safeHeadGlobalPosition,
                limit,
                tenantId: input?.tenantId,
                eventTypes: input?.eventTypes,
                streamPrefixes: input?.streamPrefixes,
              }),
            );

            return result.rows.map(mapDbEventRow);
          } catch (error) {
            throw normalizeEventStoreError(error, "Failed to read global events from Postgres event store.");
          }
        },
      );
    },
  };
}

/**
 * Captures the largest global position that a catch-up consumer may safely
 * checkpoint. Appenders hold the shared advisory transaction lock from
 * position assignment through commit; this query takes the exclusive side,
 * so every position at or below the returned sequence value is committed or
 * permanently abandoned by a rolled-back transaction.
 *
 * The sequence must remain CACHE 1. A cached sequence could hand out a future
 * position below `last_value` after this fence releases, invalidating the
 * horizon. `schema.sql` enforces that storage invariant.
 */
export async function readGapSafeEventStoreHead(
  pool: PgTransactionalPool,
  eventsTableName = DEFAULT_EVENTS_TABLE,
): Promise<GlobalPosition> {
  const eventsTable = assertSqlIdentifier(eventsTableName);
  const result = await pool.query<Readonly<{ head: string | number | bigint | null }>>(
    `WITH append_fence AS MATERIALIZED (
       SELECT pg_advisory_xact_lock($1::bigint)
     )
     SELECT COALESCE(
              pg_sequence_last_value(pg_get_serial_sequence($2, 'global_position')::regclass),
              0
            )::text AS head
     FROM append_fence`,
    [EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY, eventsTable],
  );

  return parseGlobalPosition(String(result.rows[0]?.head ?? ZERO_GLOBAL_POSITION));
}

type AppendInTransactionArgs = Readonly<{
  client: PgPoolClient;
  input: AppendToStreamInput;
  now: () => IsoUtcTimestamp;
  createEventId: () => EventId;
  upsertStreamSql: string;
  readCurrentVersionSql: string;
  eventsTable: string;
  readEventsByIdsSql: string;
  updateStreamVersionSql: string;
}>;

type AppendStreamsInTransactionArgs = Omit<AppendInTransactionArgs, "input"> &
  Readonly<{
    inputs: readonly AppendToStreamInput[];
  }>;

type AppendStreamsIndependentlyInTransactionArgs = AppendStreamsInTransactionArgs &
  Readonly<{
    onAdvisoryLockAcquired: () => void;
  }>;

type ReadAllQueryInput = Readonly<{
  afterGlobalPosition: GlobalPosition;
  safeHeadGlobalPosition: GlobalPosition;
  limit: number;
  tenantId?: ReadAllInput["tenantId"];
  eventTypes?: readonly string[];
  streamPrefixes?: readonly string[];
}>;

type NormalizedEventStoreWakeNotificationConfig = Readonly<{
  channel: string;
  source: string;
  maxPayloadBytes: number;
  observer?: EventStoreWakeNotificationObserver;
}>;

function buildReadAllSql(eventsTable: string, input: ReadAllInput | undefined): string {
  const predicates = ["global_position > $1::bigint", "global_position <= $2::bigint"];
  let nextParam = 3;

  if (input?.tenantId) {
    predicates.push(`tenant_id = $${nextParam}`);
    nextParam += 1;
  }

  if (input?.eventTypes?.length) {
    predicates.push(`event_type = ANY($${nextParam}::text[])`);
    nextParam += 1;
  }

  if (input?.streamPrefixes?.length) {
    const streamPrefixFilter = buildStreamPrefixFilterSql(input.streamPrefixes, nextParam);
    if (streamPrefixFilter) {
      predicates.push(streamPrefixFilter.predicate);
      nextParam += streamPrefixFilter.params.length;
    }
  }

  return `
    SELECT ${EVENT_COLUMNS}
    FROM ${eventsTable}
    WHERE ${predicates.join("\n      AND ")}
    ORDER BY global_position ASC
    LIMIT $${nextParam}
  `;
}

function buildReadAllParams(input: ReadAllQueryInput): readonly unknown[] {
  const params: unknown[] = [input.afterGlobalPosition, input.safeHeadGlobalPosition];

  if (input.tenantId) {
    params.push(input.tenantId);
  }

  if (input.eventTypes?.length) {
    params.push([...new Set(input.eventTypes)]);
  }

  if (input.streamPrefixes?.length) {
    const streamPrefixFilter = buildStreamPrefixFilterSql(input.streamPrefixes, params.length + 1);
    if (streamPrefixFilter) {
      params.push(...streamPrefixFilter.params);
    }
  }

  params.push(input.limit);
  return params;
}

async function appendEventsToStream(args: AppendInTransactionArgs): Promise<readonly StoredEvent[]> {
  const now = args.now();

  await args.client.query(args.upsertStreamSql, [args.input.streamId, now]);

  const streamVersionResult = await args.client.query<DbStreamVersionRow>(args.readCurrentVersionSql, [
    args.input.streamId,
  ]);

  if (streamVersionResult.rows.length !== 1) {
    throw createEventStoreError("infrastructure_failure", "Stream row not found", {
      streamId: args.input.streamId,
    });
  }

  const currentVersion = toNumber(streamVersionResult.rows[0].current_version);

  assertExpectedVersion(args.input.streamId, args.input.expectedVersion, currentVersion);

  const eventCandidates: AppendEventCandidate[] = args.input.events.map((event) => ({
    streamId: args.input.streamId,
    event,
    context: args.input.context,
    now,
    eventId: event.eventId ?? args.createEventId(),
  }));
  const existingEventsById = await readExistingEventsById(args.client, args.readEventsByIdsSql, eventCandidates);
  const plannedEventsById = new Map<string, AppendEventToInsert>();
  const eventsToInsert: AppendEventToInsert[] = [];
  let nextVersion = currentVersion;

  for (const candidate of eventCandidates) {
    const existingEvent = existingEventsById.get(candidate.eventId);
    if (existingEvent) {
      assertIdempotentEventMatch(existingEvent, candidate);
      nextVersion = Math.max(nextVersion, existingEvent.streamVersion);
      continue;
    }

    const plannedEvent = plannedEventsById.get(candidate.eventId);
    if (plannedEvent) {
      assertDuplicateEventIdInAppendMatches(plannedEvent, candidate);
      continue;
    }

    nextVersion += 1;
    const eventToInsert = { ...candidate, streamVersion: nextVersion };
    plannedEventsById.set(candidate.eventId, eventToInsert);
    eventsToInsert.push(eventToInsert);
  }

  const insertedEventsById = new Map<string, StoredEvent>();
  if (eventsToInsert.length > 0) {
    // Independent appenders share this transaction lock, so unrelated streams
    // can assign positions and commit concurrently. Catch-up readers take the
    // exclusive side before capturing the sequence horizon; they therefore
    // cannot checkpoint past any position owned by an in-flight append.
    await args.client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
      EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
    ]);
    const insertResult = await args.client.query<DbEventRow>(
      buildInsertEventsSql(args.eventsTable, eventsToInsert.length),
      buildInsertEventsParams(eventsToInsert),
    );

    for (const row of insertResult.rows) {
      const storedEvent = mapDbEventRow(row);
      insertedEventsById.set(storedEvent.eventId, storedEvent);
    }

    if (insertedEventsById.size !== eventsToInsert.length) {
      const missingEvents = eventsToInsert.filter((event) => !insertedEventsById.has(event.eventId));
      const eventsConflictingDuringInsert = await readExistingEventsById(
        args.client,
        args.readEventsByIdsSql,
        missingEvents,
      );

      for (const missingEvent of missingEvents) {
        const existingEvent = eventsConflictingDuringInsert.get(missingEvent.eventId);
        if (!existingEvent) {
          throw createEventStoreError(
            "infrastructure_failure",
            "Failed to insert event row into Postgres event store.",
          );
        }

        assertIdempotentEventMatch(existingEvent, missingEvent);
        existingEventsById.set(missingEvent.eventId, existingEvent);
      }
    }
  }

  const storedEvents = eventCandidates.map((candidate) => {
    const storedEvent = existingEventsById.get(candidate.eventId) ?? insertedEventsById.get(candidate.eventId);
    if (!storedEvent) {
      throw createEventStoreError("infrastructure_failure", "Failed to insert event row into Postgres event store.");
    }
    return storedEvent;
  });
  const updatedStreamVersion = storedEvents.reduce(
    (version, event) => Math.max(version, event.streamVersion),
    currentVersion,
  );

  await args.client.query(args.updateStreamVersionSql, [args.input.streamId, updatedStreamVersion, now]);

  return storedEvents;
}

async function appendEventsToStreams(args: AppendStreamsInTransactionArgs): Promise<readonly AppendToStreamsResult[]> {
  const results: AppendToStreamsResult[] = [];

  for (const input of args.inputs) {
    const storedEvents =
      input.events.length === 0
        ? []
        : await appendEventsToStream({
            ...args,
            input,
          });
    results.push({
      streamId: input.streamId,
      storedEvents,
    });
  }

  return results;
}

type PendingIndependentStreamAppend = Readonly<{
  streamId: string;
  currentVersion: number;
  eventCandidates: AppendEventCandidate[];
  existingEventsById: Map<string, StoredEvent>;
}>;

/**
 * The chunk primitive: validates every stream's expected version up front
 * (per-stream `FOR UPDATE`, same as `appendEventsToStream`), excludes any
 * stream that fails validation from the batch WITHOUT aborting the others,
 * then performs exactly one multi-row INSERT across every stream that
 * passed -- extending the single-stream multi-row insert (m106's
 * batch-apply work) to the multi-stream case. The shared append-fence lock is
 * acquired at most once per call, right before that single INSERT, so a chunk
 * of K streams holds it for one bounded window instead of K separate windows.
 */
async function appendEventsToStreamsIndependently(
  args: AppendStreamsIndependentlyInTransactionArgs,
): Promise<readonly AppendToStreamsIndependentResult[]> {
  const now = args.now();
  const results: AppendToStreamsIndependentResult[] = [];
  const pendingStreams: PendingIndependentStreamAppend[] = [];
  const combinedEventsToInsert: AppendEventToInsert[] = [];

  for (const input of args.inputs) {
    if (input.events.length === 0) {
      results.push({ streamId: input.streamId, outcome: "no_op", storedEvents: [] });
      continue;
    }

    const eventCandidates: AppendEventCandidate[] = input.events.map((event) => ({
      streamId: input.streamId,
      event,
      context: input.context,
      now,
      eventId: event.eventId ?? args.createEventId(),
    }));
    const replayEventsById = await readExistingEventsById(args.client, args.readEventsByIdsSql, eventCandidates);
    if (eventCandidates.every((candidate) => replayEventsById.has(candidate.eventId))) {
      const storedEvents = eventCandidates.map((candidate) => {
        const stored = replayEventsById.get(candidate.eventId)!;
        assertIdempotentEventMatch(stored, candidate);
        return stored;
      });
      results.push({ streamId: input.streamId, outcome: "appended", storedEvents });
      continue;
    }

    await args.client.query(args.upsertStreamSql, [input.streamId, now]);

    const streamVersionResult = await args.client.query<DbStreamVersionRow>(args.readCurrentVersionSql, [
      input.streamId,
    ]);

    if (streamVersionResult.rows.length !== 1) {
      results.push({
        streamId: input.streamId,
        outcome: "conflict",
        storedEvents: [],
        error: createEventStoreError("infrastructure_failure", "Stream row not found", {
          streamId: input.streamId,
        }),
      });
      continue;
    }

    const currentVersion = toNumber(streamVersionResult.rows[0].current_version);

    try {
      assertExpectedVersion(input.streamId, input.expectedVersion, currentVersion);
    } catch (error) {
      results.push({
        streamId: input.streamId,
        outcome: "conflict",
        storedEvents: [],
        error: isEventStoreError(error)
          ? error
          : createEventStoreError("infrastructure_failure", "Failed to validate expected stream version.", {
              streamId: input.streamId,
              cause: error instanceof Error ? error.message : String(error),
            }),
      });
      continue;
    }

    const existingEventsById = await readExistingEventsById(args.client, args.readEventsByIdsSql, eventCandidates);
    const plannedEventsById = new Map<string, AppendEventToInsert>();
    let nextVersion = currentVersion;

    for (const candidate of eventCandidates) {
      const existingEvent = existingEventsById.get(candidate.eventId);
      if (existingEvent) {
        assertIdempotentEventMatch(existingEvent, candidate);
        nextVersion = Math.max(nextVersion, existingEvent.streamVersion);
        continue;
      }

      const plannedEvent = plannedEventsById.get(candidate.eventId);
      if (plannedEvent) {
        assertDuplicateEventIdInAppendMatches(plannedEvent, candidate);
        continue;
      }

      nextVersion += 1;
      const eventToInsert = { ...candidate, streamVersion: nextVersion };
      plannedEventsById.set(candidate.eventId, eventToInsert);
      combinedEventsToInsert.push(eventToInsert);
    }

    pendingStreams.push({ streamId: input.streamId, currentVersion, eventCandidates, existingEventsById });
  }

  const insertedEventsById = new Map<string, StoredEvent>();
  if (combinedEventsToInsert.length > 0) {
    // One advisory-lock acquisition, one multi-row INSERT, for every stream
    // in this chunk that passed its expected-version check above -- streams
    // excluded above never reach this INSERT, so their conflict never rolls
    // back a sibling stream's events.
    args.onAdvisoryLockAcquired();
    await args.client.query("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
      EVENT_STORE_GLOBAL_APPEND_ADVISORY_LOCK_KEY,
    ]);
    const insertResult = await args.client.query<DbEventRow>(
      buildInsertEventsSql(args.eventsTable, combinedEventsToInsert.length),
      buildInsertEventsParams(combinedEventsToInsert),
    );

    for (const row of insertResult.rows) {
      const storedEvent = mapDbEventRow(row);
      insertedEventsById.set(storedEvent.eventId, storedEvent);
    }

    if (insertedEventsById.size !== combinedEventsToInsert.length) {
      const missingEvents = combinedEventsToInsert.filter((event) => !insertedEventsById.has(event.eventId));
      const eventsConflictingDuringInsert = await readExistingEventsById(
        args.client,
        args.readEventsByIdsSql,
        missingEvents,
      );

      for (const missingEvent of missingEvents) {
        const existingEvent = eventsConflictingDuringInsert.get(missingEvent.eventId);
        if (!existingEvent) {
          throw createEventStoreError(
            "infrastructure_failure",
            "Failed to insert event row into Postgres event store.",
          );
        }

        assertIdempotentEventMatch(existingEvent, missingEvent);
        insertedEventsById.set(missingEvent.eventId, existingEvent);
      }
    }
  }

  for (const pendingStream of pendingStreams) {
    const storedEvents = pendingStream.eventCandidates.map((candidate) => {
      const storedEvent =
        pendingStream.existingEventsById.get(candidate.eventId) ?? insertedEventsById.get(candidate.eventId);
      if (!storedEvent) {
        throw createEventStoreError("infrastructure_failure", "Failed to insert event row into Postgres event store.");
      }
      return storedEvent;
    });
    const updatedStreamVersion = storedEvents.reduce(
      (version, event) => Math.max(version, event.streamVersion),
      pendingStream.currentVersion,
    );

    await args.client.query(args.updateStreamVersionSql, [pendingStream.streamId, updatedStreamVersion, now]);
    results.push({ streamId: pendingStream.streamId, outcome: "appended", storedEvents });
  }

  const resultsByStreamId = new Map(results.map((result) => [result.streamId, result] as const));
  return args.inputs.map((input) => {
    const result = resultsByStreamId.get(input.streamId);
    if (!result) {
      throw createEventStoreError("infrastructure_failure", "Missing independent append result for stream.", {
        streamId: input.streamId,
      });
    }
    return result;
  });
}

type AppendEventCandidate = Readonly<{
  eventId: EventId;
  streamId: string;
  event: EventRecordToStore;
  context: AppendToStreamInput["context"];
  now: IsoUtcTimestamp;
}>;

type AppendEventToInsert = AppendEventCandidate & Readonly<{ streamVersion: number }>;

function buildInsertEventsSql(eventsTable: string, eventCount: number): string {
  const columnCount = 17;
  const values = Array.from({ length: eventCount }, (_, rowIndex) => {
    const firstParam = rowIndex * columnCount + 1;
    const params = Array.from({ length: columnCount }, (__, columnIndex) => `$${firstParam + columnIndex}`);
    return `(${params.join(", ")})`;
  }).join(",\n      ");

  return `
    INSERT INTO ${eventsTable} (
      event_id,
      stream_id,
      stream_version,
      tenant_id,
      stream_context_name,
      stream_category,
      event_type,
      payload,
      metadata,
      occurred_at,
      recorded_at,
      performed_by_user_id,
      for_account_id,
      trace_id,
      span_id,
      parent_span_id,
      trace_state
    )
    VALUES
      ${values}
    ON CONFLICT (event_id) DO NOTHING
    RETURNING ${EVENT_COLUMNS}
  `;
}

function buildInsertEventsParams(events: readonly AppendEventToInsert[]): readonly unknown[] {
  const params: unknown[] = [];

  for (const event of events) {
    params.push(
      event.eventId,
      event.streamId,
      event.streamVersion,
      event.context.tenantId,
      streamContextName(event.streamId),
      streamCategory(event.streamId),
      event.event.eventType,
      event.event.payload,
      event.event.metadata ?? {},
      event.event.occurredAt ?? event.now,
      event.now,
      event.context.audit.performedByUserId,
      event.context.audit.forAccountId,
      event.context.trace?.traceId ?? null,
      event.context.trace?.spanId ?? null,
      event.context.trace?.parentSpanId ?? null,
      event.context.trace?.traceState ?? null,
    );
  }

  return params;
}

async function readExistingEventsById(
  client: PgPoolClient,
  readEventsByIdsSql: string,
  events: readonly AppendEventCandidate[],
): Promise<Map<string, StoredEvent>> {
  const eventIds = [...new Set(events.map((event) => event.eventId))];
  if (eventIds.length === 0) {
    return new Map();
  }

  const result = await client.query<DbEventRow>(readEventsByIdsSql, [eventIds]);
  return new Map(
    result.rows.map((row) => {
      const event = mapDbEventRow(row);
      return [event.eventId, event];
    }),
  );
}

function assertIdempotentEventMatch(existingEvent: StoredEvent, args: AppendEventCandidate): void {
  const expectedMetadata = args.event.metadata ?? {};
  if (
    existingEvent.streamId !== args.streamId ||
    existingEvent.tenantId !== args.context.tenantId ||
    existingEvent.eventType !== args.event.eventType ||
    stableJsonStringify(existingEvent.payload) !== stableJsonStringify(args.event.payload) ||
    stableJsonStringify(existingEvent.metadata) !== stableJsonStringify(expectedMetadata)
  ) {
    throw createEventStoreError("concurrency_conflict", "Event id was already used with different event data.", {
      eventId: existingEvent.eventId,
      streamId: args.streamId,
      existingStreamId: existingEvent.streamId,
      eventType: args.event.eventType,
      existingEventType: existingEvent.eventType,
    });
  }
}

function assertDuplicateEventIdInAppendMatches(first: AppendEventToInsert, duplicate: AppendEventCandidate): void {
  const expectedMetadata = duplicate.event.metadata ?? {};
  const firstMetadata = first.event.metadata ?? {};
  if (
    first.streamId !== duplicate.streamId ||
    first.context.tenantId !== duplicate.context.tenantId ||
    first.event.eventType !== duplicate.event.eventType ||
    stableJsonStringify(first.event.payload) !== stableJsonStringify(duplicate.event.payload) ||
    stableJsonStringify(firstMetadata) !== stableJsonStringify(expectedMetadata)
  ) {
    throw createEventStoreError("concurrency_conflict", "Event id was already used with different event data.", {
      eventId: duplicate.eventId,
      streamId: duplicate.streamId,
      existingStreamId: first.streamId,
      eventType: duplicate.event.eventType,
      existingEventType: first.event.eventType,
    });
  }
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function assertExpectedVersion(streamId: string, expectedVersion: ExpectedStreamVersion, currentVersion: number): void {
  if (expectedVersion === "any") {
    return;
  }

  if (expectedVersion === "no_stream") {
    if (currentVersion === 0) {
      return;
    }

    throw createEventStoreError("concurrency_conflict", "Expected no stream but stream already exists.", {
      streamId,
      expectedVersion,
      currentVersion,
    });
  }

  if (expectedVersion !== currentVersion) {
    throw createEventStoreError("concurrency_conflict", "Expected stream version does not match current version.", {
      streamId,
      expectedVersion,
      currentVersion,
    });
  }
}

function normalizeEventStoreWakeNotificationConfig(
  config: PostgresEventStoreWakeNotificationConfig | undefined,
): NormalizedEventStoreWakeNotificationConfig | null {
  if (!config?.enabled) {
    return null;
  }

  const channel = assertPostgresEventStoreWakeNotificationChannel(
    config.channel ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_CHANNEL,
  );
  const source = (config.source ?? DEFAULT_EVENT_STORE_WAKE_NOTIFICATION_SOURCE).trim();

  if (!source) {
    throw new Error("Event-store wake notification source is required.");
  }

  return {
    channel,
    source,
    maxPayloadBytes: Math.max(1, Math.floor(config.maxPayloadBytes ?? EVENT_STORE_WAKE_NOTIFICATION_MAX_PAYLOAD_BYTES)),
    ...(config.observer ? { observer: config.observer } : {}),
  };
}

type EmitEventStoreWakeNotificationAfterCommitArgs = Readonly<{
  client: PgPoolClient;
  config: NormalizedEventStoreWakeNotificationConfig;
  input: AppendToStreamInput;
  storedEvents: readonly StoredEvent[];
  emittedAt: IsoUtcTimestamp;
}>;

async function emitEventStoreWakeNotificationAfterCommit(
  args: EmitEventStoreWakeNotificationAfterCommitArgs,
): Promise<void> {
  if (args.storedEvents.length === 0) {
    return;
  }

  const envelope = createEventStoreWakeNotificationEnvelope({
    input: args.input,
    storedEvents: args.storedEvents,
    source: args.config.source,
    emittedAt: args.emittedAt,
  });
  const observation = createEventStoreWakeNotificationObservation(args.config.channel, envelope);
  let serialized: string;

  try {
    serialized = serializeEventStoreWakeNotificationEnvelope(envelope, {
      maxPayloadBytes: args.config.maxPayloadBytes,
    });
  } catch (error) {
    emitWakeNotificationObserver(args.config.observer?.payloadRejected, {
      ...observation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    await args.client.query("SELECT pg_notify($1, $2)", [args.config.channel, serialized]);
    emitWakeNotificationObserver(args.config.observer?.notificationEmitted, {
      ...observation,
      payloadBytes: byteLengthUtf8(serialized),
    });
  } catch (error) {
    emitWakeNotificationObserver(args.config.observer?.notificationFailed, {
      ...observation,
      error,
    });
  }
}

function emitWakeNotificationObserver<TEvent>(observer: ((event: TEvent) => void) | undefined, event: TEvent): void {
  try {
    observer?.(event);
  } catch {
    return;
  }
}

type CreateEventStoreWakeNotificationEnvelopeArgs = Readonly<{
  input: AppendToStreamInput;
  storedEvents: readonly StoredEvent[];
  source: string;
  emittedAt: IsoUtcTimestamp;
}>;

function createEventStoreWakeNotificationEnvelope(
  args: CreateEventStoreWakeNotificationEnvelopeArgs,
): EventStoreWakeNotificationEnvelope {
  const firstEvent = args.storedEvents[0];
  const lastEvent = args.storedEvents[args.storedEvents.length - 1];
  const correlationId = eventStoreWakeCorrelationId(args.input, args.storedEvents);

  return {
    schemaVersion: EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION,
    payloadVersion: EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION,
    kind: EVENT_STORE_WAKE_NOTIFICATION_KIND,
    source: args.source,
    emittedAt: args.emittedAt,
    ...(correlationId ? { correlationId } : {}),
    payload: {
      sourceContextName: args.input.wakeSourceContextName ?? streamContextName(args.input.streamId),
      streamCategory: streamCategory(args.input.streamId),
      firstGlobalPosition: firstEvent.globalPosition,
      lastGlobalPosition: lastEvent.globalPosition,
      eventCount: args.storedEvents.length,
      eventTypes: [...new Set(args.storedEvents.map((event) => event.eventType))],
    },
  };
}

function eventStoreWakeCorrelationId(input: AppendToStreamInput, storedEvents: readonly StoredEvent[]): string | null {
  return input.context.trace?.traceId ?? storedEvents[0]?.eventId ?? null;
}

function createEventStoreWakeNotificationObservation(
  channel: string,
  envelope: EventStoreWakeNotificationEnvelope,
): Omit<EventStoreWakeNotificationEmittedEvent, "payloadBytes"> {
  return {
    channel,
    sourceContextName: envelope.payload.sourceContextName,
    streamCategory: envelope.payload.streamCategory,
    firstGlobalPosition: envelope.payload.firstGlobalPosition,
    lastGlobalPosition: envelope.payload.lastGlobalPosition,
    eventCount: envelope.payload.eventCount,
    eventTypes: envelope.payload.eventTypes,
    emittedAt: envelope.emittedAt,
    correlationId: envelope.correlationId ?? null,
  };
}

export function serializeEventStoreWakeNotificationEnvelope(
  envelope: EventStoreWakeNotificationEnvelope,
  options: Readonly<{ maxPayloadBytes?: number }> = {},
): string {
  assertSafeEventStoreWakeNotificationEnvelope(envelope);
  const serialized = JSON.stringify(envelope);
  const maxPayloadBytes = Math.max(
    1,
    Math.floor(options.maxPayloadBytes ?? EVENT_STORE_WAKE_NOTIFICATION_MAX_PAYLOAD_BYTES),
  );
  const payloadBytes = byteLengthUtf8(serialized);

  if (payloadBytes > maxPayloadBytes) {
    throw new Error(
      `Event-store wake notification payload is ${payloadBytes} bytes, which exceeds the ${maxPayloadBytes} byte limit.`,
    );
  }

  return serialized;
}

export function parseEventStoreWakeNotificationEnvelope(
  payload: string | undefined,
): EventStoreWakeNotificationEnvelope | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as EventStoreWakeNotificationEnvelope;
    assertSafeEventStoreWakeNotificationEnvelope(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function assertPostgresEventStoreWakeNotificationChannel(channel: string): string {
  if (!POSTGRES_WAKE_NOTIFICATION_CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid Postgres event-store wake notification channel '${channel}'.`);
  }

  return channel;
}

function assertSafeEventStoreWakeNotificationEnvelope(envelope: EventStoreWakeNotificationEnvelope): void {
  if (envelope.schemaVersion !== EVENT_STORE_WAKE_NOTIFICATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported event-store wake notification schemaVersion '${String(envelope.schemaVersion)}'.`);
  }
  if (
    !Number.isInteger(envelope.payloadVersion) ||
    envelope.payloadVersion < EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION
  ) {
    throw new Error("Event-store wake notification payloadVersion must be a positive integer.");
  }
  if (envelope.kind !== EVENT_STORE_WAKE_NOTIFICATION_KIND) {
    throw new Error(`Unsupported event-store wake notification kind '${String(envelope.kind)}'.`);
  }
  if (!envelope.source?.trim()) {
    throw new Error("Event-store wake notification source is required.");
  }
  if (!envelope.emittedAt || Number.isNaN(new Date(envelope.emittedAt).getTime())) {
    throw new Error("Event-store wake notification emittedAt must be an ISO timestamp.");
  }

  assertSafeWakeNotificationPayload(envelope.payload);
  assertSafeWakeNotificationRecord(envelope.payload, "payload");
}

function assertSafeWakeNotificationPayload(payload: EventStoreWakeNotificationPayload): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Event-store wake notification payload must be a JSON object.");
  }
  if (typeof payload.sourceContextName !== "string" || !payload.sourceContextName.trim()) {
    throw new Error("Event-store wake notification payload.sourceContextName is required.");
  }
  if (typeof payload.streamCategory !== "string" || !payload.streamCategory.trim()) {
    throw new Error("Event-store wake notification payload.streamCategory is required.");
  }
  assertGlobalPositionString(payload.firstGlobalPosition, "payload.firstGlobalPosition");
  assertGlobalPositionString(payload.lastGlobalPosition, "payload.lastGlobalPosition");
  if (!Number.isInteger(payload.eventCount) || payload.eventCount < 1) {
    throw new Error("Event-store wake notification payload.eventCount must be a positive integer.");
  }
  if (!Array.isArray(payload.eventTypes) || payload.eventTypes.length < 1) {
    throw new Error("Event-store wake notification payload.eventTypes must contain at least one event type.");
  }
  for (const eventType of payload.eventTypes) {
    if (typeof eventType !== "string" || !eventType.trim()) {
      throw new Error("Event-store wake notification payload.eventTypes must contain non-empty strings.");
    }
  }
}

function assertGlobalPositionString(value: unknown, fieldName: string): asserts value is GlobalPosition {
  if (typeof value !== "string") {
    throw new Error(`Event-store wake notification ${fieldName} must be a global position string.`);
  }

  parseGlobalPosition(value);
}

function assertSafeWakeNotificationRecord(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Event-store wake notification ${path} must be a JSON object.`);
  }

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (SENSITIVE_WAKE_NOTIFICATION_KEY_PATTERN.test(key)) {
      throw new Error(`Event-store wake notification ${nestedPath} uses a sensitive payload key.`);
    }

    if (!nested || typeof nested !== "object") {
      continue;
    }

    if (Array.isArray(nested)) {
      for (let index = 0; index < nested.length; index += 1) {
        const item = nested[index];
        if (item && typeof item === "object") {
          assertSafeWakeNotificationRecord(item, `${nestedPath}[${index}]`);
        }
      }
      continue;
    }

    assertSafeWakeNotificationRecord(nested, nestedPath);
  }
}

function byteLengthUtf8(value: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : new TextEncoder().encode(value).length;
}

function assertEventPayloadSizes(inputs: readonly AppendToStreamInput[]): void {
  for (const input of inputs) {
    for (const event of input.events) {
      const payloadBytes = byteLengthUtf8(JSON.stringify(event.payload));
      if (payloadBytes <= EVENT_STORE_MAX_PAYLOAD_BYTES) {
        continue;
      }

      throw createEventStoreError(
        "payload_too_large",
        `Event payload is ${payloadBytes} bytes, which exceeds the ${EVENT_STORE_MAX_PAYLOAD_BYTES} byte limit.`,
        {
          eventType: event.eventType,
          payloadBytes,
          maxPayloadBytes: EVENT_STORE_MAX_PAYLOAD_BYTES,
        },
      );
    }
  }
}

function normalizeEventStoreError(error: unknown, message: string): EventStoreError {
  if (isEventStoreError(error)) {
    return error;
  }

  if (isPgUniqueViolation(error)) {
    return createEventStoreError("concurrency_conflict", "Unique constraint conflict while appending events.", {
      postgresCode: error.code,
    });
  }

  if (isPgRetryableTransientError(error)) {
    return createEventStoreError("concurrency_conflict", "Retryable Postgres conflict while appending events.", {
      postgresCode: getPgErrorCode(error),
    });
  }

  return createEventStoreError("infrastructure_failure", message, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

type PgError = Readonly<{
  code?: string;
}>;

function isPgUniqueViolation(error: unknown): error is PgError {
  return typeof error === "object" && error !== null && "code" in error && (error as PgError).code === "23505";
}

function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as PgError).code;
  return typeof code === "string" ? code : undefined;
}

function isEventStoreError(error: unknown): error is EventStoreError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    EVENT_STORE_ERROR_CODES.has((error as { code: string }).code)
  );
}

function mapDbEventRow(row: DbEventRow): StoredEvent {
  return {
    eventId: row.event_id as EventId,
    streamId: row.stream_id,
    streamVersion: toNumber(row.stream_version),
    globalPosition: coerceDbGlobalPosition(row.global_position, "global_position"),
    tenantId: row.tenant_id as StoredEvent["tenantId"],
    eventType: row.event_type,
    payload: toJsonObject(row.payload, "payload"),
    metadata: toJsonObject(row.metadata ?? {}, "metadata"),
    occurredAt: toIsoUtcTimestamp(row.occurred_at),
    recordedAt: toIsoUtcTimestamp(row.recorded_at),
    performedByUserId: row.performed_by_user_id as StoredEvent["performedByUserId"],
    forAccountId: row.for_account_id as StoredEvent["forAccountId"],
    traceId: row.trace_id ? (row.trace_id as StoredEvent["traceId"]) : undefined,
    spanId: row.span_id ? (row.span_id as StoredEvent["spanId"]) : undefined,
    parentSpanId: row.parent_span_id ? (row.parent_span_id as StoredEvent["parentSpanId"]) : undefined,
    traceState: row.trace_state ? row.trace_state : undefined,
  };
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

function assertEventStoreReadPageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_STORE_READ_PAGE_SIZE_LIMIT) {
    throw new Error(`Event store read limit must be an integer between 1 and ${EVENT_STORE_READ_PAGE_SIZE_LIMIT}.`);
  }

  return limit;
}

function createDefaultEventId(): EventId {
  return createId("evt");
}
