import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { JsonObject } from "../primitives/json";
import type { AccountId, EventId, SpanId, TenantId, TraceId, UserId } from "../primitives/typed-ids";
import {
  isIdentityAccountBlockFactEventType,
  isIdentityAccountBlockPrivateEventType,
  parseIdentityAccountBlockFactPayload,
} from "./public-event-payloads/identity";
import type { GlobalPosition, StoredEvent, StreamId, StreamVersion } from "./storage";

export type TransportEvent = Readonly<{
  id: EventId;
  type: string;
  streamId: StreamId;
  streamVersion: StreamVersion;
  globalPosition: GlobalPosition;
  tenantId: TenantId;
  data: JsonObject;
  metadata: JsonObject;
  audit: Readonly<{
    performedByUserId: UserId;
    forAccountId: AccountId;
  }>;
  trace: Readonly<{
    traceId?: TraceId | undefined;
    spanId?: SpanId | undefined;
    parentSpanId?: SpanId | undefined;
    traceState?: string | undefined;
  }>;
  timing: Readonly<{
    occurredAt: IsoUtcTimestamp;
    recordedAt: IsoUtcTimestamp;
  }>;
}>;

export type TransportEventPayload = TransportEvent["data"];

export type TypedTransportEvent<
  TPayload extends TransportEventPayload = TransportEventPayload,
  TEventType extends string = string,
> = Omit<TransportEvent, "type" | "data"> &
  Readonly<{
    type: TEventType;
    data: TPayload;
  }>;

/**
 * Neutral envelope values for privacy-redacted integration events. They name no real
 * User, Account, trace or instant, so a redacted event carries nothing beyond its
 * position and closed payload.
 */
export const redactedTransportAudit: TransportEvent["audit"] = Object.freeze({
  performedByUserId: "usr_redacted" as UserId,
  forAccountId: "acc_redacted" as AccountId,
});

export const redactedTransportTiming: TransportEvent["timing"] = Object.freeze({
  occurredAt: "1970-01-01T00:00:00.000Z" as IsoUtcTimestamp,
  recordedAt: "1970-01-01T00:00:00.000Z" as IsoUtcTimestamp,
});

/**
 * Event types whose authority is private to the owning context. Subscription
 * registration refuses them for any subscriber outside that context.
 */
export function isContextPrivateEventType(eventType: string): boolean {
  return isIdentityAccountBlockPrivateEventType(eventType);
}

/**
 * Event types published with a privacy-redacted envelope: Account Block facts, plus the
 * private Account Block types for the rare in-context reader.
 */
export function isPrivacyRedactedTransportEventType(eventType: string): boolean {
  return isIdentityAccountBlockFactEventType(eventType) || isIdentityAccountBlockPrivateEventType(eventType);
}

export function toTransportEvent(event: StoredEvent): TransportEvent {
  if (isPrivacyRedactedTransportEventType(event.eventType)) {
    return toPrivacyRedactedTransportEvent(event);
  }
  return {
    id: event.eventId,
    type: event.eventType,
    streamId: event.streamId,
    streamVersion: event.streamVersion,
    globalPosition: event.globalPosition,
    tenantId: event.tenantId,
    data: event.payload,
    metadata: event.metadata,
    audit: {
      performedByUserId: event.performedByUserId,
      forAccountId: event.forAccountId,
    },
    trace: {
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      traceState: event.traceState,
    },
    timing: {
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
    },
  };
}

/**
 * Keeps only id, type, stream position, tenant and data. Audit (initiating User), session
 * or other metadata, trace and timing are neutral. A public Account Block fact's data is
 * re-read through its closed codec, so a planted field fails closed instead of crossing.
 */
function toPrivacyRedactedTransportEvent(event: StoredEvent): TransportEvent {
  return {
    id: event.eventId,
    type: event.eventType,
    streamId: event.streamId,
    streamVersion: event.streamVersion,
    globalPosition: event.globalPosition,
    tenantId: event.tenantId,
    data: isIdentityAccountBlockFactEventType(event.eventType)
      ? { ...parseIdentityAccountBlockFactPayload(event.payload) }
      : event.payload,
    metadata: {},
    audit: { ...redactedTransportAudit },
    trace: {},
    timing: { ...redactedTransportTiming },
  };
}
