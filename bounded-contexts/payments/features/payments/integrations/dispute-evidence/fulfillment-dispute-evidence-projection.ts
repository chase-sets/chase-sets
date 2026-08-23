import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPaymentsFulfillmentDisputeEvidenceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...defineProjectorHandlers<
      Pick<
        ChaseSetsEventPayloads,
        | "fulfillment.shipment.created"
        | "fulfillment.shipment.label-attached"
        | "fulfillment.shipment.dispatched"
        | "fulfillment.shipment.delivered"
        | "fulfillment.shipment.cancelled"
      >
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

        await db.query(
          `INSERT INTO payments_fulfillment_dispute_evidence_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           shipping_destination_snapshot,
           lines,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'created', $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
             lines = EXCLUDED.lines,
             updated_at = EXCLUDED.updated_at`,
          [
            data.shipmentId,
            data.orderId,
            data.buyerAccountId,
            data.sellerAccountId,
            JSON.stringify(data.shippingDestinationSnapshot ?? null),
            JSON.stringify(data.lines ?? []),
            data.createdAt,
          ],
        );
      },
      "fulfillment.shipment.label-attached": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE payments_fulfillment_dispute_evidence_sources
         SET status = 'label-attached',
             shipping_method = $2,
             carrier_name = $3,
             tracking_identifier = $4,
             label_attached_at = $5,
             updated_at = $5
         WHERE shipment_id = $1`,
          [data.shipmentId, data.shippingMethod, data.carrierName, data.trackingIdentifier, data.attachedAt],
        );
      },
      "fulfillment.shipment.dispatched": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE payments_fulfillment_dispute_evidence_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
          [data.shipmentId, data.dispatchedAt],
        );
      },
      "fulfillment.shipment.delivered": async (event) => {
        const { data } = event;

        await db.query(
          `UPDATE payments_fulfillment_dispute_evidence_sources
         SET order_id = $2,
             buyer_account_id = $3,
             status = 'delivered',
             shipping_destination_snapshot = $4::jsonb,
             tracking_identifier = COALESCE($5, tracking_identifier),
             delivered_at = $6,
             updated_at = $6
         WHERE shipment_id = $1`,
          [
            data.shipmentId,
            data.orderId,
            data.buyerAccountId,
            JSON.stringify(data.shippingDestinationSnapshot ?? null),
            data.trackingIdentifier,
            data.deliveredAt,
          ],
        );
      },
      "fulfillment.shipment.cancelled": async (event) => {
        const { data } = event;
        await recordTerminalShipmentStatus(db, data.shipmentId, "cancelled", data.cancelledAt);
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };
      await recordTerminalShipmentStatus(db, data.shipmentId, "returned", data.returnedAt);
    },
  };
}

async function recordTerminalShipmentStatus(db: PgQueryable, shipmentId: string, status: string, timestamp: string) {
  await db.query(
    `UPDATE payments_fulfillment_dispute_evidence_sources
     SET status = $2,
         updated_at = $3
     WHERE shipment_id = $1`,
    [shipmentId, status, timestamp],
  );
}
