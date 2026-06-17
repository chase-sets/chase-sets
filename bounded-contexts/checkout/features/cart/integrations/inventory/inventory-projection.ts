import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Recomputes the holds-accurate supply counters denormalized onto every
 * `checkout_marketplace_seller_options` row that joins to the given inventory
 * item. `supply_total_quantity` mirrors the item's current total quantity and
 * `active_held_quantity` sums the item's active holds.
 *
 * Recomputing from the auxiliary `checkout_supply_items` / `checkout_supply_holds`
 * tables (rather than applying deltas in place) keeps the projection replay-safe
 * and event-ordering independent: the counters are derived state, so re-running
 * any event — or projecting a listing created after its inventory item already
 * had supply/holds — converges to the same correct values. The marketplace
 * listing projection calls this on `marketplace.listing.created` to backfill a
 * freshly inserted row.
 */
export async function recomputeCheckoutSellerOptionSupply(db: PgQueryable, itemId: string): Promise<void> {
  await db.query(
    `UPDATE checkout_marketplace_seller_options AS o
     SET supply_total_quantity = supply.total_quantity,
         active_held_quantity = COALESCE(holds.held_quantity, 0)
     FROM checkout_supply_items AS supply
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM checkout_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS holds
       ON holds.item_id = supply.item_id
     WHERE supply.item_id = $1
       AND o.inventory_item_id = supply.item_id`,
    [itemId],
  );
}

/**
 * Checkout-local inventory supply/holds handler set feeding the SAME
 * `checkout-marketplace-seller-options-projection` as the marketplace listing
 * handlers. It maintains replay-safe auxiliary supply/hold tables keyed by the
 * inventory item id and recomputes the denormalized `supply_total_quantity` /
 * `active_held_quantity` counters on the joined seller-option rows so the cart
 * read model can compute `available_quantity = LEAST(quantity_cap,
 * GREATEST(supply - holds, 0))`.
 *
 * `inventory.hold.released` carries only the hold id, so the released hold is
 * resolved back to its inventory item through the auxiliary holds table before
 * recomputing the affected rows.
 */
export function buildCheckoutInventorySupplyProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        totalQuantity: number;
      };

      await db.query(
        `INSERT INTO checkout_supply_items (
           item_id,
           total_quantity,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (item_id) DO UPDATE SET
           total_quantity = EXCLUDED.total_quantity,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE checkout_supply_items.last_stream_version < EXCLUDED.last_stream_version`,
        [data.itemId, data.totalQuantity, event.streamVersion, event.timing.recordedAt],
      );

      await recomputeCheckoutSellerOptionSupply(db, data.itemId);
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE checkout_supply_items
         SET total_quantity = total_quantity + $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );

      await recomputeCheckoutSellerOptionSupply(db, data.itemId);
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        itemId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO checkout_supply_holds (
           hold_id,
           item_id,
           quantity,
           status,
           released_at,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, 'active', NULL, $4, $5)
         ON CONFLICT (hold_id) DO UPDATE SET
           item_id = EXCLUDED.item_id,
           quantity = EXCLUDED.quantity,
           status = EXCLUDED.status,
           released_at = EXCLUDED.released_at,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE checkout_supply_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [data.holdId, data.itemId, data.quantity, event.streamVersion, event.timing.recordedAt],
      );

      await recomputeCheckoutSellerOptionSupply(db, data.itemId);
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      const released = await db.query<{ item_id: string }>(
        `UPDATE checkout_supply_holds
         SET status = 'released',
             released_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4
         RETURNING item_id`,
        [data.holdId, data.releasedAt, event.timing.recordedAt, event.streamVersion],
      );

      const itemId = released.rows[0]?.item_id;
      if (itemId) {
        await recomputeCheckoutSellerOptionSupply(db, itemId);
      }
    },
  };
}
