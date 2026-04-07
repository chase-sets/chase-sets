import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryReservationProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.reservation.confirmed": async (event) => {
      const data = event.data as {
        reservationRequestId: string;
        orderId: string;
        sellerAccountId: string;
        inventoryRecordId: string;
        quantity: number;
        holdId: string;
      };

      await db.query(
        `INSERT INTO inventory_reservation_pages (
           reservation_request_id,
           order_id,
           seller_account_id,
           inventory_record_id,
           quantity,
           hold_id,
           status,
           rejection_reason,
           released_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', NULL, NULL, $7)
         ON CONFLICT (reservation_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             seller_account_id = EXCLUDED.seller_account_id,
             inventory_record_id = EXCLUDED.inventory_record_id,
             quantity = EXCLUDED.quantity,
             hold_id = EXCLUDED.hold_id,
             status = EXCLUDED.status,
             rejection_reason = EXCLUDED.rejection_reason,
             released_at = EXCLUDED.released_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.reservationRequestId,
          data.orderId,
          data.sellerAccountId,
          data.inventoryRecordId,
          data.quantity,
          data.holdId,
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.reservation.rejected": async (event) => {
      const data = event.data as {
        reservationRequestId: string;
        orderId: string;
        sellerAccountId: string;
        inventoryRecordId: string;
        quantity: number;
        reason: string;
      };

      await db.query(
        `INSERT INTO inventory_reservation_pages (
           reservation_request_id,
           order_id,
           seller_account_id,
           inventory_record_id,
           quantity,
           hold_id,
           status,
           rejection_reason,
           released_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, NULL, 'rejected', $6, NULL, $7)
         ON CONFLICT (reservation_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             seller_account_id = EXCLUDED.seller_account_id,
             inventory_record_id = EXCLUDED.inventory_record_id,
             quantity = EXCLUDED.quantity,
             hold_id = EXCLUDED.hold_id,
             status = EXCLUDED.status,
             rejection_reason = EXCLUDED.rejection_reason,
             released_at = EXCLUDED.released_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.reservationRequestId,
          data.orderId,
          data.sellerAccountId,
          data.inventoryRecordId,
          data.quantity,
          data.reason,
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.reservation.released": async (event) => {
      const data = event.data as {
        reservationRequestId: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE inventory_reservation_pages
         SET status = 'released',
             released_at = $2,
             updated_at = $2
         WHERE reservation_request_id = $1`,
        [data.reservationRequestId, data.releasedAt],
      );
    },
  };
}
