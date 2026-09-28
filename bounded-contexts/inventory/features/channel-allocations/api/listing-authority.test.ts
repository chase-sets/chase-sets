import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { createInventoryListingAuthority } from "./listing-authority";
import { createInventoryChannelStockAllocationRuntime } from "./runtime";
import { createInventoryHoldRuntime } from "../../holds/api/runtime";

async function fixture(
  quantity = 2,
  owner: "ordering" | "marketplace" = "ordering",
  selectedOptions: readonly { dimensionId: string; optionId: string }[] = [],
) {
  const memory = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const db: PgQueryable = {
    async query<Row>(sql: string) {
      if (!sql.includes("WITH placed_holds")) return { rows: [] as Row[] };
      const rows = [];
      for (const [streamId, events] of memory.streams) {
        if (!streamId.startsWith("inventory.hold-")) continue;
        const placed = events.find((event) => event.eventType === "inventory.hold.placed");
        if (!placed) continue;
        rows.push({
          hold_id: placed.payload.holdId,
          account_id: placed.payload.accountId,
          item_id: placed.payload.itemId,
          quantity: placed.payload.quantity,
          active: !events.some((event) =>
            ["inventory.hold.released", "inventory.hold.consumed", "inventory.hold.expired"].includes(event.eventType),
          ),
        });
      }
      return { rows: rows as Row[] };
    },
  };
  const deps = {
    eventStore: memory.eventStore,
    db,
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
  };
  const restart = () => createInventoryListingAuthority(deps, () => fence.forParticipant("inventory"));
  const authority = restart();
  const fence = createListingAuthorityFence({
    eventStore: consumerStore,
    owner,
    participants: [authority.source],
  });
  await authority.eventStore.appendToStream({
    streamId: "inventory.item-inv_synthetic",
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "inventory.item.created",
        payload: {
          itemId: "inv_synthetic",
          accountId: "acc_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          selectedOptions,
          gradedCard: null,
          storageLocationId: "loc_synthetic",
          totalQuantity: quantity,
          acquisitionCostAmount: null,
        },
      },
    ],
  });
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: owner,
    kind: "native-commitment",
    requestId: "synthetic-purchase",
    command: { orderId: "ord_synthetic" },
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions,
      quantity: 1,
      pair: { amount: "12.00", currencyCode: "USD" },
      allocationRevision: 0,
      commitmentSourceId: "ord_synthetic",
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: 1,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: 1,
    expectedPublicationRevision: 1,
    participants: [authority.source.participant],
  };
  const guardedDeps = { ...deps, eventStore: authority.eventStore };
  return {
    ...deps,
    memory,
    context,
    input,
    fence,
    authority,
    restart,
    consumerStore,
    holds: createInventoryHoldRuntime(guardedDeps),
    allocations: createInventoryChannelStockAllocationRuntime(guardedDeps),
  };
}

