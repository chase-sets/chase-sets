import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { listingAttempt } from "./listing-attempt";
import { lookupListingBatch, runListingBatch, type ListingBatchDecision } from "./listing-batch";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const batch = {
  accountId: "acc_synthetic",
  family: "listing.pause",
  batchId: "synthetic_batch_identity_000001",
} as const;
const target = (reason = "seller", targetId = "lst_synthetic") => ({
  targetId,
  attempt: listingAttempt({
    idempotencyKey: batch.batchId,
    mutationKind: batch.family,
    accountId: batch.accountId,
    targetId,
    request: { listingId: targetId, reason },
  }),
});
const terminal = { outcome: "error", version: 0 } as const;

describe("durable Listing batch decisions", () => {
  it("returns unknown after pre-commit failure, then retains the first durable terminal on retry", async () => {
    const { eventStore } = createInMemoryEventStore();
    let fail = true;
    const store: EventStore = {
      ...eventStore,
      appendToStream: async (input) => {
        if (fail) throw new Error("synthetic pre-commit outage");
        return eventStore.appendToStream(input);
      },
    };
    const drive = vi.fn(async () => new Map([[target().targetId, terminal]]));
    const run = () => runListingBatch({ store, batch, context, targets: [target()], drive });
    expect((await run())[0]?.outcome).toBe("unknown");
    expect(await lookupListingBatch(store, batch)).toBeNull();
    fail = false;
    expect((await run())[0]?.outcome).toBe("error");
    expect((await run())[0]?.outcome).toBe("error");
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it("rereads a committed vector after response loss and never redrives its terminal target", async () => {
    const { eventStore } = createInMemoryEventStore();
    const store: EventStore = {
      ...eventStore,
      appendToStream: async (input) => {
        await eventStore.appendToStream(input);
        throw new Error("synthetic post-commit response loss");
      },
    };
    const drive = vi.fn(async () => new Map([[target().targetId, terminal]]));
    const run = () => runListingBatch({ store, batch, context, targets: [target()], drive });
    expect((await run())[0]?.outcome).toBe("error");
    expect((await run())[0]?.outcome).toBe("error");
    expect(drive).toHaveBeenCalledOnce();
  });

  it("does not guess a terminal when the winner cannot be read, preserving prior durable entries", async () => {
    const { eventStore } = createInMemoryEventStore();
    const prior = target("seller", "lst_prior");
    await runListingBatch({
      store: eventStore,
      batch,
      context,
      targets: [prior],
      drive: async () => new Map([[prior.targetId, terminal]]),
    });
    let unreadable = false;
    const store: EventStore = {
      ...eventStore,
      readStream: async (input) => {
        if (unreadable) throw new Error("synthetic read outage");
        return eventStore.readStream(input);
      },
      appendToStream: async (input) => {
        await eventStore.appendToStream(input);
        unreadable = true;
        throw Object.assign(new Error("synthetic unavailable winner"), { code: "concurrency_conflict" });
      },
    };
    const drive = vi.fn(async () => new Map([[target().targetId, terminal]]));
    const run = () => runListingBatch({ store, batch, context, targets: [prior, target()], drive });
    const result = await run();
    expect(result.map((item) => item.outcome)).toEqual(["error", "unknown"]);
    unreadable = false;
    expect((await run()).map((item) => item.outcome)).toEqual(["error", "error"]);
    expect(drive).toHaveBeenCalledOnce();
  });

  it.each([false, true])("uses the concurrent winner, with changed binding=%s", async (changedBinding) => {
    const { eventStore } = createInMemoryEventStore();
    const winnerTarget = target(changedBinding ? "different" : "seller");
    const winner: ListingBatchDecision = { outcome: "succeeded", version: 7 };
    const store: EventStore = {
      ...eventStore,
      appendToStream: async () => {
        await runListingBatch({
          store: eventStore,
          batch,
          context,
          targets: [winnerTarget],
          drive: async () => new Map([[winnerTarget.targetId, winner]]),
        });
        throw Object.assign(new Error("synthetic concurrent winner"), { code: "concurrency_conflict" });
      },
    };
    const drive = vi.fn(async () => new Map([[target().targetId, terminal]]));
    const run = () => runListingBatch({ store, batch, context, targets: [target()], drive });
    expect((await run())[0]?.outcome).toBe(changedBinding ? "conflict" : "succeeded");
    expect((await run())[0]?.outcome).toBe(changedBinding ? "conflict" : "succeeded");
    expect(drive).toHaveBeenCalledOnce();
  });

  it("keeps strict wrong-owner rejection and refuses to drive a poisoned vector", async () => {
    const { eventStore } = createInMemoryEventStore();
    await runListingBatch({
      store: eventStore,
      batch,
      context: { ...context, audit: { ...context.audit, forAccountId: "acc_synthetic_other" as never } },
      targets: [target()],
      drive: async () => new Map([[target().targetId, terminal]]),
    });
    await expect(lookupListingBatch(eventStore, batch)).rejects.toMatchObject({ code: "history_incomplete" });
    const drive = vi.fn(async () => new Map([[target().targetId, terminal]]));
    expect((await runListingBatch({ store: eventStore, batch, context, targets: [target()], drive }))[0]?.outcome).toBe(
      "unknown",
    );
    expect(drive).not.toHaveBeenCalled();
  });
});
