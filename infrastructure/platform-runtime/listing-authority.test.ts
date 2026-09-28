import { describe, it, expect, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityConformanceFixture } from "./listing-authority-conformance";
import { listingAuthorityConformance } from "./listing-authority-conformance";
import { createListingAuthorityFence } from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";

async function fixture() {
  const { eventStore: sourceStore } = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  function restart(): ListingAuthorityConformanceFixture {
    const source = createListingAuthorityParticipant({
      eventStore: sourceStore,
      participant: { owner: "catalog", purpose: "product-measures" },
      consumer: () => fence.forParticipant("catalog"),
      resources: (operation) => [`${operation.accountId}/synthetic-product-measures`],
      validate: async (operation, context) => {
        const events = await readCompleteStream(sourceStore, { streamId: "catalog.synthetic-product" });
        if (events.length) throw new Error("Synthetic source is revoked.");
        return {
          value: { ready: true },
          sourceRevisions: [{ resourceId: "synthetic-product", revision: "0" }],
          validBefore: operation.prepareBefore,
          localGuards: [{ streamId: "catalog.synthetic-product", expectedVersion: 0, context, events: [] }],
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
        kind: "native-visibility",
        requestId: "synthetic-request",
        command: { priceAmount: "12.00", priceCurrencyCode: "USD", quantity: 1 },
        listingId: "lst_synthetic",
        target: { kind: "native-marketplace" },
        expectedListingRevision: 1,
        expectedTargetRevision: 1,
        expectedVisibilityRevision: 1,
        expectedPublicationRevision: null,
        participants: [{ owner: "catalog", purpose: "product-measures" }],
      },
      invalidate: () =>
        source.mutate({
          resources: [`${context.audit.forAccountId}/synthetic-product-measures`],
          mutationId: "synthetic-invalidation",
          command: { revoke: true },
          context,
          prepare: async () => [
            {
              streamId: "catalog.synthetic-product",
              expectedVersion: 0,
              context,
              events: [{ eventType: "catalog.synthetic-product-revoked", payload: {} }],
            },
          ],
        }),
    };
  }
  return restart();
}

describe("durable Listing authority protocol conformance", () => listingAuthorityConformance(it, fixture));

describe("Listing authority unknown outcomes and predicate serialization", () => {
  it("recovers ambiguous prepare, commit and settle replies from authoritative histories", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const sourceAppend = f.sourceStore.appendToStreams!;
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await sourceAppend(appends);
      throw new Error("lost prepare reply");
    });
    const reservation = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
    await f.consumerStore.appendToStreams!([terminal]);
    const restarted = f.restart();
    expect((await restarted.fence.inspect(operation)).status).toBe("committed");
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await sourceAppend(appends);
      throw new Error("lost settle reply");
    });
    expect((await restarted.source.settle(operation)).status).toBe("consumed");
  });
  it("retains a closed invalidation across an ambiguous abort and resumes the same writer after restart", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const append = f.consumerStore.appendToStream;
    const read = f.consumerStore.readStream;
    vi.spyOn(f.consumerStore, "appendToStream").mockImplementationOnce(async (input) => {
      await append(input);
      throw new Error("lost abort reply");
    });
    vi.spyOn(f.consumerStore, "readStream")
      .mockImplementationOnce(read)
      .mockRejectedValueOnce(new Error("consumer unavailable"));
    await expect(f.invalidate()).rejects.toThrow();
    vi.restoreAllMocks();
    const later = await f.fence.open({ ...f.input, requestId: "synthetic-next" }, f.context);
    await expect(f.source.prepare(later, f.context)).rejects.toThrow("pending invalidation");
    await f.restart().invalidate();
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    expect(await f.sourceStore.readStream({ streamId: "catalog.synthetic-product" })).toHaveLength(1);
  });
  it("a source change during acquisition fences the whole predicate, including a previously absent row", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const append = f.sourceStore.appendToStreams!;
    vi.spyOn(f.sourceStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await f.invalidate();
      return append(appends);
    });
    await expect(f.source.prepare(operation, f.context)).rejects.toThrow();
    expect(await f.source.inspect(operation)).toBeNull();
  });
});
