import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ShipmentStatus } from "./common";
import { fulfillmentReservedSeedIds } from "@chase-sets/fulfillment/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { createFulfillmentServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";

type OrderSnapshot = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  shipping_option: string;
  lines: ReadonlyArray<{
    line_id: string;
    catalog_item_id: string;
    catalog_version_key: string;
    item_title: string;
    item_subtitle: string | null;
    version_summary: string | null;
    quantity: number;
  }>;
}>;

function createSeedContext(): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as never,
    audit: {
      performedByUserId: identitySeedIds.seller.userId,
      forAccountId: identitySeedIds.seller.accountId,
    },
  };
}

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

async function getShipmentStatus(
  pool: PgTransactionalPool,
  shipmentId: string,
): Promise<ShipmentStatus | null> {
  const result = await pool.query<{ status: ShipmentStatus }>(
    `SELECT status
     FROM fulfillment_shipment_pages
     WHERE shipment_id = $1`,
    [shipmentId],
  );

  return result.rows[0]?.status ?? null;
}

async function loadReferenceOrder(pool: PgTransactionalPool): Promise<OrderSnapshot> {
  const orderResult = await pool.query<{
    order_id: string;
    buyer_account_id: string;
    seller_account_id: string;
    shipping_option: string;
  }>(
    `SELECT order_id, buyer_account_id, seller_account_id, shipping_option
     FROM fulfillment_order_sources
     WHERE status = 'ready-for-fulfillment'
     ORDER BY updated_at ASC, order_id ASC
     LIMIT 1`,
  );
  const order = orderResult.rows[0];
  if (!order) {
    throw new Error("Fulfillment seed requires at least one ready-for-fulfillment order.");
  }

  const linesResult = await pool.query<OrderSnapshot["lines"][number]>(
    `SELECT
       line_id,
       catalog_item_id,
       catalog_version_key,
       item_title,
       item_subtitle,
       version_summary,
       quantity
     FROM fulfillment_order_source_lines
     WHERE order_id = $1
     ORDER BY line_index ASC, line_id ASC`,
    [order.order_id],
  );

  return {
    ...order,
    lines: linesResult.rows,
  };
}

