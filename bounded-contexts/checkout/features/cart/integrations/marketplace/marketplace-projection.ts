import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recomputeCheckoutSellerOptionSupply } from "../inventory/inventory-projection";

function productMeasureSnapshotFromUnknown(value: unknown) {
  return value && typeof value === "object" ? JSON.stringify(value) : null;
}

type ListingEvidenceRow = Readonly<{ evidence: unknown }>;

async function transformListingEvidence(
  db: PgQueryable,
  listingId: string,
  updatedAt: string,
  transform: (evidence: Record<string, unknown>[]) => Record<string, unknown>[],
) {
  const result = await db.query<ListingEvidenceRow>(
    `SELECT evidence
     FROM checkout_marketplace_seller_options
     WHERE listing_id = $1`,
    [listingId],
  );
  const evidence = Array.isArray(result.rows[0]?.evidence)
    ? (result.rows[0].evidence as Record<string, unknown>[])
    : [];
  await db.query(
    `UPDATE checkout_marketplace_seller_options
     SET evidence = $2,
         updated_at = $3
     WHERE listing_id = $1`,
    [listingId, JSON.stringify(transform(evidence)), updatedAt],
  );
}

/**
 * Checkout-local seller-options projection.
 *
 * Mirrors marketplace listing availability per product into a single
 * denormalized table keyed by `listing_id`. These handlers cover the
 * MARKETPLACE events (price / quantity-cap / lifecycle status +
 * seller-listing availability gating); holds-accurate supply quantity is
 * maintained by the sibling inventory handler set
 * (`integrations/inventory/inventory-projection.ts`) through the
 * reserved-nullable supply counters. On
 * `marketplace.listing.created` we backfill those counters so a listing
 * created after its inventory item already has supply/holds is immediately
 * accurate. Seller identity (identity) is added in a later wave.
 *
 * Seller-listing availability is keyed by `accountId` and is projected
 * authoritatively into `checkout_marketplace_seller_availability`
 * (`available` latch, version-guarded against stale redelivery). It gates
 * every active row for that seller: `disabled` records the seller
 * unavailable and flips its active rows to `seller-unavailable`, `enabled`
 * records the seller available and restores them to `active`. Crucially,
 * `published` consults that authoritative availability record rather than
 * unconditionally activating, so a listing published while its seller is
 * unavailable projects `seller-unavailable` — publish and disable converge
 * to a non-purchasable row in either replay order, and a listing created
 * after its seller was already disabled is projected correctly too.
 * Lifecycle states (draft / paused / withdrawn) are orthogonal and left
 * untouched by the availability gate, mirroring the marketplace read model
 * that keeps listing status and seller availability as separate concerns.
 */
