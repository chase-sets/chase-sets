import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type AcceptedOfferParams = Readonly<{
  offerId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  quantityRequested: number;
  context: EventStoreContext;
}>;

export function buildOrderingMarketplaceSupplyProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onOfferAccepted?: (params: AcceptedOfferParams) => Promise<void>;
  }> = {},
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
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string;
        quantityCap: number;
      };

      await db.query(
        `INSERT INTO ordering_market_listing_inputs (
           listing_id,
           seller_account_id,
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
           marketplace_sales_fee_unit_amount,
           seller_net_unit_amount,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           quantity_cap,
           status,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, 'draft', $19
         )
         ON CONFLICT (listing_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
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
             marketplace_sales_fee_unit_amount = EXCLUDED.marketplace_sales_fee_unit_amount,
             seller_net_unit_amount = EXCLUDED.seller_net_unit_amount,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             quantity_cap = EXCLUDED.quantity_cap,
             status = EXCLUDED.status,
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
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.quantityCap,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as {
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string;
      };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET price_amount = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             terms_schedule_id = $5,
             terms_agreement_id = $6,
             terms_resolved_at = $7,
             updated_at = $8
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.priceAmount,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const data = event.data as {
        quantityCap: number;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string;
      };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET quantity_cap = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             terms_schedule_id = $5,
             terms_agreement_id = $6,
             terms_resolved_at = $7,
             updated_at = $8
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.quantityCap,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      const data = event.data as {
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string;
      };
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'active',
             marketplace_sales_fee_unit_amount = $2,
             seller_net_unit_amount = $3,
             terms_schedule_id = $4,
             terms_agreement_id = $5,
             terms_resolved_at = $6,
             updated_at = $7
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [event.streamId.replace("marketplace.listing-", ""), event.timing.recordedAt],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as unknown as Omit<AcceptedOfferParams, "context"> & Readonly<{
        acceptedAt: string;
      }>;

      await db.query(
        `INSERT INTO ordering_offer_acceptance_inputs (
           offer_id,
           buyer_account_id,
           seller_account_id,
           catalog_catalog_item_id,
           product_id,
           item_title,
           item_subtitle,
           selected_options,
           product_summary,
           price_amount,
           marketplace_sales_fee_unit_amount,
           seller_net_unit_amount,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           quantity_requested,
           accepted_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17
         )
         ON CONFLICT (offer_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             item_title = EXCLUDED.item_title,
             item_subtitle = EXCLUDED.item_subtitle,
             selected_options = EXCLUDED.selected_options,
             product_summary = EXCLUDED.product_summary,
             price_amount = EXCLUDED.price_amount,
             marketplace_sales_fee_unit_amount = EXCLUDED.marketplace_sales_fee_unit_amount,
             seller_net_unit_amount = EXCLUDED.seller_net_unit_amount,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             quantity_requested = EXCLUDED.quantity_requested,
             accepted_at = EXCLUDED.accepted_at,
             updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.priceAmount,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.quantityRequested,
          data.acceptedAt,
        ],
      );

      await options.onOfferAccepted?.({
        ...data,
        context: {
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        } as EventStoreContext,
      });
    },
  };
}

export function buildOrderingInventorySupplyProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        totalQuantity: number;
      };

      await db.query(
        `INSERT INTO ordering_inventory_item_inputs (
           item_id,
           seller_account_id,
           catalog_catalog_item_id,
           product_id,
           total_quantity,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (item_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             product_id = EXCLUDED.product_id,
             total_quantity = EXCLUDED.total_quantity,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE ordering_inventory_item_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.itemId,
          data.accountId,
          data.catalogItemId,
          data.productId,
          data.totalQuantity,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE ordering_inventory_item_inputs
         SET total_quantity = GREATEST(total_quantity + $2, 0),
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
      };

      await db.query(
        `INSERT INTO ordering_inventory_hold_inputs (
           hold_id,
           item_id,
           seller_account_id,
           quantity,
           status,
           released_at,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, 'active', NULL, $5, $6)
         ON CONFLICT (hold_id) DO UPDATE
         SET item_id = EXCLUDED.item_id,
             seller_account_id = EXCLUDED.seller_account_id,
             quantity = EXCLUDED.quantity,
             status = EXCLUDED.status,
             released_at = EXCLUDED.released_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE ordering_inventory_hold_inputs.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.holdId,
          data.itemId,
          data.accountId,
          data.quantity,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE ordering_inventory_hold_inputs
         SET status = 'released',
             released_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4`,
        [data.holdId, data.releasedAt, event.timing.recordedAt, event.streamVersion],
      );
    },
  };
}
