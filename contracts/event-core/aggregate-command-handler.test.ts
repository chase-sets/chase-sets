import { describe, expect, it, vi } from "vitest";
import { createAggregateCommandHandler } from "./aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "./codec";
import type { EventStore } from "./event-store";
import type { DomainEvent } from "./domain";
import type { StoredEvent } from "./storage";

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

    // The first read is explicit about the page it wants: relying on the
    // store's default cap is exactly how a fold silently becomes a prefix.
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
});
