import { describe, expect, it, vi } from "vitest";
import { createAggregateCommandHandler } from "./aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "./codec";
import type { EventStore } from "./event-store";
import type { DomainEvent } from "./domain";
import type { StoredEvent } from "./storage";
import { createInMemoryEventStore } from "./test-support";

type CounterEvent = DomainEvent<"counter.incremented", { by: number }>;
type CounterCommand = Readonly<{ type: "Increment"; by: number }>;

describe("aggregate command handler factory", () => {
  const existingEvent: StoredEvent<"counter.incremented", { by: number }> = {
    eventId: "evt_1" as never,
    streamId: "counter-1",
    streamVersion: 1,
    globalPosition: "10" as never,
    tenantId: "tnt_1" as never,
    eventType: "counter.incremented",
    payload: { by: 2 },
    metadata: {},
    occurredAt: "2026-04-30T00:00:00.000Z" as never,
    recordedAt: "2026-04-30T00:00:00.000Z" as never,
    performedByUserId: "usr_1" as never,
    forAccountId: "acc_1" as never,
  };
  const appendedEvent: StoredEvent<"counter.incremented", { by: number }> = {
    ...existingEvent,
    eventId: "evt_2" as never,
    streamVersion: 2,
    globalPosition: "11" as never,
    payload: { by: 3 },
  };
  const context = {
    tenantId: "tnt_1" as never,
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
  };

  it("creates a repository and command handler from aggregate wiring", async () => {
    const appendToStream = vi.fn<EventStore["appendToStream"]>(async () => [appendedEvent]);
    const eventStore: EventStore = {
      readStream: vi.fn(async () => [existingEvent]),
      appendToStream,
      readAll: vi.fn(async () => []),
    };

    const { commandHandler, repository } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) =>
        command.by === 0 ? [] : [{ type: "counter.incremented" as const, data: { by: command.by } }],
    });

    await expect(repository.load("counter-1")).resolves.toMatchObject({
      state: 2,
      version: 1,
      events: [{ type: "counter.incremented", data: { by: 2 } }],
    });

    await expect(
      commandHandler({
        streamId: "counter-1",
        command: { type: "Increment", by: 3 },
        context,
      }),
    ).resolves.toMatchObject({
      state: 5,
      version: 2,
      newEvents: [{ type: "counter.incremented", data: { by: 3 } }],
    });
    expect(appendToStream).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "counter-1",
        expectedVersion: 1,
        events: [expect.objectContaining({ eventType: "counter.incremented", payload: { by: 3 } })],
      }),
    );
  });

  it("loads all aggregate stream pages before choosing the append expected version", async () => {
    const existingEvents = Array.from({ length: 501 }, (_, index) => ({
      ...existingEvent,
      eventId: `evt_${index + 1}` as never,
      streamVersion: index + 1,
      globalPosition: String(index + 10) as never,
      payload: { by: 1 },
    }));
    const appendedPagedEvent = {
      ...appendedEvent,
      streamVersion: 502,
      globalPosition: "600" as never,
    };
    const appendToStream = vi.fn<EventStore["appendToStream"]>(async () => [appendedPagedEvent]);
    const eventStore: EventStore = {
      readStream: vi.fn(async (input) =>
        existingEvents.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit ?? 500),
      ),
      appendToStream,
      readAll: vi.fn(async () => []),
    };

    const { commandHandler } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
    });

    await expect(
      commandHandler({
        streamId: "counter-1",
        command: { type: "Increment", by: 3 },
        context,
      }),
    ).resolves.toMatchObject({
      state: 504,
      version: 502,
    });

    expect(eventStore.readStream).toHaveBeenNthCalledWith(1, {
      streamId: "counter-1",
      fromVersion: 1,
      limit: 500,
    });
    expect(eventStore.readStream).toHaveBeenNthCalledWith(2, {
      streamId: "counter-1",
      fromVersion: 501,
      limit: 500,
    });
    expect(appendToStream).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 501 }));
  });

  it("issue-6298-acceptance-control rejects an aggregate-helper bypass at a cross-page gap", async () => {
    const existingEvents = [
      ...Array.from({ length: 500 }, (_, index) => ({
        ...existingEvent,
        eventId: `evt_${index + 1}` as never,
        streamVersion: index + 1,
        globalPosition: String(index + 10) as never,
        payload: { by: 1 },
      })),
      {
        ...existingEvent,
        eventId: "evt_502" as never,
        streamVersion: 502,
        globalPosition: "512" as never,
        payload: { by: 1 },
      },
    ];
    const appendToStream = vi.fn<EventStore["appendToStream"]>(async () => []);
    const eventStore: EventStore = {
      readStream: vi.fn(async (input) =>
        existingEvents.filter((event) => event.streamVersion >= (input.fromVersion ?? 1)).slice(0, input.limit ?? 500),
      ),
      appendToStream,
      readAll: vi.fn(async () => []),
    };
    const { commandHandler } = createAggregateCommandHandler<number, CounterCommand, CounterEvent>({
      eventStore,
      codec: createPassthroughDomainEventCodec<CounterEvent>(),
      initialState: () => 0,
      evolve: (state, event) => state + event.data.by,
      decide: (_state, command) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
    });

    await expect(
      commandHandler({
        streamId: "counter-1",
        command: { type: "Increment", by: 3 },
        context,
      }),
    ).rejects.toThrow("inclusive read expected 501");
    expect(appendToStream).not.toHaveBeenCalled();
  });

  describe("aggregate-max-events-append-preconditions", () => {
    const event: CounterEvent = { type: "counter.incremented", data: { by: 1 } };

    function setupBound(maxEvents: number | undefined = 2) {
      const store = createInMemoryEventStore();
      const appendToStream = vi.spyOn(store.eventStore, "appendToStream");
      const config = {
        eventStore: store.eventStore,
        codec: createPassthroughDomainEventCodec<CounterEvent>(),
        initialState: () => 0,
        evolve: (state: number, event: CounterEvent) => state + event.data.by,
        decide: (_state: number, command: CounterCommand) => [
          { type: "counter.incremented" as const, data: { by: command.by } },
        ],
        maxEvents,
      };
      return { ...store, appendToStream, config, ...createAggregateCommandHandler(config) };
    }

    it.each([0, "no_stream"] as const)(
      "accepts exact-bound predecessor %s and rejects cap+1 before delegation",
      async (expectedVersion) => {
        const { repository, appendToStream, allEvents } = setupBound();
        await expect(
          repository.append({ streamId: "over", expectedVersion, context, events: [event, event, event] }),
        ).rejects.toMatchObject({ name: "EventStreamTooLongError", maxEvents: 2 });
        expect(appendToStream).not.toHaveBeenCalled();
        await expect(
          repository.append({ streamId: "exact", expectedVersion, context, events: [event, event] }),
        ).resolves.toHaveLength(2);
        await expect(repository.load("exact")).resolves.toMatchObject({ state: 2, version: 2 });
        await expect(
          repository.append({ streamId: "exact", expectedVersion: 2, context, events: [event] }),
        ).rejects.toMatchObject({ name: "EventStreamTooLongError" });
        expect(appendToStream).toHaveBeenCalledTimes(1);
        expect(allEvents).toHaveLength(2);
      },
    );

    it.each([{ events: [] }, { events: [event] }])(
      "rejects any-bypass including an empty append (%j)",
      async ({ events }) => {
        const { repository, appendToStream } = setupBound();
        await expect(
          repository.append({ streamId: "counter", expectedVersion: "any", context, events }),
        ).rejects.toThrow('expectedVersion="any"');
        expect(appendToStream).not.toHaveBeenCalled();
      },
    );

    it("rejects snapshots at construction without reading a snapshot", () => {
      const { config } = setupBound();
      const store = { loadLatest: vi.fn(async () => null), save: vi.fn(async () => {}) };
      expect(() =>
        createAggregateCommandHandler({
          ...config,
          snapshots: { store, schemaVersion: 1, everyNEvents: 1 },
        }),
      ).toThrow("maxEvents cannot be combined with snapshots");
      expect(store.loadLatest).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid maxEvents %s at construction",
      (maxEvents) => {
        expect(() => setupBound(maxEvents)).toThrow("maxEvents must be a positive safe integer");
      },
    );

    it("forwards the complete-read cap and preserves unconfigured any/snapshots", async () => {
      const { config, repository, eventStore } = setupBound();
      await eventStore.appendToStream({
        streamId: "over",
        expectedVersion: 0,
        context,
        events: Array.from({ length: 3 }, () => ({
          eventType: event.type,
          payload: event.data,
        })),
      });
      await expect(repository.load("over")).rejects.toMatchObject({ name: "EventStreamTooLongError" });
      const unconfigured = createAggregateCommandHandler({ ...config, maxEvents: undefined });
      await expect(unconfigured.repository.load("over")).resolves.toMatchObject({ version: 3 });
      await expect(
        unconfigured.repository.append({ streamId: "over", expectedVersion: "any", context, events: [event] }),
      ).resolves.toHaveLength(1);
      await expect(
        unconfigured.repository.append({ streamId: "over", expectedVersion: "any", context, events: [] }),
      ).resolves.toEqual([]);
      const withSnapshots = createAggregateCommandHandler({
        ...config,
        maxEvents: undefined,
        snapshots: { store: { loadLatest: async () => null, save: async () => {} }, schemaVersion: 1, everyNEvents: 1 },
      });
      await expect(withSnapshots.repository.load("over")).resolves.toMatchObject({ version: 4 });
      expect(withSnapshots.repository.scheduleSnapshot).toBeTypeOf("function");
    });

    it("keeps a concurrent append conflict from bypassing the cap", async () => {
      const { repository, allEvents } = setupBound();
      await repository.append({ streamId: "counter", expectedVersion: "no_stream", context, events: [event] });
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          repository.append({
            streamId: "counter",
            expectedVersion: 1,
            context,
            events: [event],
          }),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        status: "rejected",
        reason: { code: "concurrency_conflict" },
      });
      expect(allEvents).toHaveLength(2);
    });
  });
});
