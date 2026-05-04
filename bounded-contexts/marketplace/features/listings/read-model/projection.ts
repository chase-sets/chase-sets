import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { createMarketplaceListingPatch } from "../../../support/realtime-support/projection-patches";
import { marketplaceRealtimeTopics } from "../../../support/realtime-support/topics";

async function loadRealtimeListing(db: PgQueryable, listingId: string) {
  const result = await db.query<{
    listing_id: string;
    account_id: string;
    inventory_item_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    graded_card: unknown;
    storage_location_name: string | null;
    ship_from_code: string | null;
    price_amount: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    shipping_allowance_percentage_bps: number;
    terms_schedule_id: string | null;
    terms_agreement_id: string | null;
    terms_resolved_at: string | null;
    fee_quote_fingerprint: string;
    quantity_cap: number;
    status: string;
    created_at: string;
    updated_at: string;
  }>("SELECT * FROM marketplace_listing_pages WHERE listing_id = $1", [listingId]);
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
        graded_card:
          typeof row.graded_card === "object" && row.graded_card !== null
            ? row.graded_card
            : null,
      }
    : null;
}

async function emitListingPatch(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  listingId: string,
) {
  const listing = await loadRealtimeListing(db, listingId);
  if (!listing) {
    return;
  }

  const topics = [marketplaceRealtimeTopics.accountListings(listing.account_id)];

  await recordRealtimeProjectionPatch(db, {
    sourceGlobalPosition: event.globalPosition,
    projectionName: "marketplace-listing-projection",
    patchKey: `listing:${listingId}`,
    topics,
    recordedAt: event.timing.recordedAt,
    patch: createMarketplaceListingPatch(topics, listing),
  });
}

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
        gradedCard: unknown;
        storageLocationName: string | null;
        shipFromCode: string | null;
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
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
          graded_card,
          storage_location_name,
          ship_from_code,
          price_amount,
          marketplace_sales_fee_unit_amount,
          seller_net_unit_amount,
          shipping_allowance_percentage_bps,
          terms_schedule_id,
          terms_agreement_id,
          terms_resolved_at,
          fee_quote_fingerprint,
          quantity_cap,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'draft', $22, $22
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
          graded_card = EXCLUDED.graded_card,
          storage_location_name = EXCLUDED.storage_location_name,
          ship_from_code = EXCLUDED.ship_from_code,
          price_amount = EXCLUDED.price_amount,
          marketplace_sales_fee_unit_amount = EXCLUDED.marketplace_sales_fee_unit_amount,
          seller_net_unit_amount = EXCLUDED.seller_net_unit_amount,
          shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
          terms_schedule_id = EXCLUDED.terms_schedule_id,
          terms_agreement_id = EXCLUDED.terms_agreement_id,
          terms_resolved_at = EXCLUDED.terms_resolved_at,
          fee_quote_fingerprint = EXCLUDED.fee_quote_fingerprint,
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
          data.gradedCard === null || typeof data.gradedCard !== "object"
            ? null
            : JSON.stringify(data.gradedCard),
          data.storageLocationName,
          data.shipFromCode,
          data.priceAmount,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.shippingAllowancePercentageBps ?? 500,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.feeQuoteFingerprint,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, data.listingId);
    },
    "marketplace.listing.price-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const {
        priceAmount,
        marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount,
        shippingAllowancePercentageBps,
        termsScheduleId,
        termsAgreementId,
        termsResolvedAt,
        feeQuoteFingerprint,
      } = event.data as {
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
      };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET price_amount = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             fee_quote_fingerprint = $9,
             updated_at = $10
         WHERE listing_id = $1`,
        [
          listingId,
          priceAmount,
          marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount,
          shippingAllowancePercentageBps ?? 500,
          termsScheduleId,
          termsAgreementId,
          termsResolvedAt,
          feeQuoteFingerprint,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const {
        quantityCap,
        marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount,
        shippingAllowancePercentageBps,
        termsScheduleId,
        termsAgreementId,
        termsResolvedAt,
        feeQuoteFingerprint,
      } = event.data as {
        quantityCap: number;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
      };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET quantity_cap = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             fee_quote_fingerprint = $9,
             updated_at = $10
         WHERE listing_id = $1`,
        [
          listingId,
          quantityCap,
          marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount,
          shippingAllowancePercentageBps ?? 500,
          termsScheduleId,
          termsAgreementId,
          termsResolvedAt,
          feeQuoteFingerprint,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.published": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const {
        marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount,
        shippingAllowancePercentageBps,
        termsScheduleId,
        termsAgreementId,
        termsResolvedAt,
        feeQuoteFingerprint,
      } = event.data as {
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
      };

      await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'active',
             marketplace_sales_fee_unit_amount = $2,
             seller_net_unit_amount = $3,
             shipping_allowance_percentage_bps = $4,
             terms_schedule_id = $5,
             terms_agreement_id = $6,
             terms_resolved_at = $7,
             fee_quote_fingerprint = $8,
             updated_at = $9
         WHERE listing_id = $1`,
        [
          listingId,
          marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount,
          shippingAllowancePercentageBps ?? 500,
          termsScheduleId,
          termsAgreementId,
          termsResolvedAt,
          feeQuoteFingerprint,
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, listingId);
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
      await emitListingPatch(db, event, listingId);
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
      await emitListingPatch(db, event, listingId);
    },
  };
}
