import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildMarketplaceOfferProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        catalogVersionKey: string;
        itemTitle: string;
        itemSubtitle: string | null;
        versionSelection: unknown;
        versionSummary: string | null;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO marketplace_offer_pages (
          offer_id,
          buyer_account_id,
          catalog_item_id,
          catalog_version_key,
          item_title,
          item_subtitle,
          version_selection,
          version_summary,
          price_amount,
          quantity_requested,
          status,
          accepted_seller_account_id,
          accepted_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', NULL, NULL, $11, $11
        )
        ON CONFLICT (offer_id) DO UPDATE SET
          buyer_account_id = EXCLUDED.buyer_account_id,
          catalog_item_id = EXCLUDED.catalog_item_id,
          catalog_version_key = EXCLUDED.catalog_version_key,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          version_selection = EXCLUDED.version_selection,
          version_summary = EXCLUDED.version_summary,
          price_amount = EXCLUDED.price_amount,
          quantity_requested = EXCLUDED.quantity_requested,
          status = EXCLUDED.status,
          accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
          accepted_at = EXCLUDED.accepted_at,
          updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.catalogVersionKey,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.versionSelection) ? data.versionSelection : []),
          data.versionSummary,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        sellerAccountId: string;
        acceptedAt: string;
      };

      await db.query(
        `UPDATE marketplace_offer_pages
         SET status = 'accepted',
             accepted_seller_account_id = $2,
             accepted_at = $3,
             updated_at = $3
         WHERE offer_id = $1`,
        [data.offerId, data.sellerAccountId, data.acceptedAt],
      );
    },
  };
}
