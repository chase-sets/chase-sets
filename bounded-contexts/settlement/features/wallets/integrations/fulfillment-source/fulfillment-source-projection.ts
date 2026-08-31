import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildSettlementFulfillmentSourceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...defineProjectorHandlers<
      Pick<
        ChaseSetsEventPayloads,
        "fulfillment.shipment.created" | "fulfillment.shipment.dispatched" | "fulfillment.shipment.delivered"
      >
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

        await db.query(
          `INSERT INTO settlement_order_fulfillment_sources (
           shipment_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           tracking_identifier,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'created', $5, $6, $6, NULL, NULL, NULL, NULL, $7)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           status = EXCLUDED.status,
           tracking_identifier = EXCLUDED.tracking_identifier,
           updated_at = EXCLUDED.updated_at,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_order_fulfillment_sources.last_stream_version < EXCLUDED.last_stream_version`,
          [
            data.shipmentId,
            data.orderId,
            data.buyerAccountId,
            data.sellerAccountId,
            null,
            data.createdAt,
            event.streamVersion,
          ],
        );
      },
      "fulfillment.shipment.dispatched": async (event) => {
        const { data } = event;
        await db.query(
          `UPDATE settlement_order_fulfillment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
          [data.shipmentId, data.dispatchedAt, event.streamVersion],
        );
      },
      "fulfillment.shipment.delivered": async (event) => {
        const { data } = event;
        await db.query(
          `UPDATE settlement_order_fulfillment_sources
         SET status = 'delivered',
             tracking_identifier = COALESCE($2, tracking_identifier),
             delivered_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE shipment_id = $1
           AND last_stream_version < $4`,
          [data.shipmentId, data.trackingIdentifier ?? null, data.deliveredAt, event.streamVersion],
        );
      },
    }),
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as { shipmentId: string; returnedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.returnedAt, event.streamVersion],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as { shipmentId: string; raisedAt: string };
      await db.query(
        `UPDATE settlement_order_fulfillment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE shipment_id = $1
           AND last_stream_version < $3`,
        [data.shipmentId, data.raisedAt, event.streamVersion],
      );
    },
  };
}
