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

async function fixture(quantity = 2) {
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
        const placed = events.find((event) => event.eventType === "inventory.hold.placed")!;
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
    owner: "ordering",
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
          selectedOptions: [],
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
    committingOwner: "ordering",
    kind: "native-commitment",
    requestId: "synthetic-purchase",
    command: { orderId: "ord_synthetic" },
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
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
    await f.consumerStore.appendToStreams!([commit]);
    await f.fence.settle(operation);
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-other-purchase" }, f.context);
    await expect(f.restart().source.prepare(next, f.context)).rejects.toThrow("current sellable Inventory stock");
    expect((await f.fence.inspect(operation)).status).toBe("committed");
  });
});
