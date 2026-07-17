import type { JsonObject } from "../primitives/json";
import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { AccountId, EventId, TenantId, UserId } from "../primitives/typed-ids";
import {
  createEventStoreError,
  type AppendToStreamsIndependentResult,
  type EventStore,
  type EventStoreError,
} from "./event-store";
import type { ChaseSetsEventPayloads } from "./public-event-payloads";
import type {
  AppendToStreamInput,
  EventRecordToStore,
  ExpectedStreamVersion,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "./storage";
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

export type InMemoryEventStore = Readonly<{
  eventStore: EventStore;
  allEvents: StoredEvent[];
  readAllEvents: () => StoredEvent[];
  streams: Map<string, StoredEvent[]>;
}>;

/**
 * Provides the shared test-only event store used by context runtime suites.
 *
 * Its append and read behavior intentionally mirrors event-core-postgres:
 * stream versions are one-based, `fromVersion` is inclusive, expected
 * versions are enforced, explicit event ids are idempotent, and global reads
 * apply the same cursor, tenant, event-type, prefix, and page-size filters.
 */
export function createInMemoryEventStore(): InMemoryEventStore {
  let globalPosition = 0n;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];
  const eventsById = new Map<string, StoredEvent>();

  function appendStoredEvents(input: AppendToStreamInput): StoredEvent[] {
    const existing = streams.get(input.streamId) ?? [];
    const now = new Date().toISOString() as IsoUtcTimestamp;
    const plannedById = new Map<string, StoredEvent>();
    const stored: StoredEvent[] = [];
    let nextVersion = existing.length;

    for (const event of input.events) {
      const eventId = (event.eventId ?? `evt_${globalPosition + 1n}`) as EventId;
      const existingEvent = eventsById.get(eventId);
      if (existingEvent) {
        assertIdempotentEventMatch(existingEvent, input, eventId);
        stored.push(existingEvent);
        nextVersion = Math.max(nextVersion, existingEvent.streamVersion);
        continue;
      }

      const plannedEvent = plannedById.get(eventId);
      if (plannedEvent) {
        assertIdempotentEventMatch(plannedEvent, input, eventId, event);
        stored.push(plannedEvent);
        nextVersion = Math.max(nextVersion, plannedEvent.streamVersion);
        continue;
      }

      nextVersion += 1;
      globalPosition += 1n;
      const created: StoredEvent = {
        eventId,
        streamId: input.streamId,
        streamVersion: nextVersion,
        globalPosition: globalPosition.toString() as GlobalPosition,
        tenantId: input.context.tenantId,
        eventType: event.eventType,
        payload: event.payload,
        metadata: event.metadata ?? {},
        occurredAt: event.occurredAt ?? now,
        recordedAt: now,
        performedByUserId: input.context.audit.performedByUserId,
        forAccountId: input.context.audit.forAccountId,
        traceId: input.context.trace?.traceId,
        spanId: input.context.trace?.spanId,
        parentSpanId: input.context.trace?.parentSpanId,
        traceState: input.context.trace?.traceState,
      };
      plannedById.set(eventId, created);
      stored.push(created);
    }

    const newEvents = [...plannedById.values()];
    streams.set(input.streamId, [...existing, ...newEvents]);
    allEvents.push(...newEvents);
    for (const event of newEvents) {
      eventsById.set(event.eventId, event);
    }
    return stored;
  }

  function currentVersion(input: AppendToStreamInput): number {
    return streams.get(input.streamId)?.length ?? 0;
  }

  function appendToStream(input: AppendToStreamInput): readonly StoredEvent[] {
    if (input.events.length === 0) {
      return [];
    }

    const deterministicIds = input.events.map((event) => event.eventId).filter((id): id is EventId => id !== undefined);
    if (deterministicIds.length === input.events.length && deterministicIds.every((id) => eventsById.has(id))) {
      return deterministicIds.map((eventId) => {
        const stored = eventsById.get(eventId)!;
        assertIdempotentEventMatch(stored, input, eventId);
        return stored;
      });
    }
    assertExpectedVersion(input.streamId, input.expectedVersion, currentVersion(input));
    return appendStoredEvents(input);
  }

  const eventStore: EventStore = {
    appendToStream: async (input) => appendToStream(input),
    appendToStreams: async (inputs) => {
      const appendableInputs = inputs.filter((input) => input.events.length > 0);
      for (const input of appendableInputs) {
        assertExpectedVersion(input.streamId, input.expectedVersion, currentVersion(input));
      }

      const results = inputs.map((input) => ({
        streamId: input.streamId,
        storedEvents: input.events.length === 0 ? [] : appendToStream(input),
      }));
      return results;
    },
    appendToStreamsIndependently: async (inputs) => {
      const results: AppendToStreamsIndependentResult[] = [];
      for (const input of inputs) {
        if (input.events.length === 0) {
          results.push({ streamId: input.streamId, outcome: "no_op", storedEvents: [] });
          continue;
        }

        try {
          results.push({ streamId: input.streamId, outcome: "appended", storedEvents: appendToStream(input) });
        } catch (error) {
          results.push({
            streamId: input.streamId,
            outcome: "conflict",
            storedEvents: [],
            error: isEventStoreError(error) ? error : createEventStoreError("infrastructure_failure", String(error)),
          });
        }
      }
      return results;
    },
    readStream: async (input) => {
      const fromVersion = input.fromVersion ?? 1;
      const limit = input.limit ?? 500;
      return [...(streams.get(input.streamId) ?? [])].slice(fromVersion - 1, fromVersion - 1 + limit);
    },
    readAll: async (input?: ReadAllInput) => {
      const after = BigInt(input?.afterGlobalPosition ?? "0");
      return allEvents
        .filter((event) => BigInt(event.globalPosition) > after)
        .filter((event) => !input?.tenantId || event.tenantId === input.tenantId)
        .filter((event) => !input?.eventTypes?.length || input.eventTypes.includes(event.eventType))
        .filter(
          (event) =>
            !input?.streamPrefixes?.length || input.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix)),
        )
        .slice(0, input?.limit ?? 500);
    },
  };

  return { eventStore, allEvents, readAllEvents: () => allEvents, streams };
}

