import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext, ReadStreamInput } from "@chase-sets/event-core/storage";
import { createListingAuthorityParticipant } from "./listing-authority-participant";
import { createListingAuthorityFence } from "./listing-authority-fence";
import { createListingAuthorityWriter } from "./listing-authority-writer";

function fixture() {
  const { eventStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const source = createListingAuthorityParticipant({
    eventStore,
    participant: { owner: "inventory", purpose: "stock-allocation" },
    consumer: () => fence.forParticipant("inventory"),
    resources: () => ["synthetic-item"],
    validate: async (operation) => ({
      value: {},
      sourceRevisions: [{ resourceId: "synthetic-item", revision: "0" }],
      validBefore: operation.prepareBefore,
    }),
  });
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const fence = createListingAuthorityFence({
    eventStore: consumerStore,
    owner: "marketplace",
    participants: [source],
  });
  const restart = () =>
    createListingAuthorityWriter({ eventStore, source, owner: "inventory", resources: async () => ["synthetic-item"] });
  const input = {
    streamId: "inventory.synthetic-item",
    expectedVersion: 0,
    context,
    events: [{ eventType: "inventory.synthetic.changed", payload: { quantity: 1 } }],
  } as const;
  return { source, eventStore, context, restart, input };
}

describe("source authority writer", () => {
  it("retains a source CAS conflict until the same mutation is authoritatively reconciled", async () => {
    const f = fixture();
    const prepare = vi.fn(async () => [f.input]);
    const input = {
      resources: ["synthetic-item"],
      mutationId: "synthetic-concurrent-invalidation",
      command: { reason: "synthetic-sale" },
      context: f.context,
      prepare,
    };
    const results = await Promise.allSettled([f.source.mutate(input), f.source.mutate(input)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "concurrency_conflict" }) }),
    ]);
    await expect(f.source.mutate(input)).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
    await expect(f.source.mutate({ ...input, command: { reason: "different-sale" } })).rejects.toThrow();
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });
  it("infrastructure/platform-runtime/listing-authority-writer.ts#readStream#1", async () => {
    const f = fixture();
    const input = { streamId: "synthetic-reader", fromVersion: 3, limit: 2 };
    const raw = {
      ...f.eventStore,
      async readStream(received: ReadStreamInput) {
        expect(this).toBe(raw);
        expect(received).toBe(input);
        return [];
      },
      async readAll() {
        expect(this).toBe(raw);
        return [];
      },
    };
    const writer = createListingAuthorityWriter({
      eventStore: raw,
      source: f.source,
      owner: "inventory",
      resources: async () => [],
    });
    await expect(writer.eventStore.readStream(input)).resolves.toEqual([]);
    await expect(writer.eventStore.readAll()).resolves.toEqual([]);
  });
  it("preserves append attribution through the durable source mutation", async () => {
    const f = fixture();
    const append = vi.spyOn(f.eventStore, "appendToStreams");
    await f.restart().eventStore.appendToStreams!([
      { ...f.input, appendTelemetry: { holderKind: "bulk_listing_price_update", sourceContextName: "marketplace" } },
    ]);
    expect(
      append.mock.calls.some(([inputs]) =>
        inputs.some(
          (input) =>
            input.streamId === f.input.streamId && input.appendTelemetry?.holderKind === "bulk_listing_price_update",
        ),
      ),
    ).toBe(true);
    expect((await f.eventStore.readStream({ streamId: f.input.streamId }))[0]?.metadata).toEqual({});
  });
  it("can retry the same append intent after a confirmed resource-selection conflict", async () => {
    const f = fixture();
    let reads = 0;
    const writer = createListingAuthorityWriter({
      eventStore: f.eventStore,
      source: f.source,
      owner: "inventory",
      resources: async () => (++reads === 1 ? ["synthetic-item"] : ["synthetic-item", "new-related-item"]),
    });
    await expect(writer.eventStore.appendToStream(f.input)).rejects.toMatchObject({ code: "concurrency_conflict" });
    await expect(writer.eventStore.appendToStream(f.input)).resolves.toHaveLength(1);
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });
  it("replays a successful write even if its affected resources later change", async () => {
    const f = fixture();
    let reads = 0;
    const writer = createListingAuthorityWriter({
      eventStore: f.eventStore,
      source: f.source,
      owner: "inventory",
      resources: async () => (++reads <= 2 ? ["synthetic-item"] : []),
    });
    const first = await writer.eventStore.appendToStream(f.input);
    await expect(writer.eventStore.appendToStream(f.input)).resolves.toEqual(first);
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });
  it("recovers the same intent after a crash before invalidation starts", async () => {
    const f = fixture();
    const writer = createListingAuthorityWriter({
      eventStore: f.eventStore,
      owner: "inventory",
      source: {
        ...f.source,
        mutate: async () => {
          throw new Error("synthetic pre-invalidation crash");
        },
      },
      resources: async () => ["synthetic-item"],
    });
    await expect(writer.eventStore.appendToStream(f.input)).rejects.toThrow("synthetic pre-invalidation crash");
    const started = (await f.eventStore.readAll()).find(
      (event) => event.eventType === "inventory.listing-authority-write.started",
    )!;
    expect(await f.source.inspectInvalidation(f.context.tenantId, String(started.payload.mutationId))).toBeNull();
    await f.restart().resumeWrite(String(started.payload.writeId));
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
    await f.restart().resumeWrite(String(started.payload.writeId));
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });
  it.each(["original", "missing", "wrong"])(
    "requires the original opening on a same-store consumer terminal (%s)",
    async (opening) => {
      const { eventStore } = createInMemoryEventStore();
      const context: EventStoreContext = {
        tenantId: "tnt_synthetic",
        audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
      };
      const source = createListingAuthorityParticipant({
        eventStore,
        participant: { owner: "marketplace", purpose: "native-commitment" },
        consumer: () => fence.forParticipant("marketplace"),
        resources: () => ["synthetic-listing"],
        validate: async (operation) => ({
          value: { eligible: true },
          sourceRevisions: [{ resourceId: "synthetic-listing", revision: "0" }],
          validBefore: operation.prepareBefore,
        }),
      });
      const writer = createListingAuthorityWriter({
        eventStore,
        source,
        owner: "marketplace",
        resources: async (inputs) =>
          inputs.some((input) => input.streamId === "marketplace.synthetic-listing") ? ["synthetic-listing"] : [],
      });
      const fence = createListingAuthorityFence({
        eventStore: writer.eventStore,
        owner: "marketplace",
        participants: [source],
      });
      const operation = await fence.open(
        {
          tenantId: context.tenantId,
          accountId: context.audit.forAccountId,
          actor: { kind: "user", userId: context.audit.performedByUserId },
          committingOwner: "marketplace",
          kind: "native-commitment",
          requestId: "synthetic-local-commit",
          command: {},
          listingId: "lst_synthetic",
          subject: {
            inventoryItemId: "inv_synthetic",
            catalogItemId: "cat_synthetic",
            productId: "cat_synthetic::",
            selectedOptions: [],
            quantity: 1,
            pair: { amount: "1.00", currencyCode: "USD" },
            allocationRevision: null,
            commitmentSourceId: "off_synthetic",
          },
          target: { kind: "native-marketplace" },
          expectedListingRevision: 0,
          expectedTargetRevision: null,
          expectedVisibilityRevision: null,
          expectedPublicationRevision: null,
          participants: [source.participant],
        },
        context,
      );
      const grant = await source.prepare(operation, context);
      const terminal = await fence.prepareCommit(operation, [grant], { accepted: true });
      const { expectedFirstEventId, ...unguarded } = terminal[0]!;
      const appends = [
        {
          streamId: "marketplace.synthetic-listing",
          expectedVersion: 0,
          context,
          events: [{ eventType: "marketplace.synthetic-listing.committed", payload: {} }],
        },
        ...(opening === "original"
          ? terminal
          : opening === "missing"
            ? [unguarded, ...terminal.slice(1)]
            : [{ ...terminal[0]!, expectedFirstEventId: "evt_wrong" as const }, ...terminal.slice(1)]),
      ];
      expect(expectedFirstEventId).toBe(operation.openingEventId);
      if (opening !== "original") {
        await expect(writer.eventStore.appendToStreams!(appends)).rejects.toThrow("guarded terminal append");
        expect((await fence.inspect(operation)).status).toBe("pending");
        expect((await source.inspect(operation))?.status).toBe("reserved");
        expect(await eventStore.readStream({ streamId: "marketplace.synthetic-listing" })).toHaveLength(0);
        return;
      }
      await writer.eventStore.appendToStreams!(appends);
      expect((await fence.inspect(operation)).status).toBe("committed");
      await fence.settle(operation);
      expect((await source.inspect(operation))?.status).toBe("consumed");
    },
  );

  it("rejects opening guards on non-atomic writer methods before starting a source intent", async () => {
    const f = fixture();
    const writer = f.restart();
    const input = { ...f.input, expectedFirstEventId: "evt_original" as const };
    await expect(writer.eventStore.appendToStream(input)).rejects.toThrow("atomic appendToStreams");
    await expect(writer.eventStore.appendToStreamsIndependently!([input])).rejects.toThrow("atomic appendToStreams");
    expect(await f.eventStore.readAll()).toHaveLength(0);
  });

  it("replays an exact committed mutation across restart without another business event", async () => {
    const f = fixture();
    const first = await f.restart().eventStore.appendToStream(f.input);
    expect(await f.restart().eventStore.appendToStream(f.input)).toEqual(first);
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(1);
  });

  it("durably rejects a stale write without stranding closure or accepting its retry", async () => {
    const f = fixture();
    const writer = f.restart();
    await writer.eventStore.appendToStream(f.input);
    const stale = { ...f.input, events: [{ eventType: "inventory.synthetic.changed", payload: { quantity: 2 } }] };
    await expect(writer.eventStore.appendToStream(stale)).rejects.toMatchObject({ code: "concurrency_conflict" });
    await expect(f.restart().eventStore.appendToStream(stale)).rejects.toMatchObject({ code: "concurrency_conflict" });
    await writer.eventStore.appendToStream({ ...stale, expectedVersion: 1 });
    expect(await f.eventStore.readStream({ streamId: f.input.streamId })).toHaveLength(2);
  });

  it("does not allow an unversioned mutation to bypass current source checks", async () => {
    const f = fixture();
    await expect(f.restart().eventStore.appendToStream({ ...f.input, expectedVersion: "any" })).rejects.toThrow(
      "exact source versions",
    );
    expect(await f.eventStore.readAll()).toEqual([]);
  });
});
