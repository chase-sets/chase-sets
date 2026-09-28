import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { StoredAggregateSnapshot } from "@chase-sets/event-core/aggregate-snapshot-store";
import { createListingAuthorityFence, type ListingAuthorityOperationInput } from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { createListingAuthorityWriter } from "./listing-authority-writer";
import assert from "node:assert/strict";
import {
  bindListingAuthorityHistories,
  type ListingAuthorityHistoryFixture,
} from "./listing-authority-history-conformance";

/** The r12 class corpus deliberately uses one resource; never silently narrow an owner fixture. */
export function bindSingleResourceHistories(...args: Parameters<typeof bindListingAuthorityHistories>) {
  const journals = bindListingAuthorityHistories(...args);
  assert.equal(journals.resource.length, 1, "single-resource class fixture");
  return { ...journals, resource: journals.resource[0]! };
}

export type ListingAuthorityHistoryTestFixture = ListingAuthorityHistoryFixture & {
  snapshots: Map<string, StoredAggregateSnapshot<unknown>>;
  writer: ReturnType<typeof createListingAuthorityWriter>;
  restart(): ListingAuthorityHistoryTestFixture;
};

export async function historyFixture(
  options: {
    setup?: boolean;
    cache?: boolean;
    principal?: boolean;
    multipleResources?: boolean;
    reservationResources?: readonly string[];
    cacheUnavailable?: boolean;
  } = {},
) {
  const sourceMemory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const snapshots = new Map<string, StoredAggregateSnapshot<unknown>>();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_history",
    audit: { forAccountId: "acc_synthetic_history", performedByUserId: "usr_synthetic_history" },
    ...(options.principal
      ? {
          listingAuthorityPrincipal: {
            kind: "user" as const,
            tenantId: "tnt_synthetic_history",
            accountId: "acc_synthetic_history",
            userId: "usr_synthetic_history",
            membershipId: "mem_synthetic_history",
            validBefore: "2099-01-01T00:00:00.000Z",
            authentication: { kind: "api-key" as const, keyId: "key_synthetic_history", revision: "1" },
            delegation: { delegationId: "del_synthetic_history", revision: "1", scopeCeiling: ["listings.manage"] },
          },
        }
      : {}),
  };
  let blocked = false;
  const sourceEffectStream = "catalog.synthetic-history-product";
  const baseline = options.setup ? 1 : 0;
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
  function restart(): ListingAuthorityHistoryTestFixture {
    const source = createListingAuthorityParticipant({
      eventStore: sourceMemory.eventStore,
      snapshots:
        options.cache === false
          ? undefined
          : {
              loadLatest: async (streamId) => {
                if (options.cacheUnavailable) throw new Error("synthetic cache unavailable");
                return snapshots.get(streamId) ?? null;
              },
              save: async (snapshot) => {
                if (options.cacheUnavailable) throw new Error("synthetic cache unavailable");
                snapshots.set(snapshot.streamId, { ...snapshot, updatedAt: "2026-09-28T00:00:00.000Z" as never });
              },
            },
      participant: { owner: "catalog", purpose: "product-measures" },
      resources: (operation) =>
        options.reservationResources ?? [
          options.multipleResources && operation.subject.catalogItemId !== "cat_synthetic_history"
            ? operation.subject.catalogItemId
            : "synthetic-product",
        ],
      consumer: () => ({
        inspect: fence.inspect,
        invalidate: (operation, reason) => {
          if (blocked) throw new Error("synthetic lost abort transport");
          return fence.forParticipant("catalog").invalidate(operation, reason);
        },
      }),
      validate: async (operation) => {
        if (
          (!options.multipleResources || operation.subject.catalogItemId === "cat_synthetic_history") &&
          (await sourceMemory.eventStore.readStream({ streamId: sourceEffectStream })).length > baseline
        )
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
      writer,
      sourceEffectStream,
      blockInvalidation(value) {
        blocked = value;
      },
      restart,
      async invalidate() {
        await writer.eventStore.appendToStream({
          streamId: sourceEffectStream,
          expectedVersion: baseline,
          context,
          events: [{ eventType: "catalog.synthetic-product-revoked", payload: { revoked: true } }],
        });
      },
    };
  }
  const f = restart();
  if (options.setup) {
    await f.writer.eventStore.appendToStream({
      streamId: sourceEffectStream,
      expectedVersion: 0,
      context,
      events: [{ eventType: "catalog.synthetic-product-created", payload: { active: true } }],
    });
    await f.writer.eventStore.appendToStream({
      streamId: "catalog.synthetic-history-unrelated",
      expectedVersion: 0,
      context,
      events: [{ eventType: "catalog.synthetic-setup", payload: { active: true } }],
    });
  }
  return f;
}
