import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ExpectedStreamVersion, StoredEvent } from "@chase-sets/event-core/storage";

export type InMemoryEventStore = EventStore &
  Readonly<{
    streams: Map<string, StoredEvent[]>;
    streamIdsWithPrefix: (prefix: string) => string[];
    eventTypesFor: (streamId: string) => string[];
  }>;

/**
 * A minimal event store for unit specs that need real append semantics without
 * a database: per-stream expected-version enforcement, and an `appendToStreams`
 * that is genuinely all-or-nothing, including for zero-event pure version
 * guards. Suites that must observe PostgreSQL's own transaction and
 * advisory-lock behaviour use the `.db.test.ts` specs instead.
 */
export function createInMemoryEventStore(): InMemoryEventStore {
  const streams = new Map<string, StoredEvent[]>();
  let globalPosition = 0;
  let eventSequence = 0;

  function currentVersion(streamId: string): number {
    const stored = streams.get(streamId) ?? [];
    return stored.length === 0 ? 0 : stored[stored.length - 1].streamVersion;
  }

  function assertExpectedVersion(streamId: string, expectedVersion: ExpectedStreamVersion): void {
    const version = currentVersion(streamId);
    if (expectedVersion === "any") {
      return;
    }
    if (expectedVersion === "no_stream" ? version !== 0 : expectedVersion !== version) {
      throw createEventStoreError("concurrency_conflict", "Expected stream version does not match current version.", {
        streamId,
        expectedVersion,
        currentVersion: version,
      });
    }
  }

  function materialize(input: AppendToStreamInput): StoredEvent[] {
    let version = currentVersion(input.streamId);
    return input.events.map((event) => {
      version += 1;
      globalPosition += 1;
      eventSequence += 1;
      return {
        eventId: event.eventId ?? `evt_memory_${eventSequence}`,
        streamId: input.streamId,
        streamVersion: version,
        globalPosition: String(globalPosition),
        tenantId: input.context.tenantId,
        eventType: event.eventType,
        payload: event.payload,
        metadata: event.metadata ?? {},
        occurredAt: event.occurredAt ?? new Date().toISOString(),
        recordedAt: new Date().toISOString(),
        performedByUserId: input.context.audit.performedByUserId,
        forAccountId: input.context.audit.forAccountId,
      } as StoredEvent;
    });
  }

  function commit(storedEvents: readonly StoredEvent[]): void {
    for (const storedEvent of storedEvents) {
      streams.set(storedEvent.streamId, [...(streams.get(storedEvent.streamId) ?? []), storedEvent]);
    }
  }

  return {
    streams,
    streamIdsWithPrefix: (prefix) => [...streams.keys()].filter((streamId) => streamId.startsWith(prefix)),
    eventTypesFor: (streamId) => (streams.get(streamId) ?? []).map((event) => event.eventType),
    appendToStream: async (input) => {
      assertExpectedVersion(input.streamId, input.expectedVersion);
      const storedEvents = materialize(input);
      commit(storedEvents);
      return storedEvents;
    },
    // Every version is asserted before anything is committed, so one
    // participant's conflict leaves no other participant's events behind.
    appendToStreams: async (inputs) => {
      for (const input of inputs) {
        assertExpectedVersion(input.streamId, input.expectedVersion);
      }
      const results = inputs.map((input) => ({ streamId: input.streamId, storedEvents: materialize(input) }));
      for (const result of results) {
        commit(result.storedEvents);
      }
      return results;
    },
    readStream: async ({ streamId, fromVersion, limit }) => {
      const stored = (streams.get(streamId) ?? []).filter((event) => event.streamVersion >= (fromVersion ?? 0));
      return limit === undefined ? stored : stored.slice(0, limit);
    },
    readAll: async (input) => {
      const all = [...streams.values()]
        .flat()
        .sort((left, right) => Number(left.globalPosition) - Number(right.globalPosition));
      const filtered = input?.streamPrefixes
        ? all.filter((event) => input.streamPrefixes!.some((prefix) => event.streamId.startsWith(prefix)))
        : all;
      return input?.limit === undefined ? filtered : filtered.slice(0, input.limit);
    },
  };
}
