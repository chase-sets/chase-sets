import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "./test-support";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

function event(eventType: string, eventId?: string) {
  return { eventId: eventId as never, eventType, payload: { value: eventType } };
}

describe("shared in-memory event store", () => {
  it("enforces expected versions and reads from the requested inclusive version", async () => {
    const { eventStore } = createInMemoryEventStore();

    await eventStore.appendToStream({
      streamId: "test.stream",
      expectedVersion: "no_stream",
      context,
      events: [event("test.created"), event("test.updated")],
    });

    await expect(
      eventStore.appendToStream({
        streamId: "test.stream",
        expectedVersion: "no_stream",
        context,
        events: [event("test.conflict")],
      }),
    ).rejects.toMatchObject({
      code: "concurrency_conflict",
      details: { expectedVersion: "no_stream", currentVersion: 2 },
    });

    await expect(eventStore.readStream({ streamId: "test.stream", fromVersion: 2 })).resolves.toMatchObject([
      { streamVersion: 2, eventType: "test.updated" },
    ]);
  });

  it("is idempotent for a repeated event id and rejects changed event data", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const input = {
      streamId: "test.idempotent",
      expectedVersion: "no_stream" as const,
      context,
      events: [event("test.created", "evt_fixed")],
    };

    const first = await eventStore.appendToStream(input);
    await expect(eventStore.appendToStream({ ...input, expectedVersion: 1 })).resolves.toEqual(first);
    expect(allEvents).toHaveLength(1);

    await expect(
      eventStore.appendToStream({
        ...input,
        expectedVersion: 1,
        events: [event("test.changed", "evt_fixed")],
      }),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
  });

  it("isolates independent append conflicts while preserving sibling commits", async () => {
    const { eventStore } = createInMemoryEventStore();
    const results = await eventStore.appendToStreamsIndependently!([
      {
        streamId: "test.winner",
        expectedVersion: "no_stream",
        context,
        events: [event("test.created")],
      },
      {
        streamId: "test.conflict",
        expectedVersion: 1,
        context,
        events: [event("test.created")],
      },
    ]);

    expect(results).toMatchObject([
      { streamId: "test.winner", outcome: "appended" },
      { streamId: "test.conflict", outcome: "conflict", error: { code: "concurrency_conflict" } },
    ]);
    await expect(eventStore.readStream({ streamId: "test.winner" })).resolves.toHaveLength(1);
    await expect(eventStore.readStream({ streamId: "test.conflict" })).resolves.toHaveLength(0);
  });

  it("uses zero-event streams as atomic expected-version guards", async () => {
    const { eventStore } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "test.policy",
      expectedVersion: "no_stream",
      context,
      events: [event("test.policy-activated")],
    });

    await expect(
      eventStore.appendToStreams!([
        {
          streamId: "test.policy",
          expectedVersion: 0,
          context,
          events: [],
        },
        {
          streamId: "test.registration",
          expectedVersion: "no_stream",
          context,
          events: [event("test.registration-created")],
        },
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    await expect(eventStore.readStream({ streamId: "test.registration" })).resolves.toEqual([]);
  });

  it("keeps global reads gap-free across atomic append batches", async () => {
    const { eventStore } = createInMemoryEventStore();

    await Promise.all([
      eventStore.appendToStream({
        streamId: "test.first",
        expectedVersion: "no_stream",
        context,
        events: [event("test.first")],
      }),
      eventStore.appendToStream({
        streamId: "test.second",
        expectedVersion: "no_stream",
        context,
        events: [event("test.second")],
      }),
    ]);

    await expect(eventStore.readAll({ limit: 10 })).resolves.toMatchObject([
      { globalPosition: "1" },
      { globalPosition: "2" },
    ]);
  });
});
