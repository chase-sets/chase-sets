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
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as inventoryModule } from "../../..";
import { buildInventoryItemProjectionHandlers } from "../../inventory-items/read-model/projection";
import { buildInventoryHoldProjectionHandlers } from "../../holds/read-model/projection";
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

  async function durableSnapshot() {
    return {
      events: (await pool.query("SELECT * FROM event_store_events ORDER BY global_position")).rows,
      streams: (await pool.query("SELECT * FROM event_store_streams ORDER BY stream_id")).rows,
      receipts: (await pool.query("SELECT * FROM inventory_mutation_attempts ORDER BY attempt_key")).rows,
      legacy: (await pool.query("SELECT * FROM inventory_item_adjustment_idempotency ORDER BY idempotency_key")).rows,
    };
  }

  async function appendDecision(events: { eventType: string; payload: JsonObject }[]) {
    return eventStore.appendToStream({
      streamId: `inventory.restock-decision-${pending.decisionId}`,
      expectedVersion: "any",
      context,
      events,
    });
  }

  it.each(["in_progress", "completed"] as const)(
    "refuses a retained %s legacy receipt without fabricating lineage",
    async (status) => {
      await pool.query(
        `INSERT INTO inventory_item_adjustment_idempotency
      (idempotency_key, account_id, item_id, command_fingerprint, claim_generation, status, result_item_id, result_version, created_at)
      VALUES ($1, $2, 'inv_c2_synthetic', 'synthetic-legacy', 'synthetic-generation', $3, 'inv_c2_synthetic', 2, now())`,
        [`restock-decision:${pending.decisionId}:restocked`, context.audit.forAccountId, status],
      );
      const before = await durableSnapshot();
      for (const outcome of ["restocked", "written-off"] as const)
        await expect(
          services.restockDecisions.recordDecision(
            choice(outcome),
            withInventoryMutationAttempt(context, randomUUID()),
          ),
        ).rejects.toThrow("reconciliation");
      expect(await durableSnapshot()).toEqual(before);
      expect(await services.mutations.read(randomUUID(), context)).toBeNull();
    },
  );

  it("preserves exact root and nested receipts through boot-two, same-boot and lagged-empty restock reads", async () => {
    const attempt = withInventoryMutationAttempt(context, randomUUID());
    expect(await services.restockDecisions.listPending({ accountId: context.audit.forAccountId })).toEqual({
      items: [],
      total: 0,
    });
    const first = await services.restockDecisions.recordDecision(choice(), attempt);
    const before = await durableSnapshot();
    for (let boot = 0; boot < 2; boot++) {
      await bootstrapContextDatabase(inventoryModule, pool);
      const restarted = inventoryModule.createServices(pool, {});
      expect(await restarted.restockDecisions.recordDecision(choice(), attempt)).toEqual(first);
      expect(await services.restockDecisions.recordDecision(choice(), attempt)).toEqual(first);
      expect(await durableSnapshot()).toEqual(before);
    }
  });

  it("does not confuse unrelated-order retained stock with the pending decision", async () => {
    await services.items.adjustItem(
      {
        accountId: context.audit.forAccountId,
        itemId: "inv_c2_synthetic",
        quantityDelta: 2,
        reason: "return-restocked",
        reasonCode: "return-restocked",
        sourceRef: { orderId: "ord_other_synthetic", reservationRequestId: "rsv_other_synthetic" },
      },
      withInventoryMutationAttempt(context, randomUUID()),
    );
    await services.restockDecisions.recordDecision(choice(), withInventoryMutationAttempt(context, randomUUID()));
    expect(await totals()).toEqual({ adjustments: "2", decisions: "1", receipts: "3" });
  });

  it.each([
    ["unknown root", { unknown: true }],
    [
      "nested unknown",
      { sourceRef: { orderId: "ord_c2_synthetic", reservationRequestId: "rsv_c2_synthetic", unknown: true } },
    ],
    ["mixed identity", { decisionId: "rstk_foreign_synthetic" }],
    ["mixed source", { sourceRef: { orderId: "ord_foreign_synthetic", reservationRequestId: "rsv_c2_synthetic" } }],
    ["numeric string", { quantity: "2" }],
    ["zero quantity", { quantity: 0 }],
    ["fractional quantity", { quantity: 0.5 }],
    ["unsafe quantity", { quantity: Number.MAX_SAFE_INTEGER + 1 }],
    ["date only", { pendingAt: "2026-10-14" }],
    ["timezone absent", { pendingAt: "2026-10-14T00:00:00" }],
  ])("rejects retained %s without changing facts, stream versions or receipts", async (_name, patch) => {
    await pool.query(
      "UPDATE event_store_events SET payload = payload || $2::jsonb WHERE stream_id = $1 AND stream_version = 1",
      [`inventory.restock-decision-${pending.decisionId}`, JSON.stringify(patch)],
    );
    const before = await durableSnapshot();
    await expect(
      services.restockDecisions.recordDecision(choice(), withInventoryMutationAttempt(context, randomUUID())),
    ).rejects.toThrow("reconciliation");
    expect(await durableSnapshot()).toEqual(before);
  });

  it.each([
    "duplicate pending",
    "post-terminal",
    "missing version",
    "ledger disagreement",
    "mixed tenant",
    "mixed audit Account",
  ])("rejects complete %s history without writes", async (defect) => {
    const streamId = `inventory.restock-decision-${pending.decisionId}`;
    const [first] = await eventStore.readStream({ streamId });
    if (defect === "duplicate pending") await appendDecision([{ eventType: first.eventType, payload: first.payload }]);
    if (defect === "post-terminal") {
      const terminal: JsonObject = {
        ...first.payload,
        outcome: "written-off",
        reason: "written-off",
        damageNote: null,
        decidedAt: "2026-10-14T00:00:01Z",
      };
      delete terminal.source;
      delete terminal.shipmentId;
      delete terminal.returnReason;
      delete terminal.pendingAt;
      await appendDecision(
        Array.from({ length: 2 }, () => ({ eventType: "inventory.restock-decision.recorded", payload: terminal })),
      );
    }
    if (defect === "missing version") {
      await appendDecision([{ eventType: first.eventType, payload: first.payload }]);
      await pool.query("DELETE FROM event_store_events WHERE stream_id = $1 AND stream_version = 2", [streamId]);
    }
    if (defect === "ledger disagreement")
      await pool.query(
        "UPDATE event_store_streams SET current_version = 2 WHERE stream_id = $1 AND current_version = 1",
        [streamId],
      );
    if (defect === "mixed audit Account")
      await pool.query(
        "UPDATE event_store_events SET for_account_id = $2 WHERE stream_id = $1 AND stream_version = 1",
        [streamId, "acc_foreign_synthetic"],
      );
    if (defect === "mixed tenant")
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 1,
        context: { ...context, tenantId: "tnt_foreign_synthetic" },
        events: [{ eventType: first.eventType, payload: first.payload }],
      });
    const before = await durableSnapshot();
    await expect(
      services.restockDecisions.recordDecision(choice(), withInventoryMutationAttempt(context, randomUUID())),
    ).rejects.toThrow("reconciliation");
    expect(await durableSnapshot()).toEqual(before);
  });

  it.each(["restocked", "written-off"] as const)(
    "retains causal split-stock evidence beyond one page before %s",
    async (outcome) => {
      await eventStore.appendToStream({
        streamId: "inventory.item-inv_c2_synthetic",
        expectedVersion: 1,
        context,
        events: [
          ...Array.from({ length: 500 }, () => ({
            eventType: "inventory.item.adjusted",
            payload: {
              itemId: "inv_c2_synthetic",
              quantityDelta: 0,
              reason: "correction",
            },
          })),
          {
            eventType: "inventory.item.adjusted",
            payload: {
              itemId: "inv_c2_synthetic",
              quantityDelta: 2,
              reason: "return-restocked",
              reasonCode: "return-restocked",
              sourceRef: { orderId: "ord_c2_synthetic", reservationRequestId: "rsv_c2_synthetic" },
            },
          },
        ],
      });
      const before = await durableSnapshot();
      await expect(
        services.restockDecisions.recordDecision(choice(outcome), withInventoryMutationAttempt(context, randomUUID())),
      ).rejects.toThrow("reconciliation");
      expect(await durableSnapshot()).toEqual(before);
    },
  );

  it.each(["tenant", "account"])(
    "conceals a foreign %s, even with poisoned history, exactly like a missing target",
    async (scope) => {
      await pool.query(
        "UPDATE event_store_events SET payload = payload || '{\"unknown\":true}'::jsonb WHERE stream_id = $1 AND stream_version = 1",
        [`inventory.restock-decision-${pending.decisionId}`],
      );
      const foreign: EventStoreContext =
        scope === "tenant"
          ? { ...context, tenantId: "tnt_foreign_synthetic" }
          : { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } };
      const before = await durableSnapshot();
      for (const decisionId of [pending.decisionId, "rstk_missing_synthetic"]) {
        await expect(
          services.restockDecisions.recordDecision(
            { ...choice(), decisionId, accountId: foreign.audit.forAccountId },
            withInventoryMutationAttempt(foreign, randomUUID()),
          ),
        ).rejects.toThrow("Restock decision not found.");
      }
      expect(await durableSnapshot()).toEqual(before);
    },
  );

  it("binds a distinct nested stock receipt to its exact root, family, target, authority and terminal result", async () => {
    const id = randomUUID();
    await services.restockDecisions.recordDecision(choice(), withInventoryMutationAttempt(context, id));
    const receipts = await pool.query<{
      family: string;
      target_id: string;
      tenant_id: string;
      actor_user_id: string;
      account_id: string;
      status: string;
      result: unknown;
    }>(
      "SELECT family, target_id, tenant_id, actor_user_id, account_id, status, result FROM inventory_mutation_attempts ORDER BY family",
    );
    expect(receipts.rows).toEqual([
      {
        family: "item-adjust",
        target_id: "inv_c2_synthetic",
        tenant_id: context.tenantId,
        actor_user_id: context.audit.performedByUserId,
        account_id: context.audit.forAccountId,
        status: "succeeded",
        result: { itemId: "inv_c2_synthetic", version: 2 },
      },
      {
        family: "restock-record",
        target_id: pending.decisionId,
        tenant_id: context.tenantId,
        actor_user_id: context.audit.performedByUserId,
        account_id: context.audit.forAccountId,
        status: "succeeded",
        result: { decisionId: pending.decisionId, version: 2 },
      },
    ]);
  });

  const commitOrders = [
    ["decision", "adjust", "release"],
    ["decision", "release", "adjust"],
    ["adjust", "decision", "release"],
    ["adjust", "release", "decision"],
    ["release", "decision", "adjust"],
    ["release", "adjust", "decision"],
  ] as const;
  it.each(
    commitOrders.flatMap((order) => (["restocked", "written-off"] as const).map((outcome) => ({ order, outcome }))),
  )(
    "preserves complete stock/hold/decision histories for $outcome with commit order $order",
    async ({ order, outcome }) => {
      const held = await services.holds.createHold(
        {
          accountId: context.audit.forAccountId,
          itemId: "inv_c2_synthetic",
          quantity: 1,
          reason: "Synthetic C2 interleaving",
          purpose: "manual",
          sourceRef: null,
        },
        withInventoryMutationAttempt(context, randomUUID()),
      );
      const handlers = buildInventoryHoldProjectionHandlers(pool);
      for (const event of await eventStore.readStream({ streamId: `inventory.hold-${held.holdId}` }))
        await handlers[event.eventType]!(toTransportEvent(event));
      const names = { "restock-record": "decision", "item-adjust": "adjust", "hold-release": "release" } as const;
      const gates = new Map<string, () => void>();
      let allEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        allEntered = resolve;
      });
      const gatedPool: PgTransactionalPool = {
        query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
        connect: async () => {
          const client = await pool.connect();
          let root = true;
          return {
            release: client.release.bind(client),
            query: async <Row>(sql: string, values?: readonly unknown[]) => {
              const target =
                typeof values?.[0] === "string" && values[0].startsWith("inventory-target:") ? values[0] : null;
              if (root && target && sql.includes("pg_advisory_xact_lock")) {
                root = false;
                const family = Object.keys(names).find((family) => target.includes(`:${family}:`));
                const name = names[family as keyof typeof names];
                expect(name).toBeDefined();
                await new Promise<void>((resolve) => {
                  gates.set(name, resolve);
                  if (gates.size === 3) allEntered();
                });
              }
              return client.query<Row>(sql, values);
            },
          };
        },
      };
      const competing = inventoryModule.createServices(gatedPool, {});
      const attempt = withInventoryMutationAttempt(context, randomUUID());
      const settle = <T>(promise: Promise<T>) =>
        promise.then(
          () => true,
          () => false,
        );
      const runs = {
        decision: settle(competing.restockDecisions.recordDecision(choice(outcome), attempt)),
        adjust: settle(
          competing.items.adjustItem(
            {
              accountId: context.audit.forAccountId,
              itemId: "inv_c2_synthetic",
              quantityDelta: -1,
              reason: "Synthetic C2 reduction",
            },
            withInventoryMutationAttempt(context, randomUUID()),
          ),
        ),
        release: settle(
          competing.holds.releaseHold(
            { accountId: context.audit.forAccountId, holdId: held.holdId, releaseReason: "manual" },
            withInventoryMutationAttempt(context, randomUUID()),
          ),
        ),
      };
      try {
        await Promise.race([
          entered,
          ...Object.entries(runs).map(async ([name, result]) => {
            await result;
            throw new Error(`Synthetic C2 ${name} settled before reaching its barrier`);
          }),
        ]);
        for (const name of order) {
          gates.get(name)!();
          await runs[name];
        }
      } finally {
        for (const open of gates.values()) open();
        await Promise.all(Object.values(runs));
      }
      expect(await runs.decision).toBe(true);
      expect(await runs.release).toBe(true);
      const canAdjust =
        order.indexOf("release") < order.indexOf("adjust") ||
        (outcome === "restocked" && order.indexOf("decision") < order.indexOf("adjust"));
      expect(await runs.adjust).toBe(canAdjust);
      const item = await eventStore.readStream({ streamId: "inventory.item-inv_c2_synthetic" });
      expect(item.map((event) => event.streamVersion)).toEqual(item.map((_, index) => index + 1));
      const quantity = item.reduce(
        (total, event) => total + Number(event.payload.quantityDelta ?? event.payload.totalQuantity ?? 0),
        0,
      );
      expect(quantity).toBe(1 + (outcome === "restocked" ? 2 : 0) - (canAdjust ? 1 : 0));
      const hold = await eventStore.readStream({ streamId: `inventory.hold-${held.holdId}` });
      expect(hold.map((event) => event.eventType)).toEqual(["inventory.hold.placed", "inventory.hold.released"]);
      expect(await totals()).toEqual({
        adjustments: String((outcome === "restocked" ? 1 : 0) + (canAdjust ? 1 : 0)),
        decisions: "1",
        receipts: String(3 + (outcome === "restocked" ? 1 : 0) + (canAdjust ? 1 : 0)),
      });
      const beforeReplay = await durableSnapshot();
      expect(await services.restockDecisions.recordDecision(choice(outcome), attempt)).toEqual({
        decisionId: pending.decisionId,
        version: 2,
      });
      expect(await durableSnapshot()).toEqual(beforeReplay);
    },
  );

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
