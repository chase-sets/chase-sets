import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { listingAttempt, stampListingAttemptEvents } from "./listing-attempt";
import {
  listingBatchStreamId,
  lookupListingBatch,
  prepareListingBatch,
  runBoundListingAttempt,
  runListingBatch,
  type ListingBatchDecision,
} from "./listing-batch";
import { createListingRecovery } from "./listing-recovery";

const context: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic" as never, forAccountId: "acc_synthetic" as never },
};
const batch = {
  accountId: "acc_synthetic",
  family: "listing.pause",
  batchId: "synthetic_batch_identity_000001",
} as const;
const target = (reason = "seller", targetId = "lst_synthetic", batchId: string = batch.batchId) => ({
  targetId,
  attempt: listingAttempt({
    idempotencyKey: batchId,
    mutationKind: batch.family,
    accountId: batch.accountId,
    targetId,
    request: { listingId: targetId, reason },
  }),
});
const terminal = { outcome: "error", version: 0 } as const;
const pauseKey = `${batch.batchId}_bulk-pause-listings`;

function bulkPause(batchId = pauseKey, legacy = false) {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const store: EventStore = legacy
    ? {
        ...eventStore,
        appendToStream: (input) =>
          eventStore.appendToStream({
            ...input,
            events: input.events.map((event) =>
              event.eventType === "marketplace.listing-batch.recorded" ? { ...event, metadata: {} } : event,
            ),
          }),
      }
    : eventStore;
  const identity = { ...batch, batchId };
  const a = target("seller", "lst_a", batchId);
  const b = target("seller", "lst_b", batchId);
  const send = ({ attempt }: typeof a) =>
    runBoundListingAttempt(
      store,
      attempt,
      (receipt) => ({ version: receipt.version }),
      async () => {
        await store.appendToStream({
          streamId: attempt.streamId,
          expectedVersion: "no_stream",
          context,
          events: stampListingAttemptEvents(attempt, [{ eventType: "marketplace.listing.paused", payload: {} }]),
        });
        return { version: 1 };
      },
    );
  const drive = vi.fn(async (targets: readonly (typeof a)[]) => {
    const decisions = new Map<string, ListingBatchDecision>();
    for (const target of targets) decisions.set(target.targetId, { outcome: "succeeded", ...(await send(target)) });
    return decisions;
  });
  const run = (targets: readonly (typeof a)[]) => runListingBatch({ store, batch: identity, context, targets, drive });
  const prepare = () =>
    prepareListingBatch(
      store,
      batch.accountId,
      {
        batchId,
        mutationKind: batch.family,
        bulk: true,
        targets: [{ id: a.targetId, requestHash: a.attempt.binding.canonicalRequestHash }],
      },
      context,
    );
  return { a, b, drive, send, run, prepare, store, identity, allEvents };
}

