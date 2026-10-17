import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { payoutReviewHoldStreamId } from "../domain/payout-review-hold";
import { createPayoutReviewHoldRuntime } from "./payout-review-hold-runtime";

const accountId = "acc_synthetic_seller" as never;
const streamId = payoutReviewHoldStreamId(accountId);
const operatorContext: EventStoreContext = {
  tenantId: "tnt_synthetic" as never,
  audit: { performedByUserId: "usr_synthetic_operator" as never, forAccountId: "acc_synthetic_operator" as never },
};
const otherOperatorContext: EventStoreContext = {
  ...operatorContext,
  audit: {
    performedByUserId: "usr_synthetic_other_operator" as never,
    forAccountId: "acc_synthetic_operator" as never,
  },
};

/** Lets a second operator commit to the hold stream between the command's load and its append. */
function storeWithConcurrentWriter(concurrent: "placed" | "released") {
  const store = createInMemoryEventStore();
  let pending = true;
  const appendToStream = vi.fn(async (input: Parameters<typeof store.eventStore.appendToStream>[0]) => {
    if (pending && input.streamId === streamId) {
      pending = false;
      await store.eventStore.appendToStream({
        streamId,
        expectedVersion: "any",
        events: [
          {
            eventType: `settlement.payout-review-hold.${concurrent}`,
            payload: {
              factSchemaVersion: 1,
              accountId,
              reason: "Concurrent operator decision",
              source: "operator",
              sourceReference: null,
            },
          },
        ],
        context: otherOperatorContext,
      });
    }
    return store.eventStore.appendToStream(input);
  });
  return { store, eventStore: { ...store.eventStore, appendToStream }, appendToStream };
}

describe("payout review hold runtime", () => {
  it("re-decides a version conflict against the reloaded hold stream", async () => {
    const placeRace = storeWithConcurrentWriter("placed");
    const placeRuntime = createPayoutReviewHoldRuntime({ eventStore: placeRace.eventStore });
    await expect(
      placeRuntime.place({ accountId, reason: "Operator review", source: "operator" }, operatorContext),
    ).resolves.toEqual({ outcome: "noop", version: 1 });
    expect(placeRace.store.readAllEvents().map((event) => event.performedByUserId)).toEqual([
      "usr_synthetic_other_operator",
    ]);

    // An empty-stream release loses the race to a placement; re-deciding releases that hold
    // instead of appending the tombstone it originally decided on.
    const releaseRace = storeWithConcurrentWriter("placed");
    const releaseRuntime = createPayoutReviewHoldRuntime({ eventStore: releaseRace.eventStore });
    await expect(
      releaseRuntime.release({ accountId, reason: "Operator release", source: "operator" }, operatorContext),
    ).resolves.toEqual({ outcome: "released", version: 2 });
    expect(releaseRace.appendToStream).toHaveBeenCalledTimes(2);
    expect(
      releaseRace.store
        .readAllEvents()
        .map((event) => [event.eventType, event.streamVersion, event.payload.reason, event.performedByUserId]),
    ).toEqual([
      ["settlement.payout-review-hold.placed", 1, "Concurrent operator decision", "usr_synthetic_other_operator"],
      ["settlement.payout-review-hold.released", 2, "Operator release", "usr_synthetic_operator"],
    ]);
  });

  it("records reason, source, source reference and actor on the stream-read view", async () => {
    const store = createInMemoryEventStore();
    const runtime = createPayoutReviewHoldRuntime({ eventStore: store.eventStore });
    await runtime.place(
      {
        accountId,
        reason: " Chargeback spike ",
        source: "risk-alert",
        sourceReference: "alert_synthetic",
        actorPermissions: ["payout-review-holds.manage"],
      },
      operatorContext,
    );
    await expect(runtime.get(accountId)).resolves.toMatchObject({
      accountId,
      active: true,
      streamExists: true,
      hasNonMigrationEvent: true,
      reason: "Chargeback spike",
      source: "risk-alert",
      sourceReference: "alert_synthetic",
      actorUserId: "usr_synthetic_operator",
      version: 1,
    });
  });
});
