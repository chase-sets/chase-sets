import { createHash } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { coerceLocalizedTextMap } from "@chase-sets/localization";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, ListingId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";

const DEFAULT_CANDIDATE_LIMIT = 50;

export type RepresentativeQueryResult<Row> = Readonly<{
  rows: Row[];
  rowCount?: number | null;
}>;

export type RepresentativeQueryable = Readonly<{
  query: <Row = unknown>(sql: string, params?: readonly unknown[]) => Promise<RepresentativeQueryResult<Row>>;
}>;

export type CatalogRepresentativeProductSchema = Readonly<{
  canonicalDimensionOrder: readonly Readonly<{ dimensionId: string; dimensionName: string }>[];
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionName: string;
    required: boolean;
    appliesWhen: readonly Readonly<{ dimensionId: string; optionIds: readonly string[] }>[];
    allowedOptions: readonly Readonly<{
      optionId: string;
      code: string;
      label_i18n?: unknown;
      label: string;
    }>[];
  }>[];
}>;

export type CatalogRepresentativeCatalogUsageCandidate = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string | null;
  blueprintId: string | null;
  status: "active";
  productSchema: CatalogRepresentativeProductSchema | null;
  productMeasureSnapshots: readonly ProductMeasureSnapshot[];
  updatedAt: string;
}>;

export type RepresentativeSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type CatalogRepresentativeServices = Readonly<{
  db: RepresentativeQueryable;
  productMeasures: Readonly<{
    resolveCatalogItemMeasures: (catalogItemId: string) => Promise<void>;
  }>;
}>;

export type InventoryRepresentativeCatalogCandidate = Readonly<{
  catalogItemId: string;
}>;

export type RepresentativeInventoryStockResult = Readonly<{
  catalogItemId: string;
  accountId: string;
  inventoryItemId: string;
  storageLocationId: string;
  selectedOptions: readonly RepresentativeSelectedOptionEntry[];
  totalQuantity: number;
  createdInventoryItem: boolean;
  adjustedQuantityBy: number;
}>;

export type RepresentativeInventoryServices = Readonly<{
  db: RepresentativeQueryable;
  catalogItems: Readonly<{
    getCatalogItem: (
      catalogItemId: string,
    ) => Promise<Readonly<{ status: string; product_schema: CatalogRepresentativeProductSchema | null }> | null>;
  }>;
  items: Readonly<{
    ensureListingStock: (
      params: Readonly<{
        accountId: AccountId;
        catalogItemId: string;
        selectedOptions: readonly RepresentativeSelectedOptionEntry[];
        quantity: number;
        shipFromCode?: string | null;
        shipFromAddress?: AddressSnapshot | null;
      }>,
      context: EventStoreContext,
    ) => Promise<
      Readonly<{
        inventoryItemId: string;
        storageLocationId: string;
        snapshot: Readonly<{
          selectedOptions: readonly RepresentativeSelectedOptionEntry[];
          totalQuantity: number;
        }>;
        createdInventoryItem: boolean;
        adjustedQuantityBy: number;
      }>
    >;
  }>;
}>;

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
  selectedOptions: readonly RepresentativeSelectedOptionEntry[];
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

export type RepresentativeListingPhotoUpload = Readonly<{
  body: Uint8Array;
  contentType: string;
  originalFilename: string | null;
  altText?: string | null;
}>;

export type RepresentativeMarketplaceServices = Readonly<{
  db: RepresentativeQueryable;
  listings: Readonly<{
    createListing: (
      params: Readonly<{
        accountId: AccountId;
        inventoryItemId: string;
        priceAmount: string;
        quantityCap: number;
        listingIdOverride?: ListingId;
        listingPhotoUploads?: readonly RepresentativeListingPhotoUpload[] | null;
      }>,
      context: EventStoreContext,
    ) => Promise<Readonly<{ listingId: string; version: number; feeQuoteFingerprint: string }>>;
    publishListing: (
      params: Readonly<{ accountId: AccountId; listingId: string; feeQuoteFingerprint: string }>,
      context: EventStoreContext,
    ) => Promise<Readonly<{ listingId: string; version: number }>>;
  }>;
  offers: Readonly<{
    submitOffer: (
      params: Readonly<{
        offerId: string;
        buyerAccountId: AccountId;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        selectedOptions: readonly RepresentativeSelectedOptionEntry[];
        productSummary: string | null;
        shippingDestinationSnapshot: AddressSnapshot;
        priceAmount: string;
        quantityRequested: number;
      }>,
      context: EventStoreContext,
    ) => Promise<Readonly<{ offerId: string; version: number }>>;
    previewOfferAcceptanceTerms: (
      params: Readonly<{ offerId: string; sellerAccountId: AccountId }>,
    ) => Promise<Readonly<{ fee_quote_fingerprint: string }>>;
    acceptOffer: (
      params: Readonly<{ offerId: string; sellerAccountId: AccountId; feeQuoteFingerprint: string }>,
      context: EventStoreContext,
    ) => Promise<Readonly<{ offerId: string; version: number }>>;
  }>;
}>;

export type DiscoveryRepresentativeMarketStateInput = Readonly<{
  listingIds: readonly string[];
  offerIds: readonly string[];
  existingRepresentativeLimit?: number;
}>;

export type DiscoveryRepresentativeMarketStateServices = Readonly<{
  discoveryDb: RepresentativeQueryable;
  marketplaceDb: RepresentativeQueryable;
}>;

export type DiscoveryRepresentativeMarketStateResult = Readonly<{
  accountCount: number;
  listingCount: number;
  offerCount: number;
}>;

export type OrderingRepresentativeSupplyStateInput = Readonly<{
  listingIds: readonly string[];
  existingRepresentativeLimit?: number;
}>;

export type OrderingRepresentativeSupplyStateServices = Readonly<{
  inventoryDb: RepresentativeQueryable;
  marketplaceDb: RepresentativeQueryable;
  orderingDb: RepresentativeQueryable;
}>;

export type OrderingRepresentativeSupplyStateResult = Readonly<{
  listingCount: number;
  inventoryItemCount: number;
  inventoryHoldCount: number;
}>;

type DimensionRule = Readonly<{
  dimensionId: string;
  required: boolean;
  allowedOptionIds?: readonly string[];
  appliesWhen?: readonly Readonly<{ dimensionId: string; optionIds?: readonly string[] }>[];
}>;

type CatalogBlueprintRow = Readonly<{
  blueprint_id: string;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type CatalogChoiceRow = Readonly<{
  option_id: string;
  code: string;
  label_i18n: unknown;
  label: string;
}>;

type CatalogRepresentativeCatalogItemRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  status: string;
  product_measure_snapshots: unknown;
  updated_at: string | Date;
}>;

type RepresentativeSellingAccount = Readonly<{
  accountId: AccountId;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
}>;

type MarketplaceCatalogItemRow = Readonly<{
  title: string;
  subtitle: string | null;
  status: string;
  product_schema: unknown;
}>;

type MarketplaceAccountRow = Readonly<{
  account_id: string;
  display_name: string;
  status: string;
  average_rating: string | null;
  review_count: number;
  rating_1_count: number;
  rating_2_count: number;
  rating_3_count: number;
  rating_4_count: number;
  rating_5_count: number;
  reputation_updated_at: string | Date | null;
  seller_listing_availability_status: "available" | "unavailable";
  seller_listing_availability_reason_category: string | null;
  seller_listing_available_again_on: string | Date | null;
  updated_at: string | Date;
}>;

type MarketplaceListingRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  product_measure_snapshot: unknown;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: unknown;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | Date | null;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  seller_listing_availability_status: "available" | "unavailable";
  seller_listing_availability_updated_at: string | Date;
  supply_total_quantity: number | null;
  active_held_quantity: number | null;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}>;

type InventoryItemRow = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  total_quantity: number;
  updated_at: string | Date;
  last_stream_version: number | string | null;
}>;

type InventoryHoldRow = Readonly<{
  hold_id: string;
  account_id: string;
  item_id: string;
  quantity: number;
  status: string;
  released_at: string | Date | null;
  updated_at: string | Date;
  last_stream_version: number | string | null;
}>;

type MarketplaceOfferRow = Readonly<{
  offer_id: string;
  buyer_account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  selected_options: unknown;
  product_summary: string | null;
  price_amount: string;
  quantity_requested: number;
  status: string;
  accepted_seller_account_id: string | null;
  accepted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}>;

type DiscoverySlugEntityKind = "listing" | "product" | "account";

const representativeSeedContext: EventStoreContext = {
  tenantId: "tnt_identity" as TenantId,
  audit: {
    performedByUserId: "usr_repr_support_ops_user" as UserId,
    forAccountId: "acc_repr_support_ops_account" as AccountId,
  },
};

const representativeSellingAccounts: readonly RepresentativeSellingAccount[] = [
  {
    accountId: "acc_repr_card_vault_account" as AccountId,
    shipFromCode: "STL-VAULT-REP",
    shipFromAddress: {
      name: "Card Vault Fulfillment",
      company: "Card Vault",
      line1: "720 Olive St",
      line2: "Suite 900",
      city: "Saint Louis",
      state: "MO",
      postalCode: "63101",
      country: "US",
      phone: "3145550203",
      email: "staging-card-vault@chasesets.test",
    },
  },
  {
    accountId: "acc_repr_sealed_stockroom_account" as AccountId,
    shipFromCode: "IND-SEALED-REP",
    shipFromAddress: {
      name: "Sealed Stockroom Fulfillment",
      company: "Sealed Stockroom",
      line1: "200 S Meridian St",
      line2: null,
      city: "Indianapolis",
      state: "IN",
      postalCode: "46225",
      country: "US",
      phone: "3175550204",
      email: "sealed-stockroom@chasesets.test",
    },
  },
];

const REPRESENTATIVE_LISTING_PHOTO_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVR4nGP4+v0XSYhhVMP30VD6OlyTBgBwoOYfM6LZAAAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export async function prepareRepresentativeCatalogUsageCandidates(
  services: CatalogRepresentativeServices,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const limit = normalizeRepresentativeCatalogCandidateLimit(options.limit);
  const currentCandidateIds = await loadCurrentRepresentativeCatalogItemIds(services.db, { limit });

  for (const catalogItemId of currentCandidateIds) {
    await services.productMeasures.resolveCatalogItemMeasures(catalogItemId);
  }

  return loadRepresentativeCatalogUsageCandidates(services.db, { limit });
}

export async function prepareRepresentativeCatalogUsageCandidatesByIds(
  services: CatalogRepresentativeServices,
  catalogItemIds: readonly string[],
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const requiredCatalogItemIds = uniqueTextValues(catalogItemIds);
  for (const catalogItemId of requiredCatalogItemIds) {
    await services.productMeasures.resolveCatalogItemMeasures(catalogItemId);
  }

  const candidates = await loadRepresentativeCatalogUsageCandidatesByIds(services.db, requiredCatalogItemIds);
  const preparedCatalogItemIds = new Set(candidates.map((candidate) => candidate.catalogItemId));
  if (requiredCatalogItemIds.some((catalogItemId) => !preparedCatalogItemIds.has(catalogItemId))) {
    throw new Error(
      "Required representative Product Contents Catalog Items are not active with resolved product measures.",
    );
  }
  return candidates;
}

