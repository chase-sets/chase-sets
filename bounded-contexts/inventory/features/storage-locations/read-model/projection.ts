import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildStorageLocationProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.storage-location.created": async (event) => {
      const {
        storageLocationId,
        accountId,
        name,
        description,
        shipFromCode,
        shipFromAddress,
      } = event.data as {
        storageLocationId: string;
        accountId: string;
        name: string;
        description: string | null;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `INSERT INTO inventory_storage_locations (
           storage_location_id,
           account_id,
           name,
           description,
           ship_from_code,
           ship_from_address,
           is_archived,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, false, $7)
         ON CONFLICT (storage_location_id) DO UPDATE
         SET account_id = $2,
             name = $3,
             description = $4,
             ship_from_code = $5,
             ship_from_address = $6,
             is_archived = false,
             updated_at = $7`,
        [
          storageLocationId,
          accountId,
          name,
          description,
          shipFromCode,
          JSON.stringify(shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.updated": async (event) => {
      const {
        storageLocationId,
        name,
        description,
        shipFromCode,
        shipFromAddress,
      } = event.data as {
        storageLocationId: string;
        name: string;
        description: string | null;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `UPDATE inventory_storage_locations
         SET name = $2,
             description = $3,
             ship_from_code = $4,
             ship_from_address = $5,
             updated_at = $6
         WHERE storage_location_id = $1`,
        [
          storageLocationId,
          name,
          description,
          shipFromCode,
          JSON.stringify(shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.archived": async (event) => {
      const { storageLocationId } = event.data as {
        storageLocationId: string;
      };

      await db.query(
        `UPDATE inventory_storage_locations
         SET is_archived = true,
             updated_at = $2
         WHERE storage_location_id = $1`,
        [storageLocationId, event.timing.recordedAt],
      );
    },
  };
}
