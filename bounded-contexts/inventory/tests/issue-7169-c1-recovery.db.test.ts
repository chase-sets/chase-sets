import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as inventoryModule } from "..";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildInventoryHoldProjectionHandlers } from "../features/holds/read-model/projection";
import { buildInventoryItemProjectionHandlers } from "../features/inventory-items/read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for C1 recovery DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_c1_synthetic" as never,
  audit: { performedByUserId: "usr_c1_synthetic" as never, forAccountId: "acc_c1_synthetic" as never },
};
const placement = {
  holdId: "hld_poison_synthetic",
  accountId: "acc_c1_synthetic",
  itemId: "inv_c1_synthetic",
  quantity: 1,
  reason: "Synthetic retained stock",
  notes: null,
  purpose: "manual",
  sourceRef: null,
  expiresAt: null,
};

describeDb("issue-7169-ac3-stock-invariants: PostgreSQL authority", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: ReturnType<typeof inventoryModule.createServices>;
  let eventStore: ReturnType<typeof createPostgresEventStore>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "c1_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    const discoveryPool: PgTransactionalPool = {
      ...pool,
      connect: () => pool.connect(),
      query: <Row>(sql: string, values?: readonly unknown[]) =>
        pool.query<Row>(
          process.env.CHASE_SETS_C1_MUTANT === "sql-poison-drop" && sql.includes("WITH candidates AS")
            ? sql.replace(
                "WHERE tenant_id = $1",
                "WHERE jsonb_typeof(payload -> 'quantity') = 'number' AND tenant_id = $1",
              )
            : sql,
          values,
        ),
    };
    services = inventoryModule.createServices(discoveryPool, {});
    eventStore = createPostgresEventStore({ pool });
    await pool.query(`INSERT INTO inventory_storage_locations
      (storage_location_id, account_id, name, ship_from_code) VALUES
      ('loc_c1_synthetic', 'acc_c1_synthetic', 'Synthetic C1 location', 'C1')`);
    const created = await eventStore.appendToStream({
      streamId: "inventory.item-inv_c1_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_c1_synthetic",
            accountId: "acc_c1_synthetic",
            catalogItemId: "cat_c1_synthetic",
            productId: "cat_c1_synthetic::raw",
            selectedOptions: [],
            gradedCard: null,
            storageLocationId: "loc_c1_synthetic",
            totalQuantity: 1,
            acquisitionCostAmount: null,
          },
        },
      ],
    });
    const itemHandlers = buildInventoryItemProjectionHandlers(pool);
    for (const event of created) await itemHandlers[event.eventType]!(toTransportEvent(event));
  });

  const hold = () =>
    services.holds.createHold(
      {
        accountId: context.audit.forAccountId,
        itemId: "inv_c1_synthetic",
        quantity: 1,
        reason: "Synthetic concurrent hold",
        purpose: "manual",
        sourceRef: null,
      },
      context,
    );

  async function counts() {
    return (
      await pool.query<{ event_type: string; total: string }>(
        "SELECT event_type, COUNT(*)::text AS total FROM event_store_events GROUP BY event_type ORDER BY event_type",
      )
    ).rows;
  }

  it.each([
    ["malformed quantity", { ...placement, quantity: "1" }],
    ["zero quantity", { ...placement, quantity: 0 }],
    ["negative quantity", { ...placement, quantity: -1 }],
    ["fractional quantity", { ...placement, quantity: 0.5 }],
    [
      "unknown nested source",
      {
        ...placement,
        purpose: "order",
        sourceRef: {
          orderId: "ord_synthetic",
          reservationRequestId: "rsv_synthetic",
          unknown: true,
        },
      },
    ],
  ])("rejects %s without any stock or hold append", async (_name, payload) => {
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_poison_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "inventory.hold.placed", payload }],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    await expect(
      services.holdCollisions.reduceItem(
        {
          accountId: "acc_c1_synthetic",
          itemId: "inv_c1_synthetic",
          requestedQuantity: 1,
          reason: "Synthetic reduction",
          mode: "protect-orders",
        },
        context,
      ),
    ).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  it("rejects a repeated placement and a fact after a terminal without Map or SQL cleanup", async () => {
    await eventStore.appendToStream({
      streamId: "inventory.hold-hld_poison_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [
        { eventType: "inventory.hold.placed", payload: placement },
        {
          eventType: "inventory.hold.released",
          payload: { holdId: placement.holdId, releasedAt: "2026-10-12T12:00:00Z", releaseReason: "manual" },
        },
        { eventType: "inventory.hold.placed", payload: placement },
      ],
    });
    const before = await counts();
    await expect(hold()).rejects.toThrow("reconciliation is required");
    expect(await counts()).toEqual(before);
  });

  it("serializes adjust versus hold and releases the winning hold before a new claim", async () => {
    let entered = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gatedPool: PgTransactionalPool = {
      ...pool,
      connect: () => pool.connect(),
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        const result = await pool.query<Row>(sql, values);
        if (sql.includes("WITH candidates AS") && entered < 2) {
          entered++;
          if (entered === 2) open();
          await barrier;
        }
        return result;
      },
    };
    services = inventoryModule.createServices(gatedPool, {});
    const results = await Promise.allSettled([
      hold(),
      services.items.adjustItem(
        {
          accountId: "acc_c1_synthetic",
          itemId: "inv_c1_synthetic",
          quantityDelta: -1,
          reason: "Synthetic concurrent reduction",
        },
        context,
      ),
    ]);
    expect(entered).toBe(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const placed = (
      await pool.query<{ stream_id: string }>(
        "SELECT stream_id FROM event_store_events WHERE event_type = 'inventory.hold.placed'",
      )
    ).rows;
    const adjustments = (
      await pool.query<{ total: string }>(
        "SELECT COUNT(*)::text AS total FROM event_store_events WHERE event_type = 'inventory.item.adjusted'",
      )
    ).rows[0];
    expect(placed.length + Number(adjustments.total)).toBe(1);
    if (placed.length === 1) {
      const events = await eventStore.readStream({ streamId: placed[0].stream_id });
      const handlers = buildInventoryHoldProjectionHandlers(pool);
      for (const event of events) await handlers[event.eventType]!(toTransportEvent(event));
      await services.holds.releaseHold(
        { accountId: "acc_c1_synthetic", holdId: String(events[0].payload.holdId), releaseReason: "manual" },
        context,
      );
      await expect(hold()).resolves.toMatchObject({ version: 1 });
    }
  });
});
