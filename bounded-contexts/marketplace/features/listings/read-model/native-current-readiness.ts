import type { EventStore } from "@chase-sets/event-core/event-store";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogListingAuthorityFacts } from "@chase-sets/catalog/server";
import { createNativeAuthorityFacts } from "../api/native-authority-facts";
import type { MarketplaceListingPhoto } from "../domain/domain";
import {
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
  type SellerListingAvailabilityEvent,
} from "../domain/seller-listing-availability";
import { createListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import { evaluateListingEvidenceReadiness } from "../domain/listing-evidence-readiness";
import { evaluateListingEvidencePolicy } from "../../listing-evidence-policy/domain/policy";
import type { ListingCurrentReadinessReader } from "./target-queries";

export type ListingCurrentOwnerFacts<T> = Readonly<{ value: T; generatedAt: string; validBefore: string }>;
export type MarketplaceListingCurrentReadinessPorts = Readonly<{
  /** Read-only current owner APIs, never a reservation or commitment permission. */
  seller(
    accountId: string,
  ): Promise<ListingCurrentOwnerFacts<Readonly<{ accountId: string; active: boolean; badgeKeys: readonly string[] }>>>;
  products(
    subjects: readonly Readonly<{
      catalogItemId: string;
      productId: string;
      selectedOptions: CatalogListingAuthorityFacts["selectedOptions"];
    }>[],
  ): Promise<ListingCurrentOwnerFacts<readonly CatalogListingAuthorityFacts[]>>;
}>;

type ListingRow = Readonly<{
  listing_id: string;
  listing_revision: number;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: CatalogListingAuthorityFacts["selectedOptions"];
  graded_card: unknown;
  evidence: MarketplaceListingPhoto[];
}>;

/** Marketplace owns the composite verdict; roots only bind the two current source readers. */
export function createMarketplaceListingCurrentReadiness(
  deps: Readonly<{ db: PgQueryable; eventStore: EventStore; now?: () => Date }>,
  ports: MarketplaceListingCurrentReadinessPorts,
): ListingCurrentReadinessReader {
  const facts = createNativeAuthorityFacts(deps.eventStore, deps.db);
  return async ({ accountId, listings }) => {
    if (!accountId.trim() || listings.length > 100)
      throw new Error("Current readiness requires at most 100 account-scoped Listings.");
    if (!listings.length) return [];
    if (
      listings.some((listing) => listing.accountId !== accountId || !listing.priceAmount || !listing.priceCurrencyCode)
    )
      throw new Error("Current readiness requires complete owned native price pairs.");
    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const source = await deps.db.query<ListingRow>(
      `
      SELECT page.listing_id, authority.listing_revision, page.catalog_catalog_item_id,
        page.product_id, page.selected_options, page.graded_card, page.evidence
      FROM marketplace_listing_pages page
      JOIN marketplace_listing_native_authority authority ON authority.listing_id=page.listing_id
      JOIN event_store_streams stream ON stream.stream_id='marketplace.listing-' || page.listing_id
        AND stream.current_version=authority.listing_revision
      WHERE page.account_id=$1 AND authority.account_id=$1 AND page.listing_id=ANY($2::text[])`,
      [accountId, [...new Set(listings.map((listing) => listing.listingId))]],
    );
    const availabilityHistory = await readCompleteStream(deps.eventStore, {
      streamId: `marketplace.seller-listing-availability-${accountId}`,
    });
    const availability = availabilityHistory.reduce(
      (state, event) =>
        evolveSellerListingAvailability(state, {
          type: event.eventType,
          data: event.payload,
        } as SellerListingAvailabilityEvent),
      initialSellerListingAvailabilityState,
    );
    const [sellerFacts, products, policy, reviewCount] = await Promise.all([
      ports.seller(accountId),
      ports.products([
        ...new Map(
          source.rows.map((row) => [
            row.product_id,
            {
              catalogItemId: row.catalog_catalog_item_id,
              productId: row.product_id,
              selectedOptions: row.selected_options,
            },
          ]),
        ).values(),
      ]),
      facts.evidencePolicy(startedAt),
      facts.sellerReviewCount(accountId),
    ]);
    const at = (deps.now?.() ?? new Date()).toISOString();
    for (const result of [sellerFacts, products]) {
      if (
        !Number.isFinite(Date.parse(result.generatedAt)) ||
        Date.parse(result.generatedAt) < Date.parse(startedAt) ||
        Date.parse(result.generatedAt) > Date.parse(at) ||
        !Number.isFinite(Date.parse(result.validBefore)) ||
        Date.parse(result.validBefore) <= Date.parse(at)
      )
        throw new Error("Native current owner facts are stale.");
    }
    if (sellerFacts.value.accountId !== accountId) throw new Error("Native seller facts have a different owner.");
    const seller = { badgeKeys: sellerFacts.value.badgeKeys, reviewCount };
    return listings.map((listing) => {
      const rows = source.rows.filter(
        (row) => row.listing_id === listing.listingId && row.listing_revision === listing.listingRevision,
      );
      if (rows.length !== 1) throw new Error("Native current Listing source changed.");
      const row = rows[0]!;
      const matches = products.value.filter(
        (product) =>
          product.catalogItemId === row.catalog_catalog_item_id &&
          product.productId === row.product_id &&
          JSON.stringify(product.selectedOptions) === JSON.stringify(row.selected_options),
      );
      if (matches.length !== 1) throw new Error("Native current Catalog membership changed.");
      const product = matches[0]!;
      const requirements = createListingEvidenceRequirementSnapshot(
        evaluateListingEvidencePolicy(
          policy.value,
          {
            catalogItemId: product.catalogItemId,
            productId: product.productId,
            blueprintId: product.blueprintId,
            categoryIds: product.categoryIds,
            selectedOptions: product.selectedOptions,
            gradedItem: row.graded_card !== null,
            priceAmount: listing.priceAmount!,
            seller: { ...seller, riskLevel: null },
          },
          policy.metadata,
        ),
        at,
      );
      const evidence = evaluateListingEvidenceReadiness({
        snapshot: requirements,
        evidence: row.evidence,
        seller,
        now: at,
      });
      const boundaries = [
        sellerFacts.validBefore,
        products.validBefore,
        ...policy.boundaries.filter(
          (boundary): boundary is string => !!boundary && Date.parse(boundary) > Date.parse(startedAt),
        ),
        ...(availability.pendingAwayWindow ? [availability.pendingAwayWindow.startsAt] : []),
      ];
      for (const covered of evidence.coverage?.slots ?? []) {
        const slot = requirements.requirements.requiredSlots.find((entry) => entry.slotId === covered.slotId)!;
        const photo = row.evidence.find((entry) => entry.photoId === covered.matchedPhotoId);
        if (photo && slot.maximumAgeHours !== null)
          boundaries.push(
            new Date(Date.parse(photo.capturedAt ?? photo.uploadedAt) + slot.maximumAgeHours * 3_600_000).toISOString(),
          );
      }
      const validBefore = boundaries.reduce((left, right) => (Date.parse(left) < Date.parse(right) ? left : right));
      return {
        listingId: listing.listingId,
        listingRevision: listing.listingRevision,
        generatedAt: at,
        validBefore,
        ready:
          sellerFacts.value.active &&
          availability.status === "available" &&
          evidence.ready &&
          product.productMeasureSnapshot !== null &&
          product.productMeasureSnapshot.productId === product.productId &&
          product.productMeasureSnapshot.catalogItemId === product.catalogItemId &&
          JSON.stringify(product.productMeasureSnapshot.selectedOptions) === JSON.stringify(product.selectedOptions) &&
          product.productMeasureRevision > 0 &&
          Date.parse(validBefore) > Date.parse(at),
      };
    });
  };
}
