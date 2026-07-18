import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { InventoryHoldCollisionRecordedEvent } from "../domain/domain";

export function buildInventoryHoldCollisionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.hold-collision-recorded": async (event) => {
      const data = event.data as InventoryHoldCollisionRecordedEvent["data"];
      await db.query(
        `INSERT INTO inventory_hold_collisions (
           collision_id,
           account_id,
           item_id,
           storage_location_id,
           mode,
           reason,
           requested_quantity,
           applied_quantity,
           refused_quantity,
           held_quantity,
           available_quantity,
           released_hold_quantity,
           affected_orders,
           recorded_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (collision_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             item_id = EXCLUDED.item_id,
             storage_location_id = EXCLUDED.storage_location_id,
             mode = EXCLUDED.mode,
             reason = EXCLUDED.reason,
             requested_quantity = EXCLUDED.requested_quantity,
             applied_quantity = EXCLUDED.applied_quantity,
             refused_quantity = EXCLUDED.refused_quantity,
             held_quantity = EXCLUDED.held_quantity,
             available_quantity = EXCLUDED.available_quantity,
             released_hold_quantity = EXCLUDED.released_hold_quantity,
             affected_orders = EXCLUDED.affected_orders,
             recorded_at = EXCLUDED.recorded_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE inventory_hold_collisions.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.collisionId,
          data.accountId,
          data.itemId,
          data.storageLocationId,
          data.mode,
          data.reason,
          data.requestedQuantity,
          data.appliedQuantity,
          data.refusedQuantity,
          data.heldQuantity,
          data.availableQuantity,
          data.releasedHoldQuantity,
          JSON.stringify(data.affectedOrders),
          data.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
