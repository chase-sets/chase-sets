import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildOrderingCartProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "ordering.cart.line-added": async (event) => {
      const data = event.data as {
        buyerAccountId: string;
        lineId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        itemTitle: string;
        itemSubtitle: string | null;
        versionSelection: unknown;
        versionSummary: string | null;
        quantity: number;
      };

      await db.query(
        `INSERT INTO ordering_cart_line_pages (
           buyer_account_id,
           line_id,
           catalog_item_id,
           catalog_version_key,
           item_title,
           item_subtitle,
           version_selection,
           version_summary,
           quantity,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (buyer_account_id, line_id) DO UPDATE
         SET catalog_item_id = EXCLUDED.catalog_item_id,
             catalog_version_key = EXCLUDED.catalog_version_key,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             version_selection = EXCLUDED.version_selection,
             version_summary = EXCLUDED.version_summary,
             quantity = EXCLUDED.quantity,
             updated_at = EXCLUDED.updated_at`,
        [
          data.buyerAccountId,
          data.lineId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.versionSelection) ? data.versionSelection : []),
          data.versionSummary,
          data.quantity,
          event.timing.recordedAt,
        ],
      );
    },
    "ordering.cart.line-quantity-set": async (event) => {
      const data = event.data as { lineId: string; quantity: number };

      await db.query(
        `UPDATE ordering_cart_line_pages
         SET quantity = $2,
             updated_at = $3
         WHERE line_id = $1`,
        [data.lineId, data.quantity, event.timing.recordedAt],
      );
    },
    "ordering.cart.line-removed": async (event) => {
      const data = event.data as { lineId: string };

      await db.query(
        `DELETE FROM ordering_cart_line_pages
         WHERE line_id = $1`,
        [data.lineId],
      );
    },
    "ordering.cart.checked-out": async (event) => {
      const data = event.data as { buyerAccountId: string };

      await db.query(
        `DELETE FROM ordering_cart_line_pages
         WHERE buyer_account_id = $1`,
        [data.buyerAccountId],
      );
    },
  };
}
