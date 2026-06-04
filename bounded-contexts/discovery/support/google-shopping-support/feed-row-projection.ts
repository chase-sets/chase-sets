import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildGoogleShoppingMappedFeedRow,
  type GoogleShoppingExclusionReason,
  type GoogleShoppingMappedFeedRow,
  type GoogleShoppingPayloadInput,
  type GoogleShoppingSelectedOption,
} from "./export-row";

export type GoogleShoppingIncrementalSyncReason =
  | "listing-created"
  | "price"
  | "availability"
  | "visibility"
  | "seller-availability"
  | "catalog"
  | "image"
  | "canonical"
  | "eligibility"
  | "manual";

export type GoogleShoppingIncrementalSyncRequest = Readonly<{
  listingId: string;
  reasons: readonly GoogleShoppingIncrementalSyncReason[];
}>;

export type GoogleShoppingRefreshOptions = Readonly<{
  reason: GoogleShoppingIncrementalSyncReason;
  requestedAt: string;
  debounceMs?: number;
}>;

type ListingFactsRow = Readonly<{
  listing_id: string;
  listing_slug: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  ship_from_code: string | null;
  price_amount: string;
  shipping_allowance_percentage_bps: number;
  quantity_cap: number;
  status: string;
  seller_listing_availability_status: string | null;
  seller_account_status: string | null;
  catalog_title: string | null;
  catalog_subtitle: string | null;
  catalog_description: string | null;
  catalog_status: string | null;
  image_urls: unknown;
  product_asset_sets: unknown;
  image_fallback: unknown;
  product_schema: unknown;
}>;

const DEFAULT_INCREMENTAL_SYNC_DEBOUNCE_MS = 30_000;
const MARKETPLACE_CANONICAL_ORIGIN = "https://marketplace.chasesets.com";
const SHIPPING_POLICY_URL = "https://chasesets.com/policies/shipping";
const RETURN_POLICY_URL = "https://chasesets.com/policies/returns";
const RETURN_POLICY_LABEL = "chase-sets-standard-returns";

export async function refreshGoogleShoppingFeedRowForListing(
  db: PgQueryable,
  listingId: string,
  options: GoogleShoppingRefreshOptions,
): Promise<GoogleShoppingMappedFeedRow | null> {
  const facts = await loadListingFacts(db, listingId);
  if (!facts) {
    return null;
  }

  const row = buildGoogleShoppingMappedFeedRow({
    catalog: {
      catalogItemId: facts.catalog_catalog_item_id,
      productId: facts.product_id,
      title: facts.catalog_title ?? facts.item_title,
      subtitle: facts.catalog_subtitle ?? facts.item_subtitle,
      description: facts.catalog_description ?? facts.product_summary,
      productSummary: facts.product_summary,
      selectedOptions: selectedOptionsForGoogleShopping(facts.selected_options, facts.product_schema),
      productAssetSets: arrayValue(facts.product_asset_sets) as never,
      imageUrls: stringArrayValue(facts.image_urls),
      imageFallback: objectValue(facts.image_fallback) as never,
      productForm: productFormFromSchema(facts.product_schema),
      fallbackImagePolicyApproved: true,
    },
    offer: {
      listingId: facts.listing_id,
      listingStatus: facts.status,
      sellerListingAvailabilityStatus: facts.seller_listing_availability_status ?? "available",
      sellerAccountStatus: facts.seller_account_status,
      accountId: facts.account_id,
      canonicalUrl: canonicalListingUrl(facts.listing_slug),
      priceAmount: facts.price_amount,
      currencyCode: "USD",
      quantityCap: facts.quantity_cap,
      crawlable: facts.status === "active" && Boolean(facts.listing_slug.trim()),
    },
    shipping: {
      ready: Boolean(facts.ship_from_code?.trim()),
      country: "US",
      service: "Standard shipping",
      priceAmount: shippingAllowanceAmount(facts.price_amount, facts.shipping_allowance_percentage_bps),
      currencyCode: "USD",
      shipFromCode: facts.ship_from_code,
      productMeasureReady: null,
    },
    returns: {
      ready: true,
      policyUrl: RETURN_POLICY_URL,
      policyLabel: RETURN_POLICY_LABEL,
    },
    targetCountry: "US",
    contentLanguage: "en",
    feedLabel: "US",
  });

  await upsertGoogleShoppingFeedRow(db, facts, row);
  await enqueueGoogleShoppingIncrementalSyncRequest(db, {
    listingId,
    reason: options.reason,
    requestedAt: options.requestedAt,
    debounceMs: options.debounceMs,
  });

  return row;
}

