import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryRecordProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.record.created": async (event) => {
      const {
        recordId,
        accountId,
        catalogItemId,
        versionSelection,
        condition,
        storageLocationId,
        totalQuantity,
        acquisitionCostAmount,
      } = event.data as {
        recordId: string;
        accountId: string;
        catalogItemId: string;
        versionSelection: unknown;
        condition: string;
        storageLocationId: string;
        totalQuantity: number;
        acquisitionCostAmount: string | null;
      };

      await db.query(
        `INSERT INTO inventory_records (
           record_id,
           account_id,
           catalog_item_id,
           version_selection,
           condition,
           storage_location_id,
           total_quantity,
           acquisition_cost_amount,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (record_id) DO UPDATE
         SET account_id = $2,
             catalog_item_id = $3,
             version_selection = $4,
             condition = $5,
             storage_location_id = $6,
             total_quantity = $7,
             acquisition_cost_amount = $8,
             updated_at = $9`,
        [
          recordId,
          accountId,
          catalogItemId,
          JSON.stringify(Array.isArray(versionSelection) ? versionSelection : []),
          condition,
          storageLocationId,
          totalQuantity,
          acquisitionCostAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.record.adjusted": async (event) => {
      const { recordId, quantityDelta } = event.data as {
        recordId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE inventory_records
         SET total_quantity = total_quantity + $2,
             updated_at = $3
         WHERE record_id = $1`,
        [recordId, quantityDelta, event.timing.recordedAt],
      );
    },
  };
}
