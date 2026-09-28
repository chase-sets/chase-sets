import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  listingAuthorityConformance,
  type ListingAuthorityConformanceFixture,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";

// Protocol-checkpoint probe only, not a Pricing evaluator or owner-writer proof.
async function fixture() {
  const sourceMemory = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const sourceStore = sourceMemory.eventStore;
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_pricing",
    audit: { forAccountId: "acc_synthetic_pricing", performedByUserId: "usr_synthetic_pricing" },
  };
  const resource = "synthetic-pricing-policy-predicate";
  const policyStream = "pricing.synthetic-policy-authority";

  function restart(): ListingAuthorityConformanceFixture {
    const source = createListingAuthorityParticipant({
      eventStore: sourceStore,
      participant: { owner: "pricing", purpose: "evaluated-price" },
      consumer: () => fence.forParticipant("pricing"),
      resources: () => [resource],
      validate: async (operation, audit) => {
        const history = await readCompleteStream(sourceStore, { streamId: policyStream });
        if (history.length) throw new Error("Synthetic pricing authority revoked.");
        return {
          value: { evaluatedAmount: "12.00", currencyCode: "USD" },
          sourceRevisions: [{ resourceId: resource, revision: "0" }],
          validBefore: operation.prepareBefore,
          localAppends: [{ streamId: policyStream, expectedVersion: 0, context: audit, events: [] }],
        };
      },
    });
    const fence = createListingAuthorityFence({
      eventStore: consumerStore,
      owner: "marketplace",
      participants: [source],
    });
    return {
      sourceStore,
      consumerStore,
      source,
      fence,
      context,
      restart,
      input: {
        tenantId: context.tenantId,
        accountId: context.audit.forAccountId,
        actor: { kind: "user", userId: context.audit.performedByUserId },
        committingOwner: "marketplace",
        kind: "accept-price",
        requestId: "synthetic-pricing-request",
        command: { decisionId: "synthetic-decision", amount: "12.00", currencyCode: "USD" },
        listingId: "lst_synthetic_pricing",
        subject: {
          inventoryItemId: "inv_synthetic_pricing",
          catalogItemId: "cat_synthetic_pricing",
          productId: "cat_synthetic_pricing::",
          selectedOptions: [],
          quantity: 1,
          pair: { amount: "12.00", currencyCode: "USD" },
          allocationRevision: null,
          commitmentSourceId: null,
        },
        target: { kind: "native-marketplace" },
        expectedListingRevision: 1,
        expectedTargetRevision: 1,
        expectedVisibilityRevision: null,
        expectedPublicationRevision: null,
        participants: [{ owner: "pricing", purpose: "evaluated-price" }],
      },
      invalidate: () =>
        source.mutate({
          resources: [resource],
          mutationId: "synthetic-policy-revoke",
          command: { revoke: true },
          context,
          prepare: async () => [
            {
              streamId: policyStream,
              expectedVersion: 0,
              context,
              events: [{ eventType: "pricing.synthetic-policy-revoked", payload: {} }],
            },
          ],
        }),
    };
  }
  return { ...restart(), sourceMemory, policyStream };
}

describe("Pricing participant checkpoint protocol", () => listingAuthorityConformance(it, fixture));

it("fails closed when resource history is missing but its durable reservation still exists", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  const reservation = await f.source.prepare(operation, f.context);
  const resourceStreams = [...f.sourceMemory.streams.keys()].filter((id) =>
    id.startsWith("pricing.listing-authority-resource-"),
  );
  expect(resourceStreams).toHaveLength(1);
  // Inject loss of one authoritative resource history, not projection lag or TTL expiry.
  f.sourceMemory.streams.delete(resourceStreams[0]!);

  const restarted = f.restart();
  // The repaired protocol detects corruption before claiming effective invalidation.
  await expect(restarted.invalidate()).rejects.toThrow("Lost authority resource history");
  expect(await readCompleteStream(f.sourceStore, { streamId: f.policyStream })).toHaveLength(0);
  const mutation = await restarted.source.inspectInvalidation(f.context.tenantId, "synthetic-policy-revoke");
  expect(mutation).toBeNull();
  expect((await restarted.fence.inspect(operation)).status).toBe("pending");

  // The retained promise cannot authorize acceptance or be released on corrupt membership.
  await expect(
    (async () => {
      const terminal = await restarted.fence.prepareCommit(operation, [reservation], { accepted: true });
      await f.consumerStore.appendToStreams!([terminal]);
      return (await restarted.fence.inspect(operation)).status;
    })(),
  ).rejects.toThrow();
});
