import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { JsonObject } from "@chase-sets/primitives/json";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventId } from "@chase-sets/primitives/typed-ids";
import { createEventStoreError, EventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import { ZERO_GLOBAL_POSITION, globalPositionFromBigInt, parseGlobalPosition } from "@chase-sets/event-core/storage";
import { observeEventStoreOperation } from "@chase-sets/observability";
import type {
  AppendToStreamInput,
  EventRecordToStore,
  ExpectedStreamVersion,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import type { PgPoolClient, PgTransactionalPool } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

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
  payloadVersion: typeof EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION;
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

  const insertEventSql = `
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
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
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

  return {
    appendToStream: async (input) => {
      if (input.events.length === 0) {
        return [];
      }

      return observeEventStoreOperation(
        "append_to_stream",
        {
          event_count: input.events.length,
          event_type: input.events.length === 1 ? input.events[0].eventType : "multiple",
        },
        async () => {
          try {
            return await withTransaction(
              pool,
              async (client) =>
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
              wakeNotifications
                ? (client, storedEvents) =>
                    emitEventStoreWakeNotificationAfterCommit({
                      client,
                      config: wakeNotifications,
                      input,
                      storedEvents,
                      emittedAt: now(),
                    })
                : undefined,
            );
          } catch (error) {
            throw normalizeEventStoreError(error, "Failed to append events to Postgres event store.");
          }
        },
      );
    },

    readStream: async (input: ReadStreamInput) => {
      const fromVersion = assertPositiveInteger(input.fromVersion ?? 1, "fromVersion");
      const limit = assertPositiveInteger(input.limit ?? 500, "limit");

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
      const limit = assertPositiveInteger(input?.limit ?? 500, "limit");

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
            const result = await pool.query<DbEventRow>(
              buildReadAllSql(eventsTable, input),
              buildReadAllParams({
                afterGlobalPosition,
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

type ReadAllQueryInput = Readonly<{
  afterGlobalPosition: GlobalPosition;
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
  const predicates = ["global_position > $1::bigint"];
  let nextParam = 2;

  if (input?.tenantId) {
    predicates.push(`tenant_id = $${nextParam}`);
    nextParam += 1;
  }

  if (input?.eventTypes?.length) {
    predicates.push(`event_type = ANY($${nextParam}::text[])`);
    nextParam += 1;
  }

  if (input?.streamPrefixes?.length) {
    const streamContextNames = normalizedStreamContextNames(input.streamPrefixes);
    if (streamContextNames.length > 0) {
      predicates.push(`stream_context_name = ANY($${nextParam}::text[])`);
      nextParam += 1;
    }
    const streamCategories = normalizedStreamCategories(input.streamPrefixes);
    if (streamCategories.length > 0) {
      predicates.push(`stream_category = ANY($${nextParam}::text[])`);
      nextParam += 1;
    }
    const prefixPredicates = [...new Set(input.streamPrefixes)].map((_, index) => {
      const prefixParam = nextParam + index;
      return `stream_id LIKE $${prefixParam} || '%'`;
    });
    predicates.push(`(${prefixPredicates.join(" OR ")})`);
    nextParam += prefixPredicates.length;
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
  const params: unknown[] = [input.afterGlobalPosition];

  if (input.tenantId) {
    params.push(input.tenantId);
  }

  if (input.eventTypes?.length) {
    params.push([...new Set(input.eventTypes)]);
  }

  if (input.streamPrefixes?.length) {
    const streamContextNames = normalizedStreamContextNames(input.streamPrefixes);
    if (streamContextNames.length > 0) {
      params.push(streamContextNames);
    }
    const streamCategories = normalizedStreamCategories(input.streamPrefixes);
    if (streamCategories.length > 0) {
      params.push(streamCategories);
    }
    params.push(...new Set(input.streamPrefixes));
  }

  params.push(input.limit);
  return params;
}

function normalizedStreamContextNames(streamPrefixes: readonly string[]): readonly string[] {
  return [
    ...new Set(
      streamPrefixes
        .map((prefix) => {
          const separatorIndex = prefix.indexOf(".");
          return separatorIndex > 0 ? prefix.slice(0, separatorIndex) : null;
        })
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function normalizedStreamCategories(streamPrefixes: readonly string[]): readonly string[] {
  return [
    ...new Set(
      streamPrefixes
        .filter((prefix) => prefix.endsWith("-"))
        .map((prefix) => prefix.slice(0, -1))
        .filter(Boolean),
    ),
  ];
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

  await args.client.query(args.updateStreamVersionSql, [args.input.streamId, nextVersion, now]);

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

async function insertSingleEvent(args: InsertSingleEventArgs): Promise<StoredEvent> {
  const result = await args.client.query<DbEventRow>(args.insertEventSql, [
    args.createEventId(),
    args.streamId,
    args.streamVersion,
    args.context.tenantId,
    streamContextName(args.streamId),
    streamCategory(args.streamId),
    args.event.eventType,
    args.event.payload,
    args.event.metadata ?? {},
    args.event.occurredAt ?? args.now,
    args.now,
    args.context.audit.performedByUserId,
    args.context.audit.forAccountId,
    args.context.trace?.traceId ?? null,
    args.context.trace?.spanId ?? null,
    args.context.trace?.parentSpanId ?? null,
    args.context.trace?.traceState ?? null,
  ]);

  if (result.rows.length !== 1) {
    throw createEventStoreError("infrastructure_failure", "Failed to insert event row into Postgres event store.");
  }

  return mapDbEventRow(result.rows[0]);
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

function streamContextName(streamId: string): string {
  const separatorIndex = streamId.indexOf(".");
  return separatorIndex > 0 ? streamId.slice(0, separatorIndex) : streamId;
}

function streamCategory(streamId: string): string {
  const lastDashIndex = streamId.lastIndexOf("-");
  return lastDashIndex > 0 ? streamId.slice(0, lastDashIndex) : streamId;
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
    args.config.observer?.payloadRejected?.({
      ...observation,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    await args.client.query("SELECT pg_notify($1, $2)", [args.config.channel, serialized]);
    args.config.observer?.notificationEmitted?.({
      ...observation,
      payloadBytes: byteLengthUtf8(serialized),
    });
  } catch (error) {
    args.config.observer?.notificationFailed?.({
      ...observation,
      error,
    });
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
      sourceContextName: streamContextName(args.input.streamId),
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
  if (envelope.payloadVersion !== EVENT_STORE_WAKE_NOTIFICATION_PAYLOAD_VERSION) {
    throw new Error(`Unsupported event-store wake notification payloadVersion '${String(envelope.payloadVersion)}'.`);
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

async function withTransaction<T>(
  pool: PgTransactionalPool,
  work: (client: PgPoolClient) => Promise<T>,
  afterCommit?: (client: PgPoolClient, result: T) => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    committed = true;
    await afterCommit?.(client, result);
    return result;
  } catch (error) {
    if (!committed) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    client.release();
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

function createDefaultEventId(): EventId {
  return createId("evt");
}
