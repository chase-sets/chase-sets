import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ShipmentLineId, ShipmentStatus } from "../../features/shipments/domain/common";
import { fulfillmentReservedSeedIds } from "@chase-sets/fulfillment/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { createFulfillmentServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, OrderId, ShipmentId, TenantId } from "@chase-sets/primitives/typed-ids";

type OrderSnapshot = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  shipping_option: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  lines: ReadonlyArray<{
    line_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string;
    item_subtitle: string | null;
    product_summary: string | null;
    quantity: number;
  }>;
}>;

function createSeedContext(): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId,
      forAccountId: identitySeedIds.demo.accountId,
    },
  };
}

async function getShipmentStatus(pool: PgTransactionalPool, shipmentId: string): Promise<ShipmentStatus | null> {
  const result = await pool.query<{ status: ShipmentStatus }>(
    `SELECT status
     FROM fulfillment_shipment_pages
     WHERE shipment_id = $1`,
    [shipmentId],
  );

  return result.rows[0]?.status ?? null;
}

type OrderSnapshotRow = Omit<OrderSnapshot, "lines">;

async function loadOrderLines(pool: PgTransactionalPool, orderId: string): Promise<OrderSnapshot["lines"]> {
  const linesResult = await pool.query<OrderSnapshot["lines"][number]>(
    `SELECT
       line_id,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       product_summary,
       quantity
     FROM fulfillment_order_source_lines
     WHERE order_id = $1
     ORDER BY line_index ASC, line_id ASC`,
    [orderId],
  );

  return linesResult.rows;
}

