import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type BcApiModule } from "@chase-sets/bounded-context-module";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  rebuildContextProjectionGroup,
  getProjectionGroup,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionGroupWorkerRunner } from "@chase-sets/platform-runtime/worker";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as inventoryModule } from "..";
import {
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../features/inventory-items/domain/domain";
import {
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationEvent,
} from "../features/storage-locations/domain/domain";
import {
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldEvent,
} from "../features/holds/domain/domain";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Inventory recovery DB tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["catalog", "ordering", "inventory"] as const;
const accountId = "acc_recovery_synthetic";
const context: EventStoreContext = {
  tenantId: "tnt_recovery_synthetic",
  audit: { performedByUserId: "usr_recovery_synthetic", forAccountId: accountId },
};
const orderingModule: BcApiModule<Record<string, never>, PgTransactionalPool, Record<string, never>> = {
  contextName: "ordering",
  routePrefix: "/ordering",
  streamPrefix: "ordering.",
  schemaSql: "",
  apiMounts: [],
  createServices: () => ({}),
  buildApis: () => [],
};
const parentNames = ["inventory-storage-location-projection", "inventory-item-projection"];

describeDb("Inventory retained-checkpoint read-model recovery", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let services: ReturnType<typeof inventoryModule.createServices>;
  let runtime: ReturnType<typeof mount>;

  function mount() {
    services = inventoryModule.createServices(pools.inventory, {});
    const catalogServices = catalogModule.createServices(pools.catalog, {});
    const mountedContexts: readonly MountedContextRuntimeEntry[] = [
      {
        contextName: "catalog",
        module: catalogModule,
        services: catalogServices,
        pool: pools.catalog,
        projectionHandlerSets: catalogModule.projectionHandlerSets?.(catalogServices) ?? [],
      },
      {
        contextName: "ordering",
        mountRole: "source-only",
        module: orderingModule,
        services: {},
        pool: pools.ordering,
        projectionHandlerSets: [],
      },
      {
        contextName: "inventory",
        module: inventoryModule,
        services,
        pool: pools.inventory,
        projectionHandlerSets: inventoryModule.projectionHandlerSets?.(services) ?? [],
      },
    ];
    const subscriptionRunners = resolveModuleSubscriptions(mountedContexts);
    return {
      mountedContexts,
      subscriptionRunners,
      projectionGroups: resolveModuleProjectionGroups(mountedContexts, subscriptionRunners),
    };
  }

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "inventory_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    await resetMultiContextTestSchemas({ catalog: pools.catalog });
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await catalogModule.seed?.(pools.catalog);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ inventory: pools.inventory, ordering: pools.ordering });
    await bootstrapContextDatabase(orderingModule, pools.ordering);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    runtime = mount();
    await settle();
    const locations = [];
    for (let index = 0; index < 2; index++) {
      locations.push(
        await services.storageLocations.createStorageLocation(
          {
            accountId,
            name: `Recovery shelf ${index}`,
            shipFromCode: `REC-${index}`,
            shipFromAddress: {
              name: "Synthetic recovery",
              line1: "100 Test Lane",
              line2: null,
              city: "Chicago",
              state: "IL",
              postalCode: "60601",
              country: "US",
              phone: null,
              email: null,
            },
          },
          context,
        ),
      );
    }
    await settle();
    const items = [];
    for (let index = 0; index < 3; index++) {
      items.push(
        await services.items.createItem(
          {
            accountId,
            catalogItemId: catalogSeedIds.items.charizardBaseSet,
            selectedOptions: [
              {
                dimensionId: catalogSeedIds.dimensions.form.dimensionId,
                optionId: catalogSeedIds.dimensions.form.optionIds.raw,
              },
              {
                dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
                optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
              },
            ],
            storageLocationId: locations[index % 2]!.storageLocationId,
            totalQuantity: 10 + index,
          },
          context,
        ),
      );
    }
    await settle();
    for (let index = 0; index < 2; index++) {
      const hold = await services.holds.createHold(
        {
          accountId,
          itemId: items[index]!.itemId,
          quantity: index + 1,
          reason: "Synthetic recovery",
          purpose: "manual",
          sourceRef: null,
        },
        context,
      );
      await settle();
      if (index === 1) {
        await services.holds.releaseHold({ accountId, holdId: hold.holdId, releaseReason: "manual" }, context);
      }
    }
    await settle();
  });

  async function settle() {
    await drainContextRuntime(runtime, { settleIdleCheckpoints: true });
  }

  async function capture() {
    const checkpoints = await pools.inventory.query(
      `SELECT c.checkpoint_key, c.last_global_position::text AS checkpoint,
              m.last_global_position::text AS marker
       FROM event_subscription_checkpoints c LEFT JOIN event_projection_recovery_markers m
         ON m.projection_kind = 'subscription' AND m.projection_key = c.checkpoint_key
       WHERE c.projection_name = ANY($1) ORDER BY c.checkpoint_key`,
      [parentNames],
    );
    const ledger = await pools.inventory.query(
      `SELECT projection_key, event_id, status, started_at::text FROM event_subscription_applications
       WHERE projection_key = ANY($1) ORDER BY projection_key, event_id`,
      [runtime.subscriptionRunners.filter((r) => parentNames.includes(r.projectionName)).map((r) => r.checkpointKey)],
    );
    const counts = await pools.inventory.query(
      `SELECT (SELECT count(*)::int FROM inventory_storage_locations) AS locations,
              (SELECT count(*)::int FROM inventory_items) AS items,
              (SELECT count(*)::int FROM inventory_holds) AS holds`,
    );
    const head = await pools.inventory.query(`SELECT max(global_position)::text AS head FROM event_store_events`);
    const poison = await pools.inventory.query(`SELECT projection_key, global_position::text, error_message
      FROM event_projection_poison_events ORDER BY global_position`);
    return {
      checkpoints: checkpoints.rows,
      ledger: ledger.rows,
      counts: counts.rows,
      head: head.rows,
      poison: poison.rows,
    };
  }

  async function removeRows(markers: boolean) {
    await pools.inventory.query(
      "TRUNCATE inventory_holds, inventory_restock_decisions, inventory_items, inventory_storage_locations",
    );
    if (markers) {
      await pools.inventory.query(
        "DELETE FROM event_projection_recovery_markers WHERE projection_kind = 'subscription'",
      );
    }
  }

  it("R1 operator parent rebuild reconstructs or gives an actionable refusal without changing replay authority", async () => {
    for (const name of parentNames) {
      const before = await capture();
      let failure: unknown;
      try {
        await rebuildContextProjectionGroup(runtime, "inventory", name);
      } catch (error) {
        failure = error;
      }
      const after = await capture();
      console.info(
        "R1 persisted recovery evidence",
        JSON.stringify({
          name,
          before,
          after,
          failure: String(failure),
          code: failure && typeof failure === "object" && "code" in failure ? failure.code : null,
        }),
      );
      if (failure) {
        expect(after).toEqual(before);
        expect.soft(String(failure)).toMatch(/cannot reset.*reset dependent.*rebuild/i);
      } else {
        expect(after.counts).toEqual(before.counts);
      }
    }
  });

  it("R2 marker loss never re-arms advanced parent checkpoints over retained ledger and absent rows", async () => {
    const before = await capture();
    await removeRows(true);
    const errors: string[] = [];
    for (const group of runtime.projectionGroups.filter((g) => g.targetContextName === "inventory")) {
      const worker = createProjectionGroupWorkerRunner(group);
      await worker.refreshPriority?.();
      try {
        await worker.runOnce();
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      await syncContextProjectionGroups(runtime, "inventory", { requiredOnly: true });
    } catch (error) {
      errors.push(String(error));
    }
    try {
      await settle();
    } catch (error) {
      errors.push(String(error));
    }
    const after = await capture();
    console.info("R2 persisted recovery evidence", JSON.stringify({ before, after, errors }));
    expect(after.poison).toEqual([]);
    for (const group of runtime.projectionGroups.filter((g) => parentNames.includes(g.projectionName))) {
      await group.refreshStatus();
      if (group.getStatus().recoveryRequired) {
        expect(errors.join("\n")).toMatch(/recovery.*reset|missing.*(item|storage.location)/i);
        expect(
          after.checkpoints.find((row) => row.checkpoint_key === group.subscriptionRunners[0]!.checkpointKey)?.marker,
        ).toBeNull();
      } else {
        const count = group.projectionName === "inventory-item-projection" ? "items" : "locations";
        expect(after.counts[0]![count]).toBe(count === "items" ? 3 : 2);
      }
    }
  });

  it("R3 marker-intact external removal is not mistaken for supported recovery", async () => {
    const before = await capture();
    await removeRows(false);
    await settle();
    const after = await capture();
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.counts).toEqual([{ locations: 0, items: 0, holds: 0 }]);
    for (const runner of runtime.subscriptionRunners) {
      await runner.refreshStatus();
      expect(runner.getStatus().recoveryRequired).toBe(false);
    }
  });

  async function assertAuthorityFolds() {
    const itemEvents = await pools.inventory.query<{ stream_id: string; event: InventoryItemEvent }>(
      `SELECT stream_id, jsonb_build_object('type', event_type, 'data', payload) AS event
       FROM event_store_events WHERE stream_id LIKE 'inventory.item-%' ORDER BY global_position`,
    );
    const locationEvents = await pools.inventory.query<{ stream_id: string; event: StorageLocationEvent }>(
      `SELECT stream_id, jsonb_build_object('type', event_type, 'data', payload) AS event
       FROM event_store_events WHERE stream_id LIKE 'inventory.storage-location-%' ORDER BY global_position`,
    );
    const holdEvents = await pools.inventory.query<{ stream_id: string; event: InventoryHoldEvent }>(
      `SELECT stream_id, jsonb_build_object('type', event_type, 'data', payload) AS event
       FROM event_store_events WHERE stream_id LIKE 'inventory.hold-%' ORDER BY global_position`,
    );
    const items = new Map<string, typeof initialInventoryItemState>();
    for (const row of itemEvents.rows)
      items.set(row.stream_id, evolveInventoryItem(items.get(row.stream_id) ?? initialInventoryItemState, row.event));
    const locations = new Map<string, typeof initialStorageLocationState>();
    for (const row of locationEvents.rows)
      locations.set(
        row.stream_id,
        evolveStorageLocation(locations.get(row.stream_id) ?? initialStorageLocationState, row.event),
      );
    const holds = new Map<string, typeof initialInventoryHoldState>();
    for (const row of holdEvents.rows)
      holds.set(row.stream_id, evolveInventoryHold(holds.get(row.stream_id) ?? initialInventoryHoldState, row.event));
    expect(
      (
        await pools.inventory.query(
          "SELECT item_id, storage_location_id, total_quantity FROM inventory_items ORDER BY item_id",
        )
      ).rows,
    ).toEqual(
      [...items.values()]
        .map((state) => ({
          item_id: state.id,
          storage_location_id: state.storageLocationId,
          total_quantity: state.totalQuantity,
        }))
        .sort((a, b) => a.item_id!.localeCompare(b.item_id!)),
    );
    expect(
      (
        await pools.inventory.query(
          "SELECT storage_location_id, name, is_archived FROM inventory_storage_locations ORDER BY storage_location_id",
        )
      ).rows,
    ).toEqual(
      [...locations.values()]
        .map((state) => ({ storage_location_id: state.id, name: state.name, is_archived: state.isArchived }))
        .sort((a, b) => a.storage_location_id!.localeCompare(b.storage_location_id!)),
    );
    expect(
      (
        await pools.inventory.query(
          "SELECT hold_id, item_id, quantity, status, release_reason FROM inventory_holds ORDER BY hold_id",
        )
      ).rows,
    ).toEqual(
      [...holds.values()]
        .map((state) => ({
          hold_id: state.id,
          item_id: state.itemId,
          quantity: state.quantity,
          status: state.status,
          release_reason: state.releaseReason,
        }))
        .sort((a, b) => a.hold_id!.localeCompare(b.hold_id!)),
    );
    expect([...holds.values()].map((state) => state.status).sort()).toEqual(["active", "released"]);
  }

  it("R4 ordered recovery reconstructs locations, items and active/released holds from independent folds", async () => {
    const authority = await pools.inventory.query("SELECT * FROM event_store_events ORDER BY global_position");
    await removeRows(true);
    for (const name of [...parentNames, "inventory-hold-projection"]) {
      await rebuildContextProjectionGroup(runtime, "inventory", name);
    }
    await syncContextProjectionGroups(runtime, "inventory");
    await settle();
    await assertAuthorityFolds();
    expect((await capture()).poison).toEqual([]);
    expect((await pools.inventory.query("SELECT * FROM event_store_events ORDER BY global_position")).rows).toEqual(
      authority.rows,
    );
  });

  it("R5 restart between resets, repeat drain and stale fencing preserve rows and authority", async () => {
    await removeRows(true);
    for (const name of [...parentNames, "inventory-hold-projection"]) {
      runtime = mount();
      await rebuildContextProjectionGroup(runtime, "inventory", name, { ownerId: "recovery-test", fencingToken: "10" });
    }
    await syncContextProjectionGroups(runtime, "inventory");
    await settle();
    await assertAuthorityFolds();
    const before = await capture();
    runtime = mount();
    await settle();
    await settle();
    expect(await capture()).toEqual(before);
    const boundary = await replayBoundary();
    await expect(
      rebuildContextProjectionGroup(runtime, "inventory", "inventory-hold-projection", {
        ownerId: "stale-recovery-test",
        fencingToken: "1",
      }),
    ).rejects.toThrow(/stale.*fencing/i);
    expect(await capture()).toEqual(before);
    expect(await replayBoundary()).toEqual(boundary);
    await assertAuthorityFolds();
  });

  async function replayBoundary() {
    const results = await Promise.all([
      pools.inventory.query("SELECT * FROM event_subscription_checkpoints ORDER BY checkpoint_key"),
      pools.inventory.query("SELECT * FROM event_projection_recovery_markers ORDER BY projection_kind, projection_key"),
      pools.inventory.query("SELECT * FROM event_subscription_applications ORDER BY projection_key, event_id"),
      pools.inventory.query(
        "SELECT * FROM event_projection_group_generations ORDER BY target_context_name, projection_name",
      ),
      pools.inventory.query("SELECT * FROM event_store_events ORDER BY global_position"),
    ]);
    return results.map((result) => result.rows);
  }

  it.each([false, true])(
    "R4/R6 missing-location guard (marker loss=%s) names the exact parent and preserves reset authority",
    async (markerLoss) => {
      await pools.inventory.query("TRUNCATE inventory_holds, inventory_restock_decisions, inventory_items");
      const location = (
        await pools.inventory.query<{ storage_location_id: string }>(
          "SELECT storage_location_id FROM inventory_storage_locations ORDER BY storage_location_id LIMIT 1",
        )
      ).rows[0]!;
      await pools.inventory.query("DELETE FROM inventory_storage_locations WHERE storage_location_id = $1", [
        location.storage_location_id,
      ]);
      if (markerLoss) await removeMarker("inventory-item-projection");
      const before = await replayBoundary();
      await expect(rebuildContextProjectionGroup(runtime, "inventory", "inventory-item-projection")).rejects.toThrow(
        `missing storage location '${location.storage_location_id}'`,
      );
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
      expect((await capture()).counts).toEqual([{ locations: 1, items: 0, holds: 0 }]);
    },
  );

  it.each([false, true])(
    "R4/R6 missing-item guard (marker loss=%s) names the exact parent and preserves reset authority",
    async (markerLoss) => {
      const item = (
        await pools.inventory.query<{ item_id: string }>("SELECT item_id FROM inventory_holds ORDER BY hold_id LIMIT 1")
      ).rows[0]!;
      await pools.inventory.query("TRUNCATE inventory_holds");
      await pools.inventory.query("DELETE FROM inventory_items WHERE item_id = $1", [item.item_id]);
      if (markerLoss) await removeMarker("inventory-hold-projection");
      const before = await replayBoundary();
      await expect(rebuildContextProjectionGroup(runtime, "inventory", "inventory-hold-projection")).rejects.toThrow(
        `missing item '${item.item_id}'`,
      );
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
      expect((await capture()).counts).toEqual([{ locations: 2, items: 2, holds: 0 }]);
    },
  );

  async function removeMarker(projectionName: string) {
    const runner = runtime.subscriptionRunners.find((r) => r.projectionName === projectionName)!;
    await pools.inventory.query("DELETE FROM event_projection_recovery_markers WHERE projection_key = $1", [
      runner.checkpointKey,
    ]);
  }

  it("R6 item-child guard refuses location reset with healthy unrelated parents and no holds", async () => {
    await pools.inventory.query("TRUNCATE inventory_holds");
    const before = await replayBoundary();
    await expect(
      rebuildContextProjectionGroup(runtime, "inventory", "inventory-storage-location-projection"),
    ).rejects.toThrow("Cannot reset Inventory storage locations while items exist");
    expect(await replayBoundary()).toEqual(before);
  });

  it("R6 hold-child guard refuses item reset with all locations present and no restock decisions", async () => {
    const before = await replayBoundary();
    await expect(rebuildContextProjectionGroup(runtime, "inventory", "inventory-item-projection")).rejects.toThrow(
      "Cannot reset Inventory items while holds or restock decisions exist",
    );
    expect(await replayBoundary()).toEqual(before);
  });

  async function createRestockDecision() {
    const item = (
      await pools.inventory.query<{ item_id: string }>("SELECT item_id FROM inventory_items ORDER BY item_id LIMIT 1")
    ).rows[0]!;
    await services.restockDecisions.markPending(
      {
        accountId,
        orderId: "ord_recovery_synthetic",
        itemId: item.item_id,
        quantity: 1,
        reservationRequestId: "rsv_recovery_synthetic",
        source: "shipment-returned",
        pendingAt: "2026-10-02T00:00:00.000Z",
      },
      context,
    );
    await settle();
    return item.item_id;
  }

  it("R6 restock-child guard refuses item reset with no holds and all parents present", async () => {
    await createRestockDecision();
    await pools.inventory.query("TRUNCATE inventory_holds");
    const before = await replayBoundary();
    await expect(rebuildContextProjectionGroup(runtime, "inventory", "inventory-item-projection")).rejects.toThrow(
      "Cannot reset Inventory items while holds or restock decisions exist",
    );
    expect(await replayBoundary()).toEqual(before);
    expect(
      (await pools.inventory.query("SELECT count(*)::int AS count FROM inventory_restock_decisions")).rows,
    ).toEqual([{ count: 1 }]);
  });

  it.each([false, true])(
    "R4/R6 missing-restock-item guard (marker loss=%s) preserves reset authority",
    async (markerLoss) => {
      const itemId = await createRestockDecision();
      await pools.inventory.query("TRUNCATE inventory_holds, inventory_restock_decisions");
      await pools.inventory.query("DELETE FROM inventory_items WHERE item_id = $1", [itemId]);
      if (markerLoss) await removeMarker("inventory-restock-decision-projection");
      const before = await replayBoundary();
      await expect(
        rebuildContextProjectionGroup(runtime, "inventory", "inventory-restock-decision-projection"),
      ).rejects.toThrow(`missing item '${itemId}'`);
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
    },
  );

  it.each(["item", "hold", "restock-decision"])(
    "R5 %s replay after parent reset waits without poisoning or completing",
    async (kind) => {
      const restockItemId = kind === "restock-decision" ? await createRestockDecision() : null;
      await pools.inventory.query("TRUNCATE inventory_holds, inventory_restock_decisions");
      const group = getProjectionGroup(runtime, "inventory", `inventory-${kind}-projection`);
      await resetProjectionGroup(group);
      if (kind === "item") {
        await pools.inventory.query(
          "DELETE FROM inventory_storage_locations WHERE storage_location_id = (SELECT storage_location_id FROM inventory_storage_locations ORDER BY storage_location_id LIMIT 1)",
        );
      } else {
        await pools.inventory.query("DELETE FROM inventory_items WHERE item_id = $1", [
          restockItemId ??
            (
              await pools.inventory.query<{ item_id: string }>(
                "SELECT payload->>'itemId' AS item_id FROM event_store_events WHERE event_type = 'inventory.hold.placed' ORDER BY global_position LIMIT 1",
              )
            ).rows[0]!.item_id,
        ]);
      }
      await expect(group.subscriptionRunners[0]!.runOnce()).rejects.toThrow(/missing.*rebuild/);
      expect((await capture()).poison).toEqual([]);
      expect(group.getStatus().caughtUp).toBe(false);
      expect(group.getStatus().lastError).toMatch(/missing.*rebuild/);
      const ledger = await pools.inventory.query<{ status: string }>(
        "SELECT status FROM event_subscription_applications WHERE projection_key = $1",
        [group.subscriptionRunners[0]!.checkpointKey],
      );
      expect(ledger.rows.some((row) => row.status === "transient")).toBe(true);
    },
  );
});