describe("Inventory Listing participation", () => {
  it.each([
    ["inventory.hold-collision-ihc_synthetic", "inventory.hold-collision-recorded", { collisionId: "ihc_synthetic" }],
    ["inventory.hold-collision-legal-hold", "inventory.hold.placed", { holdId: "collision-legal-hold" }],
  ])(
    "classifies %s by its opening identity and invalidates the original owner",
    async (streamId, eventType, identity) => {
      const f = await fixture();
      const operation = await f.fence.open({ ...f.input, kind: "activate-channel" }, f.context);
      await f.authority.source.prepare(operation, f.context);
      const input = {
        streamId,
        expectedVersion: 0,
        context: { ...f.context, audit: { ...f.context.audit, forAccountId: "acc_system" } },
        events: [{ eventType, payload: { ...identity, itemId: "inv_synthetic", accountId: "acc_synthetic" } }],
      };
      await expect(f.authority.eventStore.appendToStream(input)).resolves.toHaveLength(1);
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      await expect(f.authority.eventStore.appendToStream(input)).resolves.toHaveLength(1);
    },
  );

  it.each([
    ["inventory.hold-plain", "inventory.hold-collision-recorded", { collisionId: "plain" }],
    ["inventory.hold-collision-ihc_wrong", "inventory.hold.placed", { holdId: "ihc_wrong" }],
    ["inventory.hold-collision-ihc_wrong", "inventory.hold-collision-recorded", { collisionId: "ihc_other" }],
  ])("rejects a mismatched Hold or Collision opening at %s", async (streamId, eventType, identity) => {
    const f = await fixture();
    await expect(
      f.authority.eventStore.appendToStream({
        streamId,
        expectedVersion: 0,
        context: f.context,
        events: [{ eventType, payload: { ...identity, itemId: "inv_synthetic", accountId: "acc_synthetic" } }],
      }),
    ).rejects.toThrow("Hold mutation has no authoritative Inventory owner.");
    expect(await f.eventStore.readStream({ streamId })).toEqual([]);
  });
  it("accepts equivalent selection objects after durable writer key canonicalization", async () => {
    const f = await fixture(2, "ordering", [{ optionId: "opt_synthetic", dimensionId: "dim_synthetic" }]);
    const operation = await f.fence.open(f.input, f.context);
    await expect(f.authority.source.prepare(operation, f.context)).resolves.toMatchObject({ status: "reserved" });
  });

  it("retains an accepted Offer hold and converts that exact hold to its Order without claiming stock twice", async () => {
    const f = await fixture(1, "marketplace");
    const operation = await f.fence.open(
      { ...f.input, subject: { ...f.input.subject, commitmentSourceId: "off_synthetic" } },
      f.context,
    );
    const grant = await f.authority.source.prepare(operation, f.context);
    const holdId = String(grant.value.holdId);
    const placed = (await f.eventStore.readStream({ streamId: `inventory.hold-${holdId}` }))[0]!;
    expect(placed.payload).toMatchObject({
      purpose: "offer",
      expiresAt: null,
      sourceRef: { offerId: "off_synthetic" },
    });
    await f.consumerStore.appendToStreams!([
      ...(await f.fence.prepareCommit(operation, [grant], { offerId: "off_synthetic" })),
    ]);
    await f.fence.settle(operation);
    const input = {
      holdId: holdId as never,
      accountId: "acc_synthetic" as never,
      itemId: "inv_synthetic",
      quantity: 1,
      offerId: "off_synthetic",
      orderId: "ord_from_offer",
      reservationRequestId: "rsv_from_offer",
    };
    await expect(f.holds.planConvertOfferHold({ ...input, offerId: "off_wrong" }, f.context)).rejects.toThrow(
      "accepted Offer",
    );
    const conversion = await f.holds.planConvertOfferHold(input, f.context);
    expect(conversion.kind).toBe("append");
    if (conversion.kind !== "append") throw new Error("Expected Offer hold conversion.");
    await f.authority.eventStore.appendToStreams!([conversion.append]);
    expect((await f.eventStore.readStream({ streamId: `inventory.hold-${holdId}` })).at(-1)?.payload).toMatchObject({
      purpose: "order",
      sourceRef: { orderId: "ord_from_offer" },
    });
    expect((await f.holds.planConvertOfferHold(input, f.context)).kind).toBe("already-converted");
    expect([...f.memory.streams.keys()].filter((id) => id.startsWith("inventory.hold-"))).toHaveLength(1);
  });

  it("serializes two simultaneous purchases of the last unit using actual Inventory holds", async () => {
    const f = await fixture(1);
    const attempts = await Promise.allSettled(
      ["first", "second"].map(async (requestId) => {
        const operation = await f.fence.open(
          { ...f.input, requestId, subject: { ...f.input.subject, commitmentSourceId: `ord_${requestId}` } },
          f.context,
        );
        try {
          const grant = await f.authority.source.prepare(operation, f.context);
          await f.consumerStore.appendToStreams!([
            ...(await f.fence.prepareCommit(operation, [grant], { orderId: `ord_${requestId}` })),
          ]);
          await f.fence.settle(operation);
          return operation;
        } catch (error) {
          await f.fence.abort(operation, "competing-purchase");
          if (await f.authority.source.inspect(operation)) await f.authority.source.settle(operation);
          throw error;
        }
      }),
    );
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const active = [...f.memory.streams.entries()].filter(
      ([id, events]) => id.startsWith("inventory.hold-") && events.at(-1)?.eventType === "inventory.hold.placed",
    );
    expect(active).toHaveLength(1);
  });

  it("fences the owned stock even when a writer's audit account is a system account", async () => {
    const f = await fixture();
    const operation = await f.fence.open({ ...f.input, kind: "activate-channel" }, f.context);
    await f.authority.source.prepare(operation, f.context);
    await f.authority.eventStore.appendToStream({
      streamId: "inventory.item-inv_synthetic",
      expectedVersion: 1,
      context: { ...f.context, audit: { ...f.context.audit, forAccountId: "acc_synthetic_system" } },
      events: [{ eventType: "inventory.item.quantity-adjusted", payload: { quantityDelta: -1 } }],
    });
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });
  it("creates a real purchase hold and atomically releases it against an aborted terminal after restart", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.authority.source.prepare(operation, f.context);
    const streamId = `inventory.hold-${String(grant.value.holdId)}`;
    expect((await f.eventStore.readStream({ streamId }))[0]?.eventType).toBe("inventory.hold.placed");
    await f.fence.abort(operation, "synthetic-cancel");
    expect((await f.restart().source.settle(operation)).status).toBe("released");
    expect((await f.eventStore.readStream({ streamId })).at(-1)?.eventType).toBe("inventory.hold.released");
    await f.restart().source.settle(operation);
    expect(await f.eventStore.readStream({ streamId })).toHaveLength(2);
  });

  it("does not create an activation hold, and a new hold invalidates the earlier availability grant", async () => {
    const f = await fixture();
    const operation = await f.fence.open({ ...f.input, kind: "activate-channel" }, f.context);
    await f.authority.source.prepare(operation, f.context);
    expect([...f.memory.streams.keys()].filter((key) => key.startsWith("inventory.hold-"))).toEqual([]);
    await f.holds.createHold(
      {
        holdId: "hld_synthetic_manual",
        accountId: "acc_synthetic",
        itemId: "inv_synthetic",
        quantity: 1,
        reason: "Synthetic manual hold",
        purpose: "manual",
        sourceRef: null,
      },
      f.context,
    );
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  it("fences insertion of a previously absent allocation through the real allocation writer", async () => {
    const f = await fixture();
    const operation = await f.fence.open({ ...f.input, kind: "activate-channel" }, f.context);
    await f.authority.source.prepare(operation, f.context);
    expect(
      (
        await f.allocations.set(
          {
            accountId: "acc_synthetic",
            inventoryItemId: "inv_synthetic",
            expectedRevision: 0,
            mode: "partitioned",
            partitions: [{ channelConnectionId: "con_synthetic", units: 1 }],
          },
          f.context,
        )
      ).kind,
    ).toBe("applied");
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
  });

  it("retains committed stock and rejects a concurrent claim of the same last unit", async () => {
    const f = await fixture(1);
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.authority.source.prepare(operation, f.context);
    const commit = await f.fence.prepareCommit(operation, [grant], { orderId: "ord_synthetic" });
    await f.consumerStore.appendToStreams!([...commit]);
    await f.fence.settle(operation);
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-other-purchase" }, f.context);
    await expect(f.restart().source.prepare(next, f.context)).rejects.toThrow("current sellable Inventory stock");
    expect((await f.fence.inspect(operation)).status).toBe("committed");
  });
});
