import type { ChaseSetsEventPayloads } from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { JsonValue } from "@chase-sets/primitives/json";
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
  shippingAllowancePercentageBps: number;
  shippingDestinationSnapshot: AddressSnapshot;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  quantityRequested: number;
  acceptanceBatchId: string | null;
  acceptanceBatchSize: number | null;
  context: EventStoreContext;
}>;

type CatalogProductMeasuresResolvedProjectionPayload = Readonly<{
  catalogItemId: string;
  products?: JsonValue;
}>;

type OrderingMarketplaceSupplyProjectionEventPayloads = Pick<
  ChaseSetsEventPayloads,
  | "marketplace.listing.created"
  | "marketplace.listing.price-updated"
  | "marketplace.listing.quantity-cap-updated"
  | "marketplace.listing.purchase-limits-updated"
  | "marketplace.listing.published"
  | "marketplace.listing.paused"
  | "marketplace.listing.withdrawn"
  | "marketplace.seller-listing-availability.disabled"
  | "marketplace.seller-listing-availability.enabled"
  | "marketplace.offer.accepted"
> &
  Readonly<{
    "catalog.catalog-item.product-measures-resolved": CatalogProductMeasuresResolvedProjectionPayload;
  }>;

export function buildOrderingMarketplaceSupplyProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onOfferAccepted?: (params: AcceptedOfferParams) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return defineProjectorHandlers<OrderingMarketplaceSupplyProjectionEventPayloads>({
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
        productMeasureSnapshot?: unknown;
        gradedCard?: unknown;
        storageLocationName: string | null;
        shipFromCode: string | null;
        shipFromAddress: unknown;
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        quantityCap: number;
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
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
           product_measure_snapshot,
           graded_card,
           storage_location_name,
           ship_from_code,
           ship_from_address,
           price_amount,
           marketplace_sales_fee_unit_amount,
           seller_net_unit_amount,
           shipping_allowance_percentage_bps,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           quantity_cap,
           max_units_per_order,
           max_units_per_day,
           max_units_per_customer_account,
           seller_listing_availability_status,
           status,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, COALESCE((SELECT status FROM ordering_seller_listing_availability_inputs WHERE account_id = $2), 'available'), 'draft', $26
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
             product_measure_snapshot = EXCLUDED.product_measure_snapshot,
             graded_card = EXCLUDED.graded_card,
             storage_location_name = EXCLUDED.storage_location_name,
             ship_from_code = EXCLUDED.ship_from_code,
             ship_from_address = EXCLUDED.ship_from_address,
             price_amount = EXCLUDED.price_amount,
             marketplace_sales_fee_unit_amount = EXCLUDED.marketplace_sales_fee_unit_amount,
             seller_net_unit_amount = EXCLUDED.seller_net_unit_amount,
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             quantity_cap = EXCLUDED.quantity_cap,
             max_units_per_order = EXCLUDED.max_units_per_order,
             max_units_per_day = EXCLUDED.max_units_per_day,
             max_units_per_customer_account = EXCLUDED.max_units_per_customer_account,
             seller_listing_availability_status = ordering_market_listing_inputs.seller_listing_availability_status,
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
          data.productMeasureSnapshot && typeof data.productMeasureSnapshot === "object"
            ? JSON.stringify(data.productMeasureSnapshot)
            : null,
          data.gradedCard && typeof data.gradedCard === "object" ? JSON.stringify(data.gradedCard) : null,
          data.storageLocationName,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress),
          data.priceAmount,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.shippingAllowancePercentageBps ?? 500,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.quantityCap,
          data.purchaseLimits?.maxUnitsPerOrder ?? null,
          data.purchaseLimits?.maxUnitsPerDay ?? null,
          data.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data;

      await db.query(
        `WITH resolved_products AS (
           SELECT measure
           FROM jsonb_array_elements($2::jsonb) AS product(measure)
         )
         UPDATE ordering_market_listing_inputs AS listing
         SET product_measure_snapshot = (
               SELECT measure
               FROM resolved_products
               WHERE measure->>'productId' = listing.product_id
               LIMIT 1
             ),
             updated_at = $3
         WHERE listing.catalog_catalog_item_id = $1`,
        [
          data.catalogItemId,
          JSON.stringify(Array.isArray(data.products) ? data.products : []),
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as {
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
      };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET price_amount = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             updated_at = $9
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.priceAmount,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.shippingAllowancePercentageBps ?? 500,
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
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
      };
      const hasPurchaseLimits = data.purchaseLimits !== undefined;

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET quantity_cap = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             max_units_per_order = CASE WHEN $9 THEN $10 ELSE max_units_per_order END,
             max_units_per_day = CASE WHEN $9 THEN $11 ELSE max_units_per_day END,
             max_units_per_customer_account = CASE WHEN $9 THEN $12 ELSE max_units_per_customer_account END,
             updated_at = $13
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.quantityCap,
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.shippingAllowancePercentageBps ?? 500,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          hasPurchaseLimits,
          data.purchaseLimits?.maxUnitsPerOrder ?? null,
          data.purchaseLimits?.maxUnitsPerDay ?? null,
          data.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.purchase-limits-updated": async (event) => {
      const data = event.data as {
        purchaseLimits: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      };

      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET max_units_per_order = $2,
             max_units_per_day = $3,
             max_units_per_customer_account = $4,
             updated_at = $5
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.purchaseLimits.maxUnitsPerOrder,
          data.purchaseLimits.maxUnitsPerDay,
          data.purchaseLimits.maxUnitsPerCustomerAccount,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.published": async (event) => {
      const data = event.data as {
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
      };
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET status = 'active',
             marketplace_sales_fee_unit_amount = $2,
             seller_net_unit_amount = $3,
             shipping_allowance_percentage_bps = $4,
             terms_schedule_id = $5,
             terms_agreement_id = $6,
             terms_resolved_at = $7,
             updated_at = $8
         WHERE listing_id = $1`,
        [
          event.streamId.replace("marketplace.listing-", ""),
          data.marketplaceSalesFeeUnitAmount,
          data.sellerNetUnitAmount,
          data.shippingAllowancePercentageBps ?? 500,
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
    "marketplace.seller-listing-availability.disabled": async (event) => {
      const data = event.data as { accountId: string };

      await db.query(
        `INSERT INTO ordering_seller_listing_availability_inputs (
           account_id,
           status,
           updated_at
         ) VALUES ($1, 'unavailable', $2)
         ON CONFLICT (account_id) DO UPDATE SET
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, event.timing.recordedAt],
      );
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET seller_listing_availability_status = 'unavailable',
             updated_at = $2
         WHERE seller_account_id = $1`,
        [data.accountId, event.timing.recordedAt],
      );
    },
    "marketplace.seller-listing-availability.enabled": async (event) => {
      const data = event.data as { accountId: string };

      await db.query(
        `INSERT INTO ordering_seller_listing_availability_inputs (
           account_id,
           status,
           updated_at
         ) VALUES ($1, 'available', $2)
         ON CONFLICT (account_id) DO UPDATE SET
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, event.timing.recordedAt],
      );
      await db.query(
        `UPDATE ordering_market_listing_inputs
         SET seller_listing_availability_status = 'available',
             updated_at = $2
         WHERE seller_account_id = $1`,
        [data.accountId, event.timing.recordedAt],
      );
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data;

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
           shipping_allowance_percentage_bps,
           terms_schedule_id,
           terms_agreement_id,
           terms_resolved_at,
           quantity_requested,
           shipping_destination_snapshot,
           accepted_at,
           acceptance_batch_id,
           acceptance_batch_size,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
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
             shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
             terms_schedule_id = EXCLUDED.terms_schedule_id,
             terms_agreement_id = EXCLUDED.terms_agreement_id,
             terms_resolved_at = EXCLUDED.terms_resolved_at,
             quantity_requested = EXCLUDED.quantity_requested,
             shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
             accepted_at = EXCLUDED.accepted_at,
             acceptance_batch_id = EXCLUDED.acceptance_batch_id,
             acceptance_batch_size = EXCLUDED.acceptance_batch_size,
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
          data.shippingAllowancePercentageBps ?? 500,
          data.termsScheduleId,
          data.termsAgreementId,
          data.termsResolvedAt,
          data.quantityRequested,
          JSON.stringify(data.shippingDestinationSnapshot),
          data.acceptedAt,
          data.acceptanceBatchId ?? null,
          data.acceptanceBatchSize ?? null,
          event.timing.recordedAt,
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
  });
}

