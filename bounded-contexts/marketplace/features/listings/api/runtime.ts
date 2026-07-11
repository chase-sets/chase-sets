import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { createId, type AccountId, type ListingId, type TenantId, type UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import {
  quoteMarketplaceTerms,
  quotePublicStandardMarketplaceTerms,
} from "../../../support/runtime-support/fee-quotes";
import type {
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
} from "../ui/contracts";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  requiresListingPhotoEvidence,
  type MarketplaceListingPhoto,
  type MarketplaceListingPurchaseLimits,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { normalizeListingPhoto } from "./listing-photo-normalization";
import {
  decideSellerListingAvailability,
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
  type SellerListingAvailabilityCommand,
  type SellerListingAvailabilityEvent,
  type SellerListingAvailabilityReasonCategory,
  type SellerListingAvailabilityState,
} from "../domain/seller-listing-availability";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import {
  getActiveQuantityCapForInventoryItem,
  getInventoryItemSupply,
  getMarketplaceAccountRisk,
  getMarketSummaryForItem,
  getSellerListing,
  getSellerListingAvailability,
  getSellerListingStatusCounts,
  hasSellerSupplyLocationNamed,
  listActiveListingsForInventoryItem,
  listItemListings,
  listSellerListingFeeLockReport,
  listSellerInventoryItemSupply,
  listSellerListings,
} from "../read-model/queries";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as TenantId;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as UserId;
const MAX_LISTING_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
const LISTING_PHOTO_UPLOAD_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HIGH_DOLLAR_LISTING_AMOUNT = 250;
const MIN_TRUSTED_REPUTATION_REVIEWS = 3;
const ANONYMOUS_LISTING_DRAFT_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_ACTIVE_ANONYMOUS_LISTING_DRAFTS = 20;

function createMarketplaceSystemContext(accountId: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_SYSTEM_USER_ID,
      forAccountId: accountId as AccountId,
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export class MarketplaceSalesFeeQuoteStaleError extends Error {
  public constructor(public readonly currentQuote: MarketplaceListingTermsPreview) {
    super("Fee quote is stale. Refresh the fee preview before continuing.");
    this.name = "MarketplaceSalesFeeQuoteStaleError";
  }
}

export type MarketplaceListingServices = Readonly<{
  commandHandler: CommandHandler<MarketplaceListingCommand, MarketplaceListingState, MarketplaceListingEvent>;
  sellerAvailabilityCommandHandler: CommandHandler<
    SellerListingAvailabilityCommand,
    SellerListingAvailabilityState,
    SellerListingAvailabilityEvent
  >;
  createListing: (
    params: Readonly<{
      accountId: AccountId;
      inventoryItemId: string;
      priceAmount: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      listingPhotoUploads?: readonly MarketplaceListingPhotoUpload[] | null;
      listingIdOverride?: ListingId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;
  createBatchDraftListingFromInventorySnapshot: (
    params: Readonly<{
      accountId: string;
      importBatchId: string;
      importRowId: string;
      inventoryItemId: string;
      listingIdOverride: ListingId;
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      gradedCard?: MarketplaceListingState["gradedCard"];
      storageLocationId: string;
      storageLocationName: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
      totalQuantity: number;
      availableQuantity?: number;
      acquisitionCostAmount: string | null;
      priceAmount: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      listingPhotoUploads?: readonly MarketplaceListingPhotoUpload[] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;
  createListingFromInventorySnapshot: (
    params: Readonly<{
      accountId: string;
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      gradedCard?: MarketplaceListingState["gradedCard"];
      storageLocationId: string;
      storageLocationName: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
      totalQuantity: number;
      availableQuantity?: number;
      acquisitionCostAmount: string | null;
      priceAmount: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      listingPhotoUploads?: readonly MarketplaceListingPhotoUpload[] | null;
      listingIdOverride?: ListingId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number; feeQuoteFingerprint: string }>;
  addListingPhotos: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      listingPhotoUploads: readonly MarketplaceListingPhotoUpload[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  previewListingTerms: (
    params: Readonly<{ accountId: string; priceAmount: string }>,
  ) => Promise<MarketplaceListingTermsPreview>;
  previewPublicStandardListingTerms: (
    params: Readonly<{ priceAmount: string }>,
  ) => Promise<MarketplacePublicStandardTermsPreview>;
  createAnonymousListingDraftIntent: (
    params: Readonly<{
      anonymousOwnerId: string;
      sourcePath: string;
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary?: string | null;
      priceAmount: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
    }>,
  ) => Promise<MarketplaceAnonymousListingDraftIntent>;
  getAnonymousListingDraftIntent: (
    params: Readonly<{
      anonymousOwnerId: string;
      intentId: string;
    }>,
  ) => Promise<MarketplaceAnonymousListingDraftIntent | null>;
  claimAnonymousListingDraftIntent: (
    params: Readonly<{
      anonymousOwnerId: string;
      intentId: string;
      accountId: string;
    }>,
  ) => Promise<MarketplaceAnonymousListingDraftIntent>;
  updateListingPrice: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      priceAmount: string;
      feeQuoteFingerprint?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  updateListingQuantityCap: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      feeQuoteFingerprint?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  updateListingPurchaseLimits: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  publishListing: (
    params: Readonly<{ accountId: string; listingId: string; feeQuoteFingerprint?: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  pauseListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  withdrawListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  getSellerListingAvailability: (accountId: string) => ReturnType<typeof getSellerListingAvailability>;
  disableSellerListingAvailability: (
    params: Readonly<{
      accountId: string;
      reasonCategory: SellerListingAvailabilityReasonCategory | null;
      availableAgainOn: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; status: "unavailable" }>;
  enableSellerListingAvailability: (
    params: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; status: "available" }>;
  listSellerListings: (params: Parameters<typeof listSellerListings>[1]) => ReturnType<typeof listSellerListings>;
  getSellerListingStatusCounts: (accountId: string) => ReturnType<typeof getSellerListingStatusCounts>;
  listSellerInventoryItemSupply: (
    params: Parameters<typeof listSellerInventoryItemSupply>[1],
  ) => ReturnType<typeof listSellerInventoryItemSupply>;
  hasSellerSupplyLocationNamed: (
    params: Parameters<typeof hasSellerSupplyLocationNamed>[1],
  ) => ReturnType<typeof hasSellerSupplyLocationNamed>;
  getSellerListing: (listingId: string, accountId: string) => ReturnType<typeof getSellerListing>;
  listSellerListingFeeHistory: (
    params: Readonly<{ listingId: string; accountId: string }>,
  ) => Promise<readonly MarketplaceListingFeeHistoryEntry[]>;
  listSellerListingFeeLockReport: (
    params: Parameters<typeof listSellerListingFeeLockReport>[1],
  ) => Promise<{ items: MarketplaceListingFeeLockReportEntry[]; total: number }>;
  getMarketSummaryForItem: (itemId: string) => ReturnType<typeof getMarketSummaryForItem>;
  listItemListings: (itemId: string) => ReturnType<typeof listItemListings>;
  getInventoryItemSupply: (itemId: string, accountId?: string) => ReturnType<typeof getInventoryItemSupply>;
  reconcileInventoryCapacity: (inventoryItemId: string) => Promise<void>;
  projectors: readonly ProjectionHandlerSet[];
}>;

type ListingRuntimeDeps = MarketplaceRuntimeDeps &
  Readonly<{
    commercialTermsResolver: CommercialTermsResolver;
  }>;

export type MarketplaceListingPhotoUpload = Readonly<{
  body: Uint8Array;
  contentType: string;
  originalFilename: string | null;
  altText?: string | null;
}>;

type AnonymousListingDraftIntentRow = Readonly<{
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  catalog_item_id: string;
  product_id: string;
  selected_options: unknown;
  product_summary: string | null;
  price_amount: string;
  quantity_cap: number;
  max_units_per_order: number | null;
  max_units_per_day: number | null;
  max_units_per_customer_account: number | null;
  status: "active" | "claimed" | "expired";
  claimed_account_id: string | null;
  claimed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}>;

function normalizeAnonymousListingDraftRow(
  row: AnonymousListingDraftIntentRow,
): MarketplaceAnonymousListingDraftIntent {
  return {
    ...row,
    selected_options: normalizeSelectedOptions(row.selected_options),
    price_amount: String(row.price_amount),
  };
}

function normalizeSelectedOptions(value: unknown): readonly { dimensionId: string; optionId: string }[] {
  return Array.isArray(value)
    ? value
        .map((entry) =>
          entry && typeof entry === "object"
            ? {
                dimensionId: String((entry as Record<string, unknown>).dimensionId ?? "").trim(),
                optionId: String((entry as Record<string, unknown>).optionId ?? "").trim(),
              }
            : null,
        )
        .filter((entry): entry is { dimensionId: string; optionId: string } =>
          Boolean(entry?.dimensionId && entry.optionId),
        )
    : [];
}

function normalizePositiveInteger(value: unknown, message: string) {
  const numeric = Number(value);
  assert(Number.isInteger(numeric) && numeric > 0, message);
  return numeric;
}

function normalizeOptionalPositiveInteger(value: unknown, message: string) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  return normalizePositiveInteger(value, message);
}

function normalizePriceAmount(value: unknown) {
  const normalized = String(value ?? "").trim();
  assert(/^\d+(\.\d{1,2})?$/.test(normalized), "Listing price must use dollars and cents.");
  const numeric = Number(normalized);
  assert(Number.isFinite(numeric) && numeric > 0, "Listing price must be greater than zero.");
  return numeric.toFixed(2);
}

function normalizeAnonymousOwnerId(value: string) {
  const normalized = value.trim();
  assert(normalized.startsWith("anon_"), "Anonymous listing draft owner is required.");
  return normalized;
}

export function createMarketplaceListingRuntime(deps: ListingRuntimeDeps): MarketplaceListingServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  const { commandHandler: sellerAvailabilityCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SellerListingAvailabilityEvent>(),
    initialState: () => initialSellerListingAvailabilityState,
    evolve: evolveSellerListingAvailability,
    decide: decideSellerListingAvailability,
  });

  async function ensureActiveCapacity(
    inventoryItemId: string,
    requestedQuantityCap: number,
    excludeListingId?: string,
  ) {
    const supply = await getInventoryItemSupply(deps.db, inventoryItemId);
    assert(supply, "Inventory item not found.");

    const activeQuantityCap = await getActiveQuantityCapForInventoryItem(deps.db, inventoryItemId, excludeListingId);
    assert(
      activeQuantityCap + requestedQuantityCap <= supply.available_quantity,
      "Active listing quantity caps cannot exceed current sellable inventory.",
    );
  }

  async function reconcileInventoryCapacity(inventoryItemId: string) {
    const supply = await getInventoryItemSupply(deps.db, inventoryItemId);
    if (!supply) {
      return;
    }

    const activeListings = await listActiveListingsForInventoryItem(deps.db, inventoryItemId);
    let activeTotal = activeListings.reduce((sum, listing) => sum + listing.quantity_cap, 0);

    for (const listing of activeListings) {
      if (activeTotal <= supply.available_quantity) {
        break;
      }

      await commandHandler({
        streamId: `marketplace.listing-${listing.listing_id}`,
        command: { type: "PauseListing" },
        context: createMarketplaceSystemContext(listing.account_id),
      });
      activeTotal -= listing.quantity_cap;
    }
  }

  async function loadOwnedListingState(listingId: string, accountId: string) {
    const aggregate = await repository.load(`marketplace.listing-${listingId}`);
    const listing = aggregate.state;

    assert(listing.listingId !== null && listing.accountId === accountId, "Listing not found.");

    return listing;
  }

  async function quoteListingTerms(accountId: string, priceAmount: string) {
    return quoteMarketplaceTerms(deps.commercialTermsResolver, {
      accountId,
      priceAmount,
    });
  }

  async function quotePublicStandardListingTerms(priceAmount: string) {
    return quotePublicStandardMarketplaceTerms(deps.commercialTermsResolver, {
      priceAmount,
    });
  }

  function assertConfirmedFeeQuote(
    providedFingerprint: string | null | undefined,
    currentQuote: MarketplaceListingTermsPreview,
  ) {
    if (providedFingerprint !== currentQuote.fee_quote_fingerprint) {
      throw new MarketplaceSalesFeeQuoteStaleError(currentQuote);
    }
  }

  async function assertListingPublicationRiskAccepted(listing: MarketplaceListingState) {
    const priceAmount = Number.parseFloat(listing.priceAmount ?? "0");
    if (!Number.isFinite(priceAmount) || priceAmount < HIGH_DOLLAR_LISTING_AMOUNT) {
      return;
    }

    assert(listing.accountId, "Listing account is missing.");
    const accountRisk = await getMarketplaceAccountRisk(deps.db, listing.accountId);
    const badges = new Set(accountRisk.badges);
    const trusted =
      badges.has("trusted-seller") ||
      (accountRisk.review_count >= MIN_TRUSTED_REPUTATION_REVIEWS && !badges.has("manual-payout-review"));

    assert(
      listing.listingPhotos.length > 0,
      "High-dollar listings require at least one listing photo before publication.",
    );
    assert(
      trusted,
      "High-dollar listings require a trusted seller account or established account reputation before publication.",
    );
  }

  async function expireAnonymousListingDraftIntents(anonymousOwnerId: string) {
    await deps.db.query(
      `UPDATE marketplace_anonymous_listing_draft_intents
       SET status = 'expired', updated_at = now()
       WHERE anonymous_owner_id = $1
         AND status = 'active'
         AND expires_at <= now()`,
      [anonymousOwnerId],
    );
  }

  async function getAnonymousListingDraftIntent(params: Readonly<{ anonymousOwnerId: string; intentId: string }>) {
    const anonymousOwnerId = normalizeAnonymousOwnerId(params.anonymousOwnerId);
    await expireAnonymousListingDraftIntents(anonymousOwnerId);

    const result = await deps.db.query<AnonymousListingDraftIntentRow>(
      `SELECT *
       FROM marketplace_anonymous_listing_draft_intents
       WHERE intent_id = $1
         AND anonymous_owner_id = $2`,
      [params.intentId, anonymousOwnerId],
    );

    return result.rows[0] ? normalizeAnonymousListingDraftRow(result.rows[0]) : null;
  }

  async function createAnonymousListingDraftIntent(
    params: Parameters<MarketplaceListingServices["createAnonymousListingDraftIntent"]>[0],
  ) {
    const anonymousOwnerId = normalizeAnonymousOwnerId(params.anonymousOwnerId);
    const catalogItemId = params.catalogItemId.trim();
    const productId = params.productId.trim();
    const sourcePath = params.sourcePath.trim();
    const selectedOptions = normalizeSelectedOptions(params.selectedOptions);
    const priceAmount = normalizePriceAmount(params.priceAmount);
    const quantityCap = normalizePositiveInteger(params.quantityCap, "Listing quantity must be greater than zero.");
    const purchaseLimits = {
      maxUnitsPerOrder: normalizeOptionalPositiveInteger(
        params.purchaseLimits?.maxUnitsPerOrder,
        "Order purchase limit must be greater than zero.",
      ),
      maxUnitsPerDay: normalizeOptionalPositiveInteger(
        params.purchaseLimits?.maxUnitsPerDay,
        "Daily purchase limit must be greater than zero.",
      ),
      maxUnitsPerCustomerAccount: normalizeOptionalPositiveInteger(
        params.purchaseLimits?.maxUnitsPerCustomerAccount,
        "Customer purchase limit must be greater than zero.",
      ),
    };

    assert(sourcePath.startsWith("/") && !sourcePath.startsWith("//"), "Listing draft source path is invalid.");
    assert(catalogItemId, "Listing draft catalog item is required.");
    assert(productId, "Listing draft product is required.");

    await expireAnonymousListingDraftIntents(anonymousOwnerId);

    const existingResult = await deps.db.query<AnonymousListingDraftIntentRow>(
      `SELECT *
       FROM marketplace_anonymous_listing_draft_intents
       WHERE anonymous_owner_id = $1
         AND status = 'active'
         AND expires_at > now()
         AND catalog_item_id = $2
         AND product_id = $3
         AND selected_options = $4::jsonb
         AND price_amount = $5::numeric
         AND quantity_cap = $6
         AND max_units_per_order IS NOT DISTINCT FROM $7
         AND max_units_per_day IS NOT DISTINCT FROM $8
         AND max_units_per_customer_account IS NOT DISTINCT FROM $9
       ORDER BY updated_at DESC
       LIMIT 1`,
      [
        anonymousOwnerId,
        catalogItemId,
        productId,
        JSON.stringify(selectedOptions),
        priceAmount,
        quantityCap,
        purchaseLimits.maxUnitsPerOrder,
        purchaseLimits.maxUnitsPerDay,
        purchaseLimits.maxUnitsPerCustomerAccount,
      ],
    );

    const expiresAt = new Date(Date.now() + ANONYMOUS_LISTING_DRAFT_TTL_MS).toISOString();

    if (existingResult.rows[0]) {
      const result = await deps.db.query<AnonymousListingDraftIntentRow>(
        `UPDATE marketplace_anonymous_listing_draft_intents
         SET source_path = $2,
             product_summary = $3,
             expires_at = $4,
             updated_at = now()
         WHERE intent_id = $1
         RETURNING *`,
        [existingResult.rows[0].intent_id, sourcePath, params.productSummary ?? null, expiresAt],
      );

      return normalizeAnonymousListingDraftRow(result.rows[0]);
    }

    const countResult = await deps.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM marketplace_anonymous_listing_draft_intents
       WHERE anonymous_owner_id = $1
         AND status = 'active'
         AND expires_at > now()`,
      [anonymousOwnerId],
    );
    assert(
      Number(countResult.rows[0]?.count ?? 0) < MAX_ACTIVE_ANONYMOUS_LISTING_DRAFTS,
      "Too many saved listing drafts. Review or finish registration before saving another listing draft.",
    );

    const result = await deps.db.query<AnonymousListingDraftIntentRow>(
      `INSERT INTO marketplace_anonymous_listing_draft_intents (
         intent_id,
         anonymous_owner_id,
         source_path,
         catalog_item_id,
         product_id,
         selected_options,
         product_summary,
         price_amount,
         quantity_cap,
         max_units_per_order,
         max_units_per_day,
         max_units_per_customer_account,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::numeric, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        createId("ldi"),
        anonymousOwnerId,
        sourcePath,
        catalogItemId,
        productId,
        JSON.stringify(selectedOptions),
        params.productSummary ?? null,
        priceAmount,
        quantityCap,
        purchaseLimits.maxUnitsPerOrder,
        purchaseLimits.maxUnitsPerDay,
        purchaseLimits.maxUnitsPerCustomerAccount,
        expiresAt,
      ],
    );

    return normalizeAnonymousListingDraftRow(result.rows[0]);
  }

  async function claimAnonymousListingDraftIntent(
    params: Parameters<MarketplaceListingServices["claimAnonymousListingDraftIntent"]>[0],
  ) {
    const anonymousOwnerId = normalizeAnonymousOwnerId(params.anonymousOwnerId);
    const accountId = params.accountId.trim();
    assert(accountId, "Seller account is required.");
    await expireAnonymousListingDraftIntents(anonymousOwnerId);

    const existing = await getAnonymousListingDraftIntent({
      anonymousOwnerId,
      intentId: params.intentId,
    });
    assert(existing, "Listing draft was not found. Start a new listing draft from the item page.");

    if (existing.status === "claimed" && existing.claimed_account_id === accountId) {
      return existing;
    }

    assert(
      existing.status === "active",
      "Listing draft is no longer available. Start a new listing draft from the item page.",
    );

    const result = await deps.db.query<AnonymousListingDraftIntentRow>(
      `UPDATE marketplace_anonymous_listing_draft_intents
       SET status = 'claimed',
           claimed_account_id = $3,
           claimed_at = now(),
           updated_at = now()
       WHERE intent_id = $1
         AND anonymous_owner_id = $2
         AND status = 'active'
         AND expires_at > now()
       RETURNING *`,
      [params.intentId, anonymousOwnerId, accountId],
    );

    assert(result.rows[0], "Listing draft is no longer available. Start a new listing draft from the item page.");

    return normalizeAnonymousListingDraftRow(result.rows[0]);
  }

  async function normalizePhotoUploads(
    params: Readonly<{
      accountId: string;
      listingId: string;
      listingPhotoUploads: readonly MarketplaceListingPhotoUpload[];
      existingPhotoCount?: number;
    }>,
  ): Promise<MarketplaceListingPhoto[]> {
    if (params.listingPhotoUploads.length === 0) {
      return [];
    }
    assert(deps.listingPhotoStorage, "Listing photo storage is not configured.");

    const generatedAt = new Date().toISOString();
    const photos: MarketplaceListingPhoto[] = [];
    for (const [index, upload] of params.listingPhotoUploads.entries()) {
      const contentType = upload.contentType.toLowerCase();
      assert(LISTING_PHOTO_UPLOAD_CONTENT_TYPES.has(contentType), "Listing photos must be JPEG, PNG, or WebP images.");
      assert(upload.body.byteLength > 0, "Listing photo uploads cannot be empty.");
      assert(upload.body.byteLength <= MAX_LISTING_PHOTO_UPLOAD_BYTES, "Listing photo uploads cannot exceed 10 MB.");

      const photoId = createId("lpho");
      photos.push(
        await normalizeListingPhoto({
          sourceBody: upload.body,
          storageBaseKey: `marketplace/listings/${params.accountId}/${params.listingId}/${photoId}`,
          photoId,
          originalFilename: upload.originalFilename,
          altText: upload.altText ?? null,
          sortOrder: (params.existingPhotoCount ?? 0) + index,
          generatedAt,
          photoStorage: deps.listingPhotoStorage,
        }),
      );
    }

    return photos;
  }

  async function upsertBatchInventorySnapshot(
    params: Readonly<{
      accountId: string;
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      gradedCard?: MarketplaceListingState["gradedCard"];
      storageLocationId: string;
      storageLocationName: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
      totalQuantity: number;
      acquisitionCostAmount: string | null;
    }>,
  ) {
    await deps.db.query(
      `INSERT INTO marketplace_supply_locations (
         storage_location_id,
         account_id,
         name,
         ship_from_code,
         ship_from_address,
         is_archived,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, false, now())
       ON CONFLICT (storage_location_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         name = EXCLUDED.name,
         ship_from_code = EXCLUDED.ship_from_code,
         ship_from_address = EXCLUDED.ship_from_address,
         is_archived = false,
         updated_at = EXCLUDED.updated_at`,
      [
        params.storageLocationId,
        params.accountId,
        params.storageLocationName,
        params.shipFromCode,
        JSON.stringify(params.shipFromAddress),
      ],
    );
    await deps.db.query(
      `INSERT INTO marketplace_supply_items (
         item_id,
         account_id,
         catalog_catalog_item_id,
         product_id,
         selected_options,
         graded_card,
         storage_location_id,
         total_quantity,
         acquisition_cost_amount,
         last_stream_version,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, now())
       ON CONFLICT (item_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
         product_id = EXCLUDED.product_id,
         selected_options = EXCLUDED.selected_options,
         graded_card = EXCLUDED.graded_card,
         storage_location_id = EXCLUDED.storage_location_id,
         total_quantity = EXCLUDED.total_quantity,
         acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
         updated_at = EXCLUDED.updated_at`,
      [
        params.inventoryItemId,
        params.accountId,
        params.catalogItemId,
        params.productId,
        JSON.stringify(params.selectedOptions),
        params.gradedCard ? JSON.stringify(params.gradedCard) : null,
        params.storageLocationId,
        params.totalQuantity,
        params.acquisitionCostAmount,
      ],
    );
  }

  function stringField(data: Readonly<Record<string, unknown>>, key: string) {
    const value = data[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  }

  function numberField(data: Readonly<Record<string, unknown>>, key: string) {
    const value = data[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function feeHistoryEntryFromEvent(
    event: Awaited<ReturnType<typeof deps.eventStore.readStream>>[number],
  ): MarketplaceListingFeeHistoryEntry | null {
    const data =
      typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};

    if (
      ![
        "marketplace.listing.created",
        "marketplace.listing.published",
        "marketplace.listing.price-updated",
        "marketplace.listing.quantity-cap-updated",
      ].includes(event.eventType)
    ) {
      return null;
    }

    return {
      event_type: event.eventType,
      stream_version: event.streamVersion,
      price_amount: stringField(data, "priceAmount"),
      quantity_cap: numberField(data, "quantityCap"),
      marketplace_sales_fee_unit_amount: stringField(data, "marketplaceSalesFeeUnitAmount"),
      seller_net_unit_amount: stringField(data, "sellerNetUnitAmount"),
      shipping_allowance_percentage_bps: Number(data.shippingAllowancePercentageBps ?? 500),
      terms_schedule_id: stringField(data, "termsScheduleId"),
      terms_agreement_id: stringField(data, "termsAgreementId"),
      terms_resolved_at: stringField(data, "termsResolvedAt"),
      fee_quote_fingerprint: stringField(data, "feeQuoteFingerprint"),
      recorded_at: String(event.recordedAt),
      performed_by_user_id: event.performedByUserId ? String(event.performedByUserId) : null,
    } satisfies MarketplaceListingFeeHistoryEntry;
  }

  async function createListing(
    params: Readonly<{
      accountId: AccountId;
      inventoryItemId: string;
      priceAmount: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      listingPhotoUploads?: readonly MarketplaceListingPhotoUpload[] | null;
      listingIdOverride?: ListingId;
    }>,
    context: EventStoreContext,
  ) {
    const supply = await getInventoryItemSupply(deps.db, params.inventoryItemId, params.accountId);
    assert(supply, "Inventory item not found.");
    const quote = await quoteListingTerms(params.accountId, params.priceAmount);

    const listingId = params.listingIdOverride ?? (createId("lst") as ListingId);
    const streamId = `marketplace.listing-${listingId}`;
    const existing = await repository.load(streamId);
    if (existing.state.listingId !== null) {
      if (params.listingPhotoUploads?.length) {
        const photoResult = await addListingPhotos(
          {
            accountId: params.accountId,
            listingId,
            listingPhotoUploads: params.listingPhotoUploads,
          },
          context,
        );
        return {
          listingId,
          version: photoResult.version,
          feeQuoteFingerprint: existing.state.feeQuoteFingerprint ?? quote.fee_quote_fingerprint,
        };
      }
      return {
        listingId,
        version: existing.version,
        feeQuoteFingerprint: existing.state.feeQuoteFingerprint ?? quote.fee_quote_fingerprint,
      };
    }
    const listingPhotos = await normalizePhotoUploads({
      accountId: params.accountId,
      listingId,
      listingPhotoUploads: params.listingPhotoUploads ?? [],
    });

    const result = await commandHandler({
      streamId,
      command: {
        type: "CreateListing",
        listingId,
        accountId: params.accountId,
        inventoryItemId: supply.item_id,
        catalogItemId: supply.catalog_catalog_item_id as CatalogItemId,
        productId: supply.product_id as ProductKey,
        itemLanguageCode: supply.item_language_code,
        itemTitle: supply.item_title,
        itemSubtitle: supply.item_subtitle,
        selectedOptions: supply.selected_options,
        productSummary: supply.product_summary,
        productMeasureSnapshot: supply.product_measure_snapshot,
        gradedCard: supply.graded_card,
        storageLocationName: supply.storage_location_name,
        shipFromCode: supply.ship_from_code,
        shipFromAddress: supply.ship_from_address,
        priceAmount: params.priceAmount,
        marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
        sellerNetUnitAmount: quote.seller_net_unit_amount,
        shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
        termsScheduleId: quote.schedule_id,
        termsAgreementId: quote.agreement_id,
        termsResolvedAt: quote.resolved_at,
        feeQuoteFingerprint: quote.fee_quote_fingerprint,
        quantityCap: params.quantityCap,
        purchaseLimits: params.purchaseLimits,
        listingPhotos,
      },
      context,
    });

    return { listingId, version: result.version, feeQuoteFingerprint: quote.fee_quote_fingerprint };
  }

  async function addListingPhotos(
    params: Readonly<{
      accountId: string;
      listingId: string;
      listingPhotoUploads: readonly MarketplaceListingPhotoUpload[];
    }>,
    context: EventStoreContext,
  ) {
    const listing = await loadOwnedListingState(params.listingId, params.accountId);
    const listingPhotos = await normalizePhotoUploads({
      accountId: params.accountId,
      listingId: params.listingId,
      listingPhotoUploads: params.listingPhotoUploads,
      existingPhotoCount: listing.listingPhotos.length,
    });

    const result = await commandHandler({
      streamId: `marketplace.listing-${params.listingId}`,
      command: {
        type: "AddListingPhotos",
        photos: listingPhotos,
      },
      context,
    });

    return { listingId: params.listingId, version: result.version };
  }

  return {
    commandHandler,
    sellerAvailabilityCommandHandler,
    createListing,
    createBatchDraftListingFromInventorySnapshot: async (params, context) => {
      assert(
        params.quantityCap <= params.totalQuantity,
        "Listing quantity caps cannot exceed created available inventory.",
      );
      await upsertBatchInventorySnapshot(params);
      return createListing(
        {
          accountId: params.accountId as AccountId,
          inventoryItemId: params.inventoryItemId,
          priceAmount: params.priceAmount,
          quantityCap: params.quantityCap,
          purchaseLimits: params.purchaseLimits,
          listingIdOverride: params.listingIdOverride,
          listingPhotoUploads: params.listingPhotoUploads,
        },
        context,
      );
    },
    createListingFromInventorySnapshot: async (params, context) => {
      assert(
        params.quantityCap <= (params.availableQuantity ?? params.totalQuantity),
        "Listing quantity caps cannot exceed available listing stock.",
      );
      await upsertBatchInventorySnapshot(params);
      return createListing(
        {
          accountId: params.accountId as AccountId,
          inventoryItemId: params.inventoryItemId,
          priceAmount: params.priceAmount,
          quantityCap: params.quantityCap,
          purchaseLimits: params.purchaseLimits,
          listingIdOverride: params.listingIdOverride,
          listingPhotoUploads: params.listingPhotoUploads,
        },
        context,
      );
    },
    addListingPhotos,
    previewListingTerms: async (params) => {
      return quoteListingTerms(params.accountId, params.priceAmount);
    },
    previewPublicStandardListingTerms: async (params) => {
      return quotePublicStandardListingTerms(params.priceAmount);
    },
    createAnonymousListingDraftIntent,
    getAnonymousListingDraftIntent,
    claimAnonymousListingDraftIntent,
    updateListingPrice: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const quote = await quoteListingTerms(params.accountId, params.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPrice",
          priceAmount: params.priceAmount,
          marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    updateListingQuantityCap: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.priceAmount, "Listing price is missing.");
      const quote = await quoteListingTerms(params.accountId, listing.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      if (listing.status === "active") {
        assert(listing.inventoryItemId, "Listing inventory item is missing.");
        await ensureActiveCapacity(listing.inventoryItemId, params.quantityCap, params.listingId);
      }

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingQuantityCap",
          quantityCap: params.quantityCap,
          purchaseLimits: params.purchaseLimits,
          marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    updateListingPurchaseLimits: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPurchaseLimits",
          purchaseLimits: params.purchaseLimits ?? null,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    publishListing: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.inventoryItemId, "Listing inventory item is missing.");
      assert(listing.priceAmount, "Listing price is missing.");
      assert(listing.productMeasureSnapshot, "Listings require a resolved shipping measure before publication.");
      assert(
        !requiresListingPhotoEvidence(listing) || listing.listingPhotos.length > 0,
        "Pristine, Mint, and graded-card listings require at least one listing photo before publication; graded-card listings must include a slab photo.",
      );
      await assertListingPublicationRiskAccepted(listing);
      const quote = await quoteListingTerms(params.accountId, listing.priceAmount);
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      await ensureActiveCapacity(listing.inventoryItemId, listing.quantityCap, params.listingId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "PublishListing",
          marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    pauseListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PauseListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    withdrawListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "WithdrawListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    getSellerListingAvailability: (accountId) => getSellerListingAvailability(deps.db, accountId),
    disableSellerListingAvailability: async (params, context) => {
      const result = await sellerAvailabilityCommandHandler({
        streamId: `marketplace.seller-listing-availability-${params.accountId}`,
        command: {
          type: "DisableSellerListingAvailability",
          accountId: params.accountId,
          reasonCategory: params.reasonCategory,
          availableAgainOn: params.availableAgainOn,
          disabledAt: new Date().toISOString(),
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
        status: "unavailable",
      };
    },
    enableSellerListingAvailability: async (params, context) => {
      const result = await sellerAvailabilityCommandHandler({
        streamId: `marketplace.seller-listing-availability-${params.accountId}`,
        command: {
          type: "EnableSellerListingAvailability",
          accountId: params.accountId,
          enabledAt: new Date().toISOString(),
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
        status: "available",
      };
    },
    listSellerListings: (params) => listSellerListings(deps.db, params),
    getSellerListingStatusCounts: (accountId) => getSellerListingStatusCounts(deps.db, accountId),
    listSellerInventoryItemSupply: (params) => listSellerInventoryItemSupply(deps.db, params),
    hasSellerSupplyLocationNamed: (params) => hasSellerSupplyLocationNamed(deps.db, params),
    getSellerListing: (listingId, accountId) => getSellerListing(deps.db, listingId, accountId),
    listSellerListingFeeHistory: async (params) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const events = await deps.eventStore.readStream({
        streamId: `marketplace.listing-${params.listingId}`,
      });

      return events
        .map(feeHistoryEntryFromEvent)
        .filter((entry): entry is MarketplaceListingFeeHistoryEntry => Boolean(entry))
        .sort((left, right) => right.stream_version - left.stream_version);
    },
    listSellerListingFeeLockReport: (params) => listSellerListingFeeLockReport(deps.db, params),
    getMarketSummaryForItem: (itemId) => getMarketSummaryForItem(deps.db, itemId),
    listItemListings: (itemId) => listItemListings(deps.db, itemId),
    getInventoryItemSupply: (itemId, accountId) => getInventoryItemSupply(deps.db, itemId, accountId),
    reconcileInventoryCapacity,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-listing-projection",
        handlers: buildMarketplaceListingProjectionHandlers(deps.db),
      }),
    ],
  };
}
