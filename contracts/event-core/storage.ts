import type { Branded } from "../primitives/brand";
import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { JsonObject } from "../primitives/json";
import type { AccountId, EventId, SpanId, TenantId, TraceId, UserId } from "../primitives/typed-ids";

export type StreamId = string;

export type StreamVersion = number;

export type GlobalPosition = Branded<string, "GlobalPosition">;

export type ExpectedStreamVersion = StreamVersion | "any" | "no_stream";

const GLOBAL_POSITION_RE = /^(0|[1-9]\d*)$/;

export const ZERO_GLOBAL_POSITION = "0" as GlobalPosition;

export function parseGlobalPosition(value: string): GlobalPosition {
  if (!GLOBAL_POSITION_RE.test(value)) {
    throw new Error("GlobalPosition must be a canonical unsigned base-10 string.");
  }

  return value as GlobalPosition;
}

export function globalPositionFromBigInt(value: bigint): GlobalPosition {
  if (value < BigInt(0)) {
    throw new Error("GlobalPosition must be non-negative.");
  }

  return value.toString() as GlobalPosition;
}

export function globalPositionToBigInt(value: GlobalPosition): bigint {
  return BigInt(value);
}

export function compareGlobalPosition(left: GlobalPosition, right: GlobalPosition): -1 | 0 | 1 {
  const leftValue = globalPositionToBigInt(left);
  const rightValue = globalPositionToBigInt(right);

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

export type EventAuditContext = Readonly<{
  performedByUserId: UserId;
  forAccountId: AccountId;
}>;

export type EventTraceContext = Readonly<{
  traceId?: TraceId;
  spanId?: SpanId;
  parentSpanId?: SpanId;
  traceState?: string;
}>;

export type EventStoreContext = Readonly<{
  tenantId: TenantId;
  audit: EventAuditContext;
  trace?: EventTraceContext;
}>;

export type EventRecordToStore = Readonly<{
  eventId?: EventId;
  eventType: string;
  payload: JsonObject;
  metadata?: JsonObject;
  occurredAt?: IsoUtcTimestamp;
}>;

export type StoredEvent<
  EventType extends string = string,
  Payload extends JsonObject = JsonObject,
  Metadata extends JsonObject = JsonObject,
> = Readonly<{
  eventId: EventId;
  streamId: StreamId;
  streamVersion: StreamVersion;
  globalPosition: GlobalPosition;
  tenantId: TenantId;
  eventType: EventType;
  payload: Payload;
  metadata: Metadata;
  occurredAt: IsoUtcTimestamp;
  recordedAt: IsoUtcTimestamp;
  performedByUserId: UserId;
  forAccountId: AccountId;
  traceId?: TraceId;
  spanId?: SpanId;
  parentSpanId?: SpanId;
  traceState?: string;
}>;

export type AppendToStreamInput = Readonly<{
  streamId: StreamId;
  wakeSourceContextName?: string;
  expectedVersion: ExpectedStreamVersion;
  events: readonly EventRecordToStore[];
  context: EventStoreContext;
}>;

/**
 * The maximum number of events any EventStore `readStream` page may return. Store
 * implementations enforce this shared contract; complete-history callers must
 * page rather than increasing the limit.
 */
export const EVENT_STORE_READ_PAGE_SIZE_MAX = 500;

/**
 * `fromVersion` is inclusive. `limit` defaults to, and may not exceed,
 * `EVENT_STORE_READ_PAGE_SIZE_MAX`, so one read never proves that a full stream
 * was returned.
 */
export type ReadStreamInput = Readonly<{
  streamId: StreamId;
  fromVersion?: StreamVersion;
  limit?: number;
}>;

export type ReadAllInput = Readonly<{
  afterGlobalPosition?: GlobalPosition;
  /**
   * Inclusive reconciliation horizon. When supplied, the store refuses the
   * read if this position is above its current gap-safe head.
   */
  atOrBeforeGlobalPosition?: GlobalPosition;
  tenantId?: TenantId;
  eventTypes?: readonly string[];
  streamPrefixes?: readonly string[];
  limit?: number;
}>;
