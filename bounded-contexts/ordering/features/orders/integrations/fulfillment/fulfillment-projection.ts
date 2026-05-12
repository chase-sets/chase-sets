import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildOrderingFulfillmentCancellationProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO ordering_fulfillment_cancellation_inputs (
           order_id,
           shipment_id,
           shipment_status,
           package_status,
           created_at,
           updated_at,
           package_prepared_at,
           cancelled_at
         ) VALUES ($1, $2, 'awaiting-package', 'awaiting-package', $3, $3, NULL, NULL)
         ON CONFLICT (order_id) DO UPDATE
         SET shipment_id = EXCLUDED.shipment_id,
             shipment_status = EXCLUDED.shipment_status,
             package_status = EXCLUDED.package_status,
             updated_at = EXCLUDED.updated_at,
             package_prepared_at = NULL,
             cancelled_at = NULL`,
        [data.orderId, data.shipmentId, data.createdAt],
      );
    },
    "fulfillment.shipment.package-prepared": async (event) => {
      const data = event.data as {
        shipmentId: string;
        preparedAt: string;
      };

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
      const data = event.data as {
        shipmentId: string;
        attachedAt: string;
      };

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
      const data = event.data as {
        shipmentId: string;
        dispatchedAt: string;
      };

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'dispatched',
             package_status = 'packed',
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.dispatchedAt],
      );
    },
    "fulfillment.shipment.cancelled": async (event) => {
      const data = event.data as {
        shipmentId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE ordering_fulfillment_cancellation_inputs
         SET shipment_status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.cancelledAt],
      );
    },
  };
}
