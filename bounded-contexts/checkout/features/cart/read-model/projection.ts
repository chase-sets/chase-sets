import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function buyerAccountIdFromCartStream(streamId: string): string {
  return extractIdFromStreamId(streamId, "checkout.cart-");
}

export function buildCheckoutCartProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "checkout.cart.line-added": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        buyerAccountId: string;
        lineId: string;
        catalogItemId: string;
        productId: string;
        itemLanguageCode?: string | null;
        itemTitle: string;
        itemSubtitle: string | null;
        itemImageUrl?: string | null;
        itemImageSrcSet?: string | null;
        itemImageLoadingUrl?: string | null;
        itemImageLoadingAlt?: string | null;
        itemImageLoadingSrcSet?: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        quantity: number;
        fulfillmentMode?: string;
        lockedListingId?: string | null;
        sellerPreferenceId?: string | null;
        selectedListingSnapshot?: {
          listingId: string;
          sellerAccountId: string | null;
          sellerDisplayName: string | null;
          sellerSlug: string | null;
          priceAmount: string | null;
          source: string;
        } | null;
        availabilityState?: string;
      };
      const selectedListing = data.selectedListingSnapshot ?? null;

      await projectionDb.query(
        `INSERT INTO checkout_cart_line_pages (
           buyer_account_id,
           line_id,
           catalog_catalog_item_id,
           product_id,
           item_language_code,
           item_title,
           item_subtitle,
           item_image_url,
           item_image_srcset,
           item_image_loading_url,
           item_image_loading_alt,
           item_image_loading_srcset,
           selected_options,
           product_summary,
           quantity,
           fulfillment_mode,
           locked_listing_id,
           selected_listing_id,
           selected_listing_seller_account_id,
           selected_listing_seller_display_name,
           selected_listing_seller_slug,
           selected_listing_price_amount,
           selected_listing_snapshot_source,
           selected_listing_snapshot_captured_at,
           seller_preference_id,
           availability_state,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $27)
         ON CONFLICT (buyer_account_id, line_id) DO UPDATE
         SET catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_language_code = EXCLUDED.item_language_code,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             item_image_url = EXCLUDED.item_image_url,
             item_image_srcset = EXCLUDED.item_image_srcset,
             item_image_loading_url = EXCLUDED.item_image_loading_url,
             item_image_loading_alt = EXCLUDED.item_image_loading_alt,
             item_image_loading_srcset = EXCLUDED.item_image_loading_srcset,
             selected_options = EXCLUDED.selected_options,
             product_summary = EXCLUDED.product_summary,
             quantity = EXCLUDED.quantity,
             fulfillment_mode = EXCLUDED.fulfillment_mode,
             locked_listing_id = EXCLUDED.locked_listing_id,
             selected_listing_id = EXCLUDED.selected_listing_id,
             selected_listing_seller_account_id = EXCLUDED.selected_listing_seller_account_id,
             selected_listing_seller_display_name = EXCLUDED.selected_listing_seller_display_name,
             selected_listing_seller_slug = EXCLUDED.selected_listing_seller_slug,
             selected_listing_price_amount = EXCLUDED.selected_listing_price_amount,
             selected_listing_snapshot_source = EXCLUDED.selected_listing_snapshot_source,
             selected_listing_snapshot_captured_at = EXCLUDED.selected_listing_snapshot_captured_at,
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
          data.itemImageSrcSet ?? null,
          data.itemImageLoadingUrl ?? null,
          data.itemImageLoadingAlt ?? null,
          data.itemImageLoadingSrcSet ?? null,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.quantity,
          data.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
          data.lockedListingId ?? null,
          selectedListing?.listingId ?? null,
          selectedListing?.sellerAccountId ?? null,
          selectedListing?.sellerDisplayName ?? null,
          selectedListing?.sellerSlug ?? null,
          selectedListing?.priceAmount ?? null,
          selectedListing?.source ?? null,
          selectedListing ? event.timing.recordedAt : null,
          data.sellerPreferenceId ?? null,
          data.availabilityState ?? "available",
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.cart.line-quantity-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as { lineId: string; quantity: number };
      const buyerAccountId = buyerAccountIdFromCartStream(event.streamId);

      await projectionDb.query(
        `UPDATE checkout_cart_line_pages
         SET quantity = $3,
             updated_at = $4
         WHERE buyer_account_id = $1
           AND line_id = $2`,
        [buyerAccountId, data.lineId, data.quantity, event.timing.recordedAt],
      );
    },
    "checkout.cart.line-fulfillment-set": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as {
        lineId: string;
        fulfillmentMode: string;
        lockedListingId: string | null;
        sellerPreferenceId: string | null;
        selectedListingSnapshot: {
          listingId: string;
          sellerAccountId: string | null;
          sellerDisplayName: string | null;
          sellerSlug: string | null;
          priceAmount: string | null;
          source: string;
        } | null;
        availabilityState: string;
      };
      const selectedListing = data.selectedListingSnapshot ?? null;
      const buyerAccountId = buyerAccountIdFromCartStream(event.streamId);

      await projectionDb.query(
        `UPDATE checkout_cart_line_pages
         SET fulfillment_mode = $3,
             locked_listing_id = $4,
             selected_listing_id = $5,
             selected_listing_seller_account_id = $6,
             selected_listing_seller_display_name = $7,
             selected_listing_seller_slug = $8,
             selected_listing_price_amount = $9,
             selected_listing_snapshot_source = $10,
             selected_listing_snapshot_captured_at = $11,
             seller_preference_id = $12,
             availability_state = $13,
             updated_at = $14
         WHERE buyer_account_id = $1
           AND line_id = $2`,
        [
          buyerAccountId,
          data.lineId,
          data.fulfillmentMode === "locked-listing" ? "locked-listing" : "optimize",
          data.lockedListingId,
          selectedListing?.listingId ?? null,
          selectedListing?.sellerAccountId ?? null,
          selectedListing?.sellerDisplayName ?? null,
          selectedListing?.sellerSlug ?? null,
          selectedListing?.priceAmount ?? null,
          selectedListing?.source ?? null,
          selectedListing ? event.timing.recordedAt : null,
          data.sellerPreferenceId,
          data.availabilityState,
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.cart.line-removed": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as { lineId: string };
      const buyerAccountId = buyerAccountIdFromCartStream(event.streamId);

      await projectionDb.query(
        `DELETE FROM checkout_cart_line_pages
         WHERE buyer_account_id = $1
           AND line_id = $2`,
        [buyerAccountId, data.lineId],
      );
    },
    "checkout.cart.checked-out": async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const data = event.data as { buyerAccountId: string };

      await projectionDb.query(
        `DELETE FROM checkout_cart_line_pages
         WHERE buyer_account_id = $1`,
        [data.buyerAccountId],
      );
    },
  };
}
