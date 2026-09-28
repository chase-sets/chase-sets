import { describe, it, expect, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AggregateSnapshotStore, StoredAggregateSnapshot } from "@chase-sets/event-core/aggregate-snapshot-store";
import type { ListingAuthorityConformanceFixture } from "./listing-authority-conformance";
import { listingAuthorityConformance } from "./listing-authority-conformance";
import { createListingAuthorityFence } from "./listing-authority-fence";
import { createListingAuthorityParticipant } from "./listing-authority-participant";

async function fixture(
  snapshots?: AggregateSnapshotStore,
  mutatingPreparation = false,
  resourceScope: "tenant" | "owner" = "tenant",
) {
  const { eventStore: sourceStore } = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  function restart(): ListingAuthorityConformanceFixture {
    const source = createListingAuthorityParticipant({
      eventStore: sourceStore,
      snapshots,
      participant: { owner: "catalog", purpose: "product-measures" },
      resourceScope,
      consumer: () => fence.forParticipant("catalog"),
      resources: (operation) => [`${operation.accountId}/synthetic-product-measures`],
      validate: async (operation, context) => {
        const events = await readCompleteStream(sourceStore, { streamId: "catalog.synthetic-product" });
        if (events.length && !mutatingPreparation) throw new Error("Synthetic source is revoked.");
        return {
          value: { ready: true },
          sourceRevisions: [{ resourceId: "synthetic-product", revision: String(events.length) }],
          validBefore: operation.prepareBefore,
          localAppends: [
            {
              streamId: "catalog.synthetic-product",
              expectedVersion: events.length,
              context,
              events: mutatingPreparation ? [{ eventType: "catalog.synthetic-product.changed", payload: {} }] : [],
            },
          ],
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
        subject: {
          inventoryItemId: "inv_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
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
  it.each(["resource", "integrity"])(
    "retains promises when the %s history disappears, including with a cached fold",
    async (lost) => {
      const snapshots = new Map<string, StoredAggregateSnapshot<unknown>>();
      const f = await fixture({
        loadLatest: async (id) => snapshots.get(id) ?? null,
        save: async (snapshot) => {
          snapshots.set(snapshot.streamId, { ...snapshot, updatedAt: "2026-09-27T00:00:00.000Z" as never });
        },
      });
      const operation = await f.fence.open(f.input, f.context);
      const grant = await f.source.prepare(operation, f.context);
      const delayed = await f.fence.prepareCommit(operation, [grant], {});
      const read = f.sourceStore.readStream;
      const fault = vi
        .spyOn(f.sourceStore, "readStream")
        .mockImplementation((input) =>
          input.streamId.includes(`listing-authority-${lost}-`) ? Promise.resolve([]) : read(input),
        );
      await expect(f.restart().source.inspect(operation)).rejects.toThrow("retain source promise");
      await expect(f.restart().invalidate()).rejects.toThrow("retain source promise");
      await expect(f.fence.prepareCommit(operation, [grant], {})).rejects.toThrow();
      expect((await f.fence.inspect(operation)).status).toBe("pending");
      expect(await read({ streamId: "catalog.synthetic-product" })).toHaveLength(0);
      fault.mockRestore();
      expect((await f.source.inspect(operation))?.status).toBe("reserved");
      await f.restart().invalidate();
      await expect(f.consumerStore.appendToStreams!([delayed])).rejects.toThrow();
      expect((await f.source.inspect(operation))?.status).toBe("released");
    },
  );

  it("rejects a contradictory resource member without invalidating or releasing the retained reservation", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const read = f.sourceStore.readStream;
    const fault = vi.spyOn(f.sourceStore, "readStream").mockImplementation(async (input) => {
      const events = await read(input);
      return input.streamId.includes("listing-authority-resource-")
        ? events.map((event) => ({
            ...event,
            payload: {
              ...event.payload,
              reservation: { ...(event.payload.reservation as object), value: { forged: true } },
            },
          }))
        : events;
    });
    await expect(f.source.inspect(operation)).rejects.toThrow("integrity");
    await expect(f.invalidate()).rejects.toThrow("integrity");
    await expect(f.fence.prepareCommit(operation, [grant], {})).rejects.toThrow("integrity");
    fault.mockRestore();
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
  });

  it("rejects a truncated resource tail rather than forgetting the newest operation", async () => {
    const f = await fixture();
    const first = await f.fence.open(f.input, f.context);
    await f.source.prepare(first, f.context);
    const second = await f.fence.open({ ...f.input, requestId: "synthetic-newer" }, f.context);
    await f.source.prepare(second, f.context);
    const read = f.sourceStore.readStream;
    const fault = vi.spyOn(f.sourceStore, "readStream").mockImplementation(async (input) => {
      const events = await read(input);
      return input.streamId.includes("listing-authority-resource-")
        ? events.filter((event) => event.streamVersion < 2)
        : events;
    });
    await expect(f.invalidate()).rejects.toThrow("Lost authority resource history");
    await expect(f.source.inspect(second)).rejects.toThrow("Lost authority resource history");
    fault.mockRestore();
    expect((await f.fence.inspect(first)).status).toBe("pending");
    expect((await f.fence.inspect(second)).status).toBe("pending");
  });

  it("fences globally owned source predicates even when the writer has a different audit tenant", async () => {
    const f = await fixture(undefined, false, "owner");
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    await f.source.mutate({
      resources: [`${operation.accountId}/synthetic-product-measures`],
      mutationId: "synthetic-global-authoring",
      command: { revoke: true },
      context: { ...f.context, tenantId: "tnt_synthetic_authoring" },
      prepare: async () => [],
    });
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  it("orders a mutating preparation before earlier grants can consume the changed predicate", async () => {
    const f = await fixture(undefined, true);
    const first = await f.fence.open(f.input, f.context);
    const firstGrant = await f.source.prepare(first, f.context);
    const second = await f.fence.open({ ...f.input, requestId: "synthetic-second" }, f.context);
    await f.source.prepare(second, f.context);
    expect((await f.fence.inspect(first)).status).toBe("aborted");
    expect((await f.source.inspect(first))?.status).toBe("released");
    await expect(f.fence.prepareCommit(first, [firstGrant], {})).rejects.toThrow();
    expect((await f.source.inspect(second))?.status).toBe("reserved");
  });

  it("does not acknowledge settlement when a committed participant reservation is missing", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const reservation = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
    await f.consumerStore.appendToStreams!([terminal]);
    const read = vi.spyOn(f.sourceStore, "readStream").mockResolvedValueOnce([]);
    await expect(f.fence.settle(operation)).rejects.toThrow("Committed authority reservation is missing");
    read.mockRestore();
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
    await f.restart().fence.settle(operation);
    expect((await f.source.inspect(operation))?.status).toBe("consumed");
  });

  it("replays reservation tails from disposable owner snapshots without losing pending promises", async () => {
    const snapshots = new Map<string, StoredAggregateSnapshot<unknown>>();
    const f = await fixture({
      loadLatest: async (streamId) => snapshots.get(streamId) ?? null,
      save: async (snapshot) => {
        snapshots.set(snapshot.streamId, { ...snapshot, updatedAt: "2026-09-27T00:00:00.000Z" as never });
      },
    });
    const first = await f.fence.open(f.input, f.context);
    await f.source.prepare(first, f.context);
    const second = await f.fence.open({ ...f.input, requestId: "synthetic-snapshot-second" }, f.context);
    await f.source.prepare(second, f.context);
    expect(snapshots.size).toBe(1);
    const reads = vi.spyOn(f.sourceStore, "readStream");
    await f.restart().invalidate();
    expect(
      reads.mock.calls.some(
        ([input]) => input.streamId.includes("authority-resource-") && (input.fromVersion ?? 1) > 1,
      ),
    ).toBe(true);
    expect((await f.fence.inspect(first)).status).toBe("aborted");
    expect((await f.fence.inspect(second)).status).toBe("aborted");
    snapshots.clear();
    await f.restart().source.settle(first);
    await f.restart().source.settle(second);
    expect((await f.source.inspect(first))?.status).toBe("released");
  });
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
    const consumerAppend = f.consumerStore.appendToStreams!;
    vi.spyOn(f.consumerStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await consumerAppend(appends);
      throw new Error("lost commit reply");
    });
    await expect(f.consumerStore.appendToStreams!([terminal])).rejects.toThrow("lost commit reply");
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

  it("missing authoritative consumer history is unknown, never permission to release", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const spy = vi.spyOn(f.consumerStore, "readStream").mockResolvedValueOnce([]);
    await expect(f.source.settle(operation)).rejects.toThrow("retain source promise");
    spy.mockRestore();
    expect((await f.source.inspect(operation))?.status).toBe("reserved");
  });

  it("only a bound authenticated owner can invalidate the consumer", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    expect(() => f.fence.forParticipant("identity").invalidate(operation, "unbound")).toThrow(
      "Unbound authority owner",
    );
    expect((await f.fence.inspect(operation)).status).toBe("pending");
  });
});
