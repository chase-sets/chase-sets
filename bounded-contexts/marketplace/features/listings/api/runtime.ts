import { createHash } from "node:crypto";
import {
  completeListingAuthorityParticipants,
  requireListingAuthorityPrincipal,
} from "@chase-sets/event-core/listing-authority";
import { combineListingAuthorityReservations } from "@chase-sets/platform-runtime/listing-authority-fence";
import { isDeepStrictEqual } from "node:util";
import { toJsonValue } from "@chase-sets/primitives/json";
import sharp from "sharp";
import { createListingTargetRuntime } from "./target-runtime";
import { createListingCurrentReads } from "../read-model/target-queries";
import { marketplaceListingCodec } from "../domain/codec";
import { listingRequestFingerprint } from "./listing-request";
import type { ListingTargetServices } from "./target-contracts";
import type { ListingAuthorityOperation, ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";
import type { CatalogListingAuthorityFacts } from "@chase-sets/product-measures";
import {
  createListingAuthorityFence,
  type ListingAuthorityFence,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { totalFeeLockedUnits } from "../domain/fee-lock";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { applyEvents } from "@chase-sets/event-core/domain";
import type { EventStoreError } from "@chase-sets/event-core/event-store";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import { createPostgresAggregateSnapshotStore } from "@chase-sets/event-core-postgres";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { createId, type AccountId, type ListingId, type TenantId, type UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import {
  feeLockFromMarketplaceTermsQuote,
  openMarketplaceListingTermsSession,
  quoteMarketplaceTerms,
  quotePublicStandardMarketplaceTerms,
} from "../../../support/runtime-support/fee-quotes";
import type {
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceBulkListingPriceUpdateInput,
  MarketplaceBulkListingPriceUpdateOutcome,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
} from "../ui/contracts";
import {
  activeListingPhotos,
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  normalizeListingPriceCurrencyCode,
  type MarketplaceListingPhoto,
  type MarketplaceListingPurchaseLimits,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { evaluateListingEvidenceReadiness } from "../domain/listing-evidence-readiness";
import { resolveListingEvidenceRequirements } from "./evidence-requirement-resolver";
import {
  assertEvidenceCountAndBytesWithinBudget,
  DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS,
} from "../domain/evidence-governance";
import { buildMarketplaceListingEvidenceReadiness } from "./evidence-readiness";
import { buildListingEvidenceSnapshot, type ListingEvidenceSnapshot } from "../domain/evidence-snapshot";
import {
  selectEvidenceGarbageCollectionTargets,
  type EvidenceGarbageCollectionEntry,
} from "../domain/evidence-garbage-collection";
import { createListingPublishedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import { marketplaceListingGatePolicy, type MarketplaceListingGatePolicyValue } from "../domain/listing-gate-policy";
import { marketplaceListingBulkPriceUpdatePolicy } from "../domain/bulk-price-update-policy";
import {
  assertActiveListingCapacity,
  decideInventoryListingCapacity,
  evolveInventoryListingCapacity,
  initialInventoryListingCapacityState,
  inventoryListingCapacityStreamId,
  type InventoryListingCapacityEvent,
} from "../domain/inventory-listing-capacity";
import {
  evaluateListingEvidencePolicy,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  marketplaceListingEvidencePolicy,
} from "../../listing-evidence-policy/domain/policy";
import { evaluateEvidenceCoverage } from "../domain/evidence-coverage";
import { normalizeListingPhoto } from "./listing-photo-normalization";
import {
  decideSellerListingAvailability,
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
  type SellerListingAvailabilityCommand,
  type SellerListingAvailabilityDisabledBy,
  type SellerListingAvailabilityEnabledBy,
  type SellerListingAvailabilityEvent,
  type SellerListingAvailabilityReasonCategory,
  type SellerListingAvailabilityState,
} from "../domain/seller-listing-availability";
import {
  decideSellerOrderCapacity,
  evolveSellerOrderCapacity,
  initialSellerOrderCapacityState,
  type SellerOrderCapacityCommand,
  type SellerOrderCapacityEvent,
  type SellerOrderCapacityState,
} from "../domain/seller-order-capacity";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import {
  getInventoryItemSupply,
  getMarketplaceAccountRisk,
  getMarketSummaryForItem,
  getSellerListing,
  getSellerListingAvailability,
  getSellerListingStatusCounts,
  getSellerOrderCapacity,
  hasSellerSupplyLocationNamed,
  listActiveListingsForInventoryItem,
  listDueSellerAvailabilityRestores,
  listDueSellerAwayWindowStarts,
  listItemListings,
  listSellerListingFeeLockReport,
  listSellerInventoryItemSupply,
  listSellerListings,
} from "../read-model/queries";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as TenantId;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as UserId;
const LISTING_PHOTO_UPLOAD_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LISTING_PHOTO_JPEG_BACKGROUND = { r: 255, g: 255, b: 255 };
const LISTING_PHOTO_JPEG_QUALITY = 90;
const LISTING_PHOTO_JPEG_MAX_BYTES = 15_000_000;

class MarketplaceListingNotFoundError extends Error {}
/**
 * Bump whenever `evolveMarketplaceListing`'s fold shape changes in a way
 * that would make an old snapshot's stored state incompatible. A stored
 * snapshot with a different schema version is ignored -- load() falls back
 * to full replay, exactly as if no snapshot existed.
 */
const MARKETPLACE_LISTING_SNAPSHOT_SCHEMA_VERSION = 8;
/**
 * Marketplace listings are m113's proven-hot aggregate: reprice-heavy
 * listings accumulate hundreds of `UpdateListingPrice` events, and every
 * subsequent interactive command replayed the whole stream before this.
 * Snapshotting every 100 events bounds that replay to at most 99 events
 * while keeping write-behind amplification to 1% of appended events.
 */
const MARKETPLACE_LISTING_SNAPSHOT_EVERY_N_EVENTS = 100;

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

export class MarketplaceListingEvidenceIncompleteError extends Error {
  public constructor(public readonly currentReadiness: import("../ui/contracts").MarketplaceListingEvidenceReadiness) {
    super("Listing evidence is incomplete.");
    this.name = "MarketplaceListingEvidenceIncompleteError";
  }
}

export type { MarketplaceBulkListingPriceUpdateInput, MarketplaceBulkListingPriceUpdateOutcome } from "../ui/contracts";

export type MarketplaceListingCreationInput = Readonly<{
  accountId: AccountId;
  inventoryItemId: string;
  priceAmount: string;
  priceCurrencyCode: string;
  quantityCap: number;
  purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
  listingPhotoUploads?: readonly MarketplaceListingPhotoUpload[] | null;
  listingIdOverride?: ListingId;
}>;

export type MarketplaceNativeListingCreationResult = Readonly<{
  listingId: ListingId;
  version: number;
  nativeFeeState: "enrolled";
  feeQuoteFingerprint: string;
}>;
export type MarketplaceChannelOnlyListingCreationResult = Readonly<{
  listingId: ListingId;
  version: number;
  nativeFeeState: "not-enrolled";
  feeQuoteFingerprint: null;
}>;

export type MarketplaceCreateListing = {
  (
    params: MarketplaceListingCreationInput & { publicationScope?: "native" },
    context: EventStoreContext,
  ): Promise<MarketplaceNativeListingCreationResult>;
  (
    params: MarketplaceListingCreationInput & { publicationScope: "channel-only" },
    context: EventStoreContext,
  ): Promise<MarketplaceChannelOnlyListingCreationResult>;
};

export type MarketplaceListingServices = ListingTargetServices & MarketplaceListingLifecycleServices;

type MarketplaceListingLifecycleServices = Readonly<{
  getListingPhotoJpeg: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      photoId: string;
    }>,
  ) => Promise<Readonly<{ body: Uint8Array; etag: string }> | null>;
  commandHandler: CommandHandler<MarketplaceListingCommand, MarketplaceListingState, MarketplaceListingEvent>;
  sellerAvailabilityCommandHandler: CommandHandler<
    SellerListingAvailabilityCommand,
    SellerListingAvailabilityState,
    SellerListingAvailabilityEvent
  >;
  orderCapacityCommandHandler: CommandHandler<
    SellerOrderCapacityCommand,
    SellerOrderCapacityState,
    SellerOrderCapacityEvent
  >;
  createListing: MarketplaceCreateListing;
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
      priceCurrencyCode: string;
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
      priceCurrencyCode: string;
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
  /** Classify an existing active evidence entry into a configured slot/view kind. */
  classifyListingPhoto: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      photoId: string;
      slotId: string | null;
      viewKind: string | null;
      altText?: string | null;
      capturedAt?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  /** Replace an active evidence entry with a freshly normalized upload. */
  replaceListingPhoto: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      replacedPhotoId: string;
      upload: MarketplaceListingPhotoUpload;
      slotId?: string | null;
      viewKind?: string | null;
      capturedAt?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  /** Remove an active evidence entry; retained for commitment resolution. */
  removeListingPhoto: (
    params: Readonly<{ accountId: string; listingId: string; photoId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  /** Reorder the active evidence entries. */
  reorderListingPhotos: (
    params: Readonly<{ accountId: string; listingId: string; orderedPhotoIds: readonly string[] }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  /**
   * Builds the immutable Listing Evidence Snapshot for a listing's current
   * active evidence. Offer Acceptance consumes this to publish the committed
   * evidence, including the recorded requirement policy hash.
   */
  getListingEvidenceSnapshot: (
    params: Readonly<{ accountId: string; listingId: string }>,
  ) => Promise<ListingEvidenceSnapshot>;
  getListingEvidenceReadiness: (
    params: Readonly<{ accountId: string; listingId: string; now?: string | null }>,
  ) => Promise<import("../ui/contracts").MarketplaceListingEvidenceReadiness>;
  previewListingEvidenceReadiness: (
    params: Readonly<{ accountId: string; inventoryItemId: string; priceAmount: string; now?: string | null }>,
  ) => Promise<import("../ui/contracts").MarketplaceListingEvidenceReadiness>;
  /**
   * Idempotent, observable evidence garbage collection sweep. Deletes storage
   * objects for replaced/removed evidence past the safe delay whose source is
   * no longer referenced by any active entry. Returns a report.
   */
  collectListingEvidenceGarbage: (
    params?: Readonly<{ safeDelayHours?: number; limit?: number; now?: string }>,
  ) => Promise<MarketplaceListingEvidenceGarbageCollectionReport>;
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
      priceCurrencyCode: string;
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
    params: MarketplaceBulkListingPriceUpdateInput & Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  /**
   * Native adapter to canonical target acceptance. The reusable bulk lane batches
   * complete request/result/owner/authority transactions and isolates conflicts.
   * Existing fee formulas are requoted, never replaced. Only explicit native-on
   * fee confirmations open a current-terms session, shared by the whole batch.
   * Pricing provenance requires a verified typed decision, never a key prefix.
   */
  applyBulkListingPriceUpdates: (
    params: Readonly<{
      accountId: string;
      updates: readonly MarketplaceBulkListingPriceUpdateInput[];
    }>,
    context: EventStoreContext,
  ) => Promise<readonly MarketplaceBulkListingPriceUpdateOutcome[]>;
  updateListingQuantityCap: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      quantityCap: number;
      purchaseLimits?: Partial<MarketplaceListingPurchaseLimits> | null;
      feeQuoteFingerprint?: string | null;
      idempotencyKey?: string;
      expectedVersion?: number;
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
    params: Readonly<{
      accountId: string;
      listingId: string;
      feeQuoteFingerprint?: string | null;
      idempotencyKey?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  pauseListing: (
    params: Readonly<{
      accountId: string;
      listingId: string;
      reason?: "seller" | "policy-input-missing";
      idempotencyKey?: string;
    }>,
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
      /**
       * The authoritative resume instant, captured client-side (seller-local
       * start-of-day for the chosen date). Optional for back-compat with
       * system callers and non-JS form submits, which fall back to the
       * informational-only `availableAgainOn` date.
       */
      availableAgainAt?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; status: "unavailable" }>;
  enableSellerListingAvailability: (
    params: Readonly<{
      accountId: string;
      /** Defaults to `"seller"`; the auto-resume sweep passes `"scheduled"`. */
      enabledBy?: SellerListingAvailabilityEnabledBy;
      /** Compare-and-swap guard for a scheduled enable; see the domain command's `dueBy` doc comment. */
      dueBy?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; status: "available" }>;
  getSellerOrderCapacity: (accountId: string) => ReturnType<typeof getSellerOrderCapacity>;
  setSellerOrderCapacity: (
    params: Readonly<{ accountId: string; maxOpenOrders: number }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; maxOpenOrders: number }>;
  clearSellerOrderCapacity: (
    params: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number; maxOpenOrders: null }>;
  /**
   * Auto-resume sweep: finds seller listing availability rows whose Resume
   * Instant has passed while still `unavailable` and auto-enables them with
   * `enabledBy: "scheduled"` provenance. Bounded to one due-index query and
   * batch per call (mirrors `sweepReviewWindowExpirations`) -- the scheduled
   * runner's own interval cadence drains any remainder on the next tick.
   * Each restore is compare-and-swap protected against a lost race (see
   * `EnableSellerListingAvailabilityCommand.dueBy`): a seller who manually
   * enabled or pushed their Resume Instant forward between this sweep's
   * read and its command is never overridden, and that lost race counts as
   * `skipped`, never `failed`.
   */
  sweepDueSellerAvailabilityRestores: (
    params: Readonly<{ now?: string; limit?: number }> | undefined,
    context: EventStoreContext,
  ) => Promise<{ checked: number; restored: number; skipped: number }>;
  /**
   * Books a future away period: Seller Listing Availability will
   * auto-disable at `startsAt` (Away Window start sweep) and, once away,
   * ride the existing Resume Instant sweep back to available at `endsAt`.
   * At most one pending window may exist -- cancel the existing one first
   * to reschedule.
   */
  scheduleSellerAwayWindow: (
    params: Readonly<{
      accountId: string;
      startsAt: string;
      endsAt: string | null;
      reasonCategory: SellerListingAvailabilityReasonCategory;
    }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number }>;
  /** Cancels the pending Away Window, if any; no-ops when none exists. */
  cancelScheduledAwayWindow: (
    params: Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ accountId: string; version: number }>;
  /**
   * Away Window start sweep: finds pending windows whose `startsAt` has
   * passed and disables the account with `disabledBy: "scheduled"`,
   * `reasonCategory` and `availableAgainAt` taken from the window itself.
   * The window's end boundary then rides the existing Resume Instant sweep
   * (`sweepDueSellerAvailabilityRestores`) for free -- this sweep only ever
   * handles the start. Each disable is compare-and-swap protected (see
   * `DisableSellerListingAvailabilityCommand.dueBy`): a seller who
   * cancelled the window between this sweep's read and its command is
   * never overridden, and that lost race counts as `skipped`, never
   * `failed`.
   */
  sweepDueSellerAwayWindowStarts: (
    params: Readonly<{ now?: string; limit?: number }> | undefined,
    context: EventStoreContext,
  ) => Promise<{ checked: number; started: number; skipped: number }>;
  listSellerListings: (params: Parameters<typeof listSellerListings>[1]) => ReturnType<typeof listSellerListings>;
  getSellerListingStatusCounts: (accountId: string) => ReturnType<typeof getSellerListingStatusCounts>;
  listSellerInventoryItemSupply: (
    params: Parameters<typeof listSellerInventoryItemSupply>[1],
  ) => ReturnType<typeof listSellerInventoryItemSupply>;
  hasSellerSupplyLocationNamed: (
    params: Parameters<typeof hasSellerSupplyLocationNamed>[1],
  ) => ReturnType<typeof hasSellerSupplyLocationNamed>;
  getSellerListing: (listingId: string, accountId: string) => ReturnType<typeof getSellerListing>;
  getListingEvidenceCoverage: (params: Readonly<{ accountId: string; listingId: string; now?: string }>) => Promise<{
    listingId: string;
    listingStatus: string;
    evidence: readonly MarketplaceListingPhoto[];
    policyHash: string;
    policyVersion: number | null;
    requirements: Awaited<ReturnType<typeof evaluateListingEvidencePolicy>>["requirements"];
    coverage: ReturnType<typeof evaluateEvidenceCoverage>;
    updatedAt: string;
  }>;
  listSellerListingFeeHistory: (
    params: Readonly<{ listingId: string; accountId: string }>,
  ) => Promise<readonly MarketplaceListingFeeHistoryEntry[]>;
  listSellerListingFeeLockReport: (
    params: Parameters<typeof listSellerListingFeeLockReport>[1],
  ) => Promise<{ items: MarketplaceListingFeeLockReportEntry[]; total: number }>;
  getMarketSummaryForItem: (itemId: string) => ReturnType<typeof getMarketSummaryForItem>;
  listItemListings: (itemId: string) => ReturnType<typeof listItemListings>;
  getInventoryItemSupply: (itemId: string, accountId?: string) => ReturnType<typeof getInventoryItemSupply>;
  loadListingState: (listingId: string) => Promise<MarketplaceListingState>;
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
  slotId?: string | null;
  viewKind?: string | null;
  capturedAt?: string | null;
}>;

const LISTING_EVIDENCE_GC_DEFAULT_LISTING_SCAN_LIMIT = 500;

export type MarketplaceListingEvidenceGarbageCollectionReport = Readonly<{
  scannedListingCount: number;
  deletedAssetKeyCount: number;
  collectedPhotoIds: readonly string[];
  retainedReferencedPhotoIds: readonly string[];
  deferredPhotoIds: readonly string[];
  /** True when object storage exposed a delete operation; false = candidates reported but not physically deleted. */
  storageDeletionPerformed: boolean;
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
  price_currency_code: string | null;
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
    price_currency_code: row.price_currency_code,
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
  const cents = tryMoneyToCents(normalized);
  assert(cents !== null, "Listing price must use dollars and cents within the supported money range.");
  assert(cents > 0n, "Listing price must be greater than zero.");
  return centsToMoneyAmount(cents);
}

function normalizeAnonymousOwnerId(value: string) {
  const normalized = value.trim();
  assert(normalized.startsWith("anon_"), "Anonymous listing draft owner is required.");
  return normalized;
}

export function createMarketplaceListingRuntime(deps: ListingRuntimeDeps): MarketplaceListingServices {
  const listingCodec = marketplaceListingCodec;
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: listingCodec,
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
    snapshots: {
      store: createPostgresAggregateSnapshotStore<MarketplaceListingState>({ db: deps.db }),
      schemaVersion: MARKETPLACE_LISTING_SNAPSHOT_SCHEMA_VERSION,
      everyNEvents: MARKETPLACE_LISTING_SNAPSHOT_EVERY_N_EVENTS,
    },
  });
  const capacityCodec = createPassthroughDomainEventCodec<InventoryListingCapacityEvent>();
  const { repository: inventoryListingCapacityRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: capacityCodec,
    initialState: () => initialInventoryListingCapacityState,
    evolve: evolveInventoryListingCapacity,
    decide: decideInventoryListingCapacity,
  });
  const { commandHandler: sellerAvailabilityCommandHandler, repository: sellerAvailabilityRepository } =
    createAggregateCommandHandler({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<SellerListingAvailabilityEvent>(),
      initialState: () => initialSellerListingAvailabilityState,
      evolve: evolveSellerListingAvailability,
      decide: decideSellerListingAvailability,
    });
  const { commandHandler: orderCapacityCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SellerOrderCapacityEvent>(),
    initialState: () => initialSellerOrderCapacityState,
    evolve: evolveSellerOrderCapacity,
    decide: decideSellerOrderCapacity,
  });

  /**
   * Resolves the marketplace listing-gate policy currently in effect. When
   * no `policies` runtime is wired (standalone/test usage) this falls back
   * to the compiled launch values -- an empty or absent policy table can
   * never break listing creation or publication.
   */
  async function resolveListingGatePolicy(): Promise<MarketplaceListingGatePolicyValue> {
    if (!deps.policies) {
      return marketplaceListingGatePolicy.defaultValue;
    }
    const resolved = await deps.policies.resolvePolicy(marketplaceListingGatePolicy);
    return resolved.value;
  }

  /**
   * Resolves the chunk size and inter-chunk yield interval for
   * `applyBulkListingPriceUpdates`. Same compiled-fallback posture as
   * `resolveListingGatePolicy`: an empty or absent policy table can never
   * break bulk repricing.
   */
  async function resolveBulkPriceUpdatePolicy() {
    if (!deps.policies) {
      return marketplaceListingBulkPriceUpdatePolicy.defaultValue;
    }
    const resolved = await deps.policies.resolvePolicy(marketplaceListingBulkPriceUpdatePolicy);
    return resolved.value;
  }

  function isConcurrencyConflict(error: unknown): error is EventStoreError {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict");
  }

  async function discoverInventoryListingIds(inventoryItemId: string): Promise<readonly string[]> {
    const listingIds = new Set<string>();
    let afterGlobalPosition: GlobalPosition | undefined;
    for (;;) {
      const events = await deps.eventStore.readAll({
        ...(afterGlobalPosition === undefined ? {} : { afterGlobalPosition }),
        eventTypes: ["marketplace.listing.created"],
        streamPrefixes: ["marketplace.listing-"],
        limit: 500,
      });
      for (const event of events) {
        if ((event.payload as Readonly<Record<string, unknown>>).inventoryItemId === inventoryItemId) {
          listingIds.add(event.streamId.slice("marketplace.listing-".length));
        }
      }
      if (events.length < 500) {
        return [...listingIds].sort();
      }
      afterGlobalPosition = events[events.length - 1]?.globalPosition;
    }
  }

  async function commitListingCreation(
    listingStreamId: string,
    inventoryItemId: string,
    command: Extract<MarketplaceListingCommand, { type: "CreateListing" }>,
    context: EventStoreContext,
    authority?: Readonly<{
      fence: ListingAuthorityFence;
      operation: ListingAuthorityOperation;
      reservations: readonly ListingAuthorityReservation[];
    }>,
  ): Promise<number> {
    const appendToStreams = deps.eventStore.appendToStreams;
    assert(appendToStreams, "Atomic inventory listing registration is unavailable.");
    const capacityStreamId = inventoryListingCapacityStreamId(inventoryItemId);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [listing, capacity] = await Promise.all([
        repository.load(listingStreamId),
        inventoryListingCapacityRepository.load(capacityStreamId),
      ]);
      if (listing.state.listingId !== null) {
        const result = await replayListingCreation(listingStreamId, command.requestFingerprint);
        return result.version;
      }
      const discoveredListingIds =
        capacity.state.listingIds.length === 0 ? await discoverInventoryListingIds(inventoryItemId) : [];
      const listingEvents = decideMarketplaceListing(listing.state, command);
      const capacityEvents = decideInventoryListingCapacity(capacity.state, {
        type: "RegisterInventoryListings",
        inventoryItemId,
        listingIds: [...discoveredListingIds, command.listingId],
      });
      try {
        const terminal = authority
          ? await authority.fence.prepareCommit(
              authority.operation,
              combineListingAuthorityReservations(authority.operation, authority.reservations),
              {
                listingId: command.listingId,
                version: listing.version + listingEvents.length,
              },
            )
          : null;
        const results = await appendToStreams([
          ...(terminal ?? []),
          {
            streamId: capacityStreamId,
            expectedVersion: capacity.version,
            context,
            events: capacityEvents.map(capacityCodec.encode),
          },
          {
            streamId: listingStreamId,
            expectedVersion: listing.version,
            context,
            events: listingEvents.map((event) => ({
              ...listingCodec.encode(event),
              ...(authority ? { metadata: { authorityOperation: authority.operation } } : {}),
            })),
          },
        ]);
        recordCommittedEvents(results.flatMap((result) => result.storedEvents));
        if (authority) await authority.fence.settle(authority.operation);
        return listing.version + listingEvents.length;
      } catch (error) {
        if (!isConcurrencyConflict(error) || attempt === 4) {
          throw error;
        }
      }
    }
    throw new Error("Inventory listing registration did not converge.");
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

    if (listing.listingId === null || listing.accountId !== accountId) {
      throw new MarketplaceListingNotFoundError("Listing not found.");
    }

    return listing;
  }

  async function resolveEvidenceRequirementsForListing(
    listing: MarketplaceListingState,
    evaluatedAt: string,
    priceAmount = listing.priceAmount,
  ) {
    assert(listing.accountId, "Listing account is missing.");
    assert(listing.catalogItemId, "Listing catalog item is missing.");
    assert(listing.productId, "Listing product is missing.");
    assert(priceAmount, "Listing price is missing.");
    try {
      return await resolveListingEvidenceRequirements(deps, {
        accountId: listing.accountId,
        catalogItemId: listing.catalogItemId,
        productId: listing.productId,
        selectedOptions: listing.selectedOptions,
        gradedItem: listing.gradedCard !== null,
        priceAmount,
        evaluatedAt,
      });
    } catch {
      throw new Error("Listing evidence requirements are unavailable.");
    }
  }

  async function evaluateListingReadiness(
    listing: MarketplaceListingState,
    snapshot: NonNullable<MarketplaceListingState["evidenceRequirements"]>,
    now: string,
  ) {
    const requiresSellerFacts = snapshot.requirements.sellerTrustRequirements.length > 0;
    assert(!requiresSellerFacts || listing.accountId, "Listing account is missing.");
    const accountRisk = requiresSellerFacts
      ? await getMarketplaceAccountRisk(deps.db, listing.accountId!)
      : { review_count: 0, badges: [] as readonly string[] };
    return evaluateListingEvidenceReadiness({
      snapshot,
      evidence: listing.evidence,
      seller: { reviewCount: accountRisk.review_count, badgeKeys: accountRisk.badges },
      now,
    });
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
    const priceCurrencyCode = normalizeListingPriceCurrencyCode(params.priceCurrencyCode);
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

    const gatePolicy = await resolveListingGatePolicy();

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
         AND price_currency_code = $6
         AND quantity_cap = $7
         AND max_units_per_order IS NOT DISTINCT FROM $8
         AND max_units_per_day IS NOT DISTINCT FROM $9
         AND max_units_per_customer_account IS NOT DISTINCT FROM $10
       ORDER BY updated_at DESC
       LIMIT 1`,
      [
        anonymousOwnerId,
        catalogItemId,
        productId,
        JSON.stringify(selectedOptions),
        priceAmount,
        priceCurrencyCode,
        quantityCap,
        purchaseLimits.maxUnitsPerOrder,
        purchaseLimits.maxUnitsPerDay,
        purchaseLimits.maxUnitsPerCustomerAccount,
      ],
    );

    const anonymousListingDraftTtlMs = gatePolicy.anonymousListingDraftTtlDays * 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + anonymousListingDraftTtlMs).toISOString();

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
      Number(countResult.rows[0]?.count ?? 0) < gatePolicy.maxActiveAnonymousListingDrafts,
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
         price_currency_code,
         quantity_cap,
         max_units_per_order,
         max_units_per_day,
         max_units_per_customer_account,
         expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::numeric, $9, $10, $11, $12, $13, $14)
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
        priceCurrencyCode,
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
      existingEvidence?: readonly MarketplaceListingPhoto[];
    }>,
  ): Promise<MarketplaceListingPhoto[]> {
    if (params.listingPhotoUploads.length === 0) {
      return [];
    }
    assert(deps.listingPhotoStorage, "Listing photo storage is not configured.");

    const gatePolicy = await resolveListingGatePolicy();
    const maxListingEvidenceUploadMb = gatePolicy.maxListingEvidenceUploadBytes / (1024 * 1024);
    const existingEvidence = params.existingEvidence ?? [];
    const existingActiveCount = activeListingPhotos(existingEvidence).length;
    // Bound the count up front so a large batch fails before doing expensive
    // image work; the byte budget is re-checked below once assets are sized.
    assert(
      existingActiveCount + params.listingPhotoUploads.length <= gatePolicy.maxListingEvidenceCount,
      `A listing can carry at most ${gatePolicy.maxListingEvidenceCount} evidence images.`,
    );
    const generatedAt = new Date().toISOString();
    const photos: MarketplaceListingPhoto[] = [];
    for (const [index, upload] of params.listingPhotoUploads.entries()) {
      const contentType = upload.contentType.toLowerCase();
      assert(
        LISTING_PHOTO_UPLOAD_CONTENT_TYPES.has(contentType),
        "Listing evidence must be JPEG, PNG, or WebP images.",
      );
      assert(upload.body.byteLength > 0, "Listing photo uploads cannot be empty.");
      assert(
        upload.body.byteLength <= gatePolicy.maxListingEvidenceUploadBytes,
        `Listing photo uploads cannot exceed ${maxListingEvidenceUploadMb} MB.`,
      );

      const photoId = createId("lpho");
      photos.push(
        await normalizeListingPhoto({
          sourceBody: upload.body,
          storageBaseKey: `marketplace/listings/${params.accountId}/${params.listingId}/${photoId}`,
          photoId,
          originalFilename: upload.originalFilename,
          altText: upload.altText ?? null,
          slotId: upload.slotId ?? null,
          viewKind: upload.viewKind ?? null,
          capturedAt: upload.capturedAt ?? null,
          sortOrder: existingActiveCount + index,
          generatedAt,
          photoStorage: deps.listingPhotoStorage,
        }),
      );
    }

    assertEvidenceCountAndBytesWithinBudget({
      existingEvidence,
      additions: photos,
      maxEvidenceCount: gatePolicy.maxListingEvidenceCount,
      maxTotalStoredBytes: gatePolicy.maxListingEvidenceTotalBytes,
    });

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
        "marketplace.listing.price-updated",
        "marketplace.listing.quantity-cap-updated",
        "marketplace.listing.native-visibility-changed",
      ].includes(event.eventType)
    ) {
      return null;
    }

    const decoded = listingCodec.decode({ eventType: event.eventType, payload: event.payload });
    const feeLocks = "feeLocks" in decoded.data ? decoded.data.feeLocks : [];
    const last = feeLocks.at(-1);
    if (!last && stringField(data, "marketplaceSalesFeeUnitAmount") === null) return null;
    const snapshot =
      event.eventType === "marketplace.listing.native-visibility-changed" && last
        ? { ...data, ...last, ...last.terms }
        : data;
    return {
      event_type: event.eventType,
      stream_version: event.streamVersion,
      price_amount: stringField(data, "priceAmount"),
      price_currency_code: stringField(data, "priceCurrencyCode"),
      quantity_cap: numberField(data, "quantityCap"),
      marketplace_sales_fee_unit_amount: stringField(snapshot, "marketplaceSalesFeeUnitAmount"),
      seller_net_unit_amount: stringField(snapshot, "sellerNetUnitAmount"),
      shipping_allowance_percentage_bps: numberField(snapshot, "shippingAllowancePercentageBps"),
      terms_schedule_id: stringField(snapshot, "termsScheduleId"),
      terms_agreement_id: stringField(snapshot, "termsAgreementId"),
      terms_resolved_at: stringField(snapshot, "termsResolvedAt"),
      fee_quote_fingerprint: stringField(snapshot, "feeQuoteFingerprint"),
      fee_locks: feeLocks,
      recorded_at: String(event.recordedAt),
      performed_by_user_id: event.performedByUserId ? String(event.performedByUserId) : null,
    } satisfies MarketplaceListingFeeHistoryEntry;
  }

  async function createListing(
    params: MarketplaceListingCreationInput & { publicationScope?: "native" },
    context: EventStoreContext,
  ): Promise<MarketplaceNativeListingCreationResult>;
  async function createListing(
    params: MarketplaceListingCreationInput & { publicationScope: "channel-only" },
    context: EventStoreContext,
  ): Promise<MarketplaceChannelOnlyListingCreationResult>;
  async function createListing(
    params: MarketplaceListingCreationInput & { publicationScope?: "native" | "channel-only" },
    context: EventStoreContext,
  ): Promise<MarketplaceNativeListingCreationResult | MarketplaceChannelOnlyListingCreationResult> {
    const publicationScope = params.publicationScope ?? "native";
    let creationAuthority:
      | Readonly<{
          fence: ListingAuthorityFence;
          operation: ListingAuthorityOperation;
          reservations: readonly ListingAuthorityReservation[];
          product: CatalogListingAuthorityFacts;
        }>
      | undefined;
    assert(context.audit.forAccountId === params.accountId, "Listing not found.");
    const listingId = params.listingIdOverride ?? (createId("lst") as ListingId);
    const streamId = `marketplace.listing-${listingId}`;
    const requestFingerprint = listingRequestFingerprint(
      {
        type: "CreateListing",
        ...params,
        listingPhotoUploads:
          params.listingPhotoUploads?.map(({ body, ...metadata }) => ({
            ...metadata,
            bodySha256: createHash("sha256").update(body).digest("hex"),
          })) ?? null,
        publicationScope,
        listingId,
        priceAmount: normalizePriceAmount(params.priceAmount),
        priceCurrencyCode: normalizeListingPriceCurrencyCode(params.priceCurrencyCode),
      },
      context,
    );
    const existing = await repository.load(streamId);
    if (existing.state.listingId !== null) {
      assert(existing.state.accountId === params.accountId, "Listing not found.");
      return replayListingCreation(streamId, requestFingerprint);
    }
    const supply = await getInventoryItemSupply(deps.db, params.inventoryItemId, params.accountId);
    assert(supply, "Inventory item not found.");
    async function prepareCreationAuthority() {
      assert(supply, "Inventory item not found.");
      assert(deps.listingTargetAuthority, "Listing target authority is unavailable.");
      const fence = createListingAuthorityFence({
        eventStore: deps.eventStore,
        owner: "marketplace",
        participants: deps.listingTargetAuthority.participants,
      });
      const operation = await fence.open(
        {
          tenantId: context.tenantId,
          accountId: params.accountId,
          actor: await deps.listingTargetAuthority.resolveActor({
            principal: requireListingAuthorityPrincipal(context),
            context,
          }),
          committingOwner: "marketplace",
          kind: "create-listing",
          requestId: listingId,
          command: { type: "CreateListing", requestFingerprint },
          listingId,
          subject: {
            inventoryItemId: params.inventoryItemId,
            catalogItemId: supply.catalog_catalog_item_id,
            productId: supply.product_id,
            selectedOptions: supply.selected_options,
            quantity: params.quantityCap,
            pair: {
              amount: normalizePriceAmount(params.priceAmount),
              currencyCode: normalizeListingPriceCurrencyCode(params.priceCurrencyCode),
            },
            allocationRevision: null,
            commitmentSourceId: null,
          },
          target: { kind: "native-marketplace" },
          expectedListingRevision: 0,
          expectedTargetRevision: null,
          expectedVisibilityRevision: null,
          expectedPublicationRevision: null,
          participants: completeListingAuthorityParticipants(
            [
              { owner: "identity", purpose: "manage-listing" },
              { owner: "inventory", purpose: "stock-allocation" },
              { owner: "catalog", purpose: "product-measures" },
              ...(publicationScope === "native"
                ? [{ owner: "commercial-terms" as const, purpose: "native-fee" as const }]
                : []),
            ],
            requireListingAuthorityPrincipal(context),
          ),
        },
        context,
      );
      try {
        const capability = await deps.listingTargetAuthority.authorizeManage(
          { accountId: params.accountId },
          context,
          operation,
        );
        assert(
          capability.value && capability.reservations.length > 0,
          "Current listings.manage capability is required.",
        );
        assert(deps.listingTargetAuthority.readInventory, "Current Inventory authority is unavailable.");
        const inventory = await deps.listingTargetAuthority.readInventory(
          { accountId: params.accountId, inventoryItemIds: [params.inventoryItemId] },
          operation,
        );
        const owned = inventory[0];
        assert(
          inventory.length === 1 &&
            owned?.value &&
            owned.reservations.length > 0 &&
            owned.value.accountId === params.accountId &&
            owned.value.inventoryItemId === params.inventoryItemId &&
            owned.value.catalogItemId === operation.subject.catalogItemId &&
            owned.value.productId === operation.subject.productId &&
            Number.isSafeInteger(owned.value.availableQuantity) &&
            owned.value.availableQuantity >= params.quantityCap,
          "Listing quantity exceeds current owned Inventory availability.",
        );
        assert(deps.listingTargetAuthority.readCatalogProduct, "Current Catalog Product authority is unavailable.");
        const product = await deps.listingTargetAuthority.readCatalogProduct(operation, context);
        assert(
          product.reservations.length > 0 &&
            product.value.catalogItemId === operation.subject.catalogItemId &&
            product.value.productId === operation.subject.productId &&
            isDeepStrictEqual(product.value.selectedOptions, operation.subject.selectedOptions),
          "Current Catalog Product identity is required.",
        );
        const reservations = [...capability.reservations, ...owned.reservations, ...product.reservations];
        if (quote) {
          assert(deps.listingTargetAuthority.verifyNativeFeeQuote, "Current native fee authority is unavailable.");
          const verified = await deps.listingTargetAuthority.verifyNativeFeeQuote(
            { accountId: params.accountId, quote },
            operation,
          );
          assert(verified.value && verified.reservations.length > 0, "Current native fee authority is required.");
          reservations.push(...verified.reservations);
        }
        return { fence, operation, reservations, product: product.value };
      } catch (error) {
        await fence.abort(operation, "creation-preparation-failed");
        await fence.settle(operation);
        throw error;
      }
    }
    const quote = publicationScope === "native" ? await quoteListingTerms(params.accountId, params.priceAmount) : null;
    const evidence = await normalizePhotoUploads({
      accountId: params.accountId,
      listingId,
      listingPhotoUploads: params.listingPhotoUploads ?? [],
    });
    const evaluatedAt = new Date().toISOString();
    let evidenceRequirements = null;
    try {
      evidenceRequirements =
        publicationScope === "native"
          ? await resolveListingEvidenceRequirements(deps, {
              accountId: params.accountId,
              catalogItemId: supply.catalog_catalog_item_id,
              productId: supply.product_id,
              selectedOptions: supply.selected_options,
              gradedItem: supply.graded_card !== null,
              priceAmount: params.priceAmount,
              evaluatedAt,
            })
          : null;
    } catch {
      throw new Error("Listing evidence requirements are unavailable.");
    }

    creationAuthority = await prepareCreationAuthority();
    try {
      await commitListingCreation(
        streamId,
        supply.item_id,
        {
          type: "CreateListing",
          requestFingerprint,
          publicationScope,
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
          productMeasureSnapshot: creationAuthority.product.productMeasureSnapshot,
          gradedCard: supply.graded_card,
          storageLocationName: supply.storage_location_name,
          shipFromCode: supply.ship_from_code,
          shipFromAddress: supply.ship_from_address,
          priceAmount: params.priceAmount,
          priceCurrencyCode: params.priceCurrencyCode,
          feeLock: quote ? feeLockFromMarketplaceTermsQuote(params.quantityCap, quote) : null,
          quantityCap: params.quantityCap,
          purchaseLimits: params.purchaseLimits,
          evidenceRequirements,
          evidence,
        },
        context,
        creationAuthority,
      );
    } catch (error) {
      if (creationAuthority) {
        const terminal = await creationAuthority.fence.abort(creationAuthority.operation, "creation-failed");
        await creationAuthority.fence.settle(creationAuthority.operation);
        if (terminal.status === "committed") return replayListingCreation(streamId, requestFingerprint);
      }
      throw error;
    }

    return replayListingCreation(streamId, requestFingerprint);
  }

  async function replayListingCreation(
    streamId: string,
    requestFingerprint: string | undefined,
  ): Promise<MarketplaceNativeListingCreationResult | MarketplaceChannelOnlyListingCreationResult> {
    // @stream-read-contract bounded-contexts/marketplace/features/listings/api/channel-only-create.test.ts
    const [created] = await deps.eventStore.readStream({ streamId, limit: 1 });
    assert(
      requestFingerprint &&
        created?.eventType === "marketplace.listing.created" &&
        created.payload.requestFingerprint === requestFingerprint,
      "Listing creation request changed.",
    );
    const listingId = String(created.payload.listingId) as ListingId;
    if (created.metadata.authorityOperation) {
      const fence = createListingAuthorityFence({
        eventStore: deps.eventStore,
        owner: "marketplace",
        participants: deps.listingTargetAuthority?.participants ?? [],
      });
      await fence.settle(created.metadata.authorityOperation as ListingAuthorityOperation);
    }
    if (created.payload.publicationScope === "channel-only") {
      return { listingId, version: created.streamVersion, nativeFeeState: "not-enrolled", feeQuoteFingerprint: null };
    }
    const feeQuoteFingerprint = created.payload.feeQuoteFingerprint;
    assert(typeof feeQuoteFingerprint === "string" && feeQuoteFingerprint, "Listing fee quote fingerprint is missing.");
    return { listingId, version: created.streamVersion, nativeFeeState: "enrolled", feeQuoteFingerprint };
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
    const evidence = await normalizePhotoUploads({
      accountId: params.accountId,
      listingId: params.listingId,
      listingPhotoUploads: params.listingPhotoUploads,
      existingEvidence: listing.evidence,
    });

    const result = await commandHandler({
      streamId: `marketplace.listing-${params.listingId}`,
      command: {
        type: "AddListingPhotos",
        photos: evidence,
      },
      context,
    });

    return { listingId: params.listingId, version: result.version };
  }

  const targetServices = createListingTargetRuntime({
    eventStore: deps.eventStore,
    currentReads: createListingCurrentReads(deps.db, deps.listingCurrentReadiness),
    authority: deps.listingTargetAuthority,
    bulkPolicy: resolveBulkPriceUpdatePolicy,
    confirmNativePrice: async (accountId, amount, fingerprint) =>
      assertConfirmedFeeQuote(fingerprint, await quoteListingTerms(accountId, amount)),
    nativePriceConfirmation: async (accountId) => {
      const session = await openMarketplaceListingTermsSession(deps.commercialTermsResolver, { accountId });
      return (amount, fingerprint) => assertConfirmedFeeQuote(fingerprint, session.quote(amount));
    },
    load: (listingId) => repository.load(`marketplace.listing-${listingId}`),
    prepareNativeEnable: async (listing, input, operation) => {
      assert(
        listing.accountId && listing.catalogItemId && listing.productId && listing.priceAmount,
        "Native listing identity and price are required.",
      );
      assert(
        listing.status !== "paused" && listing.status !== "withdrawn",
        "Listing visibility cannot clear a pause or withdrawal.",
      );
      const availabilityStreamId = `marketplace.seller-listing-availability-${listing.accountId}`;
      const availability = await sellerAvailabilityRepository.load(availabilityStreamId);
      const now = new Date().toISOString();
      assert(
        availability.state.status === "available" &&
          (!availability.state.pendingAwayWindow || availability.state.pendingAwayWindow.startsAt > now),
        "Seller listing availability is disabled.",
      );
      assert(deps.listingTargetAuthority?.readNativeReadiness, "Current native readiness authority is unavailable.");
      const resolved = await deps.listingTargetAuthority.readNativeReadiness(
        {
          accountId: listing.accountId,
          evaluatedAt: now,
          listings: [
            {
              listingId: input.listingId,
              catalogItemId: listing.catalogItemId,
              productId: listing.productId,
              selectedOptions: listing.selectedOptions,
              gradedItem: listing.gradedCard !== null,
              priceAmount: listing.priceAmount,
            },
          ],
        },
        operation,
      );
      const current = resolved[0];
      assert(
        resolved.length === 1 &&
          current?.value?.listingId === input.listingId &&
          current.value.accountId === listing.accountId &&
          current.reservations.length > 0,
        "Current native readiness authority is required.",
      );
      const { productMeasureSnapshot, productMeasureRevision, evidenceRequirements, seller } = current.value;
      assert(
        productMeasureSnapshot &&
          Number.isSafeInteger(productMeasureRevision) &&
          productMeasureRevision > 0 &&
          productMeasureSnapshot.catalogItemId === listing.catalogItemId &&
          productMeasureSnapshot.productId === listing.productId &&
          productMeasureSnapshot.selectedOptions.length === listing.selectedOptions.length &&
          listing.selectedOptions.every((selection) =>
            productMeasureSnapshot.selectedOptions.some(
              (option) => option.dimensionId === selection.dimensionId && option.optionId === selection.optionId,
            ),
          ),
        "Current native shipping measure is required.",
      );
      assert(evidenceRequirements, "Listing evidence requirements are unavailable.");
      const readiness = evaluateListingEvidenceReadiness({
        snapshot: evidenceRequirements,
        evidence: listing.evidence,
        seller,
        now,
      });
      if (!readiness.ready) {
        throw new MarketplaceListingEvidenceIncompleteError(
          buildMarketplaceListingEvidenceReadiness(evidenceRequirements, listing.evidence, readiness),
        );
      }
      const uncovered = listing.quantityCap - totalFeeLockedUnits(listing.feeLocks);
      const quote = uncovered > 0 ? await quoteListingTerms(listing.accountId, listing.priceAmount) : null;
      const feeReservations: ListingAuthorityReservation[] = [];
      if (quote) {
        assertConfirmedFeeQuote(input.feeQuoteFingerprint, quote);
        assert(deps.listingTargetAuthority.verifyNativeFeeQuote, "Current native fee authority is unavailable.");
        const verified = await deps.listingTargetAuthority.verifyNativeFeeQuote(
          {
            accountId: listing.accountId,
            quote,
          },
          operation,
        );
        assert(verified.value && verified.reservations.length > 0, "Current native fee authority is required.");
        feeReservations.push(...verified.reservations);
      }
      return {
        command: {
          type: "SetNativeListingVisibility",
          nativeVisibility: "enabled",
          csatOutcomeFact: createListingPublishedCsatOutcomeFact({
            accountId: listing.accountId,
            listingId: input.listingId,
          }),
          evidenceRequirements,
          productMeasureSnapshot,
          productMeasureRevision,
          readiness,
          feeLocks: [...listing.feeLocks, ...(quote ? [feeLockFromMarketplaceTermsQuote(uncovered, quote)] : [])],
        },
        reservations: [...current.reservations, ...feeReservations],
        localGuards: [
          {
            streamId: availabilityStreamId,
            expectedVersion: availability.version,
            context: {
              tenantId: operation.tenantId as EventStoreContext["tenantId"],
              audit: {
                forAccountId: operation.accountId as AccountId,
                performedByUserId: operation.actor.userId as UserId,
              },
            },
            events: [],
          },
        ],
      };
    },
    capacityAppends: async (listing, events, context, operation) => {
      assert(listing.inventoryItemId && listing.listingId, "Listing inventory identity is required.");
      const inventoryItemId = listing.inventoryItemId;
      const capacityStreamId = inventoryListingCapacityStreamId(inventoryItemId);
      const capacity = await inventoryListingCapacityRepository.load(capacityStreamId);
      const discovered =
        capacity.state.listingIds.length === 0 ? await discoverInventoryListingIds(inventoryItemId) : [];
      const ids = [...new Set([...capacity.state.listingIds, ...discovered, listing.listingId])].sort();
      const next = applyEvents(listing, evolveMarketplaceListing, events);
      const others = await Promise.all(
        ids.filter((id) => id !== listing.listingId).map((id) => repository.load(`marketplace.listing-${id}`)),
      );
      assert(
        others.every(
          ({ state }) =>
            state.listingId && state.accountId === listing.accountId && state.inventoryItemId === inventoryItemId,
        ),
        "Inventory capacity contains an unavailable or foreign Listing.",
      );
      assert(deps.listingTargetAuthority?.readInventory, "Current Inventory authority is unavailable.");
      const inventory = await deps.listingTargetAuthority.readInventory(
        {
          accountId: listing.accountId!,
          inventoryItemIds: [inventoryItemId],
        },
        operation,
      );
      const supply = inventory[0];
      assert(
        inventory.length === 1 &&
          supply?.value &&
          supply.reservations.length > 0 &&
          supply.value.accountId === listing.accountId &&
          supply.value.inventoryItemId === inventoryItemId &&
          supply.value.catalogItemId === listing.catalogItemId &&
          supply.value.productId === listing.productId &&
          Number.isSafeInteger(supply.value.availableQuantity) &&
          supply.value.availableQuantity >= 0,
        "Current owned Inventory and product identity are required.",
      );
      assertActiveListingCapacity([next, ...others.map((other) => other.state)], supply.value.availableQuantity);
      const registrations = decideInventoryListingCapacity(capacity.state, {
        type: "RegisterInventoryListings",
        inventoryItemId,
        listingIds: ids,
      });
      const capacityEvents = [
        ...registrations,
        ...decideInventoryListingCapacity(applyEvents(capacity.state, evolveInventoryListingCapacity, registrations), {
          type: "CommitInventoryListingCapacity",
          inventoryItemId,
          listingId: listing.listingId,
          quantityCap: next.quantityCap,
        }),
      ];
      return {
        reservations: supply.reservations,
        appends: [
          ...others.map((other) => ({
            streamId: `marketplace.listing-${other.state.listingId}`,
            expectedVersion: other.version,
            context,
            events: [],
          })),
          {
            streamId: capacityStreamId,
            expectedVersion: capacity.version,
            context,
            events: capacityEvents.map(capacityCodec.encode),
          },
        ],
      };
    },
  });

  return {
    ...targetServices,
    commandHandler,
    sellerAvailabilityCommandHandler,
    orderCapacityCommandHandler,
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
          priceCurrencyCode: params.priceCurrencyCode,
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
          priceCurrencyCode: params.priceCurrencyCode,
          quantityCap: params.quantityCap,
          purchaseLimits: params.purchaseLimits,
          listingIdOverride: params.listingIdOverride,
          listingPhotoUploads: params.listingPhotoUploads,
        },
        context,
      );
    },
    addListingPhotos,
    getListingPhotoJpeg: async (params) => {
      let listing: MarketplaceListingState;
      try {
        listing = await loadOwnedListingState(params.listingId, params.accountId);
      } catch (error) {
        if (error instanceof MarketplaceListingNotFoundError) return null;
        throw error;
      }
      const photo = listing.evidence.find((entry) => entry.photoId === params.photoId && entry.status === "active");
      if (!photo) return null;
      assert(deps.listingPhotoStorage, "Listing photo storage is not configured.");
      const source = await deps.listingPhotoStorage.getObject(photo.assetSet.source.storageKey);
      if (!source) return null;
      const body = await sharp(source.body, { limitInputPixels: DEFAULT_LISTING_EVIDENCE_MAX_SOURCE_PIXELS })
        .flatten({ background: LISTING_PHOTO_JPEG_BACKGROUND })
        .jpeg({ quality: LISTING_PHOTO_JPEG_QUALITY })
        .toBuffer();
      assert(body.byteLength <= LISTING_PHOTO_JPEG_MAX_BYTES, "Listing photo JPEG exceeds the byte budget.");
      return { body, etag: `"${createHash("sha256").update(body).digest("hex")}"` };
    },
    classifyListingPhoto: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "ClassifyListingPhoto",
          photoId: params.photoId,
          slotId: params.slotId,
          viewKind: params.viewKind,
          altText: params.altText,
          capturedAt: params.capturedAt,
        },
        context,
      });
      return { listingId: params.listingId, version: result.version };
    },
    replaceListingPhoto: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      const target = listing.evidence.find(
        (photo) => photo.photoId === params.replacedPhotoId && photo.status === "active",
      );
      assert(target, "Listing evidence entry was not found.");
      assert(deps.listingPhotoStorage, "Listing photo storage is not configured.");
      const gatePolicy = await resolveListingGatePolicy();
      const contentType = params.upload.contentType.toLowerCase();
      assert(
        LISTING_PHOTO_UPLOAD_CONTENT_TYPES.has(contentType),
        "Listing evidence must be JPEG, PNG, or WebP images.",
      );
      assert(params.upload.body.byteLength > 0, "Listing photo uploads cannot be empty.");
      assert(
        params.upload.body.byteLength <= gatePolicy.maxListingEvidenceUploadBytes,
        `Listing photo uploads cannot exceed ${gatePolicy.maxListingEvidenceUploadBytes / (1024 * 1024)} MB.`,
      );

      const photoId = createId("lpho");
      const replacement = await normalizeListingPhoto({
        sourceBody: params.upload.body,
        storageBaseKey: `marketplace/listings/${params.accountId}/${params.listingId}/${photoId}`,
        photoId,
        originalFilename: params.upload.originalFilename,
        altText: params.upload.altText ?? target.altText,
        slotId: params.slotId ?? target.slotId,
        viewKind: params.viewKind ?? target.viewKind,
        capturedAt: params.capturedAt ?? null,
        replacesPhotoId: target.photoId,
        sortOrder: target.sortOrder,
        generatedAt: new Date().toISOString(),
        photoStorage: deps.listingPhotoStorage,
      });

      // Governance is evaluated against the post-replacement active set: the
      // demoted target no longer counts, the replacement does.
      assertEvidenceCountAndBytesWithinBudget({
        existingEvidence: listing.evidence.filter((photo) => photo.photoId !== target.photoId),
        additions: [replacement],
        maxEvidenceCount: gatePolicy.maxListingEvidenceCount,
        maxTotalStoredBytes: gatePolicy.maxListingEvidenceTotalBytes,
      });

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "ReplaceListingPhoto", replacedPhotoId: target.photoId, photo: replacement },
        context,
      });
      return { listingId: params.listingId, version: result.version };
    },
    removeListingPhoto: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "RemoveListingPhoto", photoId: params.photoId },
        context,
      });
      return { listingId: params.listingId, version: result.version };
    },
    reorderListingPhotos: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "ReorderListingPhotos", orderedPhotoIds: params.orderedPhotoIds },
        context,
      });
      return { listingId: params.listingId, version: result.version };
    },
    getListingEvidenceSnapshot: async (params) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      return buildListingEvidenceSnapshot({
        evidence: listing.evidence,
        policyHash: listing.evidenceRequirements?.policyHash ?? null,
        createdAt: new Date().toISOString(),
      });
    },
    getListingEvidenceReadiness: async (params) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      const evaluatedAt = params.now ?? new Date().toISOString();
      const snapshot = await resolveEvidenceRequirementsForListing(listing, evaluatedAt);
      const readiness = await evaluateListingReadiness(listing, snapshot, evaluatedAt);
      return buildMarketplaceListingEvidenceReadiness(snapshot, listing.evidence, readiness);
    },
    previewListingEvidenceReadiness: async (params) => {
      const supply = await getInventoryItemSupply(deps.db, params.inventoryItemId, params.accountId);
      assert(supply, "Inventory item not found.");
      const evaluatedAt = params.now ?? new Date().toISOString();
      const snapshot = await resolveListingEvidenceRequirements(deps, {
        accountId: params.accountId,
        catalogItemId: supply.catalog_catalog_item_id,
        productId: supply.product_id,
        selectedOptions: supply.selected_options,
        gradedItem: supply.graded_card !== null,
        priceAmount: params.priceAmount,
        evaluatedAt,
      });
      const requiresSellerFacts = snapshot.requirements.sellerTrustRequirements.length > 0;
      const accountRisk = requiresSellerFacts
        ? await getMarketplaceAccountRisk(deps.db, params.accountId)
        : { review_count: 0, badges: [] as readonly string[] };
      const readiness = evaluateListingEvidenceReadiness({
        snapshot,
        evidence: [],
        seller: { reviewCount: accountRisk.review_count, badgeKeys: accountRisk.badges },
        now: evaluatedAt,
      });
      return buildMarketplaceListingEvidenceReadiness(snapshot, [], readiness);
    },
    collectListingEvidenceGarbage: async (params) => {
      const gatePolicy = await resolveListingGatePolicy();
      const safeDelayHours = params?.safeDelayHours ?? gatePolicy.evidenceGarbageCollectionSafeDelayHours;
      const now = params?.now ?? new Date().toISOString();
      const limit = Math.max(1, Math.min(params?.limit ?? LISTING_EVIDENCE_GC_DEFAULT_LISTING_SCAN_LIMIT, 5000));

      // Scan listings that carry any non-active evidence. `evidence` is a
      // JSONB array; a listing qualifies when at least one entry is not active.
      const rows = await deps.db.query<{ listing_id: string; updated_at: string; evidence: unknown }>(
        `SELECT listing_id, updated_at::text AS updated_at, evidence
         FROM marketplace_listing_pages
         WHERE EXISTS (
           SELECT 1
           FROM jsonb_array_elements(COALESCE(evidence, '[]'::jsonb)) AS entry
           WHERE COALESCE(entry->>'status', 'active') <> 'active'
         )
         ORDER BY updated_at ASC
         LIMIT $1`,
        [limit],
      );

      // Referenced source hashes: every ACTIVE evidence entry across all
      // scanned listings must be retained (dedup safety). Commitment-snapshot
      // references are added here once commitment snapshots record them.
      const referencedSourceHashes = new Set<string>();
      const entries: EvidenceGarbageCollectionEntry[] = [];
      for (const row of rows.rows) {
        const photos = Array.isArray(row.evidence) ? (row.evidence as MarketplaceListingPhoto[]) : [];
        for (const photo of photos) {
          const sourceHash = photo.assetSet?.sourceHash;
          if (!sourceHash) {
            continue;
          }
          if (photo.status === "active") {
            referencedSourceHashes.add(sourceHash);
            continue;
          }
          const storageKeys = [photo.assetSet.source, ...(photo.assetSet.variants ?? [])]
            .map((variant) => variant.storageKey)
            .filter((key): key is string => typeof key === "string" && key.length > 0);
          entries.push({
            photoId: photo.photoId,
            status: photo.status,
            // The read model does not carry a per-entry retirement timestamp;
            // the listing's updated_at is a safe coarse proxy — an asset is
            // only collected once the whole listing has been quiet for the
            // safe delay. A later migration can add a precise timestamp.
            retiredAt: row.updated_at,
            sourceHash,
            storageKeys,
          });
        }
      }

      const plan = selectEvidenceGarbageCollectionTargets({
        entries,
        referencedSourceHashes,
        now,
        safeDelayHours,
      });

      const deleteKeys = plan.targets.flatMap((target) => target.storageKeys);
      const storageDeletionPerformed = Boolean(deps.listingPhotoStorage?.deleteObjects) && deleteKeys.length > 0;
      if (storageDeletionPerformed) {
        // Idempotent: deleting an already-absent key is a no-op, so re-running
        // the sweep is safe.
        await deps.listingPhotoStorage!.deleteObjects!(deleteKeys);
      }

      return {
        scannedListingCount: rows.rows.length,
        deletedAssetKeyCount: storageDeletionPerformed ? deleteKeys.length : 0,
        collectedPhotoIds: plan.targets.map((target) => target.photoId),
        retainedReferencedPhotoIds: plan.retainedReferencedPhotoIds,
        deferredPhotoIds: plan.deferredPhotoIds,
        storageDeletionPerformed,
      } satisfies MarketplaceListingEvidenceGarbageCollectionReport;
    },
    previewListingTerms: async (params) => {
      return quoteListingTerms(params.accountId, params.priceAmount);
    },
    previewPublicStandardListingTerms: async (params) => {
      return quotePublicStandardListingTerms(params.priceAmount);
    },
    createAnonymousListingDraftIntent,
    getAnonymousListingDraftIntent,
    claimAnonymousListingDraftIntent,
    updateListingPrice: targetServices.updateNativePrice,
    applyBulkListingPriceUpdates: targetServices.applyNativePrices,
    updateListingQuantityCap: async (params, context) => {
      return targetServices.commitCapacity(
        params,
        context,
        {
          type: "UpdateListingQuantityCap",
          accountId: params.accountId,
          listingId: params.listingId,
          quantityCap: params.quantityCap,
          purchaseLimits: toJsonValue(params.purchaseLimits ?? null),
          feeQuoteFingerprint: params.feeQuoteFingerprint ?? null,
          expectedVersion: params.expectedVersion ?? null,
        },
        async (listing, operation) => {
          assert(listing.priceAmount, "Listing price is missing.");
          const addedUnitCount = Math.max(0, params.quantityCap - listing.quantityCap);
          const quote =
            addedUnitCount > 0 && listing.nativeVisibility === "enabled"
              ? await quoteListingTerms(params.accountId, listing.priceAmount)
              : null;
          const reservations: ListingAuthorityReservation[] = [];
          if (quote) {
            assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);
            assert(deps.listingTargetAuthority?.verifyNativeFeeQuote, "Current native fee authority is unavailable.");
            const verified = await deps.listingTargetAuthority.verifyNativeFeeQuote(
              { accountId: params.accountId, quote },
              operation,
            );
            assert(verified.value && verified.reservations.length > 0, "Current native fee authority is required.");
            reservations.push(...verified.reservations);
          }
          return {
            command: {
              type: "UpdateListingQuantityCap",
              quantityCap: params.quantityCap,
              purchaseLimits: params.purchaseLimits,
              addedUnitsFeeLock: quote ? feeLockFromMarketplaceTermsQuote(addedUnitCount, quote) : null,
            },
            reservations,
          };
        },
      );
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
    publishListing: targetServices.publishNative,
    pauseListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PauseListing", reason: params.reason },
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
          availableAgainAt: params.availableAgainAt ?? null,
          disabledAt: new Date().toISOString(),
          // A manual (seller-facing) disable; the Away Window start sweep
          // calls the command handler directly with "scheduled" instead of
          // routing through this public method.
          disabledBy: "seller",
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
          enabledBy: params.enabledBy ?? "seller",
          dueBy: params.dueBy,
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
        status: "available",
      };
    },
    getSellerOrderCapacity: (accountId) => getSellerOrderCapacity(deps.db, accountId),
    setSellerOrderCapacity: async (params, context) => {
      const result = await orderCapacityCommandHandler({
        streamId: `marketplace.seller-order-capacity-${params.accountId}`,
        command: {
          type: "SetSellerOrderCapacity",
          accountId: params.accountId,
          maxOpenOrders: params.maxOpenOrders,
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
        maxOpenOrders: params.maxOpenOrders,
      };
    },
    clearSellerOrderCapacity: async (params, context) => {
      const result = await orderCapacityCommandHandler({
        streamId: `marketplace.seller-order-capacity-${params.accountId}`,
        command: {
          type: "ClearSellerOrderCapacity",
          accountId: params.accountId,
        },
        context,
      });

      return {
        accountId: params.accountId,
        version: result.version,
        maxOpenOrders: null,
      };
    },
    sweepDueSellerAvailabilityRestores: async (params, context) => {
      const now = params?.now ?? new Date().toISOString();
      const candidates = await listDueSellerAvailabilityRestores(deps.db, { now, limit: params?.limit });
      let restored = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        const result = await sellerAvailabilityCommandHandler({
          streamId: `marketplace.seller-listing-availability-${candidate.account_id}`,
          command: {
            type: "EnableSellerListingAvailability",
            accountId: candidate.account_id,
            enabledAt: now,
            enabledBy: "scheduled",
            dueBy: candidate.available_again_at,
          },
          context,
        });

        if (result.newEvents.length > 0) {
          restored += 1;
        } else {
          // The seller enabled, or pushed the resume instant forward,
          // between the due-query read above and this command -- the
          // decider's compare-and-swap already no-opped it cleanly.
          skipped += 1;
        }
      }

      return { checked: candidates.length, restored, skipped };
    },
    scheduleSellerAwayWindow: async (params, context) => {
      const result = await sellerAvailabilityCommandHandler({
        streamId: `marketplace.seller-listing-availability-${params.accountId}`,
        command: {
          type: "ScheduleSellerAwayWindow",
          accountId: params.accountId,
          startsAt: params.startsAt,
          endsAt: params.endsAt,
          reasonCategory: params.reasonCategory,
          scheduledAt: new Date().toISOString(),
        },
        context,
      });

      return { accountId: params.accountId, version: result.version };
    },
    cancelScheduledAwayWindow: async (params, context) => {
      const result = await sellerAvailabilityCommandHandler({
        streamId: `marketplace.seller-listing-availability-${params.accountId}`,
        command: {
          type: "CancelScheduledAwayWindow",
          accountId: params.accountId,
          cancelledAt: new Date().toISOString(),
        },
        context,
      });

      return { accountId: params.accountId, version: result.version };
    },
    sweepDueSellerAwayWindowStarts: async (params, context) => {
      const now = params?.now ?? new Date().toISOString();
      const candidates = await listDueSellerAwayWindowStarts(deps.db, { now, limit: params?.limit });
      let started = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        const result = await sellerAvailabilityCommandHandler({
          streamId: `marketplace.seller-listing-availability-${candidate.account_id}`,
          command: {
            type: "DisableSellerListingAvailability",
            accountId: candidate.account_id,
            reasonCategory: candidate.away_window_reason_category as SellerListingAvailabilityReasonCategory,
            availableAgainOn: null,
            availableAgainAt: candidate.away_window_ends_at,
            // The away period is dated from the window's own scheduled
            // start, not from whenever this tick of the sweep happens to
            // run -- a late-running sweep (e.g. after a missed interval)
            // must not retroactively violate "available again after
            // disable" for a window whose endsAt has since also elapsed.
            disabledAt: candidate.away_window_starts_at,
            disabledBy: "scheduled" satisfies SellerListingAvailabilityDisabledBy,
            dueBy: candidate.away_window_starts_at,
          },
          context,
        });

        if (result.newEvents.length > 0) {
          started += 1;
        } else {
          // The seller cancelled the window (or it no longer matches)
          // between the due-query read above and this command -- the
          // decider's compare-and-swap already no-opped it cleanly.
          skipped += 1;
        }
      }

      return { checked: candidates.length, started, skipped };
    },
    listSellerListings: (params) => listSellerListings(deps.db, params),
    getSellerListingStatusCounts: (accountId) => getSellerListingStatusCounts(deps.db, accountId),
    listSellerInventoryItemSupply: (params) => listSellerInventoryItemSupply(deps.db, params),
    hasSellerSupplyLocationNamed: (params) => hasSellerSupplyLocationNamed(deps.db, params),
    getSellerListing: (listingId, accountId) => getSellerListing(deps.db, listingId, accountId),
    getListingEvidenceCoverage: async ({ accountId, listingId, now }) => {
      const listing = await loadOwnedListingState(listingId, accountId);
      const [catalogResult, accountRisk, listingRow] = await Promise.all([
        deps.db.query<{ blueprint_id: string | null; category_ids: unknown }>(
          `SELECT blueprint_id, category_ids
             FROM marketplace_catalog_items
            WHERE catalog_item_id = $1`,
          [listing.catalogItemId],
        ),
        getMarketplaceAccountRisk(deps.db, accountId),
        deps.db.query<{ updated_at: string }>(
          `SELECT updated_at::text AS updated_at
             FROM marketplace_listing_pages
            WHERE listing_id = $1 AND account_id = $2`,
          [listingId, accountId],
        ),
      ]);
      const catalog = catalogResult.rows[0];
      const categoryIds = Array.isArray(catalog?.category_ids)
        ? catalog.category_ids.filter((value): value is string => typeof value === "string")
        : [];
      const resolved = deps.policies
        ? await deps.policies.resolvePolicy(marketplaceListingEvidencePolicy)
        : {
            value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
            documentId: null,
            effectiveFrom: null,
            effectiveUntil: null,
          };
      const evaluation = evaluateListingEvidencePolicy(
        resolved.value,
        {
          catalogItemId: listing.catalogItemId ?? "",
          productId: listing.productId ?? "",
          blueprintId: catalog?.blueprint_id ?? null,
          categoryIds,
          selectedOptions: listing.selectedOptions,
          gradedItem: listing.gradedCard !== null,
          priceAmount: listing.priceAmount ?? "0",
          seller: {
            reviewCount: accountRisk.review_count,
            badgeKeys: accountRisk.badges,
            riskLevel: null,
          },
        },
        {
          policyId: resolved.documentId,
          policyVersion: null,
          effectiveFrom: resolved.effectiveFrom,
          effectiveUntil: resolved.effectiveUntil,
        },
      );
      return {
        listingId,
        listingStatus: listing.status,
        evidence: listing.evidence,
        policyHash: evaluation.policyHash,
        policyVersion: evaluation.policyVersion,
        requirements: evaluation.requirements,
        coverage: evaluateEvidenceCoverage(evaluation.requirements, listing.evidence, { now }),
        updatedAt: listingRow.rows[0]?.updated_at ?? new Date().toISOString(),
      };
    },
    listSellerListingFeeHistory: async (params) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const events = await readCompleteStream(deps.eventStore, {
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
    loadListingState: async (listingId) => (await repository.load(`marketplace.listing-${listingId}`)).state,
    reconcileInventoryCapacity,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-listing-projection",
        handlers: buildMarketplaceListingProjectionHandlers(deps.db),
      }),
    ],
  };
}
