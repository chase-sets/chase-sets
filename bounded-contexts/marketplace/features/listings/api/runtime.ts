import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresAggregateSnapshotStore } from "@chase-sets/event-core-postgres";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { createId, type AccountId, type ListingId, type TenantId, type UserId } from "@chase-sets/primitives/typed-ids";
import type { CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import {
  chunkItems,
  createBulkAppendLane,
  defaultLaneYield,
  type BulkAppendLaneItem,
} from "@chase-sets/platform-runtime/bulk-append-lane";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import {
  feeLockFromMarketplaceTermsQuote,
  quoteMarketplaceTerms,
  quotePublicStandardMarketplaceTerms,
  requoteMarketplaceListingFeeLock,
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
  type MarketplaceListingPhoto,
  type MarketplaceListingPurchaseLimits,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { evaluateListingEvidenceReadiness } from "../domain/listing-evidence-readiness";
import { resolveListingEvidenceRequirements } from "./evidence-requirement-resolver";
import { assertEvidenceCountAndBytesWithinBudget } from "../domain/evidence-governance";
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
  getActiveQuantityCapForInventoryItem,
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
/**
 * Bump whenever `evolveMarketplaceListing`'s fold shape changes in a way
 * that would make an old snapshot's stored state incompatible. A stored
 * snapshot with a different schema version is ignored -- load() falls back
 * to full replay, exactly as if no snapshot existed.
 */
const MARKETPLACE_LISTING_SNAPSHOT_SCHEMA_VERSION = 4;
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

export type MarketplaceListingServices = Readonly<{
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
  /**
   * Chunked multi-listing price-update append, part of the m113 (repricing
   * at scale) throughput lane: applies many `UpdateListingPrice` commands
   * amortized across `marketplaceListingBulkPriceUpdatePolicy`-sized
   * chunks, one advisory-lock window and one multi-row event INSERT per
   * chunk, with the lane yielding between chunks so a bulk repricing run
   * cannot starve interactive listing edits. One listing's version
   * conflict, domain error (e.g. a withdrawn listing), or stale fee quote
   * is isolated to that listing -- every other listing in the batch still
   * applies. Consumed by the future bulk-ingestion on-ramp, `pricing`'s
   * `applyRecommendations`, and the policy evaluation engine; all funnel
   * through this same path.
   *
   * Terms resolution (m113 repricing-at-scale throughput lane): every
   * listing in `params.updates` belongs to the SAME `params.accountId`, so
   * the account's commercial terms are resolved into one session per chunk
   * -- not once per listing -- and applied locally to each listing's
   * price. A fresh session is
   * opened for every chunk (the same boundary the advisory-lock window
   * already uses), so a schedule/agreement revision that lands mid-run is
   * picked up by the NEXT chunk without ever baking stale fee fields into
   * a chunk that hasn't appended yet. `feeQuoteFingerprint` stays optional
   * per update: when a caller supplies one (e.g. a human confirming a
   * previewed price), it must still match the freshly-resolved quote or
   * the update is isolated as an error, exactly like `updateListingPrice`;
   * when omitted (bulk/system callers with no separate preview step), the
   * update applies at the freshly-resolved terms with no confirmation
   * required.
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
    snapshots: {
      store: createPostgresAggregateSnapshotStore<MarketplaceListingState>({ db: deps.db }),
      schemaVersion: MARKETPLACE_LISTING_SNAPSHOT_SCHEMA_VERSION,
      everyNEvents: MARKETPLACE_LISTING_SNAPSHOT_EVERY_N_EVENTS,
    },
  });
  const { commandHandler: sellerAvailabilityCommandHandler } = createAggregateCommandHandler({
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
    const evidence = await normalizePhotoUploads({
      accountId: params.accountId,
      listingId,
      listingPhotoUploads: params.listingPhotoUploads ?? [],
    });
    const evaluatedAt = new Date().toISOString();
    let evidenceRequirements;
    try {
      evidenceRequirements = await resolveListingEvidenceRequirements(deps, {
        accountId: params.accountId,
        catalogItemId: supply.catalog_catalog_item_id,
        productId: supply.product_id,
        selectedOptions: supply.selected_options,
        gradedItem: supply.graded_card !== null,
        priceAmount: params.priceAmount,
        evaluatedAt,
      });
    } catch {
      throw new Error("Listing evidence requirements are unavailable.");
    }

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
        feeLock: feeLockFromMarketplaceTermsQuote(params.quantityCap, quote),
        quantityCap: params.quantityCap,
        purchaseLimits: params.purchaseLimits,
        evidenceRequirements,
        evidence,
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

  return {
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
    updateListingPrice: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      const feeLocks = listing.feeLocks.map((lock) => requoteMarketplaceListingFeeLock(lock, params.priceAmount));

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPrice",
          priceAmount: params.priceAmount,
          feeLocks,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    applyBulkListingPriceUpdates: async (params, context) => {
      if (params.updates.length === 0) {
        return [];
      }

      const policy = await resolveBulkPriceUpdatePolicy();
      const waves = chunkItems(params.updates, policy.chunkSize);
      const outcomesByListingId = new Map<string, MarketplaceBulkListingPriceUpdateOutcome>();

      for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
        const wave = waves[waveIndex]!;

        // One terms session per wave, not per listing: every update in
        // `params.updates` shares `params.accountId`, so the account's
        // schedule/agreement resolves once per chunk instead of once per
        // listing. Re-opening the session at each chunk boundary (rather
        // than once for the whole call) is the mid-run staleness safety
        // net -- a schedule/agreement revision between chunks is picked up
        // by the next wave instead of silently reusing stale fee fields.
        const laneItems: BulkAppendLaneItem<MarketplaceListingCommand>[] = [];
        for (const update of wave) {
          try {
            const listing = await loadOwnedListingState(update.listingId, params.accountId);
            assert(listing.priceAmount !== null, "Listing price is missing.");
            const feeLocks = listing.feeLocks.map((lock) => requoteMarketplaceListingFeeLock(lock, update.priceAmount));

            laneItems.push({
              streamId: `marketplace.listing-${update.listingId}`,
              command: {
                type: "UpdateListingPrice",
                priceAmount: update.priceAmount,
                feeLocks,
              },
              context,
            });
          } catch (error) {
            outcomesByListingId.set(update.listingId, {
              listingId: update.listingId,
              outcome: "error",
              version: 0,
              message: error instanceof Error ? error.message : "Bulk listing price update failed.",
            });
          }
        }

        if (laneItems.length > 0) {
          // One chunk's worth of items per lane call -- the lane's own
          // internal chunking degenerates to a single chunk here since
          // `laneItems.length <= policy.chunkSize`, preserving the "one
          // advisory-lock window and one multi-row event INSERT per
          // chunk" invariant the chunked multi-listing append path
          // established. The inter-chunk yield happens below, between
          // waves, instead of inside the lane.
          const lane = createBulkAppendLane({
            eventStore: deps.eventStore,
            repository,
            codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
            evolve: evolveMarketplaceListing,
            decide: decideMarketplaceListing,
            chunkSize: laneItems.length,
            yieldIntervalMs: 0,
            telemetry: { holderKind: "bulk_listing_price_update", sourceContextName: "marketplace" },
          });
          const laneOutcomes = await lane(laneItems);
          for (const laneOutcome of laneOutcomes) {
            const listingId = laneOutcome.streamId.slice("marketplace.listing-".length);
            outcomesByListingId.set(listingId, {
              listingId,
              outcome: laneOutcome.outcome,
              version: laneOutcome.version,
              ...(laneOutcome.error ? { message: laneOutcome.error.message } : {}),
            });
          }
        }

        const isLastWave = waveIndex === waves.length - 1;
        if (!isLastWave) {
          await defaultLaneYield(policy.yieldIntervalMs);
        }
      }

      return params.updates.map((update) => {
        return (
          outcomesByListingId.get(update.listingId) ?? {
            listingId: update.listingId,
            outcome: "error" as const,
            version: 0,
            message: "Bulk listing price update did not run.",
          }
        );
      });
    },
    updateListingQuantityCap: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.priceAmount, "Listing price is missing.");
      const addedUnitCount = Math.max(0, params.quantityCap - listing.quantityCap);
      const quote = addedUnitCount > 0 ? await quoteListingTerms(params.accountId, listing.priceAmount) : null;
      if (quote) {
        assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);
      }

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
          addedUnitsFeeLock: quote ? feeLockFromMarketplaceTermsQuote(addedUnitCount, quote) : null,
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
      const evaluatedAt = new Date().toISOString();
      const evidenceRequirements = await resolveEvidenceRequirementsForListing(listing, evaluatedAt);
      await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "RefreshListingEvidenceRequirements", evidenceRequirements },
        context,
      });
      const readiness = await evaluateListingReadiness(listing, evidenceRequirements, evaluatedAt);
      if (!readiness.ready) {
        const evidenceReadiness = buildMarketplaceListingEvidenceReadiness(
          evidenceRequirements,
          listing.evidence,
          readiness,
        );
        throw new MarketplaceListingEvidenceIncompleteError(evidenceReadiness);
      }
      await ensureActiveCapacity(listing.inventoryItemId, listing.quantityCap, params.listingId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "PublishListing",
          readiness,
          csatOutcomeFact: createListingPublishedCsatOutcomeFact({
            accountId: params.accountId,
            listingId: params.listingId,
          }),
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
