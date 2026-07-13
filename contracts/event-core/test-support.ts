import type { JsonObject } from "../primitives/json";
import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { AccountId, EventId, TenantId, UserId } from "../primitives/typed-ids";
import type { ChaseSetsEventPayloads } from "./public-event-payloads";
import type { TransportEvent } from "./transport";

export type TransportEventFixtureOverrides = Readonly<
  Partial<{
    id: string;
    streamId: string;
    streamVersion: number;
    globalPosition: string;
    tenantId: string;
    metadata: JsonObject;
    audit: Readonly<{
      performedByUserId: string;
      forAccountId: string | null;
    }>;
    trace: TransportEvent["trace"];
    timing: Readonly<{
      occurredAt: string;
      recordedAt: string;
    }>;
  }>
>;

type PublicEventType = keyof ChaseSetsEventPayloads & string;

/**
 * Builds the transport envelope used by projection and subscription tests.
 *
 * Public event names are tied to their shared payload type. Other event names
 * remain available for context-local fixtures, while still requiring a JSON
 * object payload and sharing the same correctly-shaped envelope.
 */
export function buildTransportEvent<TEventType extends PublicEventType>(
  type: TEventType,
  data: ChaseSetsEventPayloads[TEventType],
  overrides?: TransportEventFixtureOverrides,
): TransportEvent;
export function buildTransportEvent<TEventType extends string, TPayload extends Record<string, unknown>>(
  type: TEventType,
  data: TPayload,
  overrides?: TransportEventFixtureOverrides,
): TransportEvent;
export function buildTransportEvent(
  type: string,
  data: Record<string, unknown>,
  overrides: TransportEventFixtureOverrides = {},
): TransportEvent {
  return {
    id: (overrides.id ?? "evt_fixture") as EventId,
    type,
    streamId: overrides.streamId ?? "fixture.stream-1",
    streamVersion: overrides.streamVersion ?? 1,
    globalPosition: (overrides.globalPosition ?? "1") as TransportEvent["globalPosition"],
    tenantId: (overrides.tenantId ?? "tnt_fixture") as TenantId,
    data: data as JsonObject,
    metadata: overrides.metadata ?? {},
    audit: {
      performedByUserId: (overrides.audit?.performedByUserId ?? "usr_fixture") as UserId,
      forAccountId: (overrides.audit?.forAccountId !== undefined
        ? overrides.audit.forAccountId
        : "acc_fixture") as AccountId,
    },
    trace: overrides.trace ?? {},
    timing: {
      occurredAt: (overrides.timing?.occurredAt ?? "2026-01-01T00:00:00.000Z") as IsoUtcTimestamp,
      recordedAt: (overrides.timing?.recordedAt ?? "2026-01-01T00:00:00.000Z") as IsoUtcTimestamp,
    },
  };
}
