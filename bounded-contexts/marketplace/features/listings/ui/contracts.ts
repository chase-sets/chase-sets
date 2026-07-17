import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductMeasureSnapshot } from "@chase-sets/product-measures";
import type { ResolvedListingEvidenceRequirements } from "../../listing-evidence-policy/domain/policy";
import type { EvidenceCoverageResult } from "../domain/evidence-coverage";
import type { MarketplaceListingFeeLock } from "../domain/fee-lock";
import type { ListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import type { ListingEvidenceReadinessCode } from "../domain/listing-evidence-readiness";

export type MarketplaceListingPhotoAssetRole = "source" | "thumbnail" | "search-card" | "catalog-detail";

export interface MarketplaceListingPhotoAssetVariant {
  role: MarketplaceListingPhotoAssetRole;
  width: number;
  height: number;
  density: 1 | 2 | null;
  mediaType: "image/webp";
  storageKey: string;
  publicUrl: string;
  byteSize: number;
  generatedAt: string;
}

export interface MarketplaceListingPhotoAssetSet {
  kind: "listing-photo";
  sourceHash: string;
  source: MarketplaceListingPhotoAssetVariant;
  variants: MarketplaceListingPhotoAssetVariant[];
}

export type MarketplaceListingPhotoStatus = "active" | "replaced" | "removed";

export interface MarketplaceListingPhoto {
  photoId: string;
  originalFilename: string | null;
  altText: string | null;
  slotId: string | null;
  viewKind: string | null;
  status: MarketplaceListingPhotoStatus;
  sortOrder: number;
  capturedAt: string | null;
  uploadedAt: string;
  assetRevision: string;
  replacesPhotoId: string | null;
  assetSet: MarketplaceListingPhotoAssetSet;
}

export interface MarketplaceListingPublicGalleryImageAsset {
  role: string;
  publicUrl: string;
  width: number;
  height: number;
  density: 1 | 2 | null;
}

export interface MarketplaceListingPublicGalleryImage {
  photoId: string;
  slotId: string | null;
  viewKind: string | null;
  altText: string | null;
  sortOrder: number;
  assets: readonly MarketplaceListingPublicGalleryImageAsset[];
}

export interface MarketplaceListingListItem {
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  product_measure_snapshot: ProductMeasureSnapshot | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_name: string | null;
  ship_from_code: string | null;
  ship_from_address: AddressSnapshot;
  price_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: readonly MarketplaceListingFeeLock[];
  quantity_cap: number;
  max_units_per_order?: number | null;
  max_units_per_day?: number | null;
  max_units_per_customer_account?: number | null;
  evidence_requirements: ListingEvidenceRequirementSnapshot | null;
  evidence: readonly MarketplaceListingPhoto[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceSellerListingStatusCounts {
  active: number;
  draft: number;
  paused: number;
  withdrawn: number;
}

export interface MarketplaceListingBulkActionOutcome {
  listingId: string;
  label: string;
  outcome: "success" | "error";
  message: string | null;
}

export interface MarketplaceGradedCardDetails {
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: {
    populationAtGrade: number | null;
    populationHigher: number | null;
    source: string | null;
    asOf: string | null;
  } | null;
  conditionDescriptors: string[];
}

export type MarketplaceListingEvidenceReadiness = Readonly<{
  ready: boolean;
  policy: Readonly<{
    policyId: ListingEvidenceRequirementSnapshot["policyId"];
    policyVersion: ListingEvidenceRequirementSnapshot["policyVersion"];
    policyHash: ListingEvidenceRequirementSnapshot["policyHash"];
    requirementHash: ListingEvidenceRequirementSnapshot["requirementHash"];
    evaluatedAt: ListingEvidenceRequirementSnapshot["evaluatedAt"];
    explanationCodes: ListingEvidenceRequirementSnapshot["explanationCodes"];
  }>;
  requirements: ResolvedListingEvidenceRequirements;
  coverage: EvidenceCoverageResult;
  nextActions: readonly Readonly<{
    code: ListingEvidenceReadinessCode;
    localeKey: string;
    slotIds: readonly string[];
  }>[];
  publicGallery: readonly MarketplaceListingPublicGalleryImage[];
}>;

export interface MarketplaceListingDetail extends MarketplaceListingListItem {
  evidence_readiness: MarketplaceListingEvidenceReadiness;
}

export type MarketplaceListingEvidenceCoverage = Readonly<{
  listingId: string;
  listingStatus: string;
  evidence: readonly MarketplaceListingPhoto[];
  policyHash: string;
  policyVersion: number | null;
  requirements: ResolvedListingEvidenceRequirements;
  coverage: EvidenceCoverageResult;
  updatedAt: string;
}>;

export interface MarketplaceSellerListingAvailability {
  account_id: string;
  status: "available" | "unavailable";
  disabled_reason_category: string | null;
  available_again_on: string | null;
  available_again_at: string | null;
  disabled_at: string | null;
  enabled_at: string | null;
  /** The pending Away Window's start, or null when no window is scheduled. */
  away_window_starts_at: string | null;
  away_window_ends_at: string | null;
  away_window_reason_category: string | null;
  updated_at: string;
}

/**
 * The seller's Order Capacity setting (m127): the maximum number of
 * concurrently Open Orders the account will accept before new order intake
 * pauses. `max_open_orders: null` means unlimited (the default). This is the
 * marketplace-owned source of truth for the cap; the live "N of M" Open Order
 * count that pairs with it is read separately from Ordering, never
 * counted client-side.
 */
export interface MarketplaceSellerOrderCapacity {
  account_id: string;
  max_open_orders: number | null;
  updated_at: string;
}

export interface MarketplaceListingFeeLockReportEntry {
  listing_id: string;
  inventory_item_id: string;
  item_title: string | null;
  item_language_code: string | null;
  product_summary: string | null;
  status: string;
  price_amount: string;
  quantity_cap: number;
  max_units_per_order?: number | null;
  max_units_per_day?: number | null;
  max_units_per_customer_account?: number | null;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string;
  fee_locks: readonly MarketplaceListingFeeLock[];
  created_at: string;
  updated_at: string;
}

export interface MarketplaceMarketSummary {
  lowest_price_amount: string | null;
  active_listing_count: number;
  total_visible_quantity: number;
}

export interface MarketplaceItemListing extends MarketplaceListingListItem {
  seller_display_name: string | null;
  visible_quantity: number;
  /** Buyer-safe evidence gallery; `evidence` is empty on public rows. */
  public_gallery: readonly MarketplaceListingPublicGalleryImage[];
}

export interface MarketplaceListingInventoryItemOption {
  item_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly { dimensionId: string; optionId: string }[];
  product_summary: string | null;
  product_measure_snapshot: ProductMeasureSnapshot | null;
  graded_card: MarketplaceGradedCardDetails | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  total_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
}

export interface MarketplaceAnonymousListingDraftIntent {
  intent_id: string;
  anonymous_owner_id: string;
  source_path: string;
  catalog_item_id: string;
  product_id: string;
  selected_options: readonly { dimensionId: string; optionId: string }[];
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
}

export interface MarketplaceListingTermsPreview {
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  marketplace_sales_fee_cap_amount: string | null;
  shipping_allowance_percentage_bps: number;
  schedule_id: string | null;
  agreement_id: string | null;
  resolved_at: string;
  fee_quote_fingerprint: string;
}

/**
 * One listing's price-update input to the bulk chunked-append path
 * (`applyBulkListingPriceUpdates`), part of the m113 repricing-at-scale
 * throughput lane. `feeQuoteFingerprint` is optional: a human-confirmed
 * price supplies it and gets the same
 * staleness protection as `updateListingPrice`; a bulk/system caller (e.g.
 * `pricing`'s `applyRecommendations`) omits it and applies at the
 * freshly-resolved per-account terms session with nothing to confirm.
 */
export interface MarketplaceBulkListingPriceUpdateInput {
  listingId: string;
  priceAmount: string;
  feeQuoteFingerprint?: string | null;
  /**
   * Optional optimistic precondition used by automated repricing. A manual
   * edit after the evaluator's snapshot produces a per-listing conflict and
   * is never overwritten.
   */
  expectedVersion?: number;
  minimumChange?: Readonly<{ mode: "absolute"; amount: string }> | Readonly<{ mode: "percent"; percent: number }>;
  idempotencyKey?: string;
}

/** Per-listing outcome of a bulk price-update run -- failure isolation means one listing's conflict or error never prevents the others from applying. */
export interface MarketplaceBulkListingPriceUpdateOutcome {
  listingId: string;
  outcome: "applied" | "no_op" | "conflict" | "error";
  version: number;
  message?: string;
}

export interface MarketplacePublicStandardTermsPreview {
  account_type: "personal" | "business" | "enterprise";
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  source_kind: "public-standard-seller-terms";
  source_label: string;
  schedule_label: string;
  source_updated_at: string;
  resolved_at: string;
}

export interface MarketplaceListingFeeHistoryEntry {
  event_type: string;
  stream_version: number;
  price_amount: string | null;
  quantity_cap: number | null;
  marketplace_sales_fee_unit_amount: string | null;
  seller_net_unit_amount: string | null;
  shipping_allowance_percentage_bps: number | null;
  terms_schedule_id: string | null;
  terms_agreement_id: string | null;
  terms_resolved_at: string | null;
  fee_quote_fingerprint: string | null;
  recorded_at: string;
  performed_by_user_id: string | null;
}
