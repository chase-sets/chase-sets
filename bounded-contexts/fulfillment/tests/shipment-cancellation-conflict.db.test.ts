import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION, type GlobalPosition } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as fulfillmentModule } from "../index";
import { createFulfillmentShipmentRuntime } from "../features/shipments/api/runtime";
import { buildFulfillmentOrderProjectionHandlers } from "../features/shipments/integrations/source/source-projection";
import { buildFulfillmentShipmentProjectionHandlers } from "../features/shipments/read-model/projection";
import { getSellerShipment, listSellerShipments } from "../features/shipments/read-model/queries";
import { createShipByAttentionSourceFromReadModel } from "../features/shipments/read-model/seller-attention-source";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

function checkpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();
  return {
    loadCheckpoint: async (name) => checkpoints.get(name) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (name, checkpoint) => void checkpoints.set(name, checkpoint),
  };
}

describeDb("shipment cancellation conflict steady state", () => {
  let pool: PgTransactionalPool;
  const context = {
    tenantId: "tnt_test" as never,
    audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
  };

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["fulfillment"], "fulfillment_cancel_race");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).fulfillment;
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas({ fulfillment: pool });
    await bootstrapContextDatabase(fulfillmentModule, pool);
  });
  afterAll(async () => closeMultiContextTestPools({ fulfillment: pool }));

  it("projects idempotently, admits flagged post-dispatch work, and excludes the cancelled steady state", async () => {
    const eventStore = createPostgresEventStore({ pool });
    const services = createFulfillmentShipmentRuntime({ eventStore, checkpointStore: checkpointStore(), db: pool });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_race",
      context,
      command: {
        type: "CreateShipment",
        shipmentId: "shp_race" as never,
        orderId: "ord_race" as never,
        buyerAccountId: "acc_buyer" as never,
        sellerAccountId: "acc_seller" as never,
        shippingOption: "standard",
        shippingDestinationSnapshot: {
          name: "Buyer",
          line1: "2 Main",
          city: "Chicago",
          state: "IL",
          postalCode: "60601",
          country: "US",
        },
        shippingOriginSnapshot: {
          name: "Seller",
          line1: "1 Main",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        lines: [
          {
            lineId: "spl_race" as never,
            orderLineId: "oli_race",
            catalogItemId: "cat_race",
            productId: "cat_race::",
            itemTitle: "Race fixture",
            itemSubtitle: null,
            productSummary: null,
            quantity: 1,
          },
        ],
        createdAt: "2026-08-02T11:00:00.000Z",
      },
    });
    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_race",
      context,
      command: { type: "StartShipmentPacking", startedAt: "2026-08-02T11:30:00.000Z" },
    });
    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         display_reference, status, package_status, created_at, updated_at
       ) VALUES ('shp_race','tnt_test','ord_race','acc_buyer','acc_seller','standard',
                 'SHP-RACE','packing','packing','2026-08-02T11:00:00Z','2026-08-02T11:30:00Z')`,
    );

    const source = buildFulfillmentOrderProjectionHandlers(pool, {
      onOrderCancelled: async (params) => {
        await services.cancelShipmentForCancelledOrder({ ...params, origin: "order-cancelled" });
      },
    });
    const cancelled = buildTransportEvent(
      "ordering.order.cancelled",
      {
        orderId: "ord_race",
        cancelledAt: "2026-08-02T12:00:00.000Z",
        reason: "buyer-cancelled",
      },
      {
        id: "evt_cancel_race",
        streamId: "ordering.order-ord_race",
        streamVersion: 2,
        globalPosition: "2",
        tenantId: "tnt_test",
        audit: context.audit,
        timing: {
          occurredAt: "2026-08-02T12:00:00.000Z",
          recordedAt: "2026-08-02T12:00:00.000Z",
        },
      },
    );
    await source["ordering.order.cancelled"]!(cancelled);
    await source["ordering.order.cancelled"]!(cancelled);

    await services.cancelShipmentForCancelledOrder({
      orderId: "ord_race",
      cancelledAt: "2026-08-02T12:00:01.000Z",
      reason: null,
      origin: "payment-fraud-warning",
      context,
      sourceIdentity: {
        eventId: "evt_fraud_race",
        streamId: "payments.payment-pay_race",
        streamVersion: 3,
        eventType: "payments.payment-fraud-warning-received",
      },
    });

    const conflictEvents = (await eventStore.readStream({ streamId: "fulfillment.shipment-shp_race" })).filter(
      (event) => event.eventType === "fulfillment.shipment.cancellation-conflict-recorded",
    );
    expect(conflictEvents).toHaveLength(2);
    const projector =
      buildFulfillmentShipmentProjectionHandlers(pool)["fulfillment.shipment.cancellation-conflict-recorded"];
    const projectedConflict = (storedEvent: (typeof conflictEvents)[number]) =>
      buildTransportEvent(
        "fulfillment.shipment.cancellation-conflict-recorded",
        storedEvent.payload as Record<string, unknown>,
        {
          id: storedEvent.eventId,
          streamId: storedEvent.streamId,
          streamVersion: storedEvent.streamVersion,
          globalPosition: String(storedEvent.globalPosition),
          tenantId: "tnt_test",
          audit: context.audit,
          timing: { occurredAt: storedEvent.occurredAt, recordedAt: storedEvent.recordedAt },
        },
      );
    const orderConflict = conflictEvents.find((event) => event.payload.origin === "order-cancelled")!;
    const fraudConflict = conflictEvents.find((event) => event.payload.origin === "payment-fraud-warning")!;
    const insertDestinationConflict = () =>
      pool.query(
        `INSERT INTO fulfillment_shipment_conflict_pages (
           shipment_id, order_id, conflict_kind, origin, reason, shipment_status, detected_at
         ) VALUES ('shp_race','ord_race','destination-correction','seller-requested','wrong-address','packing','2026-08-02T12:00:02Z')`,
      );
    const readProductionConflicts = async () => {
      const list = await listSellerShipments(pool, { sellerAccountId: "acc_seller" });
      const detail = await getSellerShipment(pool, "shp_race", "acc_seller");
      expect(list.items).toHaveLength(1);
      expect(detail?.shipment_id).toBe("shp_race");
      expect(detail?.conflicts).toEqual(list.items[0]?.conflicts);
      return list.items[0]!.conflicts;
    };

    await projector!(projectedConflict(orderConflict));
    await projector!(projectedConflict(fraudConflict));
    await projector!(projectedConflict(orderConflict));
    await insertDestinationConflict();
    const orderThenFraud = await readProductionConflicts();
    expect(orderThenFraud.map(({ conflict_kind, origin }) => ({ conflict_kind, origin }))).toEqual([
      { conflict_kind: "cancellation", origin: "order-cancelled" },
      { conflict_kind: "cancellation", origin: "payment-fraud-warning" },
      { conflict_kind: "destination-correction", origin: "seller-requested" },
    ]);

    await pool.query("DELETE FROM fulfillment_shipment_conflict_pages WHERE shipment_id = 'shp_race'");
    await projector!(projectedConflict(fraudConflict));
    await projector!(projectedConflict(orderConflict));
    await insertDestinationConflict();
    const fraudThenOrder = await readProductionConflicts();
    expect(fraudThenOrder).toEqual(orderThenFraud);
    const stored = await pool.query(
      `SELECT conflict_kind, origin, reason FROM fulfillment_shipment_conflict_pages
       WHERE shipment_id = 'shp_race' ORDER BY conflict_kind, origin`,
    );
    expect(stored.rows).toEqual([
      { conflict_kind: "cancellation", origin: "order-cancelled", reason: "buyer-cancelled" },
      { conflict_kind: "cancellation", origin: "payment-fraud-warning", reason: null },
      { conflict_kind: "destination-correction", origin: "seller-requested", reason: "wrong-address" },
    ]);

    const attention = createShipByAttentionSourceFromReadModel(pool);
    await expect(attention.load({ accountId: "acc_seller", now: "2026-08-02T12:01:00.000Z" })).resolves.toHaveLength(1);

    await services.commandHandler({
      streamId: "fulfillment.shipment-shp_race",
      context,
      command: { type: "CancelShipment", cancelledAt: "2026-08-02T12:02:00.000Z" },
    });
    const afterExitCount = (await eventStore.readStream({ streamId: "fulfillment.shipment-shp_race" })).length;
    await source["ordering.order.cancelled"]!(cancelled);
    const repeatedCancel = await services.commandHandler({
      streamId: "fulfillment.shipment-shp_race",
      context,
      command: { type: "CancelShipment", cancelledAt: "2026-08-02T12:03:00.000Z" },
    });
    expect(repeatedCancel.newEvents).toEqual([]);
    expect(await eventStore.readStream({ streamId: "fulfillment.shipment-shp_race" })).toHaveLength(afterExitCount);
    await pool.query("UPDATE fulfillment_shipment_pages SET status = 'cancelled' WHERE shipment_id = 'shp_race'");
    await expect(attention.load({ accountId: "acc_seller", now: "2026-08-02T12:03:00.000Z" })).resolves.toHaveLength(0);

    await pool.query(
      `INSERT INTO fulfillment_shipment_pages (
         shipment_id, tenant_id, order_id, buyer_account_id, seller_account_id, shipping_option,
         display_reference, status, package_status, created_at, updated_at
       ) VALUES ('shp_post','tnt_test','ord_post','acc_buyer','acc_seller','standard',
                 'SHP-POST','delivered','delivered','2026-08-02T10:00:00Z','2026-08-02T12:00:00Z');
       INSERT INTO fulfillment_shipment_conflict_pages (
         shipment_id, order_id, conflict_kind, origin, reason, shipment_status, detected_at
       ) VALUES ('shp_post','ord_post','cancellation','order-cancelled','buyer-cancelled','delivered','2026-08-02T12:00:00Z')`,
    );
    const flagged = await attention.load({ accountId: "acc_seller", now: "2026-08-02T12:04:00.000Z" });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ id: "fulfillment-ship-by:shp_post", severity: "critical" });
  });
});