describe("durable Listing batch decisions", () => {
  it.each([
    [pauseKey, false],
    [batch.batchId, false],
    [pauseKey, true],
  ] as const)("extends direct batch %s (legacy=%s) without redriving A", async (batchId, legacy) => {
    const { a, b, drive, run, store, identity, allEvents } = bulkPause(batchId, legacy);
    expect((await run([a])).map(({ outcome }) => outcome)).toEqual(["succeeded"]);
    expect((await run([a, b])).map(({ outcome }) => outcome)).toEqual(["succeeded", "succeeded"]);
    expect(drive.mock.calls).toEqual([[[a]], [[b]]]);
    expect(allEvents.map(({ streamId }) => streamId)).toEqual([
      a.attempt.streamId,
      listingBatchStreamId(identity),
      b.attempt.streamId,
      listingBatchStreamId(identity),
    ]);
    expect((await lookupListingBatch(store, identity))?.items).toMatchObject([
      { targetId: a.targetId, outcome: "succeeded" },
      { targetId: b.targetId, outcome: "succeeded" },
    ]);
  });

  it.each(["prepared", "legacy preparation", "prepared after direct", "retained direct"] as const)(
    "freezes membership for %s and refuses B before any owner append",
    async (kind) => {
      const { a, b, drive, send, run, prepare, store, allEvents } = bulkPause(pauseKey, kind === "legacy preparation");
      if (kind === "prepared after direct" || kind === "retained direct") await run([a]);
      if (kind === "retained direct") {
        const retained = { batchId: pauseKey, mutationKind: batch.family, bulk: true };
        await expect(
          createListingRecovery(store).prepareListingRecovery(
            batch.accountId,
            {
              intent: "bulk-pause-listings",
              idempotencyKey: batch.batchId,
              listingId: null,
              listingIds: [a.targetId],
              fields: {},
              retained,
            },
            context,
          ),
        ).resolves.toEqual({ reference: retained });
      } else await prepare();
      await run([a]);
      const before = allEvents.length;
      expect(before).toBe(3);
      expect((await run([a, b])).map(({ outcome }) => outcome)).toEqual(["succeeded", "conflict"]);
      await expect(send(b)).rejects.toMatchObject({ code: "attempt_conflict" });
      expect(drive.mock.calls).toEqual([[[a]]]);
      expect(allEvents).toHaveLength(before);
      expect(allEvents.filter(({ streamId }) => streamId === a.attempt.streamId)).toHaveLength(1);
    },
  );

  it("does not confuse a marked direct unknown outcome with legacy preparation", async () => {
    const { a, b, drive, run } = bulkPause();
    drive.mockRejectedValueOnce(new Error("synthetic uncertain drive"));
    expect((await run([a]))[0]?.outcome).toBe("unknown");
    expect((await run([a, b])).map(({ outcome }) => outcome)).toEqual(["succeeded", "succeeded"]);
    expect(drive.mock.calls).toEqual([[[a]], [[a, b]]]);
  });

  it("keeps possible legacy bulk preparation fail-closed even without a command suffix", async () => {
    const { a, b, drive, run, prepare } = bulkPause(batch.batchId, true);
    await prepare();
    expect((await run([a, b])).map(({ outcome }) => outcome)).toEqual(["succeeded", "conflict"]);
    expect(drive.mock.calls).toEqual([[[a]]]);
  });

  it("prepares only hashes, is owner bound and refuses changed targets or hashes without overwriting a terminal", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const identity = {
      batchId: batch.batchId,
      mutationKind: batch.family,
      bulk: true,
      targets: [{ id: target().targetId, requestHash: target().attempt.binding.canonicalRequestHash }],
    };
    await prepareListingBatch(eventStore, batch.accountId, identity, context);
    await prepareListingBatch(eventStore, batch.accountId, identity, context);
    expect(allEvents).toHaveLength(1);
    expect((await lookupListingBatch(eventStore, batch))?.items[0]).toMatchObject({
      outcome: "unknown",
      requestHash: identity.targets[0]!.requestHash,
    });
    expect(await lookupListingBatch(eventStore, { ...batch, accountId: "acc_other" })).toBeNull();
    await expect(
      prepareListingBatch(
        eventStore,
        batch.accountId,
        { ...identity, targets: [{ id: "lst_other", requestHash: identity.targets[0]!.requestHash }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    await expect(
      prepareListingBatch(
        eventStore,
        batch.accountId,
        { ...identity, targets: [{ ...identity.targets[0]!, requestHash: "0".repeat(64) }] },
        context,
      ),
    ).rejects.toMatchObject({ code: "history_incomplete" });
    await runListingBatch({
      store: eventStore,
      batch,
      context,
      targets: [target()],
      drive: async () => new Map([[target().targetId, { outcome: "succeeded", noOp: true, version: 4 }]]),
    });
    await prepareListingBatch(eventStore, batch.accountId, identity, context);
    expect(allEvents).toHaveLength(2);
    expect((await lookupListingBatch(eventStore, batch))?.items[0]).toMatchObject({
      outcome: "succeeded",
      noOp: true,
      version: 4,
      requestHash: identity.targets[0]!.requestHash,
      attemptKeyFingerprint: target().attempt.binding.attemptKeyFingerprint,
    });
  });
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