export async function seedFulfillmentDatabase(pool: PgTransactionalPool) {
  const services = createFulfillmentServices(pool);
  const reservedShipmentIds = Object.values(fulfillmentReservedSeedIds.shipments);

  try {
    const existing = await services.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM fulfillment_shipment_pages
       WHERE shipment_id = ANY($1::text[])`,
      [reservedShipmentIds],
    );
    if (Number(existing.rows[0]?.count ?? 0) === reservedShipmentIds.length) {
      console.log("Fulfillment already contains seed data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const order = await loadReferenceOrder(pool);
  const context = createSeedContext();

  const ensureShipmentCreated = async (shipmentId: string, createdAt: string) => {
    const existingStatus = await getShipmentStatus(pool, shipmentId);
    if (existingStatus) {
      return existingStatus;
    }

    await services.shipments.commandHandler({
      streamId: `fulfillment.shipment-${shipmentId}`,
      command: {
        type: "CreateShipment",
        shipmentId: shipmentId as never,
        orderId: order.order_id as never,
        buyerAccountId: order.buyer_account_id as never,
        sellerAccountId: order.seller_account_id as never,
        shippingOption: order.shipping_option,
        lines: order.lines.map((line, index) => ({
          lineId: `spl_seed_${shipmentId}_${index}` as never,
          orderLineId: line.line_id,
          catalogItemId: line.catalog_item_id,
          catalogVersionKey: line.catalog_version_key,
          itemTitle: line.item_title,
          itemSubtitle: line.item_subtitle,
          versionSummary: line.version_summary,
          quantity: line.quantity,
        })),
        createdAt,
      },
      context,
    });
    await drainProjectors(services.projectors);

    return getShipmentStatus(pool, shipmentId);
  };

  const ensureShipmentPacked = async (shipmentId: string, createdAt: string) => {
    let status = await ensureShipmentCreated(shipmentId, createdAt);

    if (status === "awaiting-package") {
      await services.shipments.packShipment(
        {
          shipmentId,
          sellerAccountId: order.seller_account_id,
          packageCount: 1,
        },
        context,
      );
      await drainProjectors(services.projectors);
      status = await getShipmentStatus(pool, shipmentId);
    }

    return status;
  };

  const ensureShipmentLabeled = async (
    shipmentId: string,
    createdAt: string,
    labelReference: string,
    trackingIdentifier: string,
  ) => {
    let status = await ensureShipmentPacked(shipmentId, createdAt);

    if (status === "awaiting-label") {
      await services.shipments.attachLabel(
        {
          shipmentId,
          sellerAccountId: order.seller_account_id,
          shippingMethod: "standard",
          carrierName: "UPS",
          labelReference,
          trackingIdentifier,
        },
        context,
      );
      await drainProjectors(services.projectors);
      status = await getShipmentStatus(pool, shipmentId);
    }

    return status;
  };

  const ensureShipmentDispatched = async (
    shipmentId: string,
    createdAt: string,
    labelReference: string,
    trackingIdentifier: string,
  ) => {
    let status = await ensureShipmentLabeled(
      shipmentId,
      createdAt,
      labelReference,
      trackingIdentifier,
    );

    if (status === "label-attached") {
      await services.shipments.dispatchShipment(
        {
          shipmentId,
          sellerAccountId: order.seller_account_id,
        },
        context,
      );
      await drainProjectors(services.projectors);
      status = await getShipmentStatus(pool, shipmentId);
    }

    return status;
  };

  await ensureShipmentPacked(
    fulfillmentReservedSeedIds.shipments.awaitingLabel,
    "2026-03-22T10:00:00.000Z",
  );

  await ensureShipmentLabeled(
    fulfillmentReservedSeedIds.shipments.labelAttached,
    "2026-03-22T10:10:00.000Z",
    "lbl_seed_label_attached",
    "1ZSEEDLABELATTACHED",
  );

  await ensureShipmentDispatched(
    fulfillmentReservedSeedIds.shipments.dispatchedShipment,
    "2026-03-22T10:20:00.000Z",
    "lbl_seed_dispatched",
    "1ZSEEDDISPATCHED",
  );

  let deliveredStatus = await ensureShipmentDispatched(
    fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
    "2026-03-22T10:30:00.000Z",
    "lbl_seed_demo_charizard",
    "1ZSEEDDELIVERED",
  );
  if (deliveredStatus === "dispatched" || deliveredStatus === "exception") {
    await services.shipments.deliverShipment(
      {
        shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
        sellerAccountId: order.seller_account_id,
      },
      context,
    );
    await drainProjectors(services.projectors);
    deliveredStatus = await getShipmentStatus(
      pool,
      fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
    );
  }

  let returnedStatus = await ensureShipmentDispatched(
    fulfillmentReservedSeedIds.shipments.returnedShipment,
    "2026-03-22T10:40:00.000Z",
    "lbl_seed_returned",
    "1ZSEEDRETURNED",
  );
  if (returnedStatus === "dispatched" || returnedStatus === "exception") {
    await services.shipments.returnShipment(
      {
        shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
        sellerAccountId: order.seller_account_id,
        reason: "Carrier return to sender",
      },
      context,
    );
    await drainProjectors(services.projectors);
    returnedStatus = await getShipmentStatus(
      pool,
      fulfillmentReservedSeedIds.shipments.returnedShipment,
    );
  }

  let exceptionStatus = await ensureShipmentDispatched(
    fulfillmentReservedSeedIds.shipments.exceptionShipment,
    "2026-03-22T10:50:00.000Z",
    "lbl_seed_exception",
    "1ZSEEDEXCEPTION",
  );
  if (
    exceptionStatus !== "exception" &&
    exceptionStatus !== "delivered" &&
    exceptionStatus !== "returned"
  ) {
    await services.shipments.raiseShipmentException(
      {
        shipmentId: fulfillmentReservedSeedIds.shipments.exceptionShipment,
        sellerAccountId: order.seller_account_id,
        exceptionType: "carrier-delay",
        notes: "Missed origin scan handoff.",
      },
      context,
    );
    await drainProjectors(services.projectors);
  }

  await drainProjectors(services.projectors);
}

