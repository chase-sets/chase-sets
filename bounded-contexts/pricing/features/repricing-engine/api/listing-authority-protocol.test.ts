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
  const consumerMemory = createInMemoryEventStore();
  const consumerStore = consumerMemory.eventStore;
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
  return { ...restart(), sourceMemory, consumerMemory, policyStream };
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
      await f.consumerStore.appendToStreams!([...terminal]);
      return (await restarted.fence.inspect(operation)).status;
    })(),
  ).rejects.toThrow();
});

it("never reuses a lost consumer terminal identity for a delayed pre-revocation commit", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  const reservation = await f.source.prepare(operation, f.context);
  const delayedCommit = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
  await f.invalidate();
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  expect((await f.source.inspect(operation))?.status).toBe("released");
  expect((await f.source.inspectInvalidation(f.context.tenantId, "synthetic-policy-revoke"))?.status).toBe("completed");
  expect(await readCompleteStream(f.sourceStore, { streamId: f.policyStream })).toHaveLength(1);

  // Synthetic loss of the consumer's authoritative operation stream and head.
  // The source's reservation, resource/integrity pair and effective revocation
  // remain intact. This is not missing projection data or a legitimate writer.
  f.consumerMemory.streams.delete(delayedCommit[0]!.streamId);
  const restarted = f.restart();
  expect((await restarted.fence.inspect(operation)).status).toBe("unknown");
  await expect(f.consumerStore.appendToStreams!([...delayedCommit])).rejects.toThrow();

  // A repair may reject reopening the lost identity or install a distinct,
  // non-reusable fence. Either way, the original executor must stay fenced out.
  try {
    await restarted.fence.open(f.input, f.context);
  } catch {
    // Fail-closed recovery is allowed; it must not make the old append valid.
  }
  await expect(
    (async () => {
      await f.consumerStore.appendToStreams!([
        ...delayedCommit,
        {
          streamId: "marketplace.synthetic-delayed-pricing-effect",
          expectedVersion: 0,
          context: f.context,
          events: [{ eventType: "marketplace.synthetic-price-accepted", payload: { amount: "12.00" } }],
        },
      ]);
      return "committed-after-effective-revocation";
    })(),
  ).rejects.toThrow();
  expect(
    await readCompleteStream(f.consumerStore, { streamId: "marketplace.synthetic-delayed-pricing-effect" }),
  ).toHaveLength(0);
});

it("never completes revocation over a lost resource and integrity pair while a prepared commit survives", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  const reservation = await f.source.prepare(operation, f.context);
  const delayedCommit = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
  const resourceStreams = [...f.sourceMemory.streams.keys()].filter((id) =>
    id.startsWith("pricing.listing-authority-resource-"),
  );
  expect(resourceStreams).toHaveLength(1);
  const resourceStream = resourceStreams[0]!;
  const integrityStream = resourceStream.replace("-resource-", "-integrity-");
  expect(f.sourceMemory.streams.has(integrityStream)).toBe(true);

  // Synthetic authoritative loss of both paired streams and their heads, not
  // projection lag. The reservation and original consumer opening are retained.
  f.sourceMemory.streams.delete(resourceStream);
  f.sourceMemory.streams.delete(integrityStream);
  const restarted = f.restart();
  await expect(restarted.source.inspect(operation)).rejects.toThrow();
  expect((await restarted.fence.inspect(operation)).status).toBe("pending");

  try {
    await restarted.invalidate();
  } catch {
    // Rejecting the corrupt source before any authority change is safe. A repair
    // may instead reconcile retained promises and abort the original consumer.
    expect(await readCompleteStream(f.sourceStore, { streamId: f.policyStream })).toHaveLength(0);
    expect(
      (await restarted.source.inspectInvalidation(f.context.tenantId, "synthetic-policy-revoke"))?.status,
    ).not.toBe("completed");
    return;
  }
  expect((await restarted.source.inspectInvalidation(f.context.tenantId, "synthetic-policy-revoke"))?.status).toBe(
    "completed",
  );
  expect(await readCompleteStream(f.sourceStore, { streamId: f.policyStream })).toHaveLength(1);

  // Re-inspecting the orphaned grant is not a fence for an append already held
  // by a delayed executor. Only the original consumer terminal can order it.
  await expect(
    (async () => {
      await f.consumerStore.appendToStreams!([
        delayedCommit,
        {
          streamId: "marketplace.synthetic-paired-loss-pricing-effect",
          expectedVersion: 0,
          context: f.context,
          events: [{ eventType: "marketplace.synthetic-price-accepted", payload: { amount: "12.00" } }],
        },
      ]);
      return "committed-after-paired-history-loss-and-effective-revocation";
    })(),
  ).rejects.toThrow();
  expect(
    await readCompleteStream(f.consumerStore, { streamId: "marketplace.synthetic-paired-loss-pricing-effect" }),
  ).toHaveLength(0);
});
