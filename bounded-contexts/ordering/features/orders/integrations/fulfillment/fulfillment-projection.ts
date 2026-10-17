import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { releaseSellerOrderCapacityClaim } from "../../api/order-capacity";

export function buildOrderingFulfillmentCancellationProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    /**
     * Order Capacity enforcement (m127): dispatch is the other
     * terminal path (besides ordering.order.cancelled) that frees a
     * seller's Open Order slot. Called after the claim row for the
     * dispatched shipment's order is actually released, so the At
     * Capacity signal can reconcile.
     */
    onOrderCapacityReleased?: (
      params: Readonly<{ sellerAccountId: string; context: EventStoreContext }>,
    ) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<
      ChaseSetsEventPayloads,
      | "fulfillment.shipment.created"
      | "fulfillment.shipment.packing-started"
      | "fulfillment.shipment.package-prepared"
      | "fulfillment.shipment.label-attached"
      | "fulfillment.shipment.dispatched"
      | "fulfillment.shipment.cancelled"
    >
  >({
    "fulfillment.shipment.created": async (event) => {
      const { data } = event;

      await db.query(
        `INSERT INTO ordering_fulfillment_cancellation_inputs (
           order_id,
           shipment_id,
           shipment_status,
           package_status,
           created_at,
           updated_at,
           packing_started_at,
           package_prepared_at,
           cancelled_at
         ) VALUES ($1, $2, 'awaiting-package', 'awaiting-package', $3, $3, NULL, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE
         SET shipment_id = EXCLUDED.shipment_id,
             shipment_status = EXCLUDED.shipment_status,
             package_status = EXCLUDED.package_status,
             updated_at = EXCLUDED.updated_at,
             packing_started_at = NULL,
             package_prepared_at = NULL,
             cancelled_at = NULL`,
        [data.orderId, data.shipmentId, data.createdAt],
      );
    },
    "fulfillment.shipment.packing-started": async (event) => {
      const { data } = event;

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'packing',
             package_status = 'packing',
             packing_started_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.startedAt],
      );
    },
    "fulfillment.shipment.package-prepared": async (event) => {
      const { data } = event;

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'awaiting-label',
             package_status = 'packed',
             package_prepared_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.preparedAt],
      );
    },
    "fulfillment.shipment.label-attached": async (event) => {
      const { data } = event;

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'label-attached',
             package_status = 'packed',
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.attachedAt],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const { data } = event;

      const updated = await db.query<{ order_id: string }>(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'dispatched',
             package_status = 'packed',
             updated_at = $2
         WHERE shipment_id = $1
         RETURNING order_id`,
        [data.shipmentId, data.dispatchedAt],
      );

      const orderId = updated.rows[0]?.order_id;
      if (orderId) {
        const sellerAccountId = await releaseSellerOrderCapacityClaim(db, orderId, data.dispatchedAt);
        if (sellerAccountId) {
          await options.onOrderCapacityReleased?.({
            sellerAccountId,
            context: { tenantId: event.tenantId, audit: event.audit, trace: event.trace } as EventStoreContext,
          });
        }
      }
    },
    "fulfillment.shipment.cancelled": async (event) => {
      const { data } = event;

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.cancelledAt],
      );
    },
  });
}
