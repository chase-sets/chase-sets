import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryHoldProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.hold.placed": async (event) => {
      const { holdId, accountId, recordId, quantity, reason, notes } =
        event.data as {
          holdId: string;
          accountId: string;
          recordId: string;
          quantity: number;
          reason: string;
          notes: string | null;
        };

      await db.query(
        `INSERT INTO inventory_holds (
           hold_id,
           account_id,
           record_id,
           quantity,
           reason,
           notes,
           status,
           created_at,
           updated_at,
           released_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, NULL)
         ON CONFLICT (hold_id) DO UPDATE
         SET account_id = $2,
             record_id = $3,
             quantity = $4,
             reason = $5,
             notes = $6,
             status = 'active',
             updated_at = $7,
             released_at = NULL`,
        [holdId, accountId, recordId, quantity, reason, notes, event.timing.recordedAt],
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
             released_at = $3
         WHERE hold_id = $1`,
        [holdId, event.timing.recordedAt, releasedAt],
      );
    },
  };
}
