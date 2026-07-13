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
    item_language_code: string | null;
    item_title: string | null;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    product_measure_snapshot: unknown;
    graded_card: unknown;
    storage_location_name: string | null;
    ship_from_code: string | null;
    ship_from_address: unknown;
    price_amount: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    shipping_allowance_percentage_bps: number;
    terms_schedule_id: string | null;
    terms_agreement_id: string | null;
    terms_resolved_at: string | null;
    fee_quote_fingerprint: string;
    fee_locks: unknown;
    quantity_cap: number;
    max_units_per_order: number | null;
    max_units_per_day: number | null;
    max_units_per_customer_account: number | null;
    listing_photos: unknown;
    status: string;
    created_at: string;
    updated_at: string;
  }>("SELECT * FROM marketplace_listing_pages WHERE listing_id = $1", [listingId]);
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
        product_measure_snapshot:
          typeof row.product_measure_snapshot === "object" && row.product_measure_snapshot !== null
            ? row.product_measure_snapshot
            : null,
        graded_card: typeof row.graded_card === "object" && row.graded_card !== null ? row.graded_card : null,
        listing_photos: Array.isArray(row.listing_photos) ? row.listing_photos : [],
        fee_locks: Array.isArray(row.fee_locks) ? row.fee_locks : [],
      }
    : null;
}

async function emitListingPatch(db: PgQueryable, event: Parameters<ProjectorHandlerMap[string]>[0], listingId: string) {
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

function assertUpdatedListingRow(
  result: Awaited<ReturnType<PgQueryable["query"]>>,
  eventType: string,
  listingId: string,
) {
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`Cannot project ${eventType} for missing marketplace listing ${listingId}.`);
  }
}

/**
 * Read-modify-write for the `listing_photos` JSONB array. The typed Listing
 * Evidence lifecycle events carry deltas rather than the full array, so
 * the projector rehydrates the current array, applies the delta, and writes it
 * back. Safe because the projector applies a stream's events sequentially in
 * order.
 */
async function transformListingPhotos(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  listingId: string,
  transform: (photos: Array<Record<string, unknown>>) => Array<Record<string, unknown>>,
) {
  const current = await db.query<{ listing_photos: unknown }>(
    "SELECT listing_photos FROM marketplace_listing_pages WHERE listing_id = $1",
    [listingId],
  );
  if (current.rows.length === 0) {
    throw new Error(`Cannot project ${event.type} for missing marketplace listing ${listingId}.`);
  }
  const photos = Array.isArray(current.rows[0]!.listing_photos)
    ? (current.rows[0]!.listing_photos as Array<Record<string, unknown>>)
    : [];
  const next = transform(photos);
  await db.query(
    `UPDATE marketplace_listing_pages
     SET listing_photos = $2,
         updated_at = $3
     WHERE listing_id = $1`,
    [listingId, JSON.stringify(next), event.timing.recordedAt],
  );
  await emitListingPatch(db, event, listingId);
}