export async function refreshGoogleShoppingFeedRowsForCatalogItem(
  db: PgQueryable,
  catalogItemId: string,
  options: GoogleShoppingRefreshOptions,
): Promise<number> {
  const result = await db.query<{ listing_id: string }>(
    `SELECT listing_id
     FROM discovery_market_listings
     WHERE catalog_catalog_item_id = $1
     ORDER BY listing_id ASC`,
    [catalogItemId],
  );

  await Promise.all(result.rows.map((row) => refreshGoogleShoppingFeedRowForListing(db, row.listing_id, options)));

  return result.rows.length;
}

export async function enqueueGoogleShoppingIncrementalSyncRequest(
  db: PgQueryable,
  input: Readonly<{
    listingId: string;
    reason: GoogleShoppingIncrementalSyncReason;
    requestedAt: string;
    debounceMs?: number;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO discovery_google_shopping_incremental_sync_requests (
       listing_id,
       reasons,
       requested_at,
       not_before,
       updated_at
     ) VALUES (
       $1,
       $2::jsonb,
       $3::timestamptz,
       $3::timestamptz + ($4::integer * interval '1 millisecond'),
       now()
     )
     ON CONFLICT (listing_id) DO UPDATE SET
       reasons = (
         SELECT COALESCE(jsonb_agg(DISTINCT reason ORDER BY reason), '[]'::jsonb)
         FROM jsonb_array_elements_text(discovery_google_shopping_incremental_sync_requests.reasons || EXCLUDED.reasons) AS reason
       ),
       requested_at = LEAST(discovery_google_shopping_incremental_sync_requests.requested_at, EXCLUDED.requested_at),
       not_before = GREATEST(discovery_google_shopping_incremental_sync_requests.not_before, EXCLUDED.not_before),
       updated_at = now()`,
    [
      input.listingId,
      JSON.stringify([input.reason]),
      input.requestedAt,
      input.debounceMs ?? DEFAULT_INCREMENTAL_SYNC_DEBOUNCE_MS,
    ],
  );
}

export async function drainDueGoogleShoppingIncrementalSyncRequests(
  db: PgQueryable,
  input: Readonly<{ limit: number; now?: string }> = { limit: 100 },
): Promise<GoogleShoppingIncrementalSyncRequest[]> {
  const result = await db.query<{ listing_id: string; reasons: unknown }>(
    `WITH due AS (
       SELECT listing_id
       FROM discovery_google_shopping_incremental_sync_requests
       WHERE not_before <= COALESCE($2::timestamptz, now())
       ORDER BY requested_at ASC, listing_id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM discovery_google_shopping_incremental_sync_requests AS request
     USING due
     WHERE request.listing_id = due.listing_id
     RETURNING request.listing_id, request.reasons`,
    [input.limit, input.now ?? null],
  );

  return result.rows.map((row) => ({
    listingId: row.listing_id,
    reasons: incrementalReasons(row.reasons),
  }));
}

async function loadListingFacts(db: PgQueryable, listingId: string): Promise<ListingFactsRow | null> {
  const result = await db.query<ListingFactsRow>(
    `SELECT
       listing.listing_id,
       listing.listing_slug,
       listing.account_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.ship_from_code,
       listing.price_amount,
       listing.shipping_allowance_percentage_bps,
       listing.quantity_cap,
       listing.status,
       account.seller_listing_availability_status,
       account.status AS seller_account_status,
       item.title AS catalog_title,
       item.subtitle AS catalog_subtitle,
       item.description AS catalog_description,
       item.status AS catalog_status,
       item.image_urls,
       item.product_asset_sets,
       item.image_fallback,
       item.product_schema
     FROM discovery_market_listings AS listing
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = listing.account_id
     LEFT JOIN discovery_item_detail_pages AS item
       ON item.catalog_item_id = listing.catalog_catalog_item_id
     WHERE listing.listing_id = $1`,
    [listingId],
  );

  return result.rows[0] ?? null;
}

async function upsertGoogleShoppingFeedRow(
  db: PgQueryable,
  facts: ListingFactsRow,
  row: GoogleShoppingMappedFeedRow,
): Promise<void> {
  await db.query(
    `INSERT INTO discovery_google_shopping_feed_rows (
       row_id,
       listing_id,
       account_id,
       catalog_catalog_item_id,
       product_id,
       merchant_offer_id,
       external_seller_id,
       canonical_url,
       target_country,
       content_language,
       feed_label,
       payload,
       payload_hash,
       eligibility_status,
       exclusion_reasons,
       image_eligibility_status,
       image_exclusion_reasons,
       shipping_policy_url,
       return_policy_url,
       return_policy_label,
       tombstone_status,
       updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'US', 'en', 'US', $9::jsonb, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18, now()
     )
     ON CONFLICT (row_id) DO UPDATE SET
       listing_id = EXCLUDED.listing_id,
       account_id = EXCLUDED.account_id,
       catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
       product_id = EXCLUDED.product_id,
       merchant_offer_id = EXCLUDED.merchant_offer_id,
       external_seller_id = EXCLUDED.external_seller_id,
       canonical_url = EXCLUDED.canonical_url,
       target_country = EXCLUDED.target_country,
       content_language = EXCLUDED.content_language,
       feed_label = EXCLUDED.feed_label,
       payload = EXCLUDED.payload,
       payload_hash = EXCLUDED.payload_hash,
       eligibility_status = EXCLUDED.eligibility_status,
       exclusion_reasons = EXCLUDED.exclusion_reasons,
       image_eligibility_status = EXCLUDED.image_eligibility_status,
       image_exclusion_reasons = EXCLUDED.image_exclusion_reasons,
       shipping_policy_url = EXCLUDED.shipping_policy_url,
       return_policy_url = EXCLUDED.return_policy_url,
       return_policy_label = EXCLUDED.return_policy_label,
       tombstone_status = EXCLUDED.tombstone_status,
       updated_at = now()`,
    [
      row.rowId,
      facts.listing_id,
      facts.account_id,
      facts.catalog_catalog_item_id,
      facts.product_id,
      row.merchantOfferId,
      row.externalSellerId,
      canonicalListingUrl(facts.listing_slug) ?? "",
      JSON.stringify(row.payload ?? {}),
      row.payloadHash,
      row.eligibility.status,
      JSON.stringify(row.eligibility.reasons),
      row.imageEligibility.status,
      JSON.stringify(row.imageEligibility.reasons),
      SHIPPING_POLICY_URL,
      RETURN_POLICY_URL,
      RETURN_POLICY_LABEL,
      facts.status === "withdrawn" ? "withdrawn" : "live",
    ],
  );
}

function selectedOptionsForGoogleShopping(value: unknown, productSchema: unknown): GoogleShoppingSelectedOption[] {
  const dimensionNames = productSchemaDimensionNames(productSchema);

  return arrayValue(value).flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const selection = entry as Record<string, unknown>;
    const dimensionId = stringValue(selection.dimensionId);
    const optionId = stringValue(selection.optionId);
    if (!dimensionId || !optionId) {
      return [];
    }

    return [
      {
        dimensionId,
        dimensionName: dimensionNames.get(dimensionId) ?? null,
        optionId,
        optionCode: stringValue(selection.optionCode),
        optionLabel: stringValue(selection.optionLabel),
        numericValue: numberValue(selection.numericValue),
      },
    ];
  });
}

function productSchemaDimensionNames(productSchema: unknown): Map<string, string> {
  const schema = objectValue(productSchema);
  const canonicalOrder = arrayValue(schema?.canonicalDimensionOrder);
  const dimensions = arrayValue(schema?.dimensions);
  const entries = [...canonicalOrder, ...dimensions].flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const id = stringValue(record.dimensionId);
    const name = stringValue(record.dimensionName);
    return id && name ? [[id, name] as const] : [];
  });

  return new Map(entries);
}

function productFormFromSchema(productSchema: unknown) {
  const schema = objectValue(productSchema);
  const productForm = stringValue(schema?.productForm);

  return productForm === "single" ||
    productForm === "graded" ||
    productForm === "sealed" ||
    productForm === "lot" ||
    productForm === "unknown"
    ? productForm
    : null;
}

function canonicalListingUrl(listingSlug: string | null): string | null {
  const slug = listingSlug?.trim();
  return slug ? `${MARKETPLACE_CANONICAL_ORIGIN}/listings/${encodeURIComponent(slug)}` : null;
}

function shippingAllowanceAmount(priceAmount: string, allowanceBps: number): string | null {
  const price = Number(priceAmount);
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  return Math.max(0, (price * allowanceBps) / 10_000).toFixed(2);
}

function incrementalReasons(value: unknown): GoogleShoppingIncrementalSyncReason[] {
  return stringArrayValue(value).filter((reason): reason is GoogleShoppingIncrementalSyncReason =>
    [
      "listing-created",
      "price",
      "availability",
      "visibility",
      "seller-availability",
      "catalog",
      "image",
      "canonical",
      "eligibility",
      "manual",
    ].includes(reason),
  );
}

function arrayValue(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function stringArrayValue(value: unknown): string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === "string");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