export async function loadRepresentativeCatalogUsageCandidates(
  db: RepresentativeQueryable,
  options: Readonly<{ limit?: number }> = {},
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const limit = normalizeRepresentativeCatalogCandidateLimit(options.limit);
  const result = await db.query<CatalogRepresentativeCatalogItemRow>(
    `SELECT
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       COALESCE(
         jsonb_agg(measure.measure_snapshot ORDER BY measure.product_id)
           FILTER (WHERE measure.measure_snapshot IS NOT NULL),
         '[]'::jsonb
       ) AS product_measure_snapshots,
       item.updated_at
     FROM catalog_items item
     JOIN catalog_resolved_product_measures measure
       ON measure.catalog_item_id = item.catalog_item_id
      AND measure.measure_snapshot IS NOT NULL
     WHERE item.status = 'active'
     GROUP BY
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       item.updated_at
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC
     LIMIT $1`,
    [limit],
  );

  const productSchemaByBlueprintId = await loadProductSchemasByBlueprintId(db, [
    ...new Set(result.rows.map((row) => row.blueprint_id).filter((id): id is string => Boolean(id))),
  ]);

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    languageCode: row.language_code,
    title: row.title,
    subtitle: row.subtitle,
    blueprintId: row.blueprint_id,
    status: "active",
    productSchema: row.blueprint_id ? (productSchemaByBlueprintId.get(row.blueprint_id) ?? null) : null,
    productMeasureSnapshots: parseProductMeasureSnapshots(row.product_measure_snapshots),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function loadRepresentativeCatalogUsageCandidatesByIds(
  db: RepresentativeQueryable,
  catalogItemIds: readonly string[],
): Promise<readonly CatalogRepresentativeCatalogUsageCandidate[]> {
  const requiredCatalogItemIds = uniqueTextValues(catalogItemIds);
  if (requiredCatalogItemIds.length === 0) {
    return [];
  }

  const result = await db.query<CatalogRepresentativeCatalogItemRow>(
    `SELECT
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       COALESCE(
         jsonb_agg(measure.measure_snapshot ORDER BY measure.product_id)
           FILTER (WHERE measure.measure_snapshot IS NOT NULL),
         '[]'::jsonb
       ) AS product_measure_snapshots,
       item.updated_at
     FROM catalog_items item
     JOIN catalog_resolved_product_measures measure
       ON measure.catalog_item_id = item.catalog_item_id
      AND measure.measure_snapshot IS NOT NULL
     WHERE item.status = 'active'
       AND item.catalog_item_id = ANY($1::text[])
     GROUP BY
       item.catalog_item_id,
       item.language_code,
       item.title,
       item.subtitle,
       item.blueprint_id,
       item.status,
       item.updated_at
     ORDER BY array_position($1::text[], item.catalog_item_id)`,
    [requiredCatalogItemIds],
  );

  const productSchemaByBlueprintId = await loadProductSchemasByBlueprintId(db, [
    ...new Set(result.rows.map((row) => row.blueprint_id).filter((id): id is string => Boolean(id))),
  ]);

  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    languageCode: row.language_code,
    title: row.title,
    subtitle: row.subtitle,
    blueprintId: row.blueprint_id,
    status: "active",
    productSchema: row.blueprint_id ? (productSchemaByBlueprintId.get(row.blueprint_id) ?? null) : null,
    productMeasureSnapshots: parseProductMeasureSnapshots(row.product_measure_snapshots),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export function prioritizeRepresentativeCatalogUsageCandidates(
  requiredCandidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
  currentCandidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
): readonly CatalogRepresentativeCatalogUsageCandidate[] {
  const candidatesById = new Map<string, CatalogRepresentativeCatalogUsageCandidate>();
  for (const candidate of [...requiredCandidates, ...currentCandidates]) {
    if (!candidatesById.has(candidate.catalogItemId)) {
      candidatesById.set(candidate.catalogItemId, candidate);
    }
  }
  return [...candidatesById.values()];
}

export function normalizeRepresentativeCatalogCandidateLimit(value: number | undefined): number {
  return normalizeRepresentativeCandidateLimit(value);
}

export async function ensureRepresentativeInventoryStock(
  services: RepresentativeInventoryServices,
  candidates: readonly InventoryRepresentativeCatalogCandidate[],
  options: Readonly<{ quantityPerItem?: number }> = {},
): Promise<readonly RepresentativeInventoryStockResult[]> {
  const quantityPerItem = normalizeRepresentativeQuantity(options.quantityPerItem);
  const results: RepresentativeInventoryStockResult[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const catalogItem = await services.catalogItems.getCatalogItem(candidate.catalogItemId);
    if (!catalogItem || catalogItem.status !== "active") {
      continue;
    }

    const seller = representativeSellingAccounts[
      index % representativeSellingAccounts.length
    ] as RepresentativeSellingAccount;
    const selectedOptions = selectDefaultRepresentativeOptions(catalogItem.product_schema);
    const result = await services.items.ensureListingStock(
      {
        accountId: seller.accountId,
        catalogItemId: candidate.catalogItemId,
        selectedOptions,
        quantity: quantityPerItem,
        shipFromCode: seller.shipFromCode,
        shipFromAddress: seller.shipFromAddress,
      },
      representativeSeedContext,
    );

    results.push({
      catalogItemId: candidate.catalogItemId,
      accountId: seller.accountId,
      inventoryItemId: result.inventoryItemId,
      storageLocationId: result.storageLocationId,
      selectedOptions: result.snapshot.selectedOptions,
      totalQuantity: result.snapshot.totalQuantity,
      createdInventoryItem: result.createdInventoryItem,
      adjustedQuantityBy: result.adjustedQuantityBy,
    });
  }

  return results;
}

export async function reconcileRepresentativeInventoryCatalogItems(
  services: Pick<RepresentativeInventoryServices, "db">,
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
): Promise<number> {
  for (const candidate of candidates) {
    await services.db.query(
      `INSERT INTO inventory_catalog_items (
         catalog_item_id,
         language_code,
         title,
         subtitle,
         blueprint_id,
         status,
         product_schema,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (catalog_item_id) DO UPDATE SET
         language_code = EXCLUDED.language_code,
         title = EXCLUDED.title,
         subtitle = EXCLUDED.subtitle,
         blueprint_id = EXCLUDED.blueprint_id,
         status = EXCLUDED.status,
         product_schema = EXCLUDED.product_schema,
         updated_at = EXCLUDED.updated_at`,
      [
        candidate.catalogItemId,
        candidate.languageCode,
        candidate.title,
        candidate.subtitle,
        candidate.blueprintId,
        candidate.status,
        candidate.productSchema ? JSON.stringify(candidate.productSchema) : null,
        candidate.updatedAt,
      ],
    );
  }

  return candidates.length;
}

export function selectDefaultRepresentativeOptions(
  productSchema: CatalogRepresentativeProductSchema | null,
): readonly RepresentativeSelectedOptionEntry[] {
  if (!productSchema || productSchema.dimensions.length === 0) {
    return [];
  }

  return recordToSelectionEntries(
    productSchema,
    normalizeSelectedOptionsForSchema(productSchema, selectRepresentativePreferredOptions(productSchema)),
  );
}

export async function loadUntouchedMarketplaceCatalogUsageCandidates(
  db: RepresentativeQueryable,
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
  db: RepresentativeQueryable,
  candidates: readonly CatalogRepresentativeCatalogUsageCandidate[],
  options: Readonly<{ limit?: number; priorityCatalogItemIds?: readonly string[] }> = {},
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
  const priorityCatalogItemIds = new Set(uniqueTextValues(options.priorityCatalogItemIds ?? []));
  const priorityCandidates = candidates.filter((candidate) => priorityCatalogItemIds.has(candidate.catalogItemId));
  const untouchedCandidates = candidates
    .filter(
      (candidate) =>
        !priorityCatalogItemIds.has(candidate.catalogItemId) && !touchedCatalogItemIds.has(candidate.catalogItemId),
    )
    .slice(0, limit);

  return [...priorityCandidates, ...untouchedCandidates];
}

export async function reconcileRepresentativeMarketplaceCatalogItems(
  db: RepresentativeQueryable,
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
  services: RepresentativeMarketplaceServices,
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
        listingPhotoUploads: buildRepresentativeListingPhotoUpload(listingId),
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
  services: RepresentativeMarketplaceServices,
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

    const product = createRepresentativeProductDescriptor({
      catalogItemId: stock.catalogItemId,
      productSchema: catalogItem.product_schema,
      selection: stock.selectedOptions,
    });

    const submitted = await services.offers.submitOffer(
      {
        offerId,
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
  services: RepresentativeMarketplaceServices,
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
        offerId,
        sellerAccountId: stock.accountId as AccountId,
      });
      await services.offers.acceptOffer(
        {
          offerId,
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

export async function reconcileRepresentativeDiscoveryMarketState(
  services: DiscoveryRepresentativeMarketStateServices,
  input: DiscoveryRepresentativeMarketStateInput,
): Promise<DiscoveryRepresentativeMarketStateResult> {
  const explicitListingIds = uniqueTextValues(input.listingIds);
  const explicitOfferIds = uniqueTextValues(input.offerIds);
  const existingRepresentativeLimit = normalizeRepresentativeCandidateLimit(input.existingRepresentativeLimit);
  const [listingIds, offerIds] = await Promise.all([
    explicitListingIds.length > 0
      ? Promise.resolve(explicitListingIds)
      : loadExistingRepresentativeMarketplaceListingIds(services.marketplaceDb, {
          limit: existingRepresentativeLimit,
        }),
    explicitOfferIds.length > 0
      ? Promise.resolve(explicitOfferIds)
      : loadExistingRepresentativeMarketplaceOfferIds(services.marketplaceDb, {
          limit: existingRepresentativeLimit,
        }),
  ]);
  const [listings, offers] = await Promise.all([
    loadMarketplaceListings(services.marketplaceDb, listingIds),
    loadMarketplaceOffers(services.marketplaceDb, offerIds),
  ]);
  const accountIds = uniqueTextValues([
    ...listings.map((listing) => listing.account_id),
    ...offers.map((offer) => offer.buyer_account_id),
    ...offers.flatMap((offer) => (offer.accepted_seller_account_id ? [offer.accepted_seller_account_id] : [])),
  ]);

  await reconcileAccounts(services, accountIds);
  await reconcileListings(services.discoveryDb, listings);
  await reconcileOffers(services.discoveryDb, offers);

  return {
    accountCount: accountIds.length,
    listingCount: listings.length,
    offerCount: offers.length,
  };
}

export async function reconcileRepresentativeOrderingSupplyState(
  services: OrderingRepresentativeSupplyStateServices,
  input: OrderingRepresentativeSupplyStateInput,
): Promise<OrderingRepresentativeSupplyStateResult> {
  const explicitListingIds = uniqueTextValues(input.listingIds);
  const existingRepresentativeLimit = normalizeRepresentativeCandidateLimit(input.existingRepresentativeLimit);
  const listingIds =
    explicitListingIds.length > 0
      ? explicitListingIds
      : await loadExistingRepresentativeMarketplaceListingIds(services.marketplaceDb, {
          limit: existingRepresentativeLimit,
        });
  const listings = await loadMarketplaceListings(services.marketplaceDb, listingIds);
  const inventoryItemIds = uniqueTextValues(listings.map((listing) => listing.inventory_item_id));
  const [inventoryItems, inventoryHolds] = await Promise.all([
    loadInventoryItems(services.inventoryDb, inventoryItemIds),
    loadInventoryHolds(services.inventoryDb, inventoryItemIds),
  ]);

  await reconcileOrderingSellerListingAvailabilityInputs(services.orderingDb, listings);
  await reconcileOrderingMarketplaceListingInputs(services.orderingDb, listings);
  await reconcileOrderingInventoryItemInputs(services.orderingDb, inventoryItems);
  await reconcileOrderingInventoryHoldInputs(services.orderingDb, inventoryItemIds, inventoryHolds);

  return {
    listingCount: listings.length,
    inventoryItemCount: inventoryItems.length,
    inventoryHoldCount: inventoryHolds.length,
  };
}

async function loadExistingRepresentativeMarketplaceListingIds(
  db: RepresentativeQueryable,
  options: Readonly<{ limit: number }>,
): Promise<readonly string[]> {
  const result = await db.query<{ listing_id: string }>(
    `SELECT listing.listing_id
     FROM marketplace_listing_pages AS listing
     WHERE listing.listing_id LIKE 'lst$_repr$_%' ESCAPE '$'
       AND listing.status = 'active'
     ORDER BY listing.updated_at DESC, listing.listing_id ASC
     LIMIT $1`,
    [options.limit],
  );

  return result.rows.map((row) => row.listing_id);
}

async function loadExistingRepresentativeMarketplaceOfferIds(
  db: RepresentativeQueryable,
  options: Readonly<{ limit: number }>,
): Promise<readonly string[]> {
  const result = await db.query<{ offer_id: string }>(
    `SELECT offer.offer_id
     FROM marketplace_offer_pages AS offer
     WHERE offer.offer_id LIKE 'off$_repr$_%' ESCAPE '$'
       AND offer.status IN ('submitted', 'accepted')
     ORDER BY offer.updated_at DESC, offer.offer_id ASC
     LIMIT $1`,
    [options.limit],
  );

  return result.rows.map((row) => row.offer_id);
}

async function loadCurrentRepresentativeCatalogItemIds(
  db: RepresentativeQueryable,
  options: Readonly<{ limit: number }>,
): Promise<readonly string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT item.catalog_item_id
     FROM catalog_items item
     WHERE item.status = 'active'
       AND NOT EXISTS (
         SELECT 1
         FROM catalog_resolved_product_measures measure
         WHERE measure.catalog_item_id = item.catalog_item_id
           AND measure.measure_snapshot IS NOT NULL
       )
     ORDER BY item.updated_at DESC, item.catalog_item_id ASC
     LIMIT $1`,
    [options.limit],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

async function loadProductSchemasByBlueprintId(
  db: RepresentativeQueryable,
  blueprintIds: readonly string[],
): Promise<ReadonlyMap<string, CatalogRepresentativeProductSchema>> {
  if (blueprintIds.length === 0) {
    return new Map();
  }

  const blueprintResult = await db.query<CatalogBlueprintRow>(
    `SELECT blueprint_id, dimension_rules, canonical_dimension_order
     FROM catalog_blueprints
     WHERE blueprint_id = ANY($1::text[])`,
    [blueprintIds],
  );

  const dimensionRules = blueprintResult.rows.flatMap((row) => asArray<DimensionRule>(row.dimension_rules));
  const canonicalDimensionOrder = blueprintResult.rows.flatMap((row) => asStringArray(row.canonical_dimension_order));
  const dimensionIds = [
    ...new Set([
      ...dimensionRules.map((rule) => rule.dimensionId),
      ...dimensionRules.flatMap((rule) => (rule.appliesWhen ?? []).map((clause) => clause.dimensionId)),
      ...canonicalDimensionOrder,
    ]),
  ];
  const optionIds = [
    ...new Set(
      dimensionRules.flatMap((rule) => [
        ...(rule.allowedOptionIds ?? []),
        ...(rule.appliesWhen ?? []).flatMap((clause) => clause.optionIds ?? []),
      ]),
    ),
  ];

  const [dimensionNameById, optionRows] = await Promise.all([
    loadNameMap(db, "catalog_dimensions", "dimension_id", "name", dimensionIds),
    optionIds.length > 0
      ? db
          .query<CatalogChoiceRow>(
            `SELECT option_id, code, label_i18n, label
             FROM catalog_dimension_options
             WHERE option_id = ANY($1::text[])`,
            [optionIds],
          )
          .then((result) => result.rows)
      : Promise.resolve([] as CatalogChoiceRow[]),
  ]);
  const optionById = new Map(optionRows.map((row) => [row.option_id, row]));

  return new Map(
    blueprintResult.rows.map((blueprint) => {
      const rules = asArray<DimensionRule>(blueprint.dimension_rules);
      const order = asStringArray(blueprint.canonical_dimension_order);

      return [
        blueprint.blueprint_id,
        {
          canonicalDimensionOrder: order.map((dimensionId) => ({
            dimensionId,
            dimensionName: dimensionNameById.get(dimensionId) ?? dimensionId,
          })),
          dimensions: rules.map((rule) => ({
            dimensionId: rule.dimensionId,
            dimensionName: dimensionNameById.get(rule.dimensionId) ?? rule.dimensionId,
            required: Boolean(rule.required),
            appliesWhen: (rule.appliesWhen ?? []).map((clause) => ({
              dimensionId: clause.dimensionId,
              optionIds: [...(clause.optionIds ?? [])],
            })),
            allowedOptions: (rule.allowedOptionIds ?? []).map((optionId) => {
              const option = optionById.get(optionId);

              return {
                optionId,
                code: option?.code ?? optionId,
                label_i18n: option?.label_i18n ?? coerceLocalizedTextMap(option?.label ?? optionId),
                label: option?.label ?? option?.code ?? optionId,
              };
            }),
          })),
        },
      ] as const;
    }),
  );
}

async function loadNameMap(
  db: RepresentativeQueryable,
  table: string,
  idColumn: string,
  nameColumn: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const result = await db.query<Record<string, string>>(
    `SELECT ${idColumn} AS id, ${nameColumn} AS name FROM ${table} WHERE ${idColumn} = ANY($1::text[])`,
    [ids],
  );

  return new Map(result.rows.map((row) => [row.id, row.name]));
}

function parseProductMeasureSnapshots(value: unknown): ProductMeasureSnapshot[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is ProductMeasureSnapshot => typeof entry === "object" && entry !== null)
    : [];
}

function selectRepresentativePreferredOptions(
  productSchema: CatalogRepresentativeProductSchema,
): Record<string, string> {
  const formDimension = productSchema.dimensions.find(
    (dimension) => isLikelyFormDimension(dimension) && dimension.allowedOptions.some(isRawOption),
  );

  if (!formDimension) {
    return {};
  }

  const rawOption = formDimension.allowedOptions.find(isRawOption);
  if (!rawOption) {
    return {};
  }

  return {
    [formDimension.dimensionId]: rawOption.optionId,
  };
}

function normalizeSelectedOptionsForSchema(
  schema: CatalogRepresentativeProductSchema,
  selections: Record<string, string>,
): Record<string, string> {
  const nextSelections = { ...selections };

  for (const dimension of getOrderedDimensions(schema)) {
    const active = isDimensionActive(dimension, nextSelections);

    if (!active) {
      delete nextSelections[dimension.dimensionId];
      continue;
    }

    const allowedOptionIds = dimension.allowedOptions.map((option) => option.optionId);
    const selectedOptionId = nextSelections[dimension.dimensionId];

    if (selectedOptionId !== undefined && allowedOptionIds.includes(selectedOptionId)) {
      continue;
    }

    if (dimension.required && allowedOptionIds.length > 0) {
      nextSelections[dimension.dimensionId] = allowedOptionIds[0];
      continue;
    }

    delete nextSelections[dimension.dimensionId];
  }

  return nextSelections;
}

function recordToSelectionEntries(
  schema: CatalogRepresentativeProductSchema,
  selections: Record<string, string>,
): RepresentativeSelectedOptionEntry[] {
  return getOrderedDimensions(schema)
    .map((dimension) => {
      const optionId = selections[dimension.dimensionId];
      if (!optionId) {
        return null;
      }

      return {
        dimensionId: dimension.dimensionId,
        optionId,
      };
    })
    .filter((entry): entry is RepresentativeSelectedOptionEntry => entry !== null);
}

function getOrderedDimensions(
  schema: CatalogRepresentativeProductSchema,
): CatalogRepresentativeProductSchema["dimensions"][number][] {
  return schema.canonicalDimensionOrder
    .map((order) => schema.dimensions.find((dimension) => dimension.dimensionId === order.dimensionId))
    .filter(
      (dimension): dimension is CatalogRepresentativeProductSchema["dimensions"][number] => dimension !== undefined,
    );
}

function isDimensionActive(
  dimension: CatalogRepresentativeProductSchema["dimensions"][number],
  selections: Record<string, string>,
): boolean {
  return dimension.appliesWhen.every((clause) => {
    const selectedOptionId = selections[clause.dimensionId];
    return selectedOptionId !== undefined && clause.optionIds.includes(selectedOptionId);
  });
}

function isLikelyFormDimension(dimension: CatalogRepresentativeProductSchema["dimensions"][number]): boolean {
  const dimensionText = `${dimension.dimensionId} ${dimension.dimensionName}`;
  return matchesMeaning(dimensionText, "form") || dimension.allowedOptions.some(isGradedOption);
}

function isRawOption(
  option: CatalogRepresentativeProductSchema["dimensions"][number]["allowedOptions"][number],
): boolean {
  return matchesMeaning(`${option.optionId} ${option.code} ${option.label}`, "raw", "ungraded");
}

function isGradedOption(
  option: CatalogRepresentativeProductSchema["dimensions"][number]["allowedOptions"][number],
): boolean {
  return matchesMeaning(`${option.optionId} ${option.code} ${option.label}`, "graded");
}

function matchesMeaning(value: string, ...terms: readonly string[]): boolean {
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return terms.some((term) => tokens.includes(term));
}

function normalizeRepresentativeQuantity(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return 4;
  }

  return Math.max(1, Math.min(Math.trunc(value), 100));
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

async function getListingStatus(db: RepresentativeQueryable, listingId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status
     FROM marketplace_listing_pages
     WHERE listing_id = $1`,
    [listingId],
  );

  return result.rows[0]?.status ?? null;
}

async function getOfferStatus(db: RepresentativeQueryable, offerId: string): Promise<string | null> {
  const result = await db.query<{ status: string }>(
    `SELECT status
     FROM marketplace_offer_pages
     WHERE offer_id = $1`,
    [offerId],
  );

  return result.rows[0]?.status ?? null;
}

async function getMarketplaceCatalogItem(
  db: RepresentativeQueryable,
  catalogItemId: string,
): Promise<{
  title: string;
  subtitle: string | null;
  status: string;
  product_schema: CatalogRepresentativeProductSchema | null;
} | null> {
  const result = await db.query<MarketplaceCatalogItemRow>(
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
        ? (row.product_schema as CatalogRepresentativeProductSchema)
        : null,
  };
}

function createRepresentativeProductDescriptor(
  input: Readonly<{
    catalogItemId: string;
    productSchema: CatalogRepresentativeProductSchema | null;
    selection: readonly RepresentativeSelectedOptionEntry[];
  }>,
): Readonly<{ productId: string; selection: RepresentativeSelectedOptionEntry[] }> {
  const catalogItemId = normalizeRequiredText(input.catalogItemId, "Catalog item id is required.");
  const schema = input.productSchema;
  const selection = normalizeSelectedOptions(input.selection);

  if (!schema || schema.dimensions.length === 0) {
    assert(selection.length === 0, "Selection is not allowed for this catalog item.");
    return {
      productId: `${catalogItemId}::`,
      selection: [],
    };
  }

  const selections = selectionEntriesToRecord(selection);

  for (const dimension of getOrderedDimensions(schema)) {
    const active = isDimensionActive(dimension, selections);
    const selectedOptionId = selections[dimension.dimensionId];

    if (!active) {
      assert(selectedOptionId === undefined, "Selection cannot include inactive dimensions.");
      continue;
    }

    if (selectedOptionId === undefined) {
      assert(!dimension.required, `Selection must include ${dimension.dimensionName}.`);
      continue;
    }

    assert(
      dimension.allowedOptions.some((option) => option.optionId === selectedOptionId),
      `Selection must use an allowed option for ${dimension.dimensionName}.`,
    );
  }

  assert(
    selection.every((entry) => schema.dimensions.some((dimension) => dimension.dimensionId === entry.dimensionId)),
    "Selection cannot include unknown dimensions.",
  );

  return {
    productId: `${catalogItemId}::${schema.canonicalDimensionOrder
      .map((entry) => `${entry.dimensionId}:${selections[entry.dimensionId] ?? "-"}`)
      .join("|")}`,
    selection: recordToSelectionEntries(schema, selections),
  };
}

function summarizeRepresentativeSelectedOptions(
  productSchema: CatalogRepresentativeProductSchema | null,
  selection: readonly RepresentativeSelectedOptionEntry[],
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

function buildRepresentativeListingPhotoUpload(listingId: string): readonly RepresentativeListingPhotoUpload[] {
  return [
    {
      body: REPRESENTATIVE_LISTING_PHOTO_PNG,
      contentType: "image/png",
      originalFilename: `${listingId}-representative-condition.png`,
      altText: "Representative staging listing condition evidence photo",
    },
  ];
}

async function loadMarketplaceListings(
  db: RepresentativeQueryable,
  listingIds: readonly string[],
): Promise<readonly MarketplaceListingRow[]> {
  if (listingIds.length === 0) {
    return [];
  }

  const result = await db.query<MarketplaceListingRow>(
    `SELECT
       listing.listing_id,
       listing.account_id,
       listing.inventory_item_id,
       listing.catalog_catalog_item_id,
       listing.product_id,
       listing.item_title,
       listing.item_subtitle,
       listing.selected_options,
       listing.product_summary,
       listing.product_measure_snapshot,
       listing.storage_location_name,
       listing.ship_from_code,
       listing.ship_from_address,
       listing.price_amount::text AS price_amount,
       listing.marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       listing.seller_net_unit_amount::text AS seller_net_unit_amount,
       listing.shipping_allowance_percentage_bps,
       listing.terms_schedule_id,
       listing.terms_agreement_id,
       listing.terms_resolved_at::text AS terms_resolved_at,
       listing.quantity_cap,
       listing.max_units_per_order,
       listing.max_units_per_day,
       listing.max_units_per_customer_account,
       COALESCE(availability.status, 'available') AS seller_listing_availability_status,
       COALESCE(availability.updated_at, listing.updated_at)::text AS seller_listing_availability_updated_at,
       supply.total_quantity AS supply_total_quantity,
       CASE
         WHEN supply.item_id IS NULL THEN NULL
         ELSE COALESCE(active_holds.held_quantity, 0)::integer
       END AS active_held_quantity,
       listing.status,
       listing.created_at::text AS created_at,
       listing.updated_at::text AS updated_at
     FROM marketplace_listing_pages AS listing
     LEFT JOIN marketplace_supply_items AS supply
       ON supply.item_id = listing.inventory_item_id
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = listing.account_id
     LEFT JOIN (
       SELECT item_id, SUM(quantity)::integer AS held_quantity
       FROM marketplace_supply_holds
       WHERE status = 'active'
       GROUP BY item_id
     ) AS active_holds
       ON active_holds.item_id = listing.inventory_item_id
     WHERE listing.listing_id = ANY($1::text[])
     ORDER BY listing.updated_at DESC, listing.listing_id ASC`,
    [listingIds],
  );

  return result.rows;
}

async function loadInventoryItems(
  db: RepresentativeQueryable,
  inventoryItemIds: readonly string[],
): Promise<readonly InventoryItemRow[]> {
  if (inventoryItemIds.length === 0) {
    return [];
  }

  const result = await db.query<InventoryItemRow>(
    `SELECT
       item.item_id,
       item.account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       item.total_quantity,
       item.updated_at::text AS updated_at,
       item.last_stream_version::text AS last_stream_version
     FROM inventory_items AS item
     WHERE item.item_id = ANY($1::text[])
     ORDER BY item.updated_at DESC, item.item_id ASC`,
    [inventoryItemIds],
  );

  return result.rows;
}

async function loadInventoryHolds(
  db: RepresentativeQueryable,
  inventoryItemIds: readonly string[],
): Promise<readonly InventoryHoldRow[]> {
  if (inventoryItemIds.length === 0) {
    return [];
  }

  const result = await db.query<InventoryHoldRow>(
    `SELECT
       hold.hold_id,
       hold.account_id,
       hold.item_id,
       hold.quantity,
       hold.status,
       hold.released_at::text AS released_at,
       hold.updated_at::text AS updated_at,
       hold.last_stream_version::text AS last_stream_version
     FROM inventory_holds AS hold
     WHERE hold.item_id = ANY($1::text[])
     ORDER BY hold.updated_at DESC, hold.hold_id ASC`,
    [inventoryItemIds],
  );

  return result.rows;
}

async function loadMarketplaceOffers(
  db: RepresentativeQueryable,
  offerIds: readonly string[],
): Promise<readonly MarketplaceOfferRow[]> {
  if (offerIds.length === 0) {
    return [];
  }

  const result = await db.query<MarketplaceOfferRow>(
    `SELECT
       offer.offer_id,
       offer.buyer_account_id,
       offer.catalog_catalog_item_id,
       offer.product_id,
       offer.item_title,
       offer.item_subtitle,
       offer.selected_options,
       offer.product_summary,
       offer.price_amount::text AS price_amount,
       offer.quantity_requested,
       offer.status,
       offer.accepted_seller_account_id,
       offer.accepted_at::text AS accepted_at,
       offer.created_at::text AS created_at,
       offer.updated_at::text AS updated_at
     FROM marketplace_offer_pages AS offer
     WHERE offer.offer_id = ANY($1::text[])
     ORDER BY offer.updated_at DESC, offer.offer_id ASC`,
    [offerIds],
  );

  return result.rows;
}

async function reconcileOrderingSellerListingAvailabilityInputs(
  db: RepresentativeQueryable,
  listings: readonly MarketplaceListingRow[],
): Promise<void> {
  const availabilityByAccount = new Map<string, Readonly<{ status: "available" | "unavailable"; updatedAt: string }>>();
  for (const listing of listings) {
    const updatedAt = toIsoText(listing.seller_listing_availability_updated_at);
    const existing = availabilityByAccount.get(listing.account_id);
    if (!existing || Date.parse(existing.updatedAt) <= Date.parse(updatedAt)) {
      availabilityByAccount.set(listing.account_id, {
        status: listing.seller_listing_availability_status,
        updatedAt,
      });
    }
  }

  for (const [accountId, availability] of availabilityByAccount) {
    await db.query(
      `INSERT INTO ordering_seller_listing_availability_inputs (
         account_id,
         status,
         updated_at
       ) VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [accountId, availability.status, availability.updatedAt],
    );
  }
}

async function reconcileOrderingMarketplaceListingInputs(
  db: RepresentativeQueryable,
  listings: readonly MarketplaceListingRow[],
): Promise<void> {
  for (const listing of listings) {
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
         $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20::timestamptz, $21, $22, $23, $24, $25, $26, $27
       )
       ON CONFLICT (listing_id) DO UPDATE SET
         seller_account_id = EXCLUDED.seller_account_id,
         inventory_item_id = EXCLUDED.inventory_item_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         item_title = EXCLUDED.item_title,
         item_subtitle = EXCLUDED.item_subtitle,
         selected_options = EXCLUDED.selected_options,
         product_summary = EXCLUDED.product_summary,
         product_measure_snapshot = EXCLUDED.product_measure_snapshot,
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
         seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [
        listing.listing_id,
        listing.account_id,
        listing.inventory_item_id,
        listing.catalog_catalog_item_id,
        listing.product_id,
        listing.item_title,
        listing.item_subtitle,
        selectedOptionsJson(listing.selected_options),
        listing.product_summary,
        optionalJsonObject(listing.product_measure_snapshot),
        listing.storage_location_name,
        listing.ship_from_code,
        jsonObject(listing.ship_from_address),
        listing.price_amount,
        listing.marketplace_sales_fee_unit_amount,
        listing.seller_net_unit_amount,
        listing.shipping_allowance_percentage_bps,
        listing.terms_schedule_id,
        listing.terms_agreement_id,
        toNullableIsoText(listing.terms_resolved_at),
        listing.quantity_cap,
        listing.max_units_per_order,
        listing.max_units_per_day,
        listing.max_units_per_customer_account,
        listing.seller_listing_availability_status,
        listing.status,
        toIsoText(listing.updated_at),
      ],
    );
  }
}

async function reconcileOrderingInventoryItemInputs(
  db: RepresentativeQueryable,
  inventoryItems: readonly InventoryItemRow[],
): Promise<void> {
  for (const item of inventoryItems) {
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
       ON CONFLICT (item_id) DO UPDATE SET
         seller_account_id = EXCLUDED.seller_account_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         total_quantity = EXCLUDED.total_quantity,
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version`,
      [
        item.item_id,
        item.account_id,
        item.catalog_catalog_item_id,
        item.product_id,
        item.total_quantity,
        toIsoText(item.updated_at),
        positiveStreamVersion(item.last_stream_version),
      ],
    );
  }
}

async function reconcileOrderingInventoryHoldInputs(
  db: RepresentativeQueryable,
  inventoryItemIds: readonly string[],
  inventoryHolds: readonly InventoryHoldRow[],
): Promise<void> {
  if (inventoryItemIds.length === 0) {
    return;
  }

  const holdIds = uniqueTextValues(inventoryHolds.map((hold) => hold.hold_id));
  await db.query(
    `DELETE FROM ordering_inventory_hold_inputs
     WHERE item_id = ANY($1::text[])
       AND hold_id <> ALL($2::text[])`,
    [inventoryItemIds, holdIds],
  );

  for (const hold of inventoryHolds) {
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
       ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
       ON CONFLICT (hold_id) DO UPDATE SET
         item_id = EXCLUDED.item_id,
         seller_account_id = EXCLUDED.seller_account_id,
         quantity = EXCLUDED.quantity,
         status = EXCLUDED.status,
         released_at = EXCLUDED.released_at,
         updated_at = EXCLUDED.updated_at,
         last_stream_version = EXCLUDED.last_stream_version`,
      [
        hold.hold_id,
        hold.item_id,
        hold.account_id,
        hold.quantity,
        hold.status,
        toNullableIsoText(hold.released_at),
        toIsoText(hold.updated_at),
        positiveStreamVersion(hold.last_stream_version),
      ],
    );
  }
}

async function reconcileAccounts(
  services: DiscoveryRepresentativeMarketStateServices,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) {
    return;
  }

  const marketplaceResult = await services.marketplaceDb.query<MarketplaceAccountRow>(
    `SELECT
       account.account_id,
       account.display_name,
       account.status,
       account.average_rating::text AS average_rating,
       account.review_count,
       account.rating_1_count,
       account.rating_2_count,
       account.rating_3_count,
       account.rating_4_count,
       account.rating_5_count,
       account.reputation_updated_at::text AS reputation_updated_at,
       COALESCE(availability.status, 'available') AS seller_listing_availability_status,
       availability.disabled_reason_category AS seller_listing_availability_reason_category,
       availability.available_again_on::text AS seller_listing_available_again_on,
       GREATEST(account.updated_at, COALESCE(availability.updated_at, account.updated_at))::text AS updated_at
     FROM marketplace_account_pages AS account
     LEFT JOIN marketplace_seller_listing_availability_pages AS availability
       ON availability.account_id = account.account_id
     WHERE account.account_id = ANY($1::text[])`,
    [accountIds],
  );
  const marketplaceAccounts = new Map(marketplaceResult.rows.map((row) => [row.account_id, row]));

  for (const accountId of accountIds) {
    const marketplace = marketplaceAccounts.get(accountId);
    const displayName = marketplace?.display_name ?? accountId;
    const updatedAt = toIsoText(marketplace?.updated_at ?? new Date().toISOString());
    const sellerSlug = createMarketplaceSlug([displayName], accountId);
    const current = await services.discoveryDb.query<{ seller_slug: string | null }>(
      `SELECT seller_slug FROM discovery_market_accounts WHERE account_id = $1`,
      [accountId],
    );

    await services.discoveryDb.query(
      `INSERT INTO discovery_market_accounts (
         account_id,
         seller_slug,
         seller_display_name,
         seller_listing_availability_status,
         seller_listing_availability_reason_category,
         seller_listing_available_again_on,
         status,
         average_rating,
         review_count,
         rating_1_count,
         rating_2_count,
         rating_3_count,
         rating_4_count,
         rating_5_count,
         reputation_updated_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, $12, $13, $14, $15::timestamptz, $16)
       ON CONFLICT (account_id) DO UPDATE SET
         seller_slug = EXCLUDED.seller_slug,
         seller_display_name = EXCLUDED.seller_display_name,
         seller_listing_availability_status = EXCLUDED.seller_listing_availability_status,
         seller_listing_availability_reason_category = EXCLUDED.seller_listing_availability_reason_category,
         seller_listing_available_again_on = EXCLUDED.seller_listing_available_again_on,
         status = EXCLUDED.status,
         average_rating = EXCLUDED.average_rating,
         review_count = EXCLUDED.review_count,
         rating_1_count = EXCLUDED.rating_1_count,
         rating_2_count = EXCLUDED.rating_2_count,
         rating_3_count = EXCLUDED.rating_3_count,
         rating_4_count = EXCLUDED.rating_4_count,
         rating_5_count = EXCLUDED.rating_5_count,
         reputation_updated_at = EXCLUDED.reputation_updated_at,
         updated_at = EXCLUDED.updated_at`,
      [
        accountId,
        sellerSlug,
        displayName,
        marketplace?.seller_listing_availability_status ?? "available",
        marketplace?.seller_listing_availability_reason_category ?? null,
        toNullableIsoText(marketplace?.seller_listing_available_again_on ?? null),
        marketplace?.status ?? "active",
        marketplace?.average_rating ?? null,
        marketplace?.review_count ?? 0,
        marketplace?.rating_1_count ?? 0,
        marketplace?.rating_2_count ?? 0,
        marketplace?.rating_3_count ?? 0,
        marketplace?.rating_4_count ?? 0,
        marketplace?.rating_5_count ?? 0,
        toNullableIsoText(marketplace?.reputation_updated_at ?? null),
        updatedAt,
      ],
    );
    await rememberSlugRedirect(services.discoveryDb, {
      entityKind: "account",
      entityId: accountId,
      previousSlug: current.rows[0]?.seller_slug,
      nextSlug: sellerSlug,
      updatedAt,
    });
  }
}

async function reconcileListings(
  db: RepresentativeQueryable,
  listings: readonly MarketplaceListingRow[],
): Promise<void> {
  for (const listing of listings) {
    const listingSlug = createMarketplaceSlug(
      [listing.item_title, listing.item_subtitle, listing.product_summary],
      listing.listing_id,
    );
    const productSlug = createMarketplaceSlug(
      [listing.item_title, listing.item_subtitle, listing.product_summary],
      listing.product_id,
    );
    const updatedAt = toIsoText(listing.updated_at);
    const current = await db.query<{
      listing_slug: string | null;
      product_slug: string | null;
    }>(
      `SELECT listing_slug, product_slug
       FROM discovery_market_listings
       WHERE listing_id = $1`,
      [listing.listing_id],
    );

    await db.query(
      `INSERT INTO discovery_market_listings (
         listing_id,
         listing_slug,
         product_slug,
         account_id,
         inventory_item_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         product_measure_snapshot,
         storage_location_name,
         ship_from_code,
         price_amount,
         shipping_allowance_percentage_bps,
         quantity_cap,
         max_units_per_order,
         max_units_per_day,
         max_units_per_customer_account,
         supply_total_quantity,
         active_held_quantity,
         status,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
       )
       ON CONFLICT (listing_id) DO UPDATE SET
         listing_slug = EXCLUDED.listing_slug,
         product_slug = EXCLUDED.product_slug,
         account_id = EXCLUDED.account_id,
         inventory_item_id = EXCLUDED.inventory_item_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         item_title = EXCLUDED.item_title,
         item_subtitle = EXCLUDED.item_subtitle,
         selected_options = EXCLUDED.selected_options,
         product_summary = EXCLUDED.product_summary,
         product_measure_snapshot = EXCLUDED.product_measure_snapshot,
         storage_location_name = EXCLUDED.storage_location_name,
         ship_from_code = EXCLUDED.ship_from_code,
         price_amount = EXCLUDED.price_amount,
         shipping_allowance_percentage_bps = EXCLUDED.shipping_allowance_percentage_bps,
         quantity_cap = EXCLUDED.quantity_cap,
         max_units_per_order = EXCLUDED.max_units_per_order,
         max_units_per_day = EXCLUDED.max_units_per_day,
         max_units_per_customer_account = EXCLUDED.max_units_per_customer_account,
         supply_total_quantity = EXCLUDED.supply_total_quantity,
         active_held_quantity = EXCLUDED.active_held_quantity,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [
        listing.listing_id,
        listingSlug,
        productSlug,
        listing.account_id,
        listing.inventory_item_id,
        listing.catalog_catalog_item_id,
        listing.product_id,
        listing.item_title,
        listing.item_subtitle,
        selectedOptionsJson(listing.selected_options),
        listing.product_summary,
        listing.product_measure_snapshot && typeof listing.product_measure_snapshot === "object"
          ? JSON.stringify(listing.product_measure_snapshot)
          : null,
        listing.storage_location_name,
        listing.ship_from_code,
        listing.price_amount,
        listing.shipping_allowance_percentage_bps,
        listing.quantity_cap,
        listing.max_units_per_order,
        listing.max_units_per_day,
        listing.max_units_per_customer_account,
        listing.supply_total_quantity,
        listing.active_held_quantity,
        listing.status,
        toIsoText(listing.created_at),
        updatedAt,
      ],
    );
    await rememberSlugRedirect(db, {
      entityKind: "listing",
      entityId: listing.listing_id,
      previousSlug: current.rows[0]?.listing_slug,
      nextSlug: listingSlug,
      updatedAt,
    });
    await rememberSlugRedirect(db, {
      entityKind: "product",
      entityId: listing.product_id,
      previousSlug: current.rows[0]?.product_slug,
      nextSlug: productSlug,
      updatedAt,
    });
  }
}

async function reconcileOffers(db: RepresentativeQueryable, offers: readonly MarketplaceOfferRow[]): Promise<void> {
  for (const offer of offers) {
    await db.query(
      `INSERT INTO discovery_offer_demand_matches (
         offer_id,
         buyer_account_id,
         catalog_catalog_item_id,
         product_id,
         item_title,
         item_subtitle,
         selected_options,
         product_summary,
         price_amount,
         quantity_requested,
         status,
         accepted_seller_account_id,
         accepted_at,
         created_at,
         updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::timestamptz, $14, $15
       )
       ON CONFLICT (offer_id) DO UPDATE SET
         buyer_account_id = EXCLUDED.buyer_account_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         item_title = EXCLUDED.item_title,
         item_subtitle = EXCLUDED.item_subtitle,
         selected_options = EXCLUDED.selected_options,
         product_summary = EXCLUDED.product_summary,
         price_amount = EXCLUDED.price_amount,
         quantity_requested = EXCLUDED.quantity_requested,
         status = EXCLUDED.status,
         accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
         accepted_at = EXCLUDED.accepted_at,
         updated_at = EXCLUDED.updated_at`,
      [
        offer.offer_id,
        offer.buyer_account_id,
        offer.catalog_catalog_item_id,
        offer.product_id,
        offer.item_title,
        offer.item_subtitle,
        selectedOptionsJson(offer.selected_options),
        offer.product_summary,
        offer.price_amount,
        offer.quantity_requested,
        offer.status,
        offer.accepted_seller_account_id,
        toNullableIsoText(offer.accepted_at),
        toIsoText(offer.created_at),
        toIsoText(offer.updated_at),
      ],
    );
  }
}

function uniqueTextValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function selectedOptionsJson(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function optionalJsonObject(value: unknown): string | null {
  return value && typeof value === "object" ? JSON.stringify(value) : null;
}

function jsonObject(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value) ? JSON.stringify(value) : "{}";
}

function positiveStreamVersion(value: number | string | null): number {
  const numericValue = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isFinite(numericValue) && numericValue > 0 ? Math.trunc(numericValue) : 1;
}

function toIsoText(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toNullableIsoText(value: string | Date | null): string | null {
  return value === null ? null : toIsoText(value);
}

function normalizeSelectedOptions(
  selection: readonly RepresentativeSelectedOptionEntry[],
): RepresentativeSelectedOptionEntry[] {
  const normalized = selection
    .map((entry) => ({
      dimensionId: normalizeRequiredText(entry.dimensionId, "Selection must include a dimension."),
      optionId: normalizeRequiredText(entry.optionId, "Selection must include an option."),
    }))
    .sort(
      (left, right) => left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
    );

  const seen = new Set<string>();
  for (const entry of normalized) {
    assert(!seen.has(entry.dimensionId), "Selection cannot include duplicate dimensions.");
    seen.add(entry.dimensionId);
  }

  return normalized;
}

function selectionEntriesToRecord(selection: readonly RepresentativeSelectedOptionEntry[]): Record<string, string> {
  return Object.fromEntries(selection.map((entry) => [entry.dimensionId, entry.optionId]));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function createSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hashId(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function compactIdSuffix(id: string): string {
  const suffix = createSlugBase(id).slice(-24).replace(/^-+/, "");

  return `${suffix || "item"}-${hashId(id)}`;
}

function createMarketplaceSlug(parts: readonly (string | null | undefined)[], id: string): string {
  const base = createSlugBase(parts.filter(Boolean).join(" ")) || "marketplace";

  return `${base}-${compactIdSuffix(id)}`;
}

async function rememberSlugRedirect(
  db: RepresentativeQueryable,
  params: Readonly<{
    entityKind: DiscoverySlugEntityKind;
    entityId: string;
    previousSlug: string | null | undefined;
    nextSlug: string;
    updatedAt: string;
  }>,
): Promise<void> {
  if (!params.previousSlug || params.previousSlug === params.nextSlug) {
    return;
  }

  await db.query(
    `INSERT INTO discovery_slug_redirects (
       entity_kind,
       slug,
       entity_id,
       target_slug,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (entity_kind, slug) DO UPDATE SET
       entity_id = EXCLUDED.entity_id,
       target_slug = EXCLUDED.target_slug,
       updated_at = EXCLUDED.updated_at`,
    [params.entityKind, params.previousSlug, params.entityId, params.nextSlug, params.updatedAt],
  );
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value).filter((entry): entry is string => typeof entry === "string");
}
