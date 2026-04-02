import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { fulfillmentReservedSeedIds, identitySeedIds } from "@chase-sets/dev-seeds";
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

async function loadReferenceOrder(pool: PgTransactionalPool): Promise<OrderSnapshot> {
  const orderResult = await pool.query<{
    order_id: string;
    buyer_account_id: string;
    seller_account_id: string;
    shipping_option: string;
  }>(
    `SELECT order_id, buyer_account_id, seller_account_id, shipping_option
     FROM ordering_order_pages
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
     FROM ordering_order_line_pages
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

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM fulfillment_shipment_pages",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Fulfillment already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const order = await loadReferenceOrder(pool);
  const context = createSeedContext();

  const createShipment = async (shipmentId: string, createdAt: string) => {
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
  };

  await createShipment(
    fulfillmentReservedSeedIds.shipments.awaitingLabel,
    "2026-03-22T10:00:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.awaitingLabel,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );

  await createShipment(
    fulfillmentReservedSeedIds.shipments.labelAttached,
    "2026-03-22T10:10:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.labelAttached,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );
  await services.shipments.attachLabel(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.labelAttached,
      sellerAccountId: order.seller_account_id,
      shippingMethod: "standard",
      carrierName: "UPS",
      labelReference: "lbl_seed_label_attached",
      trackingIdentifier: "1ZSEEDLABELATTACHED",
    },
    context,
  );

  await createShipment(
    fulfillmentReservedSeedIds.shipments.dispatchedShipment,
    "2026-03-22T10:20:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.dispatchedShipment,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );
  await services.shipments.attachLabel(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.dispatchedShipment,
      sellerAccountId: order.seller_account_id,
      shippingMethod: "standard",
      carrierName: "UPS",
      labelReference: "lbl_seed_dispatched",
      trackingIdentifier: "1ZSEEDDISPATCHED",
    },
    context,
  );
  await services.shipments.dispatchShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.dispatchedShipment,
      sellerAccountId: order.seller_account_id,
    },
    context,
  );

  await createShipment(
    fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
    "2026-03-22T10:30:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );
  await services.shipments.attachLabel(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
      sellerAccountId: order.seller_account_id,
      shippingMethod: "standard",
      carrierName: "UPS",
      labelReference: "lbl_seed_demo_charizard",
      trackingIdentifier: "1ZSEEDDELIVERED",
    },
    context,
  );
  await services.shipments.dispatchShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
      sellerAccountId: order.seller_account_id,
    },
    context,
  );
  await services.shipments.deliverShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
      sellerAccountId: order.seller_account_id,
    },
    context,
  );

  await createShipment(
    fulfillmentReservedSeedIds.shipments.returnedShipment,
    "2026-03-22T10:40:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );
  await services.shipments.attachLabel(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
      sellerAccountId: order.seller_account_id,
      shippingMethod: "standard",
      carrierName: "UPS",
      labelReference: "lbl_seed_returned",
      trackingIdentifier: "1ZSEEDRETURNED",
    },
    context,
  );
  await services.shipments.dispatchShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
      sellerAccountId: order.seller_account_id,
    },
    context,
  );
  await services.shipments.returnShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
      sellerAccountId: order.seller_account_id,
      reason: "Carrier return to sender",
    },
    context,
  );

  await createShipment(
    fulfillmentReservedSeedIds.shipments.exceptionShipment,
    "2026-03-22T10:50:00.000Z",
  );
  await services.shipments.packShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.exceptionShipment,
      sellerAccountId: order.seller_account_id,
      packageCount: 1,
    },
    context,
  );
  await services.shipments.attachLabel(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.exceptionShipment,
      sellerAccountId: order.seller_account_id,
      shippingMethod: "standard",
      carrierName: "UPS",
      labelReference: "lbl_seed_exception",
      trackingIdentifier: "1ZSEEDEXCEPTION",
    },
    context,
  );
  await services.shipments.dispatchShipment(
    {
      shipmentId: fulfillmentReservedSeedIds.shipments.exceptionShipment,
      sellerAccountId: order.seller_account_id,
    },
    context,
  );
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
