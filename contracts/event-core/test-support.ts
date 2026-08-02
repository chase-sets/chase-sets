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
import { EVENT_STORE_READ_PAGE_SIZE_MAX } from "./storage";
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

export const EVENT_STORE_READ_ALL_PAGE_SIZE_BOUNDARIES = {
  accepted: [1, EVENT_STORE_READ_PAGE_SIZE_MAX],
  rejected: [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 501],
} as const;

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

export type BoundedStreamReadContractInput = Readonly<{
  streamId: string;
  bound: number;
  historyLength: number;
  requests: readonly ReadStreamInput[];
}>;

/**
 * Proves that a bounded-prefix production read requested its declared prefix
 * against history long enough to expose an accidental unbounded read.
 *
 * Owning-workspace tests record the real store method with their test runner;
 * this helper deliberately does not wrap or call `readStream`, so the direct
 * production-call inventory stays authoritative.
 */
export function assertBoundedStreamReadContract(input: BoundedStreamReadContractInput): void {
  if (!Number.isSafeInteger(input.bound) || input.bound < 1 || input.bound > EVENT_STORE_READ_PAGE_SIZE_MAX) {
    throw new Error(
      `Bounded stream read contract requires an integer bound between 1 and ${EVENT_STORE_READ_PAGE_SIZE_MAX}.`,
    );
  }
  if (!Number.isSafeInteger(input.historyLength) || input.historyLength <= input.bound) {
    throw new Error("Bounded stream read contract history must be longer than the declared bound.");
  }
  if (input.requests.length !== 1) {
    throw new Error(`Bounded stream read contract expected exactly one request, received ${input.requests.length}.`);
  }

  const request = input.requests[0];
  if (request?.streamId !== input.streamId) {
    throw new Error(`Bounded stream read contract expected stream ${input.streamId}.`);
  }
  if (request.fromVersion !== undefined) {
    throw new Error("Bounded prefix reads must begin at the first stream event.");
  }
  if (request.limit !== input.bound) {
    throw new Error(`Bounded stream read contract expected literal bound ${input.bound}.`);
  }
}

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
      // Every input's expected version is enforced, including a zero-event
      // one: that input is a pure version guard on a stream this append does
      // not write to, and skipping it would silently drop the guard.
      for (const input of inputs) {
        assertExpectedVersion(input.streamId, input.expectedVersion, currentVersion(input));
      }

      const priorGlobalPosition = globalPosition;
      const priorStreams = new Map([...streams].map(([streamId, events]) => [streamId, [...events]]));
      const priorAllEvents = [...allEvents];
      const priorEventsById = new Map(eventsById);

      try {
        return inputs.map((input) => ({
          streamId: input.streamId,
          storedEvents: input.events.length === 0 ? [] : appendToStream(input),
        }));
      } catch (error) {
        globalPosition = priorGlobalPosition;
        streams.clear();
        for (const [streamId, events] of priorStreams) streams.set(streamId, events);
        allEvents.splice(0, allEvents.length, ...priorAllEvents);
        eventsById.clear();
        for (const [eventId, event] of priorEventsById) eventsById.set(eventId, event);
        throw error;
      }
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
      const fromVersion = assertPositiveInteger(input.fromVersion ?? 1, "fromVersion");
      const limit = assertEventStoreReadPageSize(input.limit ?? EVENT_STORE_READ_PAGE_SIZE_MAX);
      return (streams.get(input.streamId) ?? []).filter((event) => event.streamVersion >= fromVersion).slice(0, limit);
    },
    readAll: async (input?: ReadAllInput) => {
      const limit = assertEventStoreReadPageSize(input?.limit ?? EVENT_STORE_READ_PAGE_SIZE_MAX);
      const after = BigInt(input?.afterGlobalPosition ?? "0");
      const safeHead = globalPosition;
      const atOrBefore = BigInt(input?.atOrBeforeGlobalPosition ?? safeHead.toString());
      if (atOrBefore > safeHead) {
        throw createEventStoreError(
          "infrastructure_failure",
          "Requested global event horizon is beyond the gap-safe event store head.",
          { requestedGlobalPosition: atOrBefore.toString(), safeHeadGlobalPosition: safeHead.toString() },
        );
      }
      return allEvents
        .filter((event) => BigInt(event.globalPosition) > after)
        .filter((event) => BigInt(event.globalPosition) <= atOrBefore)
        .filter((event) => !input?.tenantId || event.tenantId === input.tenantId)
        .filter((event) => !input?.eventTypes?.length || input.eventTypes.includes(event.eventType))
        .filter(
          (event) =>
            !input?.streamPrefixes?.length || input.streamPrefixes.some((prefix) => event.streamId.startsWith(prefix)),
        )
        .slice(0, limit);
    },
  };

  return { eventStore, allEvents, readAllEvents: () => allEvents, streams };
}

function assertPositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return value;
}

function assertEventStoreReadPageSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EVENT_STORE_READ_PAGE_SIZE_MAX) {
    throw new Error(`Event store read limit must be an integer between 1 and ${EVENT_STORE_READ_PAGE_SIZE_MAX}.`);
  }
  return limit;
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