export function buildCheckoutMarketplaceSellerOptionsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => {
      const data = event.data as {
        listingId: string;
        accountId: string;
        inventoryItemId?: string | null;
        catalogItemId: string;
        productId: string;
        productSummary?: string | null;
        priceAmount: string;
        quantityCap: number;
        productMeasureSnapshot?: unknown;
        evidenceRequirements?: unknown;
        evidence?: unknown;
      };

      await db.query(
        `INSERT INTO checkout_marketplace_seller_options (
           listing_id,
           seller_account_id,
           product_id,
           catalog_catalog_item_id,
           price_amount,
           listing_quantity_cap,
           product_summary,
           product_measure_snapshot,
           status,
           updated_at,
           inventory_item_id,
           evidence_requirements,
           evidence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11, $12)
         ON CONFLICT (listing_id) DO UPDATE
         SET seller_account_id = EXCLUDED.seller_account_id,
             product_id = EXCLUDED.product_id,
             catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
             price_amount = EXCLUDED.price_amount,
             listing_quantity_cap = EXCLUDED.listing_quantity_cap,
             product_summary = EXCLUDED.product_summary,
             product_measure_snapshot = EXCLUDED.product_measure_snapshot,
             inventory_item_id = EXCLUDED.inventory_item_id,
             evidence_requirements = EXCLUDED.evidence_requirements,
             evidence = EXCLUDED.evidence,
             updated_at = EXCLUDED.updated_at`,
        [
          data.listingId,
          data.accountId,
          data.productId,
          data.catalogItemId,
          data.priceAmount,
          data.quantityCap,
          data.productSummary ?? null,
          productMeasureSnapshotFromUnknown(data.productMeasureSnapshot),
          event.timing.recordedAt,
          data.inventoryItemId ?? null,
          data.evidenceRequirements && typeof data.evidenceRequirements === "object"
            ? JSON.stringify(data.evidenceRequirements)
            : null,
          JSON.stringify(Array.isArray(data.evidence) ? data.evidence : []),
        ],
      );

      // Backfill holds-accurate supply counters from the auxiliary supply/hold
      // tables in case the inventory item already had supply or holds projected
      // before this listing row existed (event-ordering independence).
      if (data.inventoryItemId) {
        await recomputeCheckoutSellerOptionSupply(db, data.inventoryItemId);
      }
    },
    "marketplace.listing.photos-added": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, "marketplace.listing-");
      const { evidence } = event.data as { evidence: unknown };
      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET evidence = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [listingId, JSON.stringify(Array.isArray(evidence) ? evidence : []), event.timing.recordedAt],
      );
    },
    "marketplace.listing.photo-classified": async (event) => {
      const data = event.data as {
        photoId: string;
        slotId: string | null;
        viewKind: string | null;
        altText: string | null;
        capturedAt: string | null;
      };
      await transformListingEvidence(
        db,
        extractIdFromStreamId(event.streamId, "marketplace.listing-"),
        event.timing.recordedAt,
        (evidence) =>
          evidence.map((photo) =>
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
      const data = event.data as { replacedPhotoId: string; photo: Record<string, unknown> };
      await transformListingEvidence(
        db,
        extractIdFromStreamId(event.streamId, "marketplace.listing-"),
        event.timing.recordedAt,
        (evidence) => [
          ...evidence.map((photo) =>
            photo.photoId === data.replacedPhotoId ? { ...photo, status: "replaced" } : photo,
          ),
          data.photo,
        ],
      );
    },
    "marketplace.listing.photo-removed": async (event) => {
      const { photoId } = event.data as { photoId: string };
      await transformListingEvidence(
        db,
        extractIdFromStreamId(event.streamId, "marketplace.listing-"),
        event.timing.recordedAt,
        (evidence) => evidence.map((photo) => (photo.photoId === photoId ? { ...photo, status: "removed" } : photo)),
      );
    },
    "marketplace.listing.photos-reordered": async (event) => {
      const { orderedPhotoIds } = event.data as { orderedPhotoIds: string[] };
      const orderIndex = new Map(orderedPhotoIds.map((id, index) => [id, index]));
      await transformListingEvidence(
        db,
        extractIdFromStreamId(event.streamId, "marketplace.listing-"),
        event.timing.recordedAt,
        (evidence) =>
          evidence.map((photo) =>
            orderIndex.has(String(photo.photoId))
              ? { ...photo, sortOrder: orderIndex.get(String(photo.photoId)) }
              : photo,
          ),
      );
    },
    "marketplace.listing.evidence-requirements-refreshed": async (event) => {
      const { evidenceRequirements } = event.data as { evidenceRequirements: unknown };
      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET evidence_requirements = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [
          extractIdFromStreamId(event.streamId, "marketplace.listing-"),
          JSON.stringify(evidenceRequirements),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data as {
        catalogItemId: string;
        products?: unknown;
      };

      await db.query(
        `WITH resolved_products AS (
           SELECT measure
           FROM jsonb_array_elements($2::jsonb) AS product(measure)
         )
         UPDATE checkout_marketplace_seller_options AS option
         SET product_measure_snapshot = (
               SELECT measure
               FROM resolved_products
               WHERE measure->>'productId' = option.product_id
               LIMIT 1
             ),
             updated_at = $3
         WHERE option.catalog_catalog_item_id = $1`,
        [
          data.catalogItemId,
          JSON.stringify(Array.isArray(data.products) ? data.products : []),
          event.timing.recordedAt,
        ],
      );
    },
    "marketplace.listing.price-updated": async (event) => {
      const data = event.data as { priceAmount: string };

      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET price_amount = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), data.priceAmount, event.timing.recordedAt],
      );
    },
    "marketplace.listing.quantity-cap-updated": async (event) => {
      const data = event.data as { quantityCap: number };

      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET listing_quantity_cap = $2,
             updated_at = $3
         WHERE listing_id = $1`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), data.quantityCap, event.timing.recordedAt],
      );
    },
    "marketplace.listing.published": async (event) => {
      const listingId = extractIdFromStreamId(event.streamId, "marketplace.listing-");
      // Project purchasability from the authoritative seller-availability
      // record, not unconditionally: publishing a listing while its seller is
      // unavailable must yield `seller-unavailable`, so publish and disable
      // converge to the same non-purchasable row in either order (and a listing
      // created after the seller was disabled is projected correctly on
      // replay). Absent availability record means available (COALESCE true).
      const updated = await db.query<{ inventory_item_id: string | null }>(
        `UPDATE checkout_marketplace_seller_options AS option
         SET status = CASE
               WHEN COALESCE(
                 (
                   SELECT availability.available
                   FROM checkout_marketplace_seller_availability AS availability
                   WHERE availability.account_id = option.seller_account_id
                 ),
                 true
               )
               THEN 'active'
               ELSE 'seller-unavailable'
             END,
             updated_at = $2
         WHERE option.listing_id = $1
         RETURNING inventory_item_id`,
        [listingId, event.timing.recordedAt],
      );

      const inventoryItemId = updated.rows[0]?.inventory_item_id;
      if (inventoryItemId) {
        await recomputeCheckoutSellerOptionSupply(db, inventoryItemId);
      }
    },
    "marketplace.listing.paused": async (event) => {
      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET status = 'paused',
             updated_at = $2
         WHERE listing_id = $1`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), event.timing.recordedAt],
      );
    },
    "marketplace.listing.withdrawn": async (event) => {
      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET status = 'withdrawn',
             updated_at = $2
         WHERE listing_id = $1`,
        [extractIdFromStreamId(event.streamId, "marketplace.listing-"), event.timing.recordedAt],
      );
    },
    "marketplace.seller-listing-availability.disabled": async (event) => {
      const data = event.data as { accountId: string };

      // Record the authoritative latch first (version-guarded so a stale
      // redelivered event cannot regress a newer one), then flip the seller's
      // currently-active rows — but only when this event actually advanced the
      // latch, so a stale disabled that lost the guard never hides rows.
      const latch = await db.query(
        `INSERT INTO checkout_marketplace_seller_availability (account_id, available, last_stream_version, updated_at)
         VALUES ($1, false, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET available = EXCLUDED.available,
             last_stream_version = EXCLUDED.last_stream_version,
             updated_at = EXCLUDED.updated_at
         WHERE checkout_marketplace_seller_availability.last_stream_version < EXCLUDED.last_stream_version`,
        [data.accountId, event.streamVersion, event.timing.recordedAt],
      );

      if (latch.rowCount === 1) {
        await db.query(
          `UPDATE checkout_marketplace_seller_options
           SET status = 'seller-unavailable',
               updated_at = $2
           WHERE seller_account_id = $1
             AND status = 'active'`,
          [data.accountId, event.timing.recordedAt],
        );
      }
    },
    "marketplace.seller-listing-availability.enabled": async (event) => {
      const data = event.data as { accountId: string };

      const latch = await db.query(
        `INSERT INTO checkout_marketplace_seller_availability (account_id, available, last_stream_version, updated_at)
         VALUES ($1, true, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET available = EXCLUDED.available,
             last_stream_version = EXCLUDED.last_stream_version,
             updated_at = EXCLUDED.updated_at
         WHERE checkout_marketplace_seller_availability.last_stream_version < EXCLUDED.last_stream_version`,
        [data.accountId, event.streamVersion, event.timing.recordedAt],
      );

      if (latch.rowCount === 1) {
        await db.query(
          `UPDATE checkout_marketplace_seller_options
           SET status = 'active',
               updated_at = $2
           WHERE seller_account_id = $1
             AND status = 'seller-unavailable'`,
          [data.accountId, event.timing.recordedAt],
        );
      }
    },
    // At-capacity buyer signal (m127, producer: ordering's open-order
    // enforcement slice -- registered ahead of that slice landing, mirroring
    // the parallel-lane pattern this projection already uses for every other
    // marketplace event). Tracked as its own at_capacity column (not a third
    // status value) so it composes independently of seller-listing
    // availability: a seller can be away AND at capacity at once, and each
    // clears on its own. listCartLines's candidate-option query requires
    // at_capacity = false alongside status = 'active', so a locked listing
    // whose seller crosses into capacity drops out of seller_options and the
    // readiness re-check flags the cart line as unavailable before order
    // creation -- the same "gone" path away-seller transitions already
    // exercise, with zero changes to readiness.ts.
    "ordering.seller-capacity.reached": async (event) => {
      const data = event.data as { accountId: string };

      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET at_capacity = true,
             updated_at = $2
         WHERE seller_account_id = $1
           AND at_capacity = false`,
        [data.accountId, event.timing.recordedAt],
      );
    },
    "ordering.seller-capacity.cleared": async (event) => {
      const data = event.data as { accountId: string };

      await db.query(
        `UPDATE checkout_marketplace_seller_options
         SET at_capacity = false,
             updated_at = $2
         WHERE seller_account_id = $1
           AND at_capacity = true`,
        [data.accountId, event.timing.recordedAt],
      );
    },
  };
}
