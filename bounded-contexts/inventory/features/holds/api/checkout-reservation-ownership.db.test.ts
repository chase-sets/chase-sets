import { Hono } from "hono";
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
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildInventoryApi, type InventoryApiEnv, type InventoryActor } from "../../../api";
import { module as inventoryModule } from "../../..";
import { decideInventoryItem, initialInventoryItemState } from "../../inventory-items/domain/domain";
import { buildInventoryItemProjectionHandlers } from "../../inventory-items/read-model/projection";
import { buildInventoryHoldProjectionHandlers } from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["inventory"] as const;
const context: EventStoreContext = {
  tenantId: "tnt_checkout_binding" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
};
const holdId = "hld_checkout_binding";
const holdStream = `inventory.hold-${holdId}`;

describeDb("checkout reservation ownership through real Inventory HTTP and Postgres", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let services: ReturnType<typeof inventoryModule.createServices>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, contextNames, "checkout_reservation_ownership");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    eventStore = createPostgresEventStore({ pool });
    services = inventoryModule.createServices(pool, {});
    await pool.query(`INSERT INTO inventory_storage_locations
      (storage_location_id, account_id, name, ship_from_code) VALUES ('loc_1', 'acc_seller', 'Main', 'MAIN')`);
    const [created] = decideInventoryItem(initialInventoryItemState, {
      type: "CreateInventoryItem",
      itemId: "inv_1" as never,
      accountId: "acc_seller" as never,
      catalogItemId: "cat_1" as never,
      productId: "cat_1::raw" as never,
      selectedOptions: [],
      storageLocationId: "loc_1",
      totalQuantity: 5,
      acquisitionCostAmount: null,
      acquisitionOccurrence: { kind: "unknown" },
      commandOccurredAt: new Date().toISOString(),
    });
    const stored = await eventStore.appendToStream({
      streamId: "inventory.item-inv_1",
      expectedVersion: "no_stream",
      events: [{ eventType: created!.type, payload: created!.data }],
      context,
    });
    const itemHandlers = buildInventoryItemProjectionHandlers(pool);
    for (const event of stored) await itemHandlers[event.eventType]!(toTransportEvent(event));
    await services.holds.createHold(
      {
        holdId: holdId as never,
        accountId: "acc_seller" as never,
        itemId: "inv_1",
        quantity: 1,
        reason: "Checkout reservation",
        purpose: "checkout",
        sourceRef: { checkoutSessionId: "chk_own", lineKey: "line_1" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      context,
    );
    await projectHold();
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  async function projectHold() {
    const handlers = buildInventoryHoldProjectionHandlers(pool);
    for (const event of await eventStore.readStream({ streamId: holdStream })) {
      await handlers[event.eventType]!(toTransportEvent(event));
    }
  }

  async function snapshot() {
    return {
      row: (await pool.query("SELECT * FROM inventory_holds WHERE hold_id = $1", [holdId])).rows[0],
      events: await eventStore.readStream({ streamId: holdStream }),
    };
  }

  function appFor(actor: InventoryActor) {
    const app = new Hono<InventoryApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", { ...context, audit: { ...context.audit, forAccountId: actor.accountId as never } });
      await next();
    });
    app.route("/api/inventory", buildInventoryApi(services));
    return app;
  }

  for (const actor of [
    { accountId: "acc_buyer", permissions: ["orders.manage"] },
    { accountId: "acc_guest", permissions: ["guest-checkout.manage"] },
  ]) {
    for (const action of ["extend", "release"] as const) {
      it(`${actor.accountId} ${action} binds the same hold to its session before persisting a mutation`, async () => {
        const app = appFor(actor);
        const send = (sessionId: string, id = holdId) =>
          app.request(`/api/inventory/checkout-reservations/${id}/${action}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ checkoutSessionId: sessionId, sellerAccountId: "acc_seller" }),
          });
        const before = await snapshot();
        const foreign = await send("chk_foreign");
        expect(foreign.status).toBe(404);
        expect(await snapshot()).toEqual(before);
        const missing = await send("chk_own", "hld_missing");
        expect(missing.status).toBe(404);
        expect(await foreign.json()).toEqual(await missing.json());
        expect(await snapshot()).toEqual(before);
        expect((await send("")).status).toBe(404);
        expect(await snapshot()).toEqual(before);
        expect(await services.holds.getHold(holdId, "acc_foreign")).toBeNull();
        expect(await services.holds.getHold(holdId, "acc_seller")).toMatchObject({ account_id: "acc_seller" });

        const own = await send("chk_own");
        expect(own.status).toBe(200);
        expect(await own.json()).toMatchObject({ holdId, sellerAccountId: "acc_seller" });
        await projectHold();
        const after = await snapshot();
        expect(after.events).toHaveLength(before.events.length + 1);
        expect(after.events.at(-1)?.eventType).toBe(
          action === "extend" ? "inventory.hold.extended" : "inventory.hold.released",
        );
        if (action === "extend") {
          expect(after.row).toMatchObject({ status: "active", extension_count: 1 });
          expect(new Date(String(after.row?.expires_at)).getTime()).toBeGreaterThan(
            new Date(String(before.row?.expires_at)).getTime(),
          );
        } else {
          expect(after.row).toMatchObject({ status: "released", release_reason: "checkout-cancelled" });
          expect((await send("chk_foreign")).status).toBe(404);
          expect((await send("chk_own")).status).toBe(200);
          expect(await snapshot()).toEqual(after);
        }
      });
    }
  }

  it("rejects non-checkout purpose and missing source associations even with a known hold ID", async () => {
    for (const [purpose, source] of [
      ["manual", null],
      ["checkout", null],
      ["order", { checkoutSessionId: "chk_own" }],
    ] as const) {
      await pool.query("UPDATE inventory_holds SET purpose = $2, source_ref = $3 WHERE hold_id = $1", [
        holdId,
        purpose,
        source ? JSON.stringify(source) : null,
      ]);
      const before = await snapshot();
      const app = appFor({ accountId: "acc_guest", permissions: ["guest-checkout.manage"] });
      for (const action of ["extend", "release"]) {
        const response = await app.request(`/api/inventory/checkout-reservations/${holdId}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkoutSessionId: "chk_own" }),
        });
        expect(response.status).toBe(404);
        expect(await snapshot()).toEqual(before);
      }
    }
  });
});
