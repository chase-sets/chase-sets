import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";

export type InventoryHoldRow = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: number;
  reason: string;
  notes: string | null;
  purpose: InventoryHoldPurpose;
  source_ref: InventoryHoldSourceRef;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  released_at: string | null;
  release_reason: InventoryHoldReleaseReason | null;
  consumed_at: string | null;
  expired_at: string | null;
  extension_count: number;
}>;

export async function getInventoryHold(db: PgQueryable, holdId: string, accountId: string) {
  const result = await db.query<InventoryHoldRow>(
    `SELECT
       hold_id,
       account_id,
       item_id,
       quantity,
       reason,
       notes,
       purpose,
       source_ref,
       expires_at,
       status,
       created_at,
       updated_at,
       released_at,
       release_reason,
       consumed_at,
       expired_at,
       extension_count
     FROM inventory_holds
     WHERE hold_id = $1
       AND account_id = $2`,
    [holdId, accountId],
  );

  return result.rows[0] ?? null;
}
