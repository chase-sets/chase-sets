import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogRepresentativeCatalogUsageCandidate } from "@chase-sets/catalog-seed";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { MarketplaceListingPhotoUpload } from "../../features/listings/api/runtime";
import {
  createMarketplaceProductDescriptor,
  type MarketplaceVersionSchema,
  type MarketplaceVersionSelectedOptionEntry,
} from "../../features/offers/domain/versioning";
import type { MarketplaceServices } from "../runtime-support/services";

const DEFAULT_CANDIDATE_LIMIT = 50;

export type MarketplaceRepresentativeCatalogUsageCandidate = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string | null;
  blueprintId: string | null;
  updatedAt: string;
}>;

export type MarketplaceRepresentativeInventoryStock = Readonly<{
  catalogItemId: string;
  accountId: string;
  inventoryItemId: string;
  selectedOptions: readonly MarketplaceVersionSelectedOptionEntry[];
  totalQuantity: number;
}>;

export type MarketplaceRepresentativeListingResult = Readonly<{
  catalogItemId: string;
  accountId: string;
  inventoryItemId: string;
  listingId: string;
  status: "created" | "already-present";
}>;

export type MarketplaceRepresentativeOfferResult = Readonly<{
  catalogItemId: string;
  buyerAccountId: string;
  offerId: string;
  status: "created" | "already-present";
}>;

export type MarketplaceRepresentativeOfferAcceptanceResult = Readonly<{
  catalogItemId: string;
  sellerAccountId: string;
  offerId: string;
  status: "accepted" | "already-accepted" | "skipped";
  reason: string | null;
}>;

const representativeSeedContext: EventStoreContext = {
  tenantId: "tnt_identity" as never,
  audit: {
    performedByUserId: "usr_repr_support_ops_user" as never,
    forAccountId: "acc_repr_support_ops_account" as never,
  },
};

export async function loadUntouchedMarketplaceCatalogUsageCandidates(
  db: Pick<PgQueryable, "query">,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly MarketplaceRepresentativeCatalogUsageCandidate[]> {
  const limit = normalizeRepresentativeCandidateLimit(options.limit);
  const result = await db.query<{
    catalog_item_id: string;
    title: string;
    subtitle: string | null;
    blueprint_id: string | null;
    updated_at: string | Date;
  }>(
    `SELECT
       item.catalog_item_id,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.updated_at
     FROM marketplace_catalog_items item
     LEFT JOIN marketplace_listing_pages listing
       ON listing.catalog_catalog_item_id = item.catalog_item_id
     LEFT JOIN marketplace_offer_pages offer
       ON offer.catalog_catalog_item_id = item.catalog_item_id
     WHERE item.status = 'active'
       AND COALESCE(jsonb_array_length(item.product_measure_snapshots), 0) > 0
       AND listing.listing_id IS NULL
       AND offer.offer_id IS NULL
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    title: row.title,
    subtitle: row.subtitle,
    blueprintId: row.blueprint_id,
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function filterUntouchedMarketplaceCatalogUsageCandidates(
  db: Pick<PgQueryable, "query">,
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const limit = normalizeRepresentativeCandidateLimit(options.limit);
  const candidateIds = candidates.map((candidate) => candidate.catalogItemId);
  if (candidateIds.length === 0) {
    return [];
  }

  const touchedResult = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT touched.catalog_item_id
     FROM (
       SELECT listing.catalog_catalog_item_id AS catalog_item_id
       FROM marketplace_listing_pages listing
       WHERE listing.catalog_catalog_item_id = ANY($1::text[])
       UNION
       SELECT offer.catalog_catalog_item_id AS catalog_item_id
       FROM marketplace_offer_pages offer
       WHERE offer.catalog_catalog_item_id = ANY($1::text[])
     ) touched
     WHERE touched.catalog_item_id IS NOT NULL`,
    [candidateIds],
  );
  const touchedCatalogItemIds = new Set(touchedResult.rows.map((row) => row.catalog_item_id));

  return candidates.filter((candidate) => !touchedCatalogItemIds.has(candidate.catalogItemId)).slice(0, limit);
}

export async function reconcileRepresentativeMarketplaceCatalogItems(
  db: Pick<PgQueryable, "query">,
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
): Promise<number> {
  for (const candidate of candidates) {
    await db.query(
      `INSERT INTO marketplace_catalog_items (
         catalog_item_id,
         language_code,
         title,
         subtitle,
         blueprint_id,
         status,
         product_measure_snapshots,
         product_schema,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (catalog_item_id) DO UPDATE SET
         language_code = EXCLUDED.language_code,
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         blueprint_id = EXCLUDED.blueprint_id,
         status = EXCLUDED.status,
         product_measure_snapshots = EXCLUDED.product_measure_snapshots,
         product_schema = EXCLUDED.product_schema,
         updated_at = EXCLUDED.updated_at`,
      [
        candidate.catalogItemId,
        candidate.languageCode,
        candidate.title,
        candidate.subtitle,
        candidate.blueprintId,
        candidate.status,
        JSON.stringify(candidate.productMeasureSnapshots),
        candidate.productSchema ? JSON.stringify(candidate.productSchema) : null,
        candidate.updatedAt,
      ],
    );
  }

  return candidates.length;
}

export function normalizeRepresentativeCandidateLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_CANDIDATE_LIMIT;
  }

  return Math.max(1, Math.min(Math.trunc(value), 500));
}

