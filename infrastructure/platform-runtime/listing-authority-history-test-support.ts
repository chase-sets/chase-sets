import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { StoredAggregateSnapshot } from "@chase-sets/event-core/aggregate-snapshot-store";
import { createListingAuthorityFence, type ListingAuthorityOperationInput } from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { createListingAuthorityWriter } from "./listing-authority-writer";
import type { ListingAuthorityHistoryFixture } from "./listing-authority-history-conformance";

export async function historyFixture() {
  const sourceMemory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const snapshots = new Map<string, StoredAggregateSnapshot<unknown>>();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_history",
    audit: { forAccountId: "acc_synthetic_history", performedByUserId: "usr_synthetic_history" },
  };
  let blocked = false;
  const sourceEffectStream = "catalog.synthetic-history-product";
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: "marketplace",
    kind: "native-visibility",
    requestId: "synthetic-history-request",
    command: { enable: true },
    listingId: "lst_synthetic_history",
    subject: {
      inventoryItemId: "inv_synthetic_history",
      catalogItemId: "cat_synthetic_history",
      productId: "cat_synthetic_history::",
      selectedOptions: [],
      quantity: 1,
      pair: { amount: "12.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: null,
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: 1,
    expectedPublicationRevision: null,
    participants: [{ owner: "catalog", purpose: "product-measures" }],
  };
  function restart() {
    const source = createListingAuthorityParticipant({
      eventStore: sourceMemory.eventStore,
      snapshots: {
        loadLatest: async (streamId) => snapshots.get(streamId) ?? null,
        save: async (snapshot) => {
          snapshots.set(snapshot.streamId, { ...snapshot, updatedAt: "2026-09-28T00:00:00.000Z" as never });
        },
      },
      participant: { owner: "catalog", purpose: "product-measures" },
      resources: () => ["synthetic-product"],
      consumer: () => ({
        inspect: fence.inspect,
        invalidate: (operation, reason) => {
          if (blocked) throw new Error("synthetic lost abort transport");
          return fence.forParticipant("catalog").invalidate(operation, reason);
        },
      }),
      validate: async (operation) => {
        if ((await sourceMemory.eventStore.readStream({ streamId: sourceEffectStream })).length)
          throw new Error("Synthetic source revoked.");
        return {
          value: { ready: true },
          sourceRevisions: [{ resourceId: "synthetic-product", revision: "0" }],
          validBefore: operation.prepareBefore,
        };
      },
    });
    const fence = createListingAuthorityFence({
      eventStore: consumerMemory.eventStore,
      owner: "marketplace",
      participants: [source],
    });
    const writer = createListingAuthorityWriter({
      eventStore: sourceMemory.eventStore,
      source,
      owner: "catalog",
      resources: async () => ["synthetic-product"],
    });
    return {
      context,
      input,
      source,
      fence,
      sourceStore: sourceMemory.eventStore,
      consumerStore: consumerMemory.eventStore,
      sourceHistories: sourceMemory.streams,
      consumerHistories: consumerMemory.streams,
      snapshots,
      sourceEffectStream,
      blockInvalidation(value) {
        blocked = value;
      },
      restart,
      async invalidate() {
        await writer.eventStore.appendToStream({
          streamId: sourceEffectStream,
          expectedVersion: 0,
          context,
          events: [{ eventType: "catalog.synthetic-product-revoked", payload: { revoked: true } }],
        });
      },
    } satisfies ListingAuthorityHistoryFixture;
  }
  return restart();
}
