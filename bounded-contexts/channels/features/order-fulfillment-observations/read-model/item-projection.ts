import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";

export function buildFulfillmentItemProjection(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const { itemId, accountId, productId } = event.data;
      if (typeof itemId !== "string" || typeof accountId !== "string" || typeof productId !== "string")
        throw new Error("invalid-fulfillment-item-fact");
      await db.query(
        `INSERT INTO channel_fulfillment_item_facts (item_id,account_id,product_id)
        VALUES ($1,$2,$3) ON CONFLICT (item_id) DO NOTHING`,
        [itemId, accountId, productId],
      );
    },
  };
}
