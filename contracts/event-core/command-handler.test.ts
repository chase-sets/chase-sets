import { describe, expect, it, vi } from "vitest";
import { createCommandHandler } from "./command-handler-internal";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "./consistency";
import type { AggregateRepository } from "./aggregate-repository";
import type { DomainEvent } from "./domain";
import type { StoredEvent } from "./storage";

type CounterEvent = DomainEvent<"counter.incremented", { by: number }>;
type CounterCommand = Readonly<{ type: "Increment"; by: number }>;

describe("command handler", () => {
  const storedEvent: StoredEvent<"counter.incremented", { by: number }> = {
    eventId: "evt_1" as never,
    streamId: "counter-1",
    streamVersion: 3,
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
  const context = {
    tenantId: "tnt_1" as never,
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
    },
  };

  it("loads state, appends decided events, and returns evolved state", async () => {
    const append = vi.fn<AggregateRepository<number, CounterEvent>["append"]>(async () => [storedEvent]);
    const repository: AggregateRepository<number, CounterEvent> = {
      load: vi.fn(async () => ({ state: 1, version: 2, events: [], storedEvents: [] })),
      append,
    };
    const handler = createCommandHandler({
      repository,
      decide: (_state, command: CounterCommand) =>
        command.by === 0 ? [] : [{ type: "counter.incremented" as const, data: { by: command.by } }],
      evolve: (state, event) => state + event.data.by,
    });

    await expect(
      handler({
        streamId: "counter-1",
        command: { type: "Increment", by: 2 },
        context,
      }),
    ).resolves.toMatchObject({
      state: 3,
      version: 3,
      newEvents: [{ type: "counter.incremented", data: { by: 2 } }],
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: "counter-1",
        expectedVersion: 2,
      }),
    );
  });

  it("does not append when the decider emits no events", async () => {
    const repository: AggregateRepository<number, CounterEvent> = {
      load: vi.fn(async () => ({ state: 1, version: 2, events: [], storedEvents: [] })),
      append: vi.fn(),
    };
    const handler = createCommandHandler({
      repository,
      decide: () => [],
      evolve: (state) => state,
    });

    await expect(
      handler({
        streamId: "counter-1",
        command: { type: "Increment", by: 0 },
        context,
      }),
    ).resolves.toMatchObject({
      state: 1,
      version: 2,
      newEvents: [],
      storedEvents: [],
    });
    expect(repository.append).not.toHaveBeenCalled();
  });

  it("records commits under an explicit owning source context", async () => {
    const append = vi.fn<AggregateRepository<number, CounterEvent>["append"]>(async () => [storedEvent]);
    const repository: AggregateRepository<number, CounterEvent> = {
      load: vi.fn(async () => ({ state: 1, version: 2, events: [], storedEvents: [] })),
      append,
    };
    const handler = createCommandHandler({
      repository,
      decide: (_state, command: CounterCommand) => [{ type: "counter.incremented" as const, data: { by: command.by } }],
      evolve: (state, event) => state + event.data.by,
      commitSourceContextName: "owning-context",
    });

    await runWithEventCommitMetadata(async () => {
      await handler({
        streamId: "legacy-prefix-1",
        command: { type: "Increment", by: 2 },
        context,
      });

      expect(getEventCommitMetadata().sources).toEqual([
        {
          sourceContextName: "owning-context",
          eventIds: ["evt_1"],
          maxGlobalPosition: "10",
        },
      ]);
      expect(append).toHaveBeenCalledWith(
        expect.objectContaining({
          wakeSourceContextName: "owning-context",
        }),
      );
    });
  });
});
