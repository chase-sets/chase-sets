import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "./event-store";
import { EVENT_STORE_READ_PAGE_SIZE_MAX, type ReadAllInput } from "./storage";
import {
  assertBoundedStreamReadContract,
  createInMemoryEventStore,
  EVENT_STORE_READ_ALL_PAGE_SIZE_BOUNDARIES,
} from "./test-support";

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
  it("validates bounded-prefix request evidence without reading the stream", () => {
    expect(() =>
      assertBoundedStreamReadContract({
        streamId: "test.bounded",
        bound: 1,
        historyLength: 2,
        requests: [{ streamId: "test.bounded", limit: 1 }],
      }),
    ).not.toThrow();
    expect(() =>
      assertBoundedStreamReadContract({
        streamId: "test.bounded",
        bound: 1,
        historyLength: 2,
        requests: [{ streamId: "test.bounded" }],
      }),
    ).toThrow("expected literal bound 1");
    expect(() =>
      assertBoundedStreamReadContract({
        streamId: "test.bounded",
        bound: 1,
        historyLength: 1,
        requests: [{ streamId: "test.bounded", limit: 1 }],
      }),
    ).toThrow("history must be longer");
  });

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

  it("issue-6298-acceptance-control enforces the shared page cap and inclusive non-one cursor", async () => {
    const { eventStore, streams } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "test.paged",
      expectedVersion: "no_stream",
      context,
      events: Array.from({ length: EVENT_STORE_READ_PAGE_SIZE_MAX + 1 }, (_, index) =>
        event(`test.event-${index + 1}`),
      ),
    });

    const firstPage = await eventStore.readStream({ streamId: "test.paged" });
    expect(firstPage).toHaveLength(EVENT_STORE_READ_PAGE_SIZE_MAX);
    expect(firstPage.at(-1)?.streamVersion).toBe(EVENT_STORE_READ_PAGE_SIZE_MAX);
    await expect(eventStore.readStream({ streamId: "test.paged", fromVersion: 500 })).resolves.toMatchObject([
      { streamVersion: 500 },
      { streamVersion: 501 },
    ]);
    await expect(eventStore.readStream({ streamId: "test.paged", limit: 1 })).resolves.toMatchObject([
      { streamVersion: 1 },
    ]);

    async function assertPageLimit(readStream: EventStore["readStream"], limit: number): Promise<void> {
      let rejected = false;
      try {
        await readStream({ streamId: "test.paged", limit });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }

    for (const invalidLimit of [0, EVENT_STORE_READ_PAGE_SIZE_MAX + 1, 1.5, Number.POSITIVE_INFINITY]) {
      await assertPageLimit(eventStore.readStream, invalidLimit);
    }
    for (const invalidFromVersion of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(eventStore.readStream({ streamId: "test.paged", fromVersion: invalidFromVersion })).rejects.toThrow(
        "fromVersion must be a positive integer",
      );
    }
    const fakeLimitBypassMutant: EventStore["readStream"] = async (input) =>
      (streams.get(input.streamId) ?? []).slice(0, input.limit);
    await expect(assertPageLimit(fakeLimitBypassMutant, EVENT_STORE_READ_PAGE_SIZE_MAX + 1)).rejects.toThrow();
  });

  it("issue-6301-acceptance-control keeps readAll page limits aligned with PostgreSQL and filters before limiting", async () => {
    const { eventStore } = createInMemoryEventStore();
    const otherTenantContext = { ...context, tenantId: "tnt_other" as never };

    await eventStore.appendToStream({
      streamId: "test.match-tenant",
      expectedVersion: "no_stream",
      context: otherTenantContext,
      events: [event("test.included")],
    });
    await eventStore.appendToStream({
      streamId: "test.match-event-type",
      expectedVersion: "no_stream",
      context,
      events: [event("test.excluded")],
    });
    await eventStore.appendToStream({
      streamId: "test.other-prefix",
      expectedVersion: "no_stream",
      context,
      events: [event("test.included")],
    });
    await eventStore.appendToStream({
      streamId: "test.match-result",
      expectedVersion: "no_stream",
      context,
      events: [event("test.included")],
    });

    for (const limit of EVENT_STORE_READ_ALL_PAGE_SIZE_BOUNDARIES.accepted) {
      await expect(
        eventStore.readAll({
          afterGlobalPosition: "0" as never,
          tenantId: context.tenantId,
          eventTypes: ["test.included"],
          streamPrefixes: ["test.match"],
          limit,
        }),
      ).resolves.toMatchObject([{ globalPosition: "4", streamId: "test.match-result" }]);
    }

    for (const limit of EVENT_STORE_READ_ALL_PAGE_SIZE_BOUNDARIES.rejected) {
      await expect(eventStore.readAll({ limit })).rejects.toThrow(
        "Event store read limit must be an integer between 1 and 500.",
      );
    }
  });

  it("issue-6301-501-limit-mutation-control rejects an unchecked readAll slice", async () => {
    const fakeUncheckedSliceMutant: EventStore["readAll"] = async (input) => [].slice(0, input?.limit);

    async function assertPageLimit(readAll: EventStore["readAll"]): Promise<void> {
      let rejected = false;
      try {
        await readAll({ limit: 501 });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
    }

    await expect(assertPageLimit(fakeUncheckedSliceMutant)).rejects.toThrow();
    await expect(assertPageLimit(createInMemoryEventStore().eventStore.readAll)).resolves.toBeUndefined();
  });

  it("keeps the optional readAll horizon absent-by-default with the existing ordered result", async () => {
    const typeLevelOptionalInput: ReadAllInput = { limit: 10 };
    const optionalHorizon: ReadAllInput["atOrBeforeGlobalPosition"] = undefined;
    const { eventStore } = createInMemoryEventStore();

    await eventStore.appendToStream({
      streamId: "test.horizon-absent",
      expectedVersion: "no_stream",
      context,
      events: [event("test.first"), event("test.second"), event("test.third")],
    });

    expect(optionalHorizon).toBeUndefined();
    await expect(eventStore.readAll(typeLevelOptionalInput)).resolves.toEqual([
      expect.objectContaining({ globalPosition: "1", eventType: "test.first" }),
      expect.objectContaining({ globalPosition: "2", eventType: "test.second" }),
      expect.objectContaining({ globalPosition: "3", eventType: "test.third" }),
    ]);
  });

  it("honors an inclusive readAll horizon and refuses one above the assigned head", async () => {
    const { eventStore } = createInMemoryEventStore();

    await eventStore.appendToStream({
      streamId: "test.horizon",
      expectedVersion: "no_stream",
      context,
      events: [event("test.first"), event("test.second"), event("test.third")],
    });

    await expect(eventStore.readAll({ atOrBeforeGlobalPosition: "2" as never, limit: 10 })).resolves.toMatchObject([
      { globalPosition: "1", eventType: "test.first" },
      { globalPosition: "2", eventType: "test.second" },
    ]);
    await expect(eventStore.readAll({ atOrBeforeGlobalPosition: "4" as never, limit: 10 })).rejects.toThrow(
      "Event store read horizon 4 exceeds available global position 3.",
    );
  });

  it.each(["", "007", "-1", "1.0", "not-a-position"])(
    "refuses malformed readAll horizon %j before scanning any event",
    async (malformedHorizon) => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      await eventStore.appendToStream({
        streamId: "test.malformed-horizon",
        expectedVersion: "no_stream",
        context,
        events: [event("test.created")],
      });
      const filterSpy = vi.spyOn(allEvents, "filter");

      await expect(
        eventStore.readAll({ atOrBeforeGlobalPosition: malformedHorizon as never, limit: 10 }),
      ).rejects.toThrow("GlobalPosition must be a canonical unsigned base-10 string.");
      expect(filterSpy).not.toHaveBeenCalled();
    },
  );

  it("honors zero and refuses above zero on an empty in-memory event store", async () => {
    const { eventStore } = createInMemoryEventStore();

    await expect(eventStore.readAll({ atOrBeforeGlobalPosition: "0" as never, limit: 10 })).resolves.toEqual([]);
    await expect(eventStore.readAll({ atOrBeforeGlobalPosition: "1" as never, limit: 10 })).rejects.toThrow(
      "Event store read horizon 1 exceeds available global position 0.",
    );
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

  it("enforces a zero-event guard participant in an atomic multi-stream append", async () => {
    const { eventStore } = createInMemoryEventStore();

    // The guarded stream is read while it has no events, then moves.
    await eventStore.appendToStream({
      streamId: "test.authority",
      expectedVersion: "no_stream",
      context,
      events: [event("test.activated")],
    });

    await expect(
      eventStore.appendToStreams!([
        {
          streamId: "test.authority",
          expectedVersion: "no_stream",
          context,
          events: [],
        },
        {
          streamId: "test.guarded",
          expectedVersion: "no_stream",
          context,
          events: [event("test.created")],
        },
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });

    await expect(eventStore.readStream({ streamId: "test.guarded" })).resolves.toHaveLength(0);
    await expect(eventStore.readStream({ streamId: "test.authority" })).resolves.toHaveLength(1);
  });

  it("commits an atomic multi-stream append whose zero-event guard still matches", async () => {
    const { eventStore } = createInMemoryEventStore();

    await eventStore.appendToStreams!([
      {
        streamId: "test.authority",
        expectedVersion: "no_stream",
        context,
        events: [],
      },
      {
        streamId: "test.guarded",
        expectedVersion: "no_stream",
        context,
        events: [event("test.created")],
      },
    ]);

    await expect(eventStore.readStream({ streamId: "test.guarded" })).resolves.toHaveLength(1);
    // A guard writes nothing to the stream it protects.
    await expect(eventStore.readStream({ streamId: "test.authority" })).resolves.toHaveLength(0);
  });

  it("rolls back every in-memory participant when a late idempotency mismatch fails", async () => {
    const { eventStore } = createInMemoryEventStore();
    await eventStore.appendToStream({
      streamId: "test.existing",
      expectedVersion: "no_stream",
      context,
      events: [event("test.original", "evt_collision")],
    });
    await expect(
      eventStore.appendToStreams!([
        {
          streamId: "test.must-roll-back",
          expectedVersion: "no_stream",
          context,
          events: [event("test.created")],
        },
        {
          streamId: "test.existing",
          expectedVersion: 1,
          context,
          events: [event("test.changed", "evt_collision")],
        },
      ]),
    ).rejects.toMatchObject({ code: "concurrency_conflict" });
    await expect(eventStore.readStream({ streamId: "test.must-roll-back" })).resolves.toHaveLength(0);
    await expect(eventStore.readStream({ streamId: "test.existing" })).resolves.toMatchObject([
      { eventType: "test.original" },
    ]);
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