export function buildMarketplaceListingProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        itemLanguageCode?: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        productMeasureSnapshot?: unknown;
        gradedCard: unknown;
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
        feeQuoteFingerprint: string;
        feeLocks: unknown;
        quantityCap: number;
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
        listingPhotos?: unknown;
      };

      await db.query(
        `INSERT INTO marketplace_listing_pages (
          listing_id,
          account_id,
          inventory_item_id,
          catalog_catalog_item_id,
          product_id,
          item_language_code,
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
          fee_quote_fingerprint,
          fee_locks,
          quantity_cap,
          max_units_per_order,
          max_units_per_day,
          max_units_per_customer_account,
          listing_photos,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, 'draft', $30, $30
        )
        ON CONFLICT (listing_id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          inventory_item_id = EXCLUDED.inventory_item_id,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_language_code = EXCLUDED.item_language_code,
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
          fee_quote_fingerprint = EXCLUDED.fee_quote_fingerprint,
          fee_locks = EXCLUDED.fee_locks,
          quantity_cap = EXCLUDED.quantity_cap,
          max_units_per_order = EXCLUDED.max_units_per_order,
          max_units_per_day = EXCLUDED.max_units_per_day,
          max_units_per_customer_account = EXCLUDED.max_units_per_customer_account,
          listing_photos = EXCLUDED.listing_photos,
          updated_at = EXCLUDED.updated_at`,
        [
          data.listingId,
          data.accountId,
          data.inventoryItemId,
          data.catalogItemId,
          data.productId,
          data.itemLanguageCode ?? null,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.productMeasureSnapshot && typeof data.productMeasureSnapshot === "object"
            ? JSON.stringify(data.productMeasureSnapshot)
            : null,
          data.gradedCard === null || typeof data.gradedCard !== "object" ? null : JSON.stringify(data.gradedCard),
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
          data.feeQuoteFingerprint,
          JSON.stringify(Array.isArray(data.feeLocks) ? data.feeLocks : []),
          data.quantityCap,
          data.purchaseLimits?.maxUnitsPerOrder ?? null,
          data.purchaseLimits?.maxUnitsPerDay ?? null,
          data.purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          JSON.stringify(Array.isArray(data.listingPhotos) ? data.listingPhotos : []),
          event.timing.recordedAt,
        ],
      );
      await emitListingPatch(db, event, data.listingId);
    },
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data as {
        catalogItemId: string;
        products?: unknown;
      };

      const updated = await db.query<{ listing_id: string }>(
        `WITH resolved_products AS (
           SELECT measure
           FROM jsonb_array_elements($2::jsonb) AS product(measure)
         )
         UPDATE marketplace_listing_pages AS listing
         SET product_measure_snapshot = (
               SELECT measure
               FROM resolved_products
               WHERE measure->>'productId' = listing.product_id
               LIMIT 1
             ),
             updated_at = $3
         WHERE listing.catalog_catalog_item_id = $1
         RETURNING listing.listing_id`,
        [
          data.catalogItemId,
          JSON.stringify(Array.isArray(data.products) ? data.products : []),
          event.timing.recordedAt,
        ],
      );

      for (const row of updated.rows) {
        await emitListingPatch(db, event, row.listing_id);
      }
    },
    "marketplace.listing.photos-added": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { listingPhotos } = event.data as { listingPhotos: unknown };

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET listing_photos = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, JSON.stringify(Array.isArray(listingPhotos) ? listingPhotos : []), event.timing.recordedAt],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.photo-classified": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = event.data as {
        photoId: string;
        slotId: string | null;
        viewKind: string | null;
        altText: string | null;
        capturedAt: string | null;
      };
      await transformListingPhotos(db, event, listingId, (photos) =>
        photos.map((photo) =>
          photo.photoId === data.photoId
            ? {
                ...photo,
                slotId: data.slotId,
                viewKind: data.viewKind,
                altText: data.altText,
                capturedAt: data.capturedAt,
              }
            : photo,
        ),
      );
    },
    "marketplace.listing.photo-replaced": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = event.data as {
        replacedPhotoId: string;
        photo: Record<string, unknown>;
      };
      await transformListingPhotos(db, event, listingId, (photos) => [
        ...photos.map((photo) => (photo.photoId === data.replacedPhotoId ? { ...photo, status: "replaced" } : photo)),
        data.photo,
      ]);
    },
    "marketplace.listing.photo-removed": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = event.data as { photoId: string };
      await transformListingPhotos(db, event, listingId, (photos) =>
        photos.map((photo) => (photo.photoId === data.photoId ? { ...photo, status: "removed" } : photo)),
      );
    },
    "marketplace.listing.photos-reordered": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const data = event.data as { orderedPhotoIds: string[] };
      const orderIndex = new Map(data.orderedPhotoIds.map((id, index) => [id, index]));
      await transformListingPhotos(db, event, listingId, (photos) =>
        photos.map((photo) =>
          orderIndex.has(String(photo.photoId))
            ? { ...photo, sortOrder: orderIndex.get(String(photo.photoId)) }
            : photo,
        ),
      );
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
        feeLocks,
      } = event.data as {
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string | null;
        feeQuoteFingerprint: string;
        feeLocks: unknown;
      };

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET price_amount = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             fee_quote_fingerprint = $9,
              fee_locks = $10,
              updated_at = $11
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
          JSON.stringify(Array.isArray(feeLocks) ? feeLocks : []),
          event.timing.recordedAt,
        ],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const {
        quantityCap,
        purchaseLimits,
        marketplaceSalesFeeUnitAmount,
        sellerNetUnitAmount,
        shippingAllowancePercentageBps,
        termsScheduleId,
        termsAgreementId,
        termsResolvedAt,
        feeQuoteFingerprint,
        feeLocks,
      } = event.data as {
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
        feeQuoteFingerprint: string;
        feeLocks: unknown;
      };
      const hasPurchaseLimits = purchaseLimits !== undefined;

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET quantity_cap = $2,
             marketplace_sales_fee_unit_amount = $3,
             seller_net_unit_amount = $4,
             shipping_allowance_percentage_bps = $5,
             terms_schedule_id = $6,
             terms_agreement_id = $7,
             terms_resolved_at = $8,
             fee_quote_fingerprint = $9,
              fee_locks = $10,
              max_units_per_order = CASE WHEN $11 THEN $12 ELSE max_units_per_order END,
              max_units_per_day = CASE WHEN $11 THEN $13 ELSE max_units_per_day END,
              max_units_per_customer_account = CASE WHEN $11 THEN $14 ELSE max_units_per_customer_account END,
              updated_at = $15
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
          JSON.stringify(Array.isArray(feeLocks) ? feeLocks : []),
          hasPurchaseLimits,
          purchaseLimits?.maxUnitsPerOrder ?? null,
          purchaseLimits?.maxUnitsPerDay ?? null,
          purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
        ],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.purchase-limits-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { purchaseLimits } = event.data as {
        purchaseLimits: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      };

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET max_units_per_order = $2,
             max_units_per_day = $3,
             max_units_per_customer_account = $4,
             updated_at = $5
         WHERE listing_id = $1`,
        [
          listingId,
          purchaseLimits.maxUnitsPerOrder,
          purchaseLimits.maxUnitsPerDay,
          purchaseLimits.maxUnitsPerCustomerAccount,
          event.timing.recordedAt,
        ],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.published": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'active',
              updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.paused": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.auto-unlisted": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.withdrawn": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [listingId, event.timing.recordedAt],
      );
      assertUpdatedListingRow(result, event.type, listingId);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.seller-listing-availability.disabled": async (event) => {
      const data = event.data as {
        accountId: string;
        reasonCategory: string | null;
        availableAgainOn: string | null;
        // Additive: absent on events recorded before the authoritative
        // resume instant existed. Those rows project `available_again_at`
        // as NULL, matching the replay-safe legacy ruling.
        availableAgainAt?: string | null;
        disabledAt: string;
      };

      // A disable (manual or scheduled) consumes any pending Away Window --
      // the columns are cleared here unconditionally, mirroring the
      // aggregate evolver.
      await db.query(
        `INSERT INTO marketplace_seller_listing_availability_pages (
           account_id,
           status,
           disabled_reason_category,
           available_again_on,
           available_again_at,
           disabled_at,
           enabled_at,
           away_window_starts_at,
           away_window_ends_at,
           away_window_reason_category,
           updated_at
         ) VALUES ($1, 'unavailable', $2, $3, $4, $5, NULL, NULL, NULL, NULL, $6)
         ON CONFLICT (account_id) DO UPDATE SET
           status = EXCLUDED.status,
           disabled_reason_category = EXCLUDED.disabled_reason_category,
           available_again_on = EXCLUDED.available_again_on,
           available_again_at = EXCLUDED.available_again_at,
           disabled_at = EXCLUDED.disabled_at,
           enabled_at = EXCLUDED.enabled_at,
           away_window_starts_at = EXCLUDED.away_window_starts_at,
           away_window_ends_at = EXCLUDED.away_window_ends_at,
           away_window_reason_category = EXCLUDED.away_window_reason_category,
           updated_at = EXCLUDED.updated_at`,
        [
          data.accountId,
          data.reasonCategory,
          data.availableAgainOn,
          data.availableAgainAt ?? null,
          data.disabledAt,
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.seller-listing-availability.enabled": async (event) => {
      const data = event.data as {
        accountId: string;
        enabledAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_seller_listing_availability_pages (
           account_id,
           status,
           disabled_reason_category,
           available_again_on,
           available_again_at,
           disabled_at,
           enabled_at,
           updated_at
         ) VALUES ($1, 'available', NULL, NULL, NULL, NULL, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           status = EXCLUDED.status,
           disabled_reason_category = EXCLUDED.disabled_reason_category,
           available_again_on = EXCLUDED.available_again_on,
           available_again_at = EXCLUDED.available_again_at,
           enabled_at = EXCLUDED.enabled_at,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.enabledAt, event.timing.recordedAt],
      );
    },
    "marketplace.seller-order-capacity.set": async (event) => {
      const data = event.data as {
        accountId: string;
        maxOpenOrders: number;
      };

      await db.query(
        `INSERT INTO marketplace_seller_order_capacity_pages (
           account_id,
           max_open_orders,
           updated_at
         ) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           max_open_orders = EXCLUDED.max_open_orders,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.maxOpenOrders, event.timing.recordedAt],
      );
    },
    "marketplace.seller-order-capacity.cleared": async (event) => {
      const data = event.data as {
        accountId: string;
      };

      await db.query(
        `INSERT INTO marketplace_seller_order_capacity_pages (
           account_id,
           max_open_orders,
           updated_at
         ) VALUES ($1, NULL, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           max_open_orders = EXCLUDED.max_open_orders,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, event.timing.recordedAt],
      );
    },
    "marketplace.seller-listing-availability.away-window-scheduled": async (event) => {
      const data = event.data as {
        accountId: string;
        startsAt: string;
        endsAt: string | null;
        reasonCategory: string;
      };

      await db.query(
        `INSERT INTO marketplace_seller_listing_availability_pages (
           account_id,
           away_window_starts_at,
           away_window_ends_at,
           away_window_reason_category,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id) DO UPDATE SET
           away_window_starts_at = EXCLUDED.away_window_starts_at,
           away_window_ends_at = EXCLUDED.away_window_ends_at,
           away_window_reason_category = EXCLUDED.away_window_reason_category,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.startsAt, data.endsAt, data.reasonCategory, event.timing.recordedAt],
      );
    },
    "marketplace.seller-listing-availability.away-window-cancelled": async (event) => {
      const data = event.data as {
        accountId: string;
        cancelledAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_seller_listing_availability_pages (
           account_id,
           away_window_starts_at,
           away_window_ends_at,
           away_window_reason_category,
           updated_at
         ) VALUES ($1, NULL, NULL, NULL, $2)
         ON CONFLICT (account_id) DO UPDATE SET
           away_window_starts_at = EXCLUDED.away_window_starts_at,
           away_window_ends_at = EXCLUDED.away_window_ends_at,
           away_window_reason_category = EXCLUDED.away_window_reason_category,
           updated_at = EXCLUDED.updated_at`,
        [data.accountId, event.timing.recordedAt],
      );
    },
  };
}
