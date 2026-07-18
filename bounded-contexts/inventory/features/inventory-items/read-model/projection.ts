import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryItemProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const {
        itemId,
        accountId,
        catalogItemId,
        productId,
        selectedOptions,
        gradedCard,
        storageLocationId,
        totalQuantity,
        acquisitionCostAmount,
      } = event.data as {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        selectedOptions: unknown;
        gradedCard: unknown;
        storageLocationId: string;
        totalQuantity: number;
        acquisitionCostAmount: string | null;
      };

      await db.query(
        `INSERT INTO inventory_items (
           item_id,
           account_id,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           graded_card,
           storage_location_id,
           total_quantity,
           last_stream_version,
           acquisition_cost_amount,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         ON CONFLICT (item_id) DO UPDATE
         SET account_id = $2,
             catalog_catalog_item_id = $3,
             product_id = $4,
             selected_options = $5,
             graded_card = $6,
             storage_location_id = $7,
             total_quantity = $8,
             last_stream_version = $9,
             acquisition_cost_amount = $10,
             updated_at = $11
         WHERE inventory_items.last_stream_version < $9`,
        [
          itemId,
          accountId,
          catalogItemId,
          productId,
          JSON.stringify(Array.isArray(selectedOptions) ? selectedOptions : []),
          gradedCard === null || typeof gradedCard !== "object" ? null : JSON.stringify(gradedCard),
          storageLocationId,
          totalQuantity,
          event.streamVersion,
          acquisitionCostAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.item.adjusted": async (event) => {
      const { itemId, quantityDelta } = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE inventory_items
         SET total_quantity = total_quantity + $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [itemId, quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.item.stock-authority-claimed": async (event) => {
      const { itemId } = event.data as { itemId: string };
      await db.query(
        `UPDATE inventory_items
         SET last_stream_version = $2,
             updated_at = $3
         WHERE item_id = $1
           AND last_stream_version < $2`,
        [itemId, event.streamVersion, event.timing.recordedAt],
      );
    },
  };
}
