import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryHoldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.hold.placed": async (event) => {
      const { holdId, accountId, itemId, quantity, reason, notes } = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
        reason: string;
        notes: string | null;
      };

      await db.query(
        `INSERT INTO inventory_holds (
           hold_id,
           account_id,
           item_id,
           quantity,
           reason,
           notes,
           status,
           created_at,
           updated_at,
           released_at,
           last_stream_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, NULL, $8)
         ON CONFLICT (hold_id) DO UPDATE
         SET account_id = $2,
             item_id = $3,
             quantity = $4,
             reason = $5,
             notes = $6,
             status = 'active',
             updated_at = $7,
             released_at = NULL,
             last_stream_version = $8
         WHERE inventory_holds.last_stream_version < $8`,
        [holdId, accountId, itemId, quantity, reason, notes, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.released": async (event) => {
      const { holdId, releasedAt } = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE inventory_holds
         SET status = 'released',
             updated_at = $2,
             released_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4`,
        [holdId, event.timing.recordedAt, releasedAt, event.streamVersion],
      );
    },
  };
}