export async function publishRepresentativeListings(
  services: MarketplaceServices,
  stockItems: readonly MarketplaceRepresentativeInventoryStock[],
): Promise<readonly MarketplaceRepresentativeListingResult[]> {
  const results: MarketplaceRepresentativeListingResult[] = [];

  for (const [index, stock] of stockItems.entries()) {
    const listingId = createRepresentativeListingId(stock);
    const existing = await getListingStatus(services.db, listingId);
    if (existing === "active") {
      results.push({
        catalogItemId: stock.catalogItemId,
        accountId: stock.accountId,
        inventoryItemId: stock.inventoryItemId,
        listingId,
        status: "already-present",
      });
      continue;
    }

    const created = await services.listings.createListing(
      {
        accountId: stock.accountId as AccountId,
        inventoryItemId: stock.inventoryItemId,
        priceAmount: representativePrice(index),
        quantityCap: Math.max(1, Math.min(stock.totalQuantity, index % 2 === 0 ? 2 : 4)),
        listingIdOverride: listingId as ListingId,
        listingPhotoUploads: await buildRepresentativeListingPhotoUpload(listingId),
      },
      representativeSeedContext,
    );

    if (existing !== "active") {
      await services.listings.publishListing(
        {
          accountId: stock.accountId as AccountId,
          listingId: created.listingId,
          feeQuoteFingerprint: created.feeQuoteFingerprint,
        },
        representativeSeedContext,
      );
    }

    results.push({
      catalogItemId: stock.catalogItemId,
      accountId: stock.accountId,
      inventoryItemId: stock.inventoryItemId,
      listingId,
      status: existing ? "already-present" : "created",
    });
  }

  return results;
}

