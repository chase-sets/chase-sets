import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createBulkAppendLane } from "./bulk-append-lane";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { forAccountId: "acc_synthetic" as never, performedByUserId: "usr_synthetic" as never },
};
function fixture() {
  const { eventStore } = createInMemoryEventStore();
  const append = vi.spyOn(eventStore, "appendToStreams");
  const sleep = vi.fn(async () => {});
  const lane = createBulkAppendLane({
    eventStore,
    chunkSize: 2,
    yieldIntervalMs: 0,
    sleep,
    prepare: async (id: string) => ({
      result: { id },
      recover: async (error: unknown): Promise<{ id: string }> => {
        throw error;
      },
      appends: [
        { streamId: "shared-authority", expectedVersion: 0, events: [], context },
        ...[id, `request-${id}`].map((streamId) => ({
          streamId,
          expectedVersion: 0,
          context,
          events: [{ eventType: "synthetic.changed", payload: { id } }],
        })),
      ],
    }),
  });
  return { eventStore, append, sleep, lane };
}

describe("bulk guarded transactions", () => {
  it("retains the earliest authorization deadline when merging a common pure guard", async () => {
    const { eventStore } = createInMemoryEventStore();
    const lane = createBulkAppendLane({
      eventStore,
      chunkSize: 2,
      yieldIntervalMs: 0,
      prepare: async (id: string) => ({
        result: { id },
        recover: async (error: unknown): Promise<{ id: string }> => {
          throw error;
        },
        appends: [
          {
            streamId: "synthetic.shared-deadline",
            expectedVersion: 0,
            context,
            events: [],
            authorizationDeadline: id === "a" ? "2999-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z",
          },
          {
            streamId: id,
            expectedVersion: 0,
            context,
            events: [{ eventType: "synthetic.committed", payload: { id } }],
          },
        ],
      }),
    });
    const outcomes = await lane(["a", "b"]);
    expect(outcomes[0]?.result).toEqual({ id: "a" });
    expect(outcomes[1]?.error).toMatchObject({ code: "concurrency_conflict" });
    expect(await eventStore.readStream({ streamId: "b" })).toHaveLength(0);
  });
  it("does not subdivide or resend a committed batch when source acknowledgement conflicts", async () => {
    const { eventStore } = createInMemoryEventStore();
    const append = vi.spyOn(eventStore, "appendToStreams");
    const recover = vi.fn(async (id: string) => {
      expect(await eventStore.readStream({ streamId: id })).toHaveLength(1);
      return { id };
    });
    const lane = createBulkAppendLane({
      eventStore,
      chunkSize: 2,
      yieldIntervalMs: 0,
      prepare: async (id: string) => ({
        result: { id },
        appends: [
          {
            streamId: id,
            expectedVersion: 0,
            context,
            events: [{ eventType: "synthetic.committed", payload: { id } }],
          },
        ],
        complete: async () => {
          throw Object.assign(new Error("source acknowledgement raced"), { code: "concurrency_conflict" });
        },
        recover: () => recover(id),
      }),
    });
    expect((await lane(["a", "b"])).map((outcome) => outcome.result)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(2);
  });
  it("amortizes complete transactions and common guards in bounded chunks", async () => {
    const { lane, append, sleep, eventStore } = fixture();
    const result = await lane(["a", "b", "c"]);
    expect(result.map((entry) => entry.result)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(result.every((entry) => entry.error === null && entry.storedEvents.length === 2)).toBe(true);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]![0]).toHaveLength(5);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(await eventStore.readAll()).toHaveLength(6);
  });

  it("isolates a version conflict without partially committing its request result", async () => {
    const { lane, append, eventStore } = fixture();
    await eventStore.appendToStream({
      streamId: "a",
      expectedVersion: 0,
      context,
      events: [{ eventType: "synthetic.changed", payload: {} }],
    });
    const result = await lane(["a", "b"]);
    expect(result[0]?.error).toMatchObject({ code: "concurrency_conflict" });
    expect(result[1]?.result).toEqual({ id: "b" });
    expect(await eventStore.readStream({ streamId: "request-a" })).toHaveLength(0);
    expect(await eventStore.readStream({ streamId: "request-b" })).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("fences common authority for every transaction including request-only no-ops", async () => {
    const { lane, eventStore } = fixture();
    await eventStore.appendToStream({
      streamId: "shared-authority",
      expectedVersion: 0,
      context,
      events: [{ eventType: "synthetic.changed", payload: {} }],
    });
    expect((await lane(["a", "b"])).every((entry) => entry.error !== null)).toBe(true);
    expect(await eventStore.readAll()).toHaveLength(1);
  });

  it("never retries an unknown infrastructure outcome", async () => {
    const { lane, append } = fixture();
    append.mockRejectedValueOnce(new Error("connection lost after commit"));
    const result = await lane(["a", "b"]);
    expect(result.every((entry) => entry.error?.message === "connection lost after commit")).toBe(true);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("does not collapse two commands for one stream into one reported outcome", async () => {
    const { lane, eventStore } = fixture();
    const result = await lane(["a", "a"]);
    expect(result[0]?.result).toEqual({ id: "a" });
    expect(result[1]?.error).toMatchObject({ code: "concurrency_conflict" });
    expect(await eventStore.readAll()).toHaveLength(2);
  });
});
