import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function resolveSellListSellerAccountId(event: { streamId: string }, data: { sellerAccountId?: unknown }) {
  if (typeof data.sellerAccountId === "string" && data.sellerAccountId.trim()) {
    return data.sellerAccountId;
  }

  const streamPrefix = "checkout.sell-list-";
  return event.streamId.startsWith(streamPrefix) ? event.streamId.slice(streamPrefix.length) : null;
}

export function buildCheckoutSellListProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "checkout.sell-list.line-added": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        lineId: string;
        lineType: string;
        offerId: string | null;
        buyerAccountId: string | null;
        buyerDisplayName: string | null;
        offerPriceAmount: string | null;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        quantity: number;
        fallbackMode: string;
        minimumListingPriceAmount: string | null;
      };

      await db.query(
        `INSERT INTO checkout_sell_list_line_pages (
           seller_account_id,
           line_id,
           line_type,
           offer_id,
           buyer_account_id,
           buyer_display_name,
           offer_price_amount,
           catalog_catalog_item_id,
           product_id,
           item_title,
           item_subtitle,
           selected_options,
           product_summary,
           quantity,
           fallback_mode,
           minimum_listing_price_amount,
           created_at,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
         ON CONFLICT (seller_account_id, line_id) DO UPDATE
         SET line_type = EXCLUDED.line_type,
             offer_id = EXCLUDED.offer_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             buyer_display_name = EXCLUDED.buyer_display_name,
             offer_price_amount = EXCLUDED.offer_price_amount,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             selected_options = EXCLUDED.selected_options,
             product_summary = EXCLUDED.product_summary,
             quantity = EXCLUDED.quantity,
             fallback_mode = EXCLUDED.fallback_mode,
             minimum_listing_price_amount = EXCLUDED.minimum_listing_price_amount,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sellerAccountId,
          data.lineId,
          data.lineType === "selected-offer" ? "selected-offer" : "product",
          data.offerId,
          data.buyerAccountId,
          data.buyerDisplayName,
          data.offerPriceAmount,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.quantity,
          data.fallbackMode === "create-listing" ? "create-listing" : "none",
          data.minimumListingPriceAmount,
          event.timing.recordedAt,
        ],
      );
    },
    "checkout.sell-list.line-quantity-set": async (event) => {
      const data = event.data as { sellerAccountId?: string | null; lineId: string; quantity: number };
      const sellerAccountId = resolveSellListSellerAccountId(event, data);

      if (sellerAccountId) {
        await db.query(
          `UPDATE checkout_sell_list_line_pages
           SET quantity = $3,
               updated_at = $4
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [sellerAccountId, data.lineId, data.quantity, event.timing.recordedAt],
        );
        return;
      }

      await db.query(
        `UPDATE checkout_sell_list_line_pages
         SET quantity = $2,
             updated_at = $3
         WHERE line_id = $1`,
        [data.lineId, data.quantity, event.timing.recordedAt],
      );
    },
    "checkout.sell-list.line-removed": async (event) => {
      const data = event.data as { sellerAccountId?: string | null; lineId: string };
      const sellerAccountId = resolveSellListSellerAccountId(event, data);

      if (sellerAccountId) {
        await db.query(
          `DELETE FROM checkout_sell_list_line_pages
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [sellerAccountId, data.lineId],
        );
        return;
      }

      await db.query(
        `DELETE FROM checkout_sell_list_line_pages
         WHERE line_id = $1`,
        [data.lineId],
      );
    },
    "checkout.sell-list.checkout-confirmed": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        confirmationId: string;
        confirmedAt: string;
        completedLineIds: string[];
        remainingLineQuantities: readonly { lineId: string; quantity: number }[];
        readinessEvidence: unknown;
        sellerEvidence: unknown;
        handoffSummary: unknown;
      };

      await db.query(
        `INSERT INTO checkout_sell_list_confirmation_pages (
           seller_account_id,
           confirmation_id,
           confirmed_at,
           readiness_evidence,
           seller_evidence,
           handoff_summary,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (seller_account_id, confirmation_id) DO UPDATE
         SET confirmed_at = EXCLUDED.confirmed_at,
             readiness_evidence = EXCLUDED.readiness_evidence,
             seller_evidence = EXCLUDED.seller_evidence,
             handoff_summary = EXCLUDED.handoff_summary,
             updated_at = EXCLUDED.updated_at`,
        [
          data.sellerAccountId,
          data.confirmationId,
          data.confirmedAt,
          JSON.stringify(data.readinessEvidence),
          JSON.stringify(data.sellerEvidence),
          JSON.stringify(data.handoffSummary),
          event.timing.recordedAt,
        ],
      );

      if (Array.isArray(data.completedLineIds) && data.completedLineIds.length > 0) {
        await db.query(
          `DELETE FROM checkout_sell_list_line_pages
           WHERE seller_account_id = $1
              AND line_id = ANY($2::text[])`,
          [data.sellerAccountId, data.completedLineIds],
        );
      }

      for (const entry of data.remainingLineQuantities) {
        await db.query(
          `UPDATE checkout_sell_list_line_pages
           SET quantity = $3,
               updated_at = $4
           WHERE seller_account_id = $1
             AND line_id = $2`,
          [data.sellerAccountId, entry.lineId, entry.quantity, event.timing.recordedAt],
        );
      }
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        sellerAccountId: string;
      };

      await db.query(
        `DELETE FROM checkout_sell_list_line_pages
         WHERE seller_account_id = $1
           AND line_type = 'selected-offer'
           AND offer_id = $2`,
        [data.sellerAccountId, data.offerId],
      );
    },
  };
}