export async function submitRepresentativeOffers(
  services: MarketplaceServices,
  stockItems: readonly MarketplaceRepresentativeInventoryStock[],
): Promise<readonly MarketplaceRepresentativeOfferResult[]> {
  const results: MarketplaceRepresentativeOfferResult[] = [];

  for (const [index, stock] of stockItems.entries()) {
    const buyerAccountId = representativeBuyerAccountId(index);
    const offerId = createRepresentativeOfferId(stock, buyerAccountId);
    const existing = await getOfferStatus(services.db, offerId);
    if (existing) {
      results.push({
        catalogItemId: stock.catalogItemId,
        buyerAccountId,
        offerId,
        status: "already-present",
      });
      continue;
    }

    const catalogItem = await getMarketplaceCatalogItem(services.db, stock.catalogItemId);
    if (!catalogItem || catalogItem.status !== "active") {
      continue;
    }

    const product = createMarketplaceProductDescriptor({
      catalogItemId: stock.catalogItemId,
      productSchema: catalogItem.product_schema,
      selection: stock.selectedOptions,
    });

    const submitted = await services.offers.submitOffer(
      {
        offerId: offerId as never,
        buyerAccountId: buyerAccountId as AccountId,
        catalogItemId: stock.catalogItemId,
        productId: product.productId,
        itemTitle: catalogItem.title,
        itemSubtitle: catalogItem.subtitle,
        selectedOptions: product.selection,
        productSummary: summarizeRepresentativeSelectedOptions(catalogItem.product_schema, product.selection),
        shippingDestinationSnapshot: representativeBuyerShippingAddress(index),
        priceAmount: representativeOfferPrice(index),
        quantityRequested: index % 2 === 0 ? 1 : Math.min(3, Math.max(1, stock.totalQuantity)),
      },
      representativeSeedContext,
    );

    results.push({
      catalogItemId: stock.catalogItemId,
      buyerAccountId,
      offerId: submitted.offerId,
      status: "created",
    });
  }

  return results;
}

export async function acceptRepresentativeOffers(
  services: MarketplaceServices,
  stockItems: readonly MarketplaceRepresentativeInventoryStock[],
  options: Readonly<{ maxAcceptedOffers?: number }> = {},
): Promise<readonly MarketplaceRepresentativeOfferAcceptanceResult[]> {
  const maxAcceptedOffers = normalizeAcceptedOfferLimit(options.maxAcceptedOffers);
  const results: MarketplaceRepresentativeOfferAcceptanceResult[] = [];

  for (const [index, stock] of stockItems.entries()) {
    if (results.filter((result) => result.status === "accepted").length >= maxAcceptedOffers) {
      break;
    }

    const buyerAccountId = representativeBuyerAccountId(index);
    const offerId = createRepresentativeOfferId(stock, buyerAccountId);
    const existing = await getOfferStatus(services.db, offerId);
    if (existing === "accepted") {
      results.push({
        catalogItemId: stock.catalogItemId,
        sellerAccountId: stock.accountId,
        offerId,
        status: "already-accepted",
        reason: null,
      });
      continue;
    }
    if (existing !== "submitted") {
      results.push({
        catalogItemId: stock.catalogItemId,
        sellerAccountId: stock.accountId,
        offerId,
        status: "skipped",
        reason: "Offer is not submitted.",
      });
      continue;
    }

    try {
      const quote = await services.offers.previewOfferAcceptanceTerms({
        offerId: offerId as never,
        sellerAccountId: stock.accountId as AccountId,
      });
      await services.offers.acceptOffer(
        {
          offerId: offerId as never,
          sellerAccountId: stock.accountId as AccountId,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        representativeSeedContext,
      );
      results.push({
        catalogItemId: stock.catalogItemId,
        sellerAccountId: stock.accountId,
        offerId,
        status: "accepted",
        reason: null,
      });
    } catch (error) {
      results.push({
        catalogItemId: stock.catalogItemId,
        sellerAccountId: stock.accountId,
        offerId,
        status: "skipped",
        reason: error instanceof Error ? error.message : "Offer could not be accepted.",
      });
    }
  }

  return results;
}

function createRepresentativeListingId(stock: MarketplaceRepresentativeInventoryStock): string {
  const hash = createHash("sha256")
    .update(`${stock.accountId}:${stock.inventoryItemId}:${stock.catalogItemId}`)
    .digest("hex")
    .slice(0, 24);

  return `lst_repr_${hash}`;
}

function representativePrice(index: number): string {
  const dollars = 9 + (index % 9) * 4;
  const cents = index % 2 === 0 ? "99" : "50";
  return `${dollars}.${cents}`;
}

function representativeOfferPrice(index: number): string {
  const dollars = 7 + (index % 9) * 3;
  const cents = index % 2 === 0 ? "75" : "25";
  return `${dollars}.${cents}`;
}

function representativeBuyerAccountId(index: number): string {
  return index % 2 === 0 ? "acc_repr_staging_collector_account" : "acc_repr_value_buyer_account";
}

function normalizeAcceptedOfferLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 2;
  }

  return Math.max(0, Math.min(Math.trunc(value), 10));
}

