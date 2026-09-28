import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch } from "@chase-sets/platform-runtime/realtime";
import { createMarketplaceListingPatch } from "../../../support/realtime-support/projection-patches";
import { marketplaceRealtimeTopics } from "../../../support/realtime-support/topics";
import { buildMarketplaceListingTargetProjectionHandlers } from "./target-projection";
import { marketplaceListingCodec } from "../domain/codec";
import type { MarketplaceListingFeeLockPayload } from "@chase-sets/event-core/public-event-payloads";

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
    price_currency_code: string | null;
    listing_stream_version: number | null;
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
    evidence_requirements: unknown;
    evidence: unknown;
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
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
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
 * Read-modify-write for the `evidence` JSONB array. The typed Listing
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
  const current = await db.query<{ evidence: unknown }>(
    "SELECT evidence FROM marketplace_listing_pages WHERE listing_id = $1",
    [listingId],
  );
  if (current.rows.length === 0) {
    throw new Error(`Cannot project ${event.type} for missing marketplace listing ${listingId}.`);
  }
  const photos = Array.isArray(current.rows[0]!.evidence)
    ? (current.rows[0]!.evidence as Array<Record<string, unknown>>)
    : [];
  const next = transform(photos);
  await db.query(
    `UPDATE marketplace_listing_pages
     SET evidence = $2,
         updated_at = $3
     WHERE listing_id = $1`,
    [listingId, JSON.stringify(next), event.timing.recordedAt],
  );
  await emitListingPatch(db, event, listingId);
}

export function buildMarketplaceListingProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const listing = buildListingProjectionHandlers(db);
  const targets = buildMarketplaceListingTargetProjectionHandlers(db);
  return Object.fromEntries(
    [...new Set([...Object.keys(listing), ...Object.keys(targets)])].map((type) => {
      const handler: ProjectorHandlerMap[string] = async (event) => {
        if (event.type.startsWith("marketplace.listing.")) {
          marketplaceListingCodec.decode({ eventType: event.type, payload: event.data });
        }
        await targets[type]?.(event);
        await listing[type]?.(event);
      };
      return [type, handler];
    }),
  );
}

function buildListingProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  async function assertPresent(
    result: Awaited<ReturnType<PgQueryable["query"]>>,
    event: Parameters<ProjectorHandlerMap[string]>[0],
  ) {
    const listingId = event.streamId.slice("marketplace.listing-".length);
    if ((result.rowCount ?? 0) === 0 && !(await loadRealtimeListing(db, listingId))) {
      throw new Error(`Cannot project ${event.type} for missing marketplace listing ${listingId}.`);
    }
  }
  async function projectRequirements(event: Parameters<ProjectorHandlerMap[string]>[0]) {
    const listingId = event.streamId.slice("marketplace.listing-".length);
    const result = await db.query(
      `UPDATE marketplace_listing_pages SET evidence_requirements = $2,
       evidence_requirements_stream_version = $4, updated_at = GREATEST(updated_at, $3::timestamptz)
       WHERE listing_id = $1 AND evidence_requirements_stream_version < $4`,
      [listingId, JSON.stringify(event.data.evidenceRequirements), event.timing.recordedAt, event.streamVersion],
    );
    await assertPresent(result, event);
  }
  async function projectFees(event: Parameters<ProjectorHandlerMap[string]>[0]) {
    const listingId = event.streamId.slice("marketplace.listing-".length);
    const locks = event.data.feeLocks as readonly MarketplaceListingFeeLockPayload[];
    const last = locks.at(-1);
    const data =
      event.type === "marketplace.listing.native-visibility-changed"
        ? {
            marketplaceSalesFeeUnitAmount: last?.marketplaceSalesFeeUnitAmount ?? null,
            sellerNetUnitAmount: last?.sellerNetUnitAmount ?? null,
            shippingAllowancePercentageBps: last?.terms.shippingAllowancePercentageBps ?? 0,
            termsScheduleId: last?.terms.termsScheduleId ?? null,
            termsAgreementId: last?.terms.termsAgreementId ?? null,
            termsResolvedAt: last?.terms.termsResolvedAt ?? null,
            feeQuoteFingerprint: last?.feeQuoteFingerprint ?? null,
          }
        : event.data;
    const result = await db.query(
      `UPDATE marketplace_listing_pages
       SET fee_stream_version = $2, fee_locks = $3,
           marketplace_sales_fee_unit_amount = $4, seller_net_unit_amount = $5,
           shipping_allowance_percentage_bps = $6, terms_schedule_id = $7,
           terms_agreement_id = $8, terms_resolved_at = $9, fee_quote_fingerprint = $10,
           updated_at = GREATEST(updated_at, $11::timestamptz)
       WHERE listing_id = $1 AND fee_stream_version < $2`,
      [
        listingId,
        event.streamVersion,
        JSON.stringify(locks),
        data.marketplaceSalesFeeUnitAmount,
        data.sellerNetUnitAmount,
        data.shippingAllowancePercentageBps ?? 500,
        data.termsScheduleId,
        data.termsAgreementId,
        data.termsResolvedAt,
        data.feeQuoteFingerprint,
        event.timing.recordedAt,
      ],
    );
    await assertPresent(result, event);
  }
  const projectLifecycle: ProjectorHandlerMap[string] = async (event) => {
    const listingId = event.streamId.slice("marketplace.listing-".length);
    const result = await db.query(
      `UPDATE marketplace_listing_pages AS listing
       SET status = authority.status, updated_at = GREATEST(listing.updated_at, $2::timestamptz)
       FROM marketplace_listing_native_authority AS authority
       WHERE listing.listing_id = $1 AND authority.listing_id = listing.listing_id`,
      [listingId, event.timing.recordedAt],
    );
    assertUpdatedListingRow(result, event.type, listingId);
    await emitListingPatch(db, event, listingId);
  };
  return {
    "marketplace.listing.channel-activated": projectLifecycle,
    "marketplace.listing.resumed": projectLifecycle,
    "marketplace.listing.inbound-clamp-engaged": projectLifecycle,
    "marketplace.listing.inbound-clamp-released": projectLifecycle,
    "marketplace.listing.inbound-clamp-ownership-adopted": projectLifecycle,
    "marketplace.listing.native-visibility-changed": async (event) => {
      const listingId = event.streamId.slice("marketplace.listing-".length);
      await projectFees(event);
      await projectRequirements(event);
      if (event.data.productMeasureSnapshot !== undefined && event.data.productMeasureRevision !== undefined) {
        const result = await db.query(
          `UPDATE marketplace_listing_pages SET product_measure_snapshot = $2,
             product_measure_source_revision = $3, updated_at = GREATEST(updated_at, $4::timestamptz)
           WHERE listing_id = $1 AND product_measure_source_revision < $3`,
          [
            listingId,
            JSON.stringify(event.data.productMeasureSnapshot),
            event.data.productMeasureRevision,
            event.timing.recordedAt,
          ],
        );
        await assertPresent(result, event);
      }
      await emitListingPatch(db, event, listingId);
    },
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
        priceCurrencyCode?: string | null;
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
        evidenceRequirements?: unknown;
        evidence?: unknown;
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
          product_measure_source_revision,
          graded_card,
          storage_location_name,
          ship_from_code,
          ship_from_address,
          price_amount,
          price_currency_code,
          listing_stream_version,
          fee_stream_version,
          quantity_stream_version,
          purchase_limits_stream_version,
          evidence_requirements_stream_version,
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
          evidence_requirements,
          evidence,
          status,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $34, $12, $13, $14, $15, $16, $17, $18, $18, $18, $18, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, 'draft', $33, $33
        )
        ON CONFLICT (listing_id) DO NOTHING`,
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
          typeof data.priceCurrencyCode === "string" ? data.priceCurrencyCode : null,
          event.streamVersion,
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
          data.evidenceRequirements && typeof data.evidenceRequirements === "object"
            ? JSON.stringify(data.evidenceRequirements)
            : null,
          JSON.stringify(Array.isArray(data.evidence) ? data.evidence : []),
          event.timing.recordedAt,
          0,
        ],
      );
      await emitListingPatch(db, event, data.listingId);
    },
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data as {
        catalogItemId: string;
        products?: unknown;
      };
      if (event.streamId !== `catalog.product-measures-${data.catalogItemId}`) {
        throw new Error("Catalog measure source identity does not match the Listing product.");
      }

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
             product_measure_source_revision = $4,
             updated_at = GREATEST(updated_at, $3::timestamptz)
         WHERE listing.catalog_catalog_item_id = $1 AND listing.product_measure_source_revision < $4
         RETURNING listing.listing_id`,
        [
          data.catalogItemId,
          JSON.stringify(Array.isArray(data.products) ? data.products : []),
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );

      for (const row of updated.rows) {
        await emitListingPatch(db, event, row.listing_id);
      }
    },
    "marketplace.listing.photos-added": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      const { evidence } = event.data as { evidence: unknown };

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET evidence = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, JSON.stringify(Array.isArray(evidence) ? evidence : []), event.timing.recordedAt],
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
    "marketplace.listing.evidence-requirements-refreshed": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      await projectRequirements(event);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.price-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      await projectFees(event);
      const { priceAmount, priceCurrencyCode } = event.data as {
        priceAmount: string;
        priceCurrencyCode?: string | null;
      };

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET price_amount = $2,
             price_currency_code = $3,
             listing_stream_version = $4,
             updated_at = GREATEST(updated_at, $5::timestamptz)
         WHERE listing_id = $1
           AND (listing_stream_version IS NULL OR listing_stream_version < $4)`,
        [
          listingId,
          priceAmount,
          typeof priceCurrencyCode === "string" ? priceCurrencyCode : null,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );
      if ((result.rowCount ?? 0) === 0) {
        const existing = await loadRealtimeListing(db, listingId);
        if (!existing) {
          throw new Error(`Cannot project ${event.type} for missing marketplace listing ${listingId}.`);
        }
        return;
      }
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const listingId = event.streamId.replace("marketplace.listing-", "");
      await projectFees(event);
      const { quantityCap, purchaseLimits } = event.data as {
        quantityCap: number;
        purchaseLimits?: {
          maxUnitsPerOrder: number | null;
          maxUnitsPerDay: number | null;
          maxUnitsPerCustomerAccount: number | null;
        };
      };
      const hasPurchaseLimits = purchaseLimits !== undefined;

      const result = await db.query(
        `UPDATE marketplace_listing_pages
         SET quantity_cap = CASE WHEN quantity_stream_version < $8 THEN $2 ELSE quantity_cap END,
              quantity_stream_version = GREATEST(quantity_stream_version, $8),
              max_units_per_order = CASE WHEN $3 AND purchase_limits_stream_version < $8 THEN $4 ELSE max_units_per_order END,
              max_units_per_day = CASE WHEN $3 AND purchase_limits_stream_version < $8 THEN $5 ELSE max_units_per_day END,
              max_units_per_customer_account = CASE WHEN $3 AND purchase_limits_stream_version < $8 THEN $6 ELSE max_units_per_customer_account END,
              purchase_limits_stream_version = CASE WHEN $3 THEN GREATEST(purchase_limits_stream_version, $8) ELSE purchase_limits_stream_version END,
              updated_at = GREATEST(updated_at, $7::timestamptz)
         WHERE listing_id = $1`,
        [
          listingId,
          quantityCap,
          hasPurchaseLimits,
          purchaseLimits?.maxUnitsPerOrder ?? null,
          purchaseLimits?.maxUnitsPerDay ?? null,
          purchaseLimits?.maxUnitsPerCustomerAccount ?? null,
          event.timing.recordedAt,
          event.streamVersion,
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
             purchase_limits_stream_version = $6,
             updated_at = GREATEST(updated_at, $5::timestamptz)
         WHERE listing_id = $1 AND purchase_limits_stream_version < $6`,
        [
          listingId,
          purchaseLimits.maxUnitsPerOrder,
          purchaseLimits.maxUnitsPerDay,
          purchaseLimits.maxUnitsPerCustomerAccount,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
      await assertPresent(result, event);
      await emitListingPatch(db, event, listingId);
    },
    "marketplace.listing.published": projectLifecycle,
    "marketplace.listing.paused": projectLifecycle,
    "marketplace.listing.auto-unlisted": projectLifecycle,
    "marketplace.listing.withdrawn": projectLifecycle,
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
