import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildCheckoutCartProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "checkout.cart.line-added": async (event) => {
      const data = event.data as {
        buyerAccountId: string;
        lineId: string;
        catalogItemId: string;
        productId: string;
        itemLanguageCode?: string | null;
        itemTitle: string;
        itemSubtitle: string | null;
        itemImageUrl?: string | null;
        itemImageLoadingUrl?: string | null;
        itemImageLoadingAlt?: string | null;
        itemImageLoadingSrcSet?: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        quantity: number;
        fulfillmentMode?: string;
        lockedListingId?: string | null;
        sellerPreferenceId?: string | null;
        availabilityState?: string;
      };

      await db.query(
        `INSERT INTO checkout_cart_line_pages (
           buyer_account_id,
           line_id,
           catalog_catalog_item_id,
           product_id,
           item_language_code,
           item_title,
           item_subtitle,
           item_image_url,
           item_image_loading_url,
           item_image_loading_alt,
           item_image_loading_srcset,
           selected_options,
           product_summary,
           quantity,
           fulfillment_mode,
           locked_listing_id,
           seller_preference_id,
           availability_state,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19)
         ON CONFLICT (buyer_account_id, line_id) DO UPDATE
         SET catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_language_code = EXCLUDED.item_language_code,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             item_image_url = EXCLUDED.item_image_url,
             item_image_loading_url = EXCLUDED.item_image_loading_url,
             item_image_loading_alt = EXCLUDED.item_image_loading_alt,
             item_image_loading_srcset = EXCLUDED.item_image_loading_srcset,
             selected_options = EXCLUDED.selected_options,
             product_summary = EXCLUDED.product_summary,
             quantity = EXCLUDED.quantity,
             fulfillment_mode = EXCLUDED.fulfillment_mode,
             locked_listing_id = EXCLUDED.locked_listing_id,
             seller_preference_id = EXCLUDED.seller_preference_id,
             availability_state = EXCLUDED.availability_state,
             updated_at = EXCLUDED.updated_at`,
        [
          data.buyerAccountId,
          data.lineId,
          data.catalogItemId,
          data.productId,
          data.itemLanguageCode ?? null,
          data.itemTitle,
          data.itemSubtitle,
          data.itemImageUrl ?? null,
          data.itemImageLoadingUrl ?? null,
          data.itemImageLoadingAlt ?? null,
          data.itemImageLoadingSrcSet ?? null,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.quantity,
          data.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
          data.lockedListingId ?? null,
          data.sellerPreferenceId ?? null,
          data.availabilityState ?? "available",
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.cart.line-quantity-set": async (event) => {
      const data = event.data as { lineId: string; quantity: number };

      await db.query(
        `UPDATE checkout_cart_line_pages
         SET quantity = $2,
             updated_at = $3
         WHERE line_id = $1`,
        [data.lineId, data.quantity, event.timing.recordedAt],
      );
    },
    "checkout.cart.line-fulfillment-set": async (event) => {
      const data = event.data as {
        lineId: string;
        fulfillmentMode: string;
        lockedListingId: string | null;
        sellerPreferenceId: string | null;
        availabilityState: string;
      };

      await db.query(
        `UPDATE checkout_cart_line_pages
         SET fulfillment_mode = $2,
             locked_listing_id = $3,
             seller_preference_id = $4,
             availability_state = $5,
             updated_at = $6
         WHERE line_id = $1`,
        [
          data.lineId,
          data.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
          data.lockedListingId,
          data.sellerPreferenceId,
          data.availabilityState,
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.cart.line-removed": async (event) => {
      const data = event.data as { lineId: string };

      await db.query(
        `DELETE FROM checkout_cart_line_pages
         WHERE line_id = $1`,
        [data.lineId],
      );
    },
    "checkout.cart.checked-out": async (event) => {
      const data = event.data as { buyerAccountId: string };

      await db.query(
        `DELETE FROM checkout_cart_line_pages
         WHERE buyer_account_id = $1`,
        [data.buyerAccountId],
      );
    },
  };
}
