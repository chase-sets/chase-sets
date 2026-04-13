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
        catalogVersionKey,
        versionSelection,
        storageLocationId,
        totalQuantity,
        acquisitionCostAmount,
      } = event.data as {
        recordId: string;
        accountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        versionSelection: unknown;
        storageLocationId: string;
        totalQuantity: number;
        acquisitionCostAmount: string | null;
      };

      await db.query(
        `INSERT INTO inventory_records (
           record_id,
           account_id,
           catalog_item_id,
           catalog_version_key,
           version_selection,
           storage_location_id,
           total_quantity,
           last_stream_version,
           acquisition_cost_amount,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (record_id) DO UPDATE
         SET account_id = $2,
             catalog_item_id = $3,
             catalog_version_key = $4,
             version_selection = $5,
             storage_location_id = $6,
             total_quantity = $7,
             last_stream_version = $8,
             acquisition_cost_amount = $9,
             updated_at = $10
         WHERE inventory_records.last_stream_version < $8`,
        [
          recordId,
          accountId,
          catalogItemId,
          catalogVersionKey,
          JSON.stringify(Array.isArray(versionSelection) ? versionSelection : []),
          storageLocationId,
          totalQuantity,
          event.streamVersion,
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
             updated_at = $3,
             last_stream_version = $4
         WHERE record_id = $1
           AND last_stream_version < $4`,
        [recordId, quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
  };
}
