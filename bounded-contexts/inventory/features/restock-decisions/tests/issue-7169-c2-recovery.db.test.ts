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
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as inventoryModule } from "../../..";
import { buildInventoryItemProjectionHandlers } from "../../inventory-items/read-model/projection";
import { buildInventoryHoldProjectionHandlers } from "../../holds/read-model/projection";
import { withInventoryMutationAttempt } from "../../../support/runtime-support/mutation-attempt";
import { buildInventoryReservationProjectionHandlers } from "../../reservations/read-model/projection";
import { loadRestockDecisionHistory } from "../api/history";
import { restockDecisionId } from "../api/runtime";
import { module as catalogModule } from "@chase-sets/catalog";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { demoIdentitySeedIds } from "@chase-sets/identity-seed";
import { inventorySeedIds } from "../../../support/seed-support/ids";
import { buildInventoryCatalogItemProjectionHandlers } from "../../inventory-items/integrations/catalog/projection";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";

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
      stock: (await pool.query("SELECT * FROM inventory_items ORDER BY item_id")).rows,
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

  async function prepareSource(
    producer: "cancelled" | "returned",
    audit: ReturnType<typeof buildTransportEvent>["audit"],
  ) {
    const subscriptions = inventoryModule.buildSubscriptions!(services);
    const orderId = `ord_source_${producer}_synthetic`;
    const reservationRequestId = `rsv_source_${producer}_synthetic`;
    const holdId = `hld_source_${producer}_synthetic` as const;
    const shipmentId = `shp_source_${producer}_synthetic`;
    const reservation = await services.reservations.commandHandler({
      streamId: `inventory.reservation-${reservationRequestId}`,
      command: {
        type: "ConfirmInventoryReservation",
        reservationRequestId,
        orderId,
        sellerAccountId: context.audit.forAccountId,
        inventoryItemId: "inv_c2_synthetic",
        quantity: 1,
        holdId,
      },
      context,
    });
    const handlers = buildInventoryReservationProjectionHandlers(pool);
    for (const event of reservation.storedEvents) await handlers[event.eventType]!(toTransportEvent(event));
    if (producer === "cancelled") {
      const hold = await services.holds.commandHandler({
        streamId: `inventory.hold-${holdId}`,
        command: {
          type: "PlaceInventoryHold",
          holdId,
          accountId: context.audit.forAccountId,
          itemId: "inv_c2_synthetic",
          quantity: 1,
          reason: "Synthetic dispatched order",
          purpose: "order",
          sourceRef: { orderId, reservationRequestId },
          expiresAt: null,
        },
        context,
      });
      const consumed = await services.holds.commandHandler({
        streamId: `inventory.hold-${holdId}`,
        command: { type: "ConsumeInventoryHold", consumedAt: "2026-10-14T00:00:00Z", consumptionReason: "dispatch" },
        context,
      });
      const holds = buildInventoryHoldProjectionHandlers(pool);
      for (const event of [...hold.storedEvents, ...consumed.storedEvents])
        await holds[event.eventType]!(toTransportEvent(event));
    }
    const workflow = subscriptions.find(
      (subscription) =>
        subscription.handlers[producer === "cancelled" ? "ordering.order.cancelled" : "fulfillment.shipment.returned"],
    )!;
    if (producer === "returned")
      await workflow.handlers["fulfillment.shipment.created"]!(
        buildTransportEvent(
          "fulfillment.shipment.created",
          {
            shipmentId,
            orderId,
            sellerAccountId: context.audit.forAccountId,
            buyerAccountId: "acc_buyer_synthetic",
            createdAt: "2026-10-14T00:00:00Z",
          },
          { tenantId: context.tenantId, audit },
        ),
      );
    const produce = () =>
      workflow.handlers[producer === "cancelled" ? "ordering.order.cancelled" : "fulfillment.shipment.returned"]!(
        buildTransportEvent(
          producer === "cancelled" ? "ordering.order.cancelled" : "fulfillment.shipment.returned",
          producer === "cancelled"
            ? {
                orderId,
                reason: "buyer cancellation",
                cancelledAt: "2026-10-14T00:00:00Z",
                reservationRequests: [
                  {
                    reservationRequestId,
                    sellerAccountId: context.audit.forAccountId,
                    inventoryItemId: "inv_c2_synthetic",
                    quantity: 1,
                    holdId,
                    status: "confirmed",
                  },
                ],
              }
            : { shipmentId, reason: "returned", returnedAt: "2026-10-14T00:00:00Z" },
          { tenantId: context.tenantId, audit },
        ),
      );
    const decisionId = restockDecisionId({ orderId, itemId: "inv_c2_synthetic" });
    const streamId = `inventory.restock-decision-${decisionId}`;
    return { produce, decisionId, streamId, orderId, reservationRequestId, shipmentId };
  }

  const sourceCases = (["cancelled", "returned"] as const).flatMap((producer) =>
    (
      [
        ["seller", context.audit.forAccountId, context.audit.performedByUserId],
        ["different buyer", "acc_buyer_synthetic", "usr_buyer_synthetic"],
        ["synthetic system", "acc_system_synthetic", "usr_system_synthetic"],
      ] as const
    ).flatMap(([name, forAccountId, performedByUserId]) =>
      (["restocked", "written-off"] as const).map((outcome) => ({
        producer,
        name,
        forAccountId,
        performedByUserId,
        outcome,
      })),
    ),
  );
  it.each(sourceCases)(
    "real $producer subscription / $name source / $outcome preserves audit and exact replay",
    async ({ producer, forAccountId, performedByUserId, outcome }) => {
      const audit = { forAccountId, performedByUserId };
      const { produce, decisionId, streamId, orderId, reservationRequestId, shipmentId } = await prepareSource(
        producer,
        audit,
      );
      const stockBefore = await eventStore.readStream({ streamId: "inventory.item-inv_c2_synthetic" });
      await produce();
      const before = await eventStore.readStream({ streamId });
      expect(before).toHaveLength(1);
      expect(before[0].tenantId).toBe(context.tenantId);
      expect(before[0].forAccountId).toBe(forAccountId);
      expect(before[0].performedByUserId).toBe(performedByUserId);
      expect(before[0].payload).toEqual({
        decisionId,
        accountId: context.audit.forAccountId,
        orderId,
        itemId: "inv_c2_synthetic",
        quantity: 1,
        source: producer === "cancelled" ? "order-cancelled-after-dispatch" : "shipment-returned",
        sourceRef: { orderId, reservationRequestId },
        shipmentId: producer === "returned" ? shipmentId : null,
        returnReason: producer === "returned" ? "returned" : "buyer cancellation",
        pendingAt: "2026-10-14T00:00:00Z",
      });
      const attempt = withInventoryMutationAttempt(context, randomUUID());
      const input = { ...choice(outcome), decisionId };
      await expect(services.restockDecisions.recordDecision(input, attempt)).resolves.toEqual({
        decisionId,
        version: 2,
      });
      const after = await eventStore.readStream({ streamId });
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(before[0]);
      expect(after[1].forAccountId).toBe(context.audit.forAccountId);
      expect(after[1].performedByUserId).toBe(context.audit.performedByUserId);
      const stockAfter = await eventStore.readStream({ streamId: "inventory.item-inv_c2_synthetic" });
      expect(stockAfter.slice(0, stockBefore.length)).toEqual(stockBefore);
      expect(stockAfter).toHaveLength(stockBefore.length + (outcome === "restocked" ? 1 : 0));
      if (outcome === "restocked")
        expect(stockAfter.at(-1)?.payload).toMatchObject({
          itemId: "inv_c2_synthetic",
          quantityDelta: 1,
          reason: "return-restocked",
          sourceRef: { orderId, reservationRequestId },
        });
      const committed = await durableSnapshot();
      await expect(services.restockDecisions.recordDecision(input, attempt)).resolves.toEqual({
        decisionId,
        version: 2,
      });
      expect(await durableSnapshot()).toEqual(committed);
    },
  );

  it.each(["cancelled", "returned"] as const)(
    "real %s subscription rejects null source producer contract without any state change",
    async (producer) => {
      const audit = buildTransportEvent(
        "synthetic.null-source",
        {},
        {
          audit: {
            forAccountId: null,
            performedByUserId: "usr_null_synthetic",
          },
        },
      ).audit;
      const { produce, streamId } = await prepareSource(producer, audit);
      const before = await durableSnapshot();
      await expect(produce()).rejects.toMatchObject({
        code: "infrastructure_failure",
        details: {
          cause: expect.stringContaining('null value in column "for_account_id"'),
        },
      });
      expect(await eventStore.readStream({ streamId })).toEqual([]);
      expect(await durableSnapshot()).toEqual(before);
    },
  );

  const itemPoisonCases = (
    [
      { name: "unknown kind", eventType: "inventory.item.unknown", payload: { itemId: "inv_c2_synthetic" } },
      {
        name: "mixed item identity",
        eventType: "inventory.item.adjusted",
        payload: { itemId: "inv_foreign_synthetic", quantityDelta: 1, reason: "correction" },
      },
      {
        name: "malformed adjustment quantity",
        eventType: "inventory.item.adjusted",
        payload: { itemId: "inv_c2_synthetic", quantityDelta: "1", reason: "correction" },
      },
    ] as const
  ).flatMap((fact) => (["restocked", "written-off"] as const).map((outcome) => ({ ...fact, outcome })));
  it.each(itemPoisonCases)(
    "rejects $name poisoned item history before $outcome without any partial mutation",
    async ({ eventType, payload, outcome }) => {
      await eventStore.appendToStream({
        streamId: "inventory.item-inv_c2_synthetic",
        expectedVersion: "any",
        context,
        events: [{ eventType, payload }],
      });
      const before = await durableSnapshot();
      await expect(
        services.restockDecisions.recordDecision(choice(outcome), withInventoryMutationAttempt(context, randomUUID())),
      ).rejects.toThrow("reconciliation");
      expect(await durableSnapshot()).toEqual(before);
    },
  );

  it.each(["restocked", "written-off"] as const)(
    "rejects foreign item audit before %s without mutation",
    async (outcome) => {
      await eventStore.appendToStream({
        streamId: "inventory.item-inv_c2_synthetic",
        expectedVersion: "any",
        context: { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } },
        events: [
          {
            eventType: "inventory.item.adjusted",
            payload: { itemId: "inv_c2_synthetic", quantityDelta: 1, reason: "correction" },
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

  const invalidInstants = [
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
  ];
  it.each(invalidInstants.flatMap((instant) => (["pending", "recorded"] as const).map((role) => ({ instant, role }))))(
    "rejects calendar-invalid $role $instant before stock/decision/receipt writes",
    async ({ instant, role }) => {
      const streamId = `inventory.restock-decision-${pending.decisionId}`;
      const [first] = await eventStore.readStream({ streamId });
      if (role === "pending")
        await pool.query("UPDATE event_store_events SET payload = payload || $2::jsonb WHERE stream_id = $1", [
          streamId,
          JSON.stringify({ pendingAt: instant }),
        ]);
      else
        await appendDecision([
          {
            eventType: "inventory.restock-decision.recorded",
            payload: {
              decisionId: pending.decisionId,
              accountId: context.audit.forAccountId,
              orderId: "ord_c2_synthetic",
              itemId: "inv_c2_synthetic",
              quantity: 2,
              outcome: "written-off",
              reason: "written-off",
              sourceRef: first.payload.sourceRef,
              damageNote: null,
              decidedAt: instant,
            },
          },
        ]);
      const before = await durableSnapshot();
      for (const outcome of ["restocked", "written-off"] as const)
        await expect(
          services.restockDecisions.recordDecision(
            choice(outcome),
            withInventoryMutationAttempt(context, randomUUID()),
          ),
        ).rejects.toThrow("reconciliation");
      expect(await durableSnapshot()).toEqual(before);
    },
  );

  it.each(["2024-02-29T12:34:56Z", "2024-02-29T12:34:56.123456789+05:30", "2024-02-29T12:34:56.1-06:00"])(
    "retains valid leap-day, offset and fractional instant %s",
    async (instant) => {
      const streamId = `inventory.restock-decision-${pending.decisionId}`;
      await pool.query("UPDATE event_store_events SET payload = payload || $2::jsonb WHERE stream_id = $1", [
        streamId,
        JSON.stringify({ pendingAt: instant }),
      ]);
      await services.restockDecisions.recordDecision(
        choice("written-off"),
        withInventoryMutationAttempt(context, randomUUID()),
      );
      await pool.query(
        "UPDATE event_store_events SET payload = payload || $2::jsonb WHERE stream_id = $1 AND stream_version = 2",
        [streamId, JSON.stringify({ decidedAt: instant })],
      );
      expect(
        (
          await loadRestockDecisionHistory(
            { db: pool, eventStore, checkpointStore: createPostgresProjectionStore({ db: pool }) },
            pending.decisionId,
            context,
          )
        ).state.status,
      ).toBe("recorded");
    },
  );

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
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 1,
        context: { ...context, audit: { ...context.audit, forAccountId: "acc_foreign_synthetic" } },
        events: [
          {
            eventType: "inventory.restock-decision.recorded",
            payload: {
              decisionId: pending.decisionId,
              accountId: context.audit.forAccountId,
              orderId: "ord_c2_synthetic",
              itemId: "inv_c2_synthetic",
              quantity: 2,
              outcome: "written-off",
              reason: "written-off",
              sourceRef: first.payload.sourceRef,
              damageNote: null,
              decidedAt: "2026-10-14T00:00:01Z",
            },
          },
        ],
      });
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

  it.each(["restocked", "written-off"] as const)(
    "records %s over a complete representative 501-fact item history",
    async (outcome) => {
      await eventStore.appendToStream({
        streamId: "inventory.item-inv_c2_synthetic",
        expectedVersion: 1,
        context,
        events: Array.from({ length: 500 }, (_, index) => ({
          eventType: "inventory.item.adjusted",
          payload: { itemId: "inv_c2_synthetic", quantityDelta: index % 2 === 0 ? 1 : -1, reason: "correction" },
        })),
      });
      const attempt = withInventoryMutationAttempt(context, randomUUID());
      const started = performance.now();
      await expect(services.restockDecisions.recordDecision(choice(outcome), attempt)).resolves.toEqual({
        ...pending,
        version: 2,
      });
      console.info(
        "N1 synthetic complete-history latency",
        JSON.stringify({ outcome, itemFacts: 501, elapsedMs: performance.now() - started }),
      );
      const item = await readCompleteStream(eventStore, { streamId: "inventory.item-inv_c2_synthetic" });
      const quantity =
        Number(item[0].payload.totalQuantity) +
        item.slice(1).reduce((sum, event) => sum + Number(event.payload.quantityDelta), 0);
      expect(quantity).toBe(outcome === "restocked" ? 3 : 1);
      const committed = await durableSnapshot();
      await expect(services.restockDecisions.recordDecision(choice(outcome), attempt)).resolves.toEqual({
        ...pending,
        version: 2,
      });
      expect(await durableSnapshot()).toEqual(committed);
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

describeDb("issue-7169-c2-release-safety: real seed and retained import callers", () => {
  let pools: Readonly<Record<"catalog" | "inventory", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: ReturnType<typeof inventoryModule.createServices>;
  const seedAccount = demoIdentitySeedIds.accountId;
  const seedContext: EventStoreContext = {
    tenantId: "tnt_identity",
    audit: {
      forAccountId: seedAccount,
      performedByUserId: demoIdentitySeedIds.userId,
    },
  };
  const itemId = inventorySeedIds.items.charizardBaseSetNearMint;
  const itemStream = `inventory.item-${itemId}`;
  const locationId = inventorySeedIds.storageLocations.vaultAnnex;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog", "inventory"], "c2_seed_callers");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.inventory;
    await resetMultiContextTestSchemas({ catalog: pools.catalog });
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await catalogModule.seed!(pools.catalog);
  });
  afterAll(async () => closeMultiContextTestPools(pools));
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ inventory: pool });
    await bootstrapContextDatabase(inventoryModule, pool);
    services = inventoryModule.createServices(pool, {});
    const handlers = buildInventoryCatalogItemProjectionHandlers(pool);
    const store = createPostgresEventStore({ pool: pools.catalog });
    let afterGlobalPosition = ZERO_GLOBAL_POSITION;
    for (;;) {
      const events = await store.readAll({ afterGlobalPosition });
      for (const event of events) await handlers[event.eventType]?.(toTransportEvent(event));
      if (events.length === 0) break;
      afterGlobalPosition = events[events.length - 1].globalPosition;
    }
  });
  async function snapshot() {
    return {
      events: (await pool.query("SELECT * FROM event_store_events ORDER BY global_position")).rows,
      streams: (await pool.query("SELECT * FROM event_store_streams ORDER BY stream_id")).rows,
      receipts: (await pool.query("SELECT * FROM inventory_mutation_attempts ORDER BY attempt_key")).rows,
      legacy: (await pool.query("SELECT * FROM inventory_item_adjustment_idempotency ORDER BY idempotency_key")).rows,
      stock: (await pool.query("SELECT * FROM inventory_items ORDER BY item_id")).rows,
      locations: (await pool.query("SELECT * FROM inventory_storage_locations ORDER BY storage_location_id")).rows,
    };
  }
  async function projectItems() {
    const handlers = {
      ...services.storageLocations.projectors[0].handlers,
      ...buildInventoryItemProjectionHandlers(pool),
    };
    const store = createPostgresEventStore({ pool });
    let afterGlobalPosition = ZERO_GLOBAL_POSITION;
    for (;;) {
      const events = await store.readAll({ afterGlobalPosition });
      for (const event of events) await handlers[event.eventType]?.(toTransportEvent(event));
      if (!events.length) break;
      afterGlobalPosition = events[events.length - 1].globalPosition;
    }
  }
  async function boot(db = pool) {
    await inventoryModule.seed!(db);
  }

  it.each(["missing-exact-catalog", "old-invalid-late-item", "old-invalid-late-location"] as const)(
    "seed refuses %s beside unrelated rows before any partial mutation, on both boots",
    async (defect) => {
      if (defect === "missing-exact-catalog") {
        await pool.query("DELETE FROM inventory_catalog_items WHERE catalog_item_id = $1", [
          catalogSeedIds.items.charizardBaseSet,
        ]);
        expect(
          (await pool.query("SELECT COUNT(*)::int AS count FROM inventory_catalog_items")).rows[0].count,
        ).toBeGreaterThan(0);
      } else {
        const store = createPostgresEventStore({ pool });
        await store.appendToStream({
          streamId:
            defect === "old-invalid-late-item"
              ? itemStream
              : `inventory.storage-location-${inventorySeedIds.storageLocations.vaultAnnex}`,
          expectedVersion: "no_stream",
          context: seedContext,
          events: [
            {
              eventType:
                defect === "old-invalid-late-item" ? "inventory.item.created" : "inventory.storage-location.created",
              payload:
                defect === "old-invalid-late-item"
                  ? {
                      itemId,
                      accountId: "acc_foreign_synthetic",
                      catalogItemId: catalogSeedIds.items.charizardBaseSet,
                      totalQuantity: 1,
                    }
                  : {
                      storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
                      accountId: seedAccount,
                      name: "Synthetic invalid retained sibling",
                      shipFromCode: "WRONG",
                      shipFromAddress: null,
                    },
            },
          ],
        });
      }
      const before = await snapshot();
      for (let invocation = 0; invocation < 2; invocation++) {
        await bootstrapContextDatabase(inventoryModule, pool);
        await expect(boot()).rejects.toThrow(/Inventory seed/);
        expect(await snapshot()).toEqual(before);
      }
    },
  );

  it("resumes partial seed after mid-adjustment death, boot-two and same-boot with lagged-empty projections", async () => {
    let fail = true;
    const faultPool: PgTransactionalPool = {
      query: <Row>(sql: string, values?: readonly unknown[]) => pool.query<Row>(sql, values),
      connect: async () => {
        const client = await pool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row>(sql: string, values?: readonly unknown[]) => {
            if (fail && sql.includes("INSERT INTO event_store_events") && values?.includes("inventory.item.adjusted")) {
              fail = false;
              throw new Error("Synthetic seed death before adjustment commit");
            }
            return client.query<Row>(sql, values);
          },
        };
      },
    };
    await expect(boot(faultPool)).rejects.toMatchObject({
      code: "infrastructure_failure",
      details: {
        cause: "Synthetic seed death before adjustment commit",
      },
    });
    expect(fail).toBe(false);
    const partial = await snapshot();
    expect(partial.events.filter((event) => event.stream_id === itemStream)).toHaveLength(1);
    expect((await inventoryModule.inspectSeedState!(pool)).find((state) => state.streamId === itemStream)?.kind).toBe(
      "draft",
    );
    await bootstrapContextDatabase(inventoryModule, pool);
    await boot();
    const completed = await snapshot();
    expect(completed.events.filter((event) => event.stream_id === itemStream)).toHaveLength(3);
    for (const event of partial.events) expect(completed.events).toContainEqual(event);
    for (const receipt of partial.receipts) expect(completed.receipts).toContainEqual(receipt);
    expect((await inventoryModule.inspectSeedState!(pool)).every((state) => state.kind === "active")).toBe(true);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM inventory_items")).rows).toEqual([{ count: 0 }]);
    for (let invocation = 0; invocation < 3; invocation++) {
      await bootstrapContextDatabase(inventoryModule, pool);
      await boot();
      expect(await snapshot()).toEqual(completed);
    }
  });

  async function prepareImport(targetLocation: string = locationId) {
    await boot();
    await projectItems();
    const batch = await services.importBatches.createBatch(
      {
        accountId: seedAccount,
        parsedRows: [
          {
            rowNumber: 1,
            values: {
              catalogItemId: catalogSeedIds.items.charizardBaseSet,
              storageLocationId: targetLocation,
              totalQuantity: "2",
              "option:form": catalogSeedIds.dimensions.form.optionIds.raw,
              "option:condition": catalogSeedIds.dimensions.condition.optionIds.nearMint,
            },
          },
        ],
      },
      seedContext,
    );
    expect(batch.accepted_count).toBe(1);
    expect(batch.rows[0].storage_location_id).toBe(targetLocation);
    if (targetLocation === locationId) {
      const target = await services.items.getItem(itemId, seedAccount);
      expect(target?.storage_location_id).toBe(targetLocation);
      expect(batch.rows[0].product_id).toBe(target?.product_id);
      expect(batch.rows[0].selected_options).toEqual(target?.selected_options);
    }
    return { accountId: seedAccount, batchId: batch.batch_id };
  }

  it("import refuses its absent exact location beside unrelated locations without stock or receipt writes", async () => {
    const exactLocation = "loc_import_exact_synthetic";
    await pool.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ($1, $2, 'Synthetic exact import shelf', 'EXACT')`,
      [exactLocation, seedAccount],
    );
    const input = await prepareImport(exactLocation);
    await pool.query("DELETE FROM inventory_storage_locations WHERE storage_location_id = $1", [exactLocation]);
    await pool.query(
      `INSERT INTO inventory_storage_locations (storage_location_id, account_id, name, ship_from_code)
      VALUES ('loc_unrelated_synthetic', $1, 'Unrelated synthetic shelf', 'UNRELATED')`,
      [seedAccount],
    );
    const before = await snapshot();
    for (let bootNumber = 0; bootNumber < 2; bootNumber++) {
      await bootstrapContextDatabase(inventoryModule, pool);
      const restarted = inventoryModule.createServices(pool, {});
      await expect(restarted.importBatches.commitBatch(input, seedContext)).rejects.toThrow(
        "Storage location not found",
      );
      expect(await snapshot()).toEqual(before);
    }
  });

  it("retained import checkpoint loss resumes its exact adjustment receipt on boot-two and same-boot", async () => {
    const input = await prepareImport();
    let fail = true;
    const faultPool: PgTransactionalPool = {
      query: async <Row>(sql: string, values?: readonly unknown[]) => {
        if (fail && sql.includes("UPDATE inventory_import_batch_rows") && sql.includes("committed_inventory_item_id")) {
          fail = false;
          throw new Error("Synthetic import checkpoint death");
        }
        return pool.query<Row>(sql, values);
      },
      connect: pool.connect.bind(pool),
    };
    await expect(
      inventoryModule.createServices(faultPool, {}).importBatches.commitBatch(input, seedContext),
    ).rejects.toThrow("Synthetic import checkpoint death");
    expect(fail).toBe(false);
    const retained = await snapshot();
    expect(retained.events.filter((event) => event.stream_id === itemStream)).toHaveLength(4);
    await bootstrapContextDatabase(inventoryModule, pool);
    const restarted = inventoryModule.createServices(pool, {});
    const first = await restarted.importBatches.commitBatch(input, seedContext);
    expect(first.committed_count).toBe(1);
    expect(await snapshot()).toEqual(retained);
    expect(await restarted.importBatches.commitBatch(input, seedContext)).toEqual(first);
    expect(await services.importBatches.commitBatch(input, seedContext)).toEqual(first);
    expect(await snapshot()).toEqual(retained);
  });
});
