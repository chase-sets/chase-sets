import { randomUUID } from "node:crypto";
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
import { module as inventoryModule } from "../../..";
import { buildInventoryItemProjectionHandlers } from "../../inventory-items/read-model/projection";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for C2 recovery DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_c2_synthetic",
  audit: { performedByUserId: "usr_c2_synthetic", forAccountId: "acc_c2_synthetic" },
};

describeDb("issue-7169-ac8-atomic-restock: PostgreSQL stock/decision/receipt", () => {
  let pools: Readonly<Record<"inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: ReturnType<typeof inventoryModule.createServices>;
  let eventStore: ReturnType<typeof createPostgresEventStore>;
  let pending: { decisionId: string; version: number };

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["inventory"], "c2_recovery");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(inventoryModule, pool);
    services = inventoryModule.createServices(pool, {});
    eventStore = createPostgresEventStore({ pool });
    await pool.query(`INSERT INTO inventory_storage_locations
      (storage_location_id, account_id, name, ship_from_code) VALUES
      ('loc_c2_synthetic', 'acc_c2_synthetic', 'Synthetic C2 location', 'C2')`);
    const created = await eventStore.appendToStream({
      streamId: "inventory.item-inv_c2_synthetic",
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_c2_synthetic",
            accountId: "acc_c2_synthetic",
            catalogItemId: "cat_c2_synthetic",
            productId: "cat_c2_synthetic::raw",
            selectedOptions: [],
            gradedCard: null,
            storageLocationId: "loc_c2_synthetic",
            totalQuantity: 1,
            acquisitionCostAmount: null,
          },
        },
      ],
    });
    const handlers = buildInventoryItemProjectionHandlers(pool);
    for (const event of created) await handlers[event.eventType]!(toTransportEvent(event));
    pending = await services.restockDecisions.markPending(
      {
        accountId: "acc_c2_synthetic",
        orderId: "ord_c2_synthetic",
        itemId: "inv_c2_synthetic",
        quantity: 2,
        reservationRequestId: "rsv_c2_synthetic",
        source: "shipment-returned",
        pendingAt: "2026-10-14T00:00:00Z",
      },
      context,
    );
  });

  function choice(outcome: "restocked" | "written-off" = "restocked") {
    return { accountId: "acc_c2_synthetic", decisionId: pending.decisionId, expectedVersion: pending.version, outcome };
  }
  async function totals() {
    return (
      await pool.query<{ adjustments: string; decisions: string; receipts: string }>(`
      SELECT
        (SELECT COUNT(*)::text FROM event_store_events WHERE event_type = 'inventory.item.adjusted') AS adjustments,
        (SELECT COUNT(*)::text FROM event_store_events WHERE event_type = 'inventory.restock-decision.recorded') AS decisions,
        (SELECT COUNT(*)::text FROM inventory_mutation_attempts) AS receipts`)
    ).rows[0];
  }

  it("coalesces concurrent identical attempts and retains the exact private result after response loss", async () => {
    const id = randomUUID();
    const attempted = withInventoryMutationAttempt(context, id);
    const [first, concurrent] = await Promise.all([
      services.restockDecisions.recordDecision(choice(), attempted),
      services.restockDecisions.recordDecision(choice(), attempted),
    ]);
    expect(concurrent).toEqual(first);
    expect(await services.mutations.read(id, context)).toMatchObject({
      family: "restock-record",
      targetId: pending.decisionId,
      result: first,
    });
    expect(await services.restockDecisions.recordDecision(choice(), attempted)).toEqual(first);
    expect(await totals()).toEqual({ adjustments: "1", decisions: "1", receipts: "2" });
    const item = await eventStore.readStream({ streamId: "inventory.item-inv_c2_synthetic" });
    expect(item.map((event) => event.eventType)).toEqual(["inventory.item.created", "inventory.item.adjusted"]);
    expect(item[1].payload).toMatchObject({ quantityDelta: 2, reasonCode: "return-restocked" });
  });

  it("normalizes note replay and conflicts on changed choice, note or version even after recording", async () => {
    const attempted = withInventoryMutationAttempt(context, randomUUID());
    const params = { ...choice("written-off"), damageNote: " Damaged " };
    const first = await services.restockDecisions.recordDecision(params, attempted);
    expect(await services.restockDecisions.recordDecision({ ...params, damageNote: "Damaged" }, attempted)).toEqual(
      first,
    );
    for (const changed of [{ outcome: "restocked" as const }, { damageNote: "Different" }, { expectedVersion: 2 }]) {
      await expect(services.restockDecisions.recordDecision({ ...params, ...changed }, attempted)).rejects.toThrow(
        "conflicts",
      );
    }
    await expect(
      services.restockDecisions.recordDecision(params, withInventoryMutationAttempt(context, randomUUID())),
    ).rejects.toThrow();
    expect(await totals()).toEqual({ adjustments: "0", decisions: "1", receipts: "1" });
  });

  it("rejects stale version and missing trusted attempt before any stock or terminal write", async () => {
    await expect(
      services.restockDecisions.recordDecision(
        { ...choice(), expectedVersion: 2 },
        withInventoryMutationAttempt(context, randomUUID()),
      ),
    ).rejects.toThrow();
    await expect(services.restockDecisions.recordDecision(choice(), context)).rejects.toThrow();
    expect(await totals()).toEqual({ adjustments: "0", decisions: "0", receipts: "0" });
  });

  it("isolates the private first result by tenant, acting User and account", async () => {
    const id = randomUUID();
    await services.restockDecisions.recordDecision(choice("written-off"), withInventoryMutationAttempt(context, id));
    const foreignContexts: EventStoreContext[] = [
      { ...context, tenantId: "tnt_foreign_synthetic" },
      { ...context, audit: { ...context.audit, performedByUserId: "usr_foreign_synthetic" } },
      { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } },
    ];
    for (const foreign of foreignContexts) {
      expect(await services.mutations.read(id, foreign)).toBeNull();
      expect(await services.mutations.read(randomUUID(), foreign)).toBeNull();
    }
  });

  it.each(["acceptance", "stock", "decision", "receipt"])(
    "rolls back physical connection death after %s and recovers the same identity",
    async (phase) => {
      let interrupted = false;
      const faultPool: PgTransactionalPool = {
        query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
        connect: async () => {
          const client = await pool.connect();
          const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              const result = await client.query<Row>(sql, values);
              const eventWrite = sql.includes("INSERT INTO event_store_events");
              if (
                !interrupted &&
                ((phase === "acceptance" && sql.includes("INSERT INTO inventory_mutation_attempts")) ||
                  (phase === "stock" && eventWrite && values?.includes("inventory.item.adjusted")) ||
                  (phase === "decision" && eventWrite && values?.includes("inventory.restock-decision.recorded")) ||
                  (phase === "receipt" &&
                    sql.includes("UPDATE inventory_mutation_attempts") &&
                    values?.includes("restock-record")))
              ) {
                interrupted = true;
                const killed = await pool.query<{ terminated: boolean }>(
                  "SELECT pg_terminate_backend($1) AS terminated",
                  [backend.rows[0].pid],
                );
                expect(killed.rows[0].terminated).toBe(true);
                throw new Error("Synthetic C2 connection interruption");
              }
              return result;
            },
          };
        },
      };
      const faulted = inventoryModule.createServices(faultPool, {});
      const id = randomUUID();
      const attempted = withInventoryMutationAttempt(context, id);
      await expect(faulted.restockDecisions.recordDecision(choice(), attempted)).rejects.toThrow();
      expect(interrupted).toBe(true);
      expect(await services.mutations.read(id, context)).toBeNull();
      expect(await totals()).toEqual({ adjustments: "0", decisions: "0", receipts: "0" });
      const first = await services.restockDecisions.recordDecision(choice(), attempted);
      expect(await services.restockDecisions.recordDecision(choice(), attempted)).toEqual(first);
      expect(await totals()).toEqual({ adjustments: "1", decisions: "1", receipts: "2" });
    },
  );
});
