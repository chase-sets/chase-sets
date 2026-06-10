import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import {
  quoteMarketplaceTerms,
  quotePublicStandardMarketplaceTerms,
} from "../../../support/runtime-support/fee-quotes";
import type {
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
  listActiveListingsForInventoryItem,
  listItemListings,
  listSellerListingFeeLockReport,
  listSellerInventoryItemSupply,
  listSellerListings,
} from "../read-model/queries";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as never;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as never;
const MAX_LISTING_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
const LISTING_PHOTO_UPLOAD_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const HIGH_DOLLAR_LISTING_AMOUNT = 250;
const MIN_TRUSTED_REPUTATION_REVIEWS = 3;

function createMarketplaceSystemContext(accountId: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_SYSTEM_USER_ID,
      forAccountId: accountId as never,
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
  listSellerInventoryItemSupply: (
    params: Parameters<typeof listSellerInventoryItemSupply>[1],
  ) => ReturnType<typeof listSellerInventoryItemSupply>;
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

export function createMarketplaceListingRuntime(deps: ListingRuntimeDeps): MarketplaceListingServices {
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  const sellerAvailabilityRepository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SellerListingAvailabilityEvent>(),
    initialState: () => initialSellerListingAvailabilityState,
    evolve: evolveSellerListingAvailability,
  });
  const sellerAvailabilityCommandHandler = createCommandHandler({
    repository: sellerAvailabilityRepository,
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
        catalogItemId: supply.catalog_catalog_item_id,
        productId: supply.product_id as never,
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
        params.quantityCap <= params.totalQuantity,
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
      assert(
        !requiresListingPhotoEvidence(listing) || listing.listingPhotos.length > 0,
        "Pristine and Mint listings require at least one listing photo before publication.",
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
    listSellerInventoryItemSupply: (params) => listSellerInventoryItemSupply(deps.db, params),
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