function assertExpectedVersion(streamId: string, expectedVersion: ExpectedStreamVersion, current: number): void {
  if (expectedVersion === "any") {
    return;
  }
  if (expectedVersion === "no_stream" && current !== 0) {
    throw createEventStoreError("concurrency_conflict", "Expected no stream but stream already exists.", {
      streamId,
      expectedVersion,
      currentVersion: current,
    });
  }
  if (typeof expectedVersion === "number" && expectedVersion !== current) {
    throw createEventStoreError("concurrency_conflict", "Expected stream version does not match current version.", {
      streamId,
      expectedVersion,
      currentVersion: current,
    });
  }
}

function assertIdempotentEventMatch(
  existing: StoredEvent,
  input: AppendToStreamInput,
  eventId: EventId,
  event?: EventRecordToStore,
): void {
  const candidate = event ?? input.events.find((entry) => (entry.eventId ?? eventId) === eventId);
  if (!candidate) {
    return;
  }
  if (
    existing.streamId !== input.streamId ||
    existing.tenantId !== input.context.tenantId ||
    existing.eventType !== candidate.eventType ||
    stableJsonStringify(existing.payload) !== stableJsonStringify(candidate.payload) ||
    stableJsonStringify(existing.metadata) !== stableJsonStringify(candidate.metadata ?? {})
  ) {
    throw createEventStoreError("concurrency_conflict", "Event id was already used with different event data.", {
      eventId,
      streamId: input.streamId,
      existingStreamId: existing.streamId,
      eventType: candidate.eventType,
      existingEventType: existing.eventType,
    });
  }
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isEventStoreError(error: unknown): error is EventStoreError {
  return Boolean(error && typeof error === "object" && "code" in error);
}
