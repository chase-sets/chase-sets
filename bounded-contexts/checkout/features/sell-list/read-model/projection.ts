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
        listingId: string | null;
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

      const values = [
        data.sellerAccountId,
        data.lineId,
        data.lineType === "selected-offer" ? "selected-offer" : "product",
        data.offerId,
        data.listingId,
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
      ];
      const conflictTarget = data.offerId
        ? "(seller_account_id, offer_id) WHERE offer_id IS NOT NULL"
        : "(seller_account_id, line_id)";

      if (data.offerId) {
        await db.query(
          `DELETE FROM checkout_sell_list_line_pages
           WHERE seller_account_id = $1
             AND (line_id = $2 OR offer_id = $3)
             AND NOT (line_id = $2 AND offer_id = $3)`,
          [data.sellerAccountId, data.lineId, data.offerId],
        );
      }

      await db.query(
        `INSERT INTO checkout_sell_list_line_pages (
           seller_account_id,
           line_id,
           line_type,
           offer_id,
           listing_id,
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
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
         ON CONFLICT ${conflictTarget} DO UPDATE
         SET line_id = EXCLUDED.line_id,
             line_type = EXCLUDED.line_type,
             offer_id = EXCLUDED.offer_id,
             listing_id = EXCLUDED.listing_id,
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
        values,
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
        buyerAccountId?: string;
        catalogItemId?: string;
        productId?: string;
        itemTitle?: string;
        itemSubtitle?: string | null;
        selectedOptions?: unknown;
        productSummary?: string | null;
        priceAmount?: string;
        quantityRequested?: number;
        acceptedAt?: string;
      };

      if (data.buyerAccountId && data.catalogItemId && data.productId && data.itemTitle && data.priceAmount) {
        await db.query(
          `INSERT INTO checkout_sell_offer_pages (
             offer_id,
             buyer_account_id,
             catalog_catalog_item_id,
             product_id,
             item_title,
             item_subtitle,
             selected_options,
             product_summary,
             price_amount,
             quantity_requested,
             status,
             accepted_seller_account_id,
             accepted_at,
             created_at,
             updated_at,
             last_stream_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'accepted', $11, $12, $13, $13, $14)
           ON CONFLICT (offer_id) DO UPDATE SET
             buyer_account_id = EXCLUDED.buyer_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             selected_options = EXCLUDED.selected_options,
             product_summary = EXCLUDED.product_summary,
             price_amount = EXCLUDED.price_amount,
             quantity_requested = EXCLUDED.quantity_requested,
             status = EXCLUDED.status,
             accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
           WHERE checkout_sell_offer_pages.last_stream_version < EXCLUDED.last_stream_version`,
          [
            data.offerId,
            data.buyerAccountId,
            data.catalogItemId,
            data.productId,
            data.itemTitle,
            data.itemSubtitle ?? null,
            JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
            data.productSummary ?? null,
            data.priceAmount,
            data.quantityRequested ?? 1,
            data.sellerAccountId,
            data.acceptedAt ?? event.timing.recordedAt,
            event.timing.recordedAt,
            event.streamVersion,
          ],
        );
      } else {
        await db.query(
          `UPDATE checkout_sell_offer_pages
           SET status = 'accepted',
               accepted_seller_account_id = $2,
               accepted_at = $3,
               updated_at = $3,
               last_stream_version = $4
           WHERE offer_id = $1
             AND last_stream_version < $4`,
          [data.offerId, data.sellerAccountId, data.acceptedAt ?? event.timing.recordedAt, event.streamVersion],
        );
      }

      await db.query(
        `DELETE FROM checkout_sell_list_line_pages
         WHERE seller_account_id = $1
           AND line_type = 'selected-offer'
           AND offer_id = $2`,
        [data.sellerAccountId, data.offerId],
      );
    },
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle?: string | null;
        selectedOptions?: unknown;
        productSummary?: string | null;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO checkout_sell_offer_pages (
           offer_id,
           buyer_account_id,
           catalog_catalog_item_id,
           product_id,
           item_title,
           item_subtitle,
           selected_options,
           product_summary,
           price_amount,
           quantity_requested,
           status,
           accepted_seller_account_id,
           accepted_at,
           created_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', NULL, NULL, $11, $11, $12)
         ON CONFLICT (offer_id) DO UPDATE SET
           buyer_account_id = EXCLUDED.buyer_account_id,
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           product_id = EXCLUDED.product_id,
           item_title = EXCLUDED.item_title,
           item_subtitle = EXCLUDED.item_subtitle,
           selected_options = EXCLUDED.selected_options,
           product_summary = EXCLUDED.product_summary,
           price_amount = EXCLUDED.price_amount,
           quantity_requested = EXCLUDED.quantity_requested,
           status = EXCLUDED.status,
           accepted_seller_account_id = NULL,
           accepted_at = NULL,
           updated_at = EXCLUDED.updated_at,
           last_stream_version = EXCLUDED.last_stream_version
         WHERE checkout_sell_offer_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle ?? null,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary ?? null,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "settlement.payout-readiness.recorded": async (event) => {
      const data = event.data as {
        accountId: string;
        status: string;
        missingRequirements?: unknown;
        recordedAt?: string;
      };

      await db.query(
        `INSERT INTO checkout_sell_payout_readiness_pages (
           account_id,
           status,
           missing_requirements,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE
         SET status = EXCLUDED.status,
             missing_requirements = EXCLUDED.missing_requirements,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE checkout_sell_payout_readiness_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.accountId,
          data.status,
          JSON.stringify(Array.isArray(data.missingRequirements) ? data.missingRequirements : []),
          data.recordedAt ?? event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