function representativeBuyerShippingAddress(index: number): AddressSnapshot {
  if (index % 2 === 0) {
    return {
      name: "Staging Collector",
      company: null,
      line1: "180 N Wabash Ave",
      line2: "Apt 4B",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "3125550201",
      email: "staging-collector@chasesets.test",
    };
  }

  return {
    name: "Value Buyer",
    company: null,
    line1: "401 S 2nd St",
    line2: null,
    city: "Saint Louis",
    state: "MO",
    postalCode: "63102",
    country: "US",
    phone: "3145550202",
    email: "value-buyer@chasesets.test",
  };
}

function createRepresentativeOfferId(stock: MarketplaceRepresentativeInventoryStock, buyerAccountId: string): string {
  const hash = createHash("sha256")
    .update(`${buyerAccountId}:${stock.catalogItemId}:${JSON.stringify(stock.selectedOptions)}`)
    .digest("hex")
    .slice(0, 24);

  return `off_repr_${hash}`;
}

async function getListingStatus(db: Pick<PgQueryable, "query">, listingId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status
     FROM marketplace_listing_pages
     WHERE listing_id = $1`,
    [listingId],
  );

  return result.rows[0]?.status ?? null;
}

async function getOfferStatus(db: Pick<PgQueryable, "query">, offerId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status
     FROM marketplace_offer_pages
     WHERE offer_id = $1`,
    [offerId],
  );

  return result.rows[0]?.status ?? null;
}

async function getMarketplaceCatalogItem(
  db: Pick<PgQueryable, "query">,
  catalogItemId: string,
): Promise<{
  title: string;
  subtitle: string | null;
  status: string;
  product_schema: MarketplaceVersionSchema | null;
} | null> {
  const result = await db.query<{
    title: string;
    subtitle: string | null;
    status: string;
    product_schema: unknown;
  }>(
    `SELECT title, subtitle, status, product_schema
     FROM marketplace_catalog_items
     WHERE catalog_item_id = $1`,
    [catalogItemId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    title: row.title,
    subtitle: row.subtitle,
    status: row.status,
    product_schema:
      typeof row.product_schema === "object" && row.product_schema !== null
        ? (row.product_schema as MarketplaceVersionSchema)
        : null,
  };
}

function summarizeRepresentativeSelectedOptions(
  productSchema: MarketplaceVersionSchema | null,
  selection: readonly MarketplaceVersionSelectedOptionEntry[],
): string | null {
  if (!productSchema || selection.length === 0) {
    return null;
  }
  const selectedOptionByDimension = new Map(selection.map((entry) => [entry.dimensionId, entry.optionId]));
  const summary = productSchema.canonicalDimensionOrder
    .map((entry) => {
      const optionId = selectedOptionByDimension.get(entry.dimensionId);
      if (!optionId) {
        return null;
      }
      const dimension = productSchema.dimensions.find((candidate) => candidate.dimensionId === entry.dimensionId);
      const option = dimension?.allowedOptions.find((candidate) => candidate.optionId === optionId);
      if (!dimension || !option) {
        return null;
      }

      return `${dimension.dimensionName}: ${option.label || option.code}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join(" | ");

  return summary || null;
}

let representativeListingPhotoBodyPromise: Promise<Buffer> | null = null;

async function buildRepresentativeListingPhotoUpload(
  listingId: string,
): Promise<readonly MarketplaceListingPhotoUpload[]> {
  representativeListingPhotoBodyPromise ??= sharp({
    create: {
      width: 720,
      height: 1008,
      channels: 3,
      background: { r: 245, g: 247, b: 250 },
    },
  })
    .png()
    .toBuffer();

  return [
    {
      body: await representativeListingPhotoBodyPromise,
      contentType: "image/png",
      originalFilename: `${listingId}-representative-condition.png`,
      altText: "Representative staging listing condition evidence photo",
    },
  ];
}