async function markOrderingInventoryHoldTerminal(
  db: PgQueryable,
  params: Readonly<{
    holdId: string;
    status: "released" | "expired";
    releasedAt: string;
    recordedAt: string;
    streamVersion: number;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE ordering_inventory_hold_inputs
     SET status = $2,
         released_at = $3,
         updated_at = $4,
         last_stream_version = $5
     WHERE hold_id = $1
       AND last_stream_version < $5`,
    [params.holdId, params.status, params.releasedAt, params.recordedAt, params.streamVersion],
  );
}

export function buildOrderingInventorySupplyProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        [data.holdId, data.itemId, data.accountId, data.quantity, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.converted": async (event) => {
      const data = event.data as {
        holdId: string;
      };

      await db.query(
        `UPDATE ordering_inventory_hold_inputs
         SET updated_at = $2,
             last_stream_version = $3
         WHERE hold_id = $1
           AND last_stream_version < $3`,
        [data.holdId, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.extended": async (event) => {
      const data = event.data as {
        holdId: string;
      };

      await db.query(
        `UPDATE ordering_inventory_hold_inputs
         SET updated_at = $2,
             last_stream_version = $3
         WHERE hold_id = $1
           AND last_stream_version < $3`,
        [data.holdId, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
      };

      await markOrderingInventoryHoldTerminal(db, {
        holdId: data.holdId,
        status: "released",
        releasedAt: data.releasedAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
    },
    "inventory.hold.expired": async (event) => {
      const data = event.data as {
        holdId: string;
        expiredAt: string;
      };

      await markOrderingInventoryHoldTerminal(db, {
        holdId: data.holdId,
        status: "expired",
        releasedAt: data.expiredAt,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
    },
  };
}