// Seeded accepted-offer orders can carry generated ids (the offer-acceptance
// projection creates them before the ordering seed pins reserved ids), so seed
// order identity keys off ready_for_fulfillment_at, which the payments seed
// fixes via payment-capture timestamps: the earliest-ready order is the
// reference order (it receives the support-request seeds), and the
// latest-ready order stays support-free so its review eligibility survives
// for the marketplace reviews seed.
async function loadSeedOrders(
  pool: PgTransactionalPool,
): Promise<Readonly<{ referenceOrder: OrderSnapshot; reviewEligibleOrder: OrderSnapshot }> | null> {
  const orderResult = await pool.query<OrderSnapshotRow>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       shipping_destination_snapshot,
       shipping_origin_snapshot
     FROM fulfillment_order_sources
     WHERE status = 'ready-for-fulfillment'
     ORDER BY ready_for_fulfillment_at ASC NULLS LAST, order_id ASC
     LIMIT 2`,
  );
  const [referenceOrder, reviewEligibleOrder] = orderResult.rows;
  if (!referenceOrder || !reviewEligibleOrder) {
    console.log("Fulfillment seed is waiting for two ready-for-fulfillment orders. Skipping shipments for this pass.");
    return null;
  }

  return {
    referenceOrder: { ...referenceOrder, lines: await loadOrderLines(pool, referenceOrder.order_id) },
    reviewEligibleOrder: { ...reviewEligibleOrder, lines: await loadOrderLines(pool, reviewEligibleOrder.order_id) },
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

  const seedOrders = await loadSeedOrders(pool);
  if (!seedOrders) {
    return;
  }
  const { referenceOrder, reviewEligibleOrder } = seedOrders;
  const context = createSeedContext();

  const ensureShipmentCreated = async (order: OrderSnapshot, shipmentId: string, createdAt: string) => {
    const existingStatus = await getShipmentStatus(pool, shipmentId);
    if (existingStatus) {
      return existingStatus;
    }

    await services.shipments.commandHandler({
      streamId: `fulfillment.shipment-${shipmentId}`,
      command: {
        type: "CreateShipment",
        shipmentId: shipmentId as ShipmentId,
        orderId: order.order_id as OrderId,
        buyerAccountId: order.buyer_account_id as AccountId,
        sellerAccountId: order.seller_account_id as AccountId,
        shippingOption: order.shipping_option,
        shippingDestinationSnapshot: order.shipping_destination_snapshot,
        shippingOriginSnapshot: order.shipping_origin_snapshot,
        lines: order.lines.map((line, index) => ({
          lineId: `spl_seed_${shipmentId}_${index}` as ShipmentLineId,
          orderLineId: line.line_id,
          catalogItemId: line.catalog_catalog_item_id,
          productId: line.product_id,
          itemTitle: line.item_title,
          itemSubtitle: line.item_subtitle,
          productSummary: line.product_summary,
          quantity: line.quantity,
        })),
        createdAt,
      },
      context,
    });

    return "awaiting-package";
  };

  const ensureShipmentPacked = async (order: OrderSnapshot, shipmentId: string, createdAt: string) => {
    let status = await ensureShipmentCreated(order, shipmentId, createdAt);

    if (status === "awaiting-package") {
      await services.shipments.commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "StartShipmentPacking",
          startedAt: new Date().toISOString(),
        },
        context,
      });
      status = "packing";
    }

    if (status === "packing") {
      for (const [index] of order.lines.entries()) {
        await services.shipments.commandHandler({
          streamId: `fulfillment.shipment-${shipmentId}`,
          command: {
            type: "ConfirmShipmentPackingLine",
            lineId: `spl_seed_${shipmentId}_${index}` as ShipmentLineId,
            confirmedAt: new Date().toISOString(),
          },
          context,
        });
      }

      await services.shipments.commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "PrepareShipmentPackage",
          packageCount: 1,
          preparedAt: new Date().toISOString(),
        },
        context,
      });
      status = "awaiting-label";
    }

    return status;
  };

  const ensureShipmentLabeled = async (
    order: OrderSnapshot,
    shipmentId: string,
    createdAt: string,
    labelReference: string,
    trackingIdentifier: string,
  ) => {
    let status = await ensureShipmentPacked(order, shipmentId, createdAt);

    if (status === "awaiting-label") {
      await services.shipments.commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "AttachShipmentLabel",
          shippingMethod: "standard",
          carrierName: "UPS",
          labelReference,
          trackingIdentifier,
          postageAmountCents: 599,
          postageCurrency: "USD",
          attachedAt: new Date().toISOString(),
        },
        context,
      });
      status = "label-attached";
    }

    return status;
  };

  const ensureShipmentDispatched = async (
    order: OrderSnapshot,
    shipmentId: string,
    createdAt: string,
    labelReference: string,
    trackingIdentifier: string,
  ) => {
    let status = await ensureShipmentLabeled(order, shipmentId, createdAt, labelReference, trackingIdentifier);

    if (status === "label-attached") {
      await services.shipments.commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "DispatchShipment",
          dispatchedAt: new Date().toISOString(),
        },
        context,
      });
      status = "dispatched";
    }

    return status;
  };

  const ensureShipmentDelivered = async (
    order: OrderSnapshot,
    shipmentId: string,
    createdAt: string,
    labelReference: string,
    trackingIdentifier: string,
  ) => {
    let status = await ensureShipmentDispatched(order, shipmentId, createdAt, labelReference, trackingIdentifier);

    if (status === "dispatched" || status === "exception") {
      await services.shipments.commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "RecordShipmentDelivery",
          deliveredAt: new Date().toISOString(),
        },
        context,
      });
      status = "delivered";
    }

    return status;
  };

  await ensureShipmentPacked(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.awaitingLabel,
    "2026-03-22T10:00:00.000Z",
  );

  await ensureShipmentLabeled(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.labelAttached,
    "2026-03-22T10:10:00.000Z",
    "lbl_seed_label_attached",
    "1ZSEEDLABELATTACHED",
  );

  await ensureShipmentDispatched(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.dispatchedShipment,
    "2026-03-22T10:20:00.000Z",
    "lbl_seed_dispatched",
    "1ZSEEDDISPATCHED",
  );

  await ensureShipmentDelivered(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
    "2026-03-22T10:30:00.000Z",
    "lbl_seed_demo_charizard",
    "1ZSEEDDELIVERED",
  );

  let returnedStatus = await ensureShipmentDispatched(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.returnedShipment,
    "2026-03-22T10:40:00.000Z",
    "lbl_seed_returned",
    "1ZSEEDRETURNED",
  );
  if (returnedStatus === "dispatched" || returnedStatus === "exception") {
    await services.shipments.commandHandler({
      streamId: `fulfillment.shipment-${fulfillmentReservedSeedIds.shipments.returnedShipment}`,
      command: {
        type: "ReturnShipment",
        reason: "Carrier return to sender",
        returnedAt: new Date().toISOString(),
      },
      context,
    });
    returnedStatus = "returned";
  }

  let exceptionStatus = await ensureShipmentDispatched(
    referenceOrder,
    fulfillmentReservedSeedIds.shipments.exceptionShipment,
    "2026-03-22T10:50:00.000Z",
    "lbl_seed_exception",
    "1ZSEEDEXCEPTION",
  );
  if (exceptionStatus !== "exception" && exceptionStatus !== "delivered" && exceptionStatus !== "returned") {
    await services.shipments.commandHandler({
      streamId: `fulfillment.shipment-${fulfillmentReservedSeedIds.shipments.exceptionShipment}`,
      command: {
        type: "RaiseShipmentException",
        exceptionType: "carrier-delay",
        notes: "Missed origin scan handoff.",
        raisedAt: new Date().toISOString(),
      },
      context,
    });
  }

  // The review-eligible order ships and delivers without a support request, so
  // its review eligibility survives for the marketplace reviews seed.
  await ensureShipmentDelivered(
    reviewEligibleOrder,
    fulfillmentReservedSeedIds.shipments.reviewEligibleDelivered,
    "2026-03-22T11:00:00.000Z",
    "lbl_seed_review_eligible",
    "1ZSEEDREVIEWELIGIBLE",
  );
}
