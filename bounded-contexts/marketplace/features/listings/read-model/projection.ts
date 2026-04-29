import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildMarketplaceListingProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        inventoryItemId: string;
        catalogItemId: string;
        productId: string;
        itemTitle: string | null;
        itemSubtitle: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        storageLocationName: string | null;
        shipFromCode: string | null;
        priceAmount: string;
        marketplaceFeeAmount: string | null;
        paymentFeeAmount: string | null;
        sellerNetAmount: string | null;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO marketplace_listing_pages (
          listing_id,
          account_id,
          inventory_item_id,
          catalog_catalog_item_id,
          product_id,
          item_title,
          item_subtitle,
          selected_options,
          product_summary,
          storage_location_name,
          ship_from_code,
          price_amount,
          marketplace_fee_amount,
          payment_fee_amount,
          seller_net_amount,
          terms_schedule_id,
          terms_agreement_id,
          terms_resolved_at,
          quantity_cap,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'draft', $20, $20
        )
        ON CONFLICT (listing_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          inventory_item_id = EXCLUDED.inventory_item_id,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
          storage_location_name = EXCLUDED.storage_location_name,
          ship_from_code = EXCLUDED.ship_from_code,
          price_amount = EXCLUDED.price_amount,
          marketplace_fee_amount = EXCLUDED.marketplace_fee_amount,
          payment_fee_amount = EXCLUDED.payment_fee_amount,
          seller_net_amount = EXCLUDED.seller_net_amount,
          terms_schedule_id = EXCLUDED.terms_schedule_id,
          terms_agreement_id = EXCLUDED.terms_agreement_id,
          terms_resolved_at = EXCLUDED.terms_resolved_at,
          quantity_cap = EXCLUDED.quantity_cap,
          updated_at = EXCLUDED.updated_at`,
        [
          data.listingId,
          data.accountId,
          data.inventoryItemId,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.storageLocationName,
          data.shipFromCode,
          data.priceAmount,
          data.marketplaceFeeAmount,
          data.paymentFeeAmount,
          data.sellerNetAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const {
        priceAmount,
        marketplaceFeeAmount,
        paymentFeeAmount,
        sellerNetAmount,
        termsScheduleId,
        termsAgreementId,
        termsResolvedAt,
      } = event.data as {
        priceAmount: string;
        marketplaceFeeAmount: string | null;
        paymentFeeAmount: string | null;
        sellerNetAmount: string | null;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
      };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET price_amount = $2,
             marketplace_fee_amount = $3,
             payment_fee_amount = $4,
             seller_net_amount = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             updated_at = $9
         WHERE listing_id = $1`,
        [
          listingId,
          priceAmount,
          marketplaceFeeAmount,
          paymentFeeAmount,
          sellerNetAmount,
          termsScheduleId,
          termsAgreementId,
          termsResolvedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { quantityCap } = event.data as { quantityCap: number };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, quantityCap, event.timing.recordedAt],
      );
    },
    "marketplace.listing.published": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'active',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
    "marketplace.listing.paused": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
    },
  };
}
