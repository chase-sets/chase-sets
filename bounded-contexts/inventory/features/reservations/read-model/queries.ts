import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type InventoryReservationRow = Readonly<{
  reservation_request_id: string;
  order_id: string;
  seller_account_id: string;
  inventory_item_id: string;
  quantity: number;
  hold_id: string | null;
  status: string;
  rejection_reason: string | null;
  released_at: string | null;
  updated_at: string;
}>;

export async function getInventoryReservation(db: PgQueryable, reservationRequestId: string) {
  const result = await db.query<InventoryReservationRow>(
    `SELECT
       reservation_request_id,
       order_id,
       seller_account_id,
       inventory_item_id,
       quantity,
       hold_id,
       status,
       rejection_reason,
       released_at,
       updated_at
     FROM inventory_reservation_pages
     WHERE reservation_request_id = $1`,
    [reservationRequestId],
  );

  return result.rows[0] ?? null;
}
