import { randomUUID } from "node:crypto";
import { withInventoryMutationAttempt } from "../support/runtime-support/mutation-attempt";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BcApiModule, type BcSchemaMigrationClient } from "@chase-sets/bounded-context-module";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  rebuildContextProjectionGroup,
  getProjectionGroup,
  resetProjectionGroup,
  resolveModuleProjectionGroups,
  resolveModuleSubscriptions,
  syncContextProjectionGroups,
  retryProjectionBlockedStream,
  type MountedContextRuntimeEntry,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { ProjectorHandlerContext } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildInventoryItemLedgerProjectionHandlers } from "../features/inventory-items/read-model/ledger-projection";
import { inventoryItemSchemaMigrations } from "../features/inventory-items/read-model/schema";
import { withInventorySystemHoldReleaseAuthority } from "../features/holds/api/runtime";
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
const handoffId = "20261028_inventory_offline_sale_ledger_handoff";
const handoffCheck = "inventory_item_ledger_offline_sale_null_delta";
const handoff = inventoryItemSchemaMigrations.find((migration) => migration.migrationId === handoffId)!;

// The retired handler differed only in the detail's quantity parameter. Keep its
// real INSERT, identities and metadata so these are old writes, not disabled writers.
async function oldSaleWriter(db: NonNullable<ProjectorHandlerContext["db"]>, event: TransportEvent) {
  const oldDb: PgQueryable = {
    query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      const oldValues = [...(values ?? [])];
      oldValues[5] = -Number(event.data.quantity);
      const result = await db.query<Row>(sql, oldValues);
      return { ...result, rows: [...result.rows] };
    },
  };
  await buildInventoryItemLedgerProjectionHandlers(oldDb)["inventory.item.offline-sale-recorded"]!(event);
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describeDb("Inventory retained-checkpoint read-model recovery", () => {
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;
  let services: ReturnType<typeof inventoryModule.createServices>;
  let runtime: ReturnType<typeof mount>;

  function mount(oldLedger = false) {
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
        projectionHandlerSets: (inventoryModule.projectionHandlerSets?.(services) ?? []).map((set) =>
          oldLedger && set.projectionName === "inventory-item-ledger-projection"
            ? {
                ...set,
                handlers: {
                  ...set.handlers,
                  "inventory.item.offline-sale-recorded": (event, handlerContext) =>
                    oldSaleWriter(handlerContext?.db ?? pools.inventory, event),
                },
              }
            : set,
        ),
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
          withInventoryMutationAttempt(context, randomUUID()),
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
          withInventoryMutationAttempt(context, randomUUID()),
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
        withInventoryMutationAttempt(context, randomUUID()),
      );
      await settle();
      if (index === 1) {
        await services.holds.releaseHold(
          { accountId, holdId: hold.holdId, releaseReason: "manual" },
          withInventoryMutationAttempt(context, randomUUID()),
        );
      }
    }
    await settle();
  });

  async function settle() {
    await drainContextRuntime(runtime, { settleIdleCheckpoints: true });
  }

  async function retainedBoot() {
    await pools.inventory.query(`ALTER TABLE inventory_item_ledger DROP CONSTRAINT ${handoffCheck}`);
    await pools.inventory.query("DELETE FROM bounded_context_schema_migrations WHERE migration_id = $1", [handoffId]);
    runtime = mount(true);
  }

  async function sale(idempotencyKey: string) {
    const item =
      (
        await pools.inventory.query<{ item_id: string }>(
          "SELECT item_id FROM inventory_items WHERE total_quantity = 10 LIMIT 1",
        )
      ).rows[0] ??
      (
        await pools.inventory.query<{ item_id: string }>(
          "SELECT item_id FROM inventory_items ORDER BY created_at, item_id LIMIT 1",
        )
      ).rows[0]!;
    await services.holdCollisions.reduceItem(
      {
        accountId,
        itemId: item.item_id,
        requestedQuantity: 1,
        reason: "Offline sale",
        reasonCode: "sold-offline",
        offlineSale: { idempotencyKey, salePriceAmount: "12.50", channel: "card-show" },
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    return item.item_id;
  }

  async function assertFullHistory() {
    const sums = await pools.inventory.query(`SELECT i.item_id, i.total_quantity,
      COALESCE(sum(l.quantity_delta), 0)::int AS ledger_quantity
      FROM inventory_items i LEFT JOIN inventory_item_ledger l
        ON l.item_id = i.item_id AND l.account_id = i.account_id
      GROUP BY i.item_id ORDER BY i.item_id`);
    expect(sums.rows.length).toBe(3);
    for (const row of sums.rows) expect(row.ledger_quantity).toBe(row.total_quantity);
    const bad = await pools.inventory.query(`SELECT ledger_entry_id FROM inventory_item_ledger
      WHERE kind = 'offline-sale' AND event_type = 'inventory.item.offline-sale-recorded'
        AND quantity_delta IS NOT NULL`);
    expect(bad.rows).toEqual([]);
  }

  async function handoffState() {
    const guard = await pools.inventory.query(
      "SELECT convalidated FROM pg_constraint WHERE conrelid = 'inventory_item_ledger'::regclass AND conname = $1",
      [handoffCheck],
    );
    const record = await pools.inventory.query(
      "SELECT migration_id FROM bounded_context_schema_migrations WHERE migration_id = $1",
      [handoffId],
    );
    return { guard: guard.rows, record: record.rows };
  }

  function instrumentedHandoff(wrap: (db: BcSchemaMigrationClient) => BcSchemaMigrationClient) {
    return {
      ...inventoryModule,
      schemaMigrations: inventoryModule.schemaMigrations!.map((migration) =>
        migration.migrationId === handoffId
          ? { ...migration, dataStep: (db: BcSchemaMigrationClient) => handoff.dataStep!(wrap(db)) }
          : migration,
      ),
    };
  }

  it("retained sale handoff preserves every sibling row, event and detail field while correcting complete sums", async () => {
    await retainedBoot();
    const itemId = await sale("retained-sale");
    await settle();
    await services.items.adjustItem(
      {
        accountId,
        itemId,
        quantityDelta: -1,
        reason: "Bare Honor Offline",
        reasonCode: "sold-offline",
        note: "No sale detail event",
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await settle();
    // Neither half of the predicate alone owns a correction, even in another account.
    await pools.inventory.query(`INSERT INTO inventory_item_ledger
      SELECT ledger_entry_id || '-kind-control', item_id, 'acc_other', occurred_at, 'adjusted', 7,
        hold_quantity, purpose, reason, reason_code, note, sale_price_amount, channel, source_ref,
        actor, event_type, stream_id, stream_version, recorded_at
      FROM inventory_item_ledger WHERE kind = 'offline-sale'`);
    await pools.inventory.query(
      `INSERT INTO inventory_item_ledger
      SELECT ledger_entry_id || '-event-control', item_id, 'acc_other', occurred_at, kind, 8,
        hold_quantity, purpose, reason, reason_code, note, sale_price_amount, channel, source_ref,
        actor, 'inventory.item.adjusted', stream_id, stream_version, recorded_at
      FROM inventory_item_ledger WHERE kind = 'offline-sale' AND account_id = $1`,
      [accountId],
    );
    const before = await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id");
    const events = await pools.inventory.query("SELECT * FROM event_store_events ORDER BY global_position");
    const items = await pools.inventory.query("SELECT * FROM inventory_items ORDER BY item_id");
    await expect(assertFullHistory()).rejects.toThrow();
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    expect((await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id")).rows).toEqual(
      before.rows.map((row) =>
        row.kind === "offline-sale" && row.event_type === "inventory.item.offline-sale-recorded"
          ? { ...row, quantity_delta: null }
          : row,
      ),
    );
    expect((await pools.inventory.query("SELECT * FROM event_store_events ORDER BY global_position")).rows).toEqual(
      events.rows,
    );
    expect((await pools.inventory.query("SELECT * FROM inventory_items ORDER BY item_id")).rows).toEqual(items.rows);
    expect(await handoffState()).toEqual({ guard: [{ convalidated: true }], record: [{ migration_id: handoffId }] });
    await assertFullHistory();
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await assertFullHistory();
  });

  it("boot replay and next sale retain non-consumption hold lifecycles and bare Honor Offline", async () => {
    await retainedBoot();
    const itemId = await sale("lifecycle-before-boot");
    await settle();
    const order = await services.holds.createHold(
      {
        accountId,
        itemId,
        quantity: 1,
        reason: "Active order",
        purpose: "order",
        sourceRef: { orderId: "ord_active", reservationRequestId: "res_active" },
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    const checkout = await services.holds.createHold(
      {
        accountId,
        itemId,
        quantity: 1,
        reason: "Active checkout",
        purpose: "checkout",
        sourceRef: { checkoutSessionId: "chk_active", lineKey: "active" },
        expiresAt: "2027-10-28T01:00:00Z",
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    for (const terminal of ["converted", "expired"] as const) {
      const hold = await services.holds.createHold(
        {
          accountId,
          itemId,
          quantity: 1,
          reason: "Checkout control",
          purpose: "checkout",
          sourceRef: { checkoutSessionId: `chk_${terminal}`, lineKey: terminal },
          expiresAt: "2026-10-28T01:00:00Z",
        },
        withInventoryMutationAttempt(context, randomUUID()),
      );
      await services.holds.commandHandler({
        streamId: `inventory.hold-${hold.holdId}`,
        command:
          terminal === "converted"
            ? {
                type: "ConvertInventoryHold",
                convertedAt: "2026-10-28T00:30:00Z",
                orderId: "ord_converted",
                reservationRequestId: "res_converted",
              }
            : { type: "ExpireInventoryHold", expiredAt: "2026-10-28T02:00:00Z" },
        context,
      });
      await settle();
      if (terminal === "converted") {
        await services.holds.releaseHold(
          { accountId, holdId: hold.holdId, releaseReason: "order-cancelled" },
          withInventorySystemHoldReleaseAuthority(withInventoryMutationAttempt(context, randomUUID())),
        );
      }
    }
    await services.items.adjustItem(
      { accountId, itemId, quantityDelta: -1, reason: "Bare Honor Offline", reasonCode: "sold-offline" },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await settle();
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    runtime = mount();
    const before = await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id");
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    const runner = runtime.subscriptionRunners.find(
      (entry) => entry.projectionName === "inventory-item-ledger-projection",
    )!;
    await runner.reset();
    await settle();
    expect((await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id")).rows).toEqual(
      before.rows,
    );
    expect(before.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "hold-placed", purpose: "manual" }),
        expect.objectContaining({ kind: "hold-placed", purpose: "order" }),
        expect.objectContaining({ kind: "hold-placed", purpose: "checkout" }),
        expect.objectContaining({ kind: "hold-converted" }),
        expect.objectContaining({ kind: "hold-released" }),
        expect.objectContaining({ kind: "hold-expired" }),
        expect.objectContaining({ kind: "adjusted", reason: "Bare Honor Offline", quantity_delta: -1 }),
      ]),
    );
    expect(
      (await pools.inventory.query("SELECT status FROM inventory_holds WHERE hold_id = $1", [order.holdId])).rows,
    ).toEqual([{ status: "active" }]);
    expect(
      (await pools.inventory.query("SELECT status FROM inventory_holds WHERE hold_id = $1", [checkout.holdId])).rows,
    ).toEqual([{ status: "active" }]);
    await sale("lifecycle-next-sale");
    await settle();
    await assertFullHistory();
  });

  it("consumed hold remains outside sale repair: stock and consumed detail retain the known mismatch", async () => {
    await retainedBoot();
    const itemId = await sale("sale-beside-consumption");
    await settle();
    const hold = await services.holds.createHold(
      {
        accountId,
        itemId,
        quantity: 1,
        reason: "Synthetic consumed order",
        purpose: "order",
        sourceRef: { orderId: "ord_sale_control", reservationRequestId: "res_sale_control" },
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await settle();
    await services.holds.commandHandler({
      streamId: `inventory.hold-${hold.holdId}`,
      command: {
        type: "ConsumeInventoryHold",
        consumedAt: "2026-10-28T00:00:00Z",
        consumptionReason: "Synthetic dispatch",
      },
      context,
    });
    await settle();
    const stock = await pools.inventory.query("SELECT * FROM inventory_items ORDER BY item_id");
    const consumed = await pools.inventory.query("SELECT * FROM inventory_item_ledger WHERE kind = 'hold-consumed'");
    expect(consumed.rows).toEqual([expect.objectContaining({ item_id: itemId, quantity_delta: -1 })]);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    expect((await pools.inventory.query("SELECT * FROM inventory_items ORDER BY item_id")).rows).toEqual(stock.rows);
    expect(
      (await pools.inventory.query("SELECT * FROM inventory_item_ledger WHERE kind = 'hold-consumed'")).rows,
    ).toEqual(consumed.rows);
    const sums = await pools.inventory.query(
      `SELECT i.total_quantity, sum(l.quantity_delta)::int AS ledger_quantity
      FROM inventory_items i JOIN inventory_item_ledger l ON l.item_id = i.item_id AND l.account_id = i.account_id
      WHERE i.item_id = $1 GROUP BY i.item_id`,
      [itemId],
    );
    expect(sums.rows).toEqual([{ total_quantity: 9, ledger_quantity: 8 }]);
  });

  it("old writer across sale handoff is locked out, quarantined and restored by the corrected runner", async () => {
    await retainedBoot();
    const itemId = await sale("before-provisional-sweep");
    await settle();
    await pools.inventory.query(`UPDATE inventory_item_ledger SET quantity_delta = NULL
      WHERE kind = 'offline-sale' AND event_type = 'inventory.item.offline-sale-recorded'`);
    await sale("after-provisional-sweep");
    await settle();
    const locked = barrier();
    const commit = barrier();
    const module = instrumentedHandoff((db) => ({
      query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        const result = await db.query<Row>(sql, values);
        if (sql.startsWith("LOCK TABLE inventory_item_ledger")) {
          locked.release();
          await commit.promise;
        }
        return result;
      },
    }));
    const boot = bootstrapContextDatabase(module, pools.inventory);
    // A rejection must not leave the bootstrap or old writer waiting on a test barrier.
    void boot.catch(() => locked.release());
    const writer = await pools.inventory.connect();
    const queuedEvent = buildTransportEvent(
      "inventory.item.offline-sale-recorded",
      {
        itemId,
        quantity: 1,
        salePriceAmount: "12.50",
        channel: "card-show",
      },
      {
        streamId: "inventory.item-queued-old-writer",
        streamVersion: 1,
        tenantId: context.tenantId,
        audit: context.audit,
      },
    );
    try {
      await locked.promise;
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const insert = oldSaleWriter(writer, queuedEvent).then(
        () => null,
        (error: unknown) => error,
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await pools.inventory.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
        if (state.rows[0]?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      commit.release();
      await boot;
      const failure = await insert;
      expect(waiting).toBe(true);
      expect(failure).toMatchObject({ code: "23514", constraint: handoffCheck });
    } finally {
      commit.release();
      await boot.catch(() => undefined);
      writer.release();
    }
    await assertFullHistory();
    // Application rollback keeps the committed guard. The actual runner advances
    // past its refused old-code write and retains a recoverable blocked stream.
    const nextItemId = await sale("old-code-after-commit");
    await settle();
    const poison = await pools.inventory.query(`SELECT error_message, state FROM event_projection_poison_events
      WHERE event_type = 'inventory.item.offline-sale-recorded'`);
    expect(poison.rows).toEqual([{ error_message: expect.stringContaining(handoffCheck), state: "blocked" }]);
    expect((await handoffState()).guard).toEqual([{ convalidated: true }]);
    runtime = mount();
    const runner = runtime.subscriptionRunners.find(
      (entry) => entry.projectionName === "inventory-item-ledger-projection",
    )!;
    await expect(
      retryProjectionBlockedStream(runtime, runner.checkpointKey, `inventory.item-${nextItemId}`, {}),
    ).resolves.toMatchObject({ state: "resolved", errorMessage: null });
    await settle();
    expect(
      (
        await pools.inventory.query(`SELECT state FROM event_projection_poison_events
      WHERE event_type = 'inventory.item.offline-sale-recorded'`)
      ).rows,
    ).toEqual([{ state: "resolved" }]);
    const missing = await pools.inventory.query(`SELECT e.event_id FROM event_store_events e
      LEFT JOIN inventory_item_ledger l ON l.stream_id = e.stream_id AND l.stream_version = e.stream_version
      WHERE e.event_type = 'inventory.item.offline-sale-recorded' AND l.ledger_entry_id IS NULL`);
    expect(missing.rows).toEqual([]);
    await assertFullHistory();
    // Guard-only bypass control: the same old input now writes and breaks the
    // invariant. Roll back the control rather than treating recorded boot as a sweep.
    const control = await pools.inventory.connect();
    try {
      await control.query("BEGIN");
      await control.query(`ALTER TABLE inventory_item_ledger DROP CONSTRAINT ${handoffCheck}`);
      await oldSaleWriter(control, queuedEvent);
      const bad = await control.query(
        `SELECT sum(quantity_delta)::int AS quantity FROM inventory_item_ledger WHERE item_id = $1 AND account_id = $2`,
        [itemId, accountId],
      );
      const stock = await control.query("SELECT total_quantity FROM inventory_items WHERE item_id = $1", [itemId]);
      expect(bad.rows[0]!.quantity).not.toBe(stock.rows[0]!.total_quantity);
    } finally {
      await control.query("ROLLBACK");
      control.release();
    }
    await assertFullHistory();
  });

  it.each(["timeout", "overflow", "injected failure", "deadline"])(
    "handoff rollback and retry: %s",
    async (failure) => {
      await retainedBoot();
      await sale(`rollback-${failure}`);
      await settle();
      if (failure === "overflow") {
        await pools.inventory.query(`INSERT INTO inventory_item_ledger
        SELECT 'overflow-' || n, 'synthetic-item', 'acc_overflow', now(), 'adjusted', 0,
          NULL, NULL, 'Synthetic bound control', NULL, NULL, NULL, NULL, NULL, 'system',
          'inventory.item.adjusted', 'inventory.item-overflow', n, now()
        FROM generate_series(1, 100001) n`);
      }
      const before = await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id");
      let restoreClock: (() => void) | undefined;
      const module = instrumentedHandoff((db) => ({
        query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          const result = await db.query<Row>(sql, values);
          if (sql.startsWith("UPDATE inventory_item_ledger")) {
            if (failure === "injected failure") throw new Error("injected after correction");
            if (failure === "timeout") {
              await db.query("SET LOCAL statement_timeout = '1ms'");
              await db.query("SELECT pg_sleep(0.02)");
            }
            if (failure === "deadline") {
              const expired = Date.now() + 60_001;
              const clock = vi.spyOn(Date, "now").mockReturnValue(expired);
              restoreClock = () => clock.mockRestore();
            }
          }
          return result;
        },
      }));
      try {
        await expect(bootstrapContextDatabase(module, pools.inventory)).rejects.toThrow("ledger handoff incomplete");
      } finally {
        restoreClock?.();
      }
      expect(await handoffState()).toEqual({ guard: [], record: [] });
      expect(
        (await pools.inventory.query("SELECT * FROM inventory_item_ledger ORDER BY ledger_entry_id")).rows,
      ).toEqual(before.rows);
      if (failure === "overflow")
        await pools.inventory.query("DELETE FROM inventory_item_ledger WHERE account_id = 'acc_overflow'");
      await bootstrapContextDatabase(inventoryModule, pools.inventory);
      expect(await handoffState()).toEqual({ guard: [{ convalidated: true }], record: [{ migration_id: handoffId }] });
      await assertFullHistory();
    },
  );

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
        `Cannot reset Inventory items: missing storage location '${location.storage_location_id}'; rebuild inventory-storage-location-projection first.`,
      );
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
      expect((await capture()).counts).toEqual([{ locations: 1, items: 0, holds: 0 }]);
      const runner = getProjectionGroup(runtime, "inventory", "inventory-item-projection").subscriptionRunners[0]!;
      expect((await runner.refreshStatus()).recoveryRequired).toBe(markerLoss);
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
        `Cannot reset Inventory holds: missing item '${item.item_id}'; rebuild inventory-item-projection first.`,
      );
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
      expect((await capture()).counts).toEqual([{ locations: 2, items: 2, holds: 0 }]);
      const runner = getProjectionGroup(runtime, "inventory", "inventory-hold-projection").subscriptionRunners[0]!;
      expect((await runner.refreshStatus()).recoveryRequired).toBe(markerLoss);
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
      ).rejects.toThrow(
        `Cannot reset Inventory restock decisions: missing item '${itemId}'; rebuild inventory-item-projection first.`,
      );
      expect(await replayBoundary()).toEqual(before);
      expect((await capture()).poison).toEqual([]);
      const runner = getProjectionGroup(runtime, "inventory", "inventory-restock-decision-projection")
        .subscriptionRunners[0]!;
      expect((await runner.refreshStatus()).recoveryRequired).toBe(markerLoss);
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
