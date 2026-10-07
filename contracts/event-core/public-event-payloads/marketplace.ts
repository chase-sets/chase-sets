// Marketplace-owned public event payloads.
//
// `MarketplaceEventPayloads` also registers the two Platform Operations action-recorded
// facts under their `platform-operations.*` stream keys. That cross-registration is the
// published contract: the types are Platform-Operations-owned, their membership here is not.
import type { AddressSnapshot } from "../../primitives/address-snapshot";
import type { JsonValue } from "../../primitives/json";
import {
  parseStrictTypedUlid,
  type AccountId,
  type ListingEnforcementActionId,
  type ReportedContentActionId,
  type TypedUlid,
} from "../../primitives/typed-ids";
import type { MarketplaceReviewScoringDispositionProjectedV1Payload } from "../review-scoring-facts";
import type { ReviewOpportunityChangedV1 } from "../review-opportunity-facts";
import type { EmptyEventPayload } from "./event-core";
import type {
  PlatformOperationsReportedContentActionRecordedPayload,
  PlatformOperationsRiskAlertActionRecordedPayload,
} from "./platform-operations";

export type MarketplaceSalesFeeLineSnapshotPayload = Readonly<{
  lineId: string;
  unitPriceAmount: string;
  quantity: number;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string;
  marketplaceSalesFeeTotalAmount: string;
}>;

export type MarketplaceOfferAcceptedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  listingId: string;
  inventoryItemId: string;
  listingVersion: number;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  priceAmount: string;
  /** Absent only when decoding historical amount-only Offer events. */
  priceCurrencyCode?: string | null;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  shippingDestinationSnapshot: AddressSnapshot;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeQuoteFingerprint: string;
  listingEvidencePolicyId: string | null;
  listingEvidencePolicyVersion: number | null;
  listingEvidencePolicyHash: string;
  listingEvidenceSnapshot: Readonly<{
    schemaVersion: 1;
    policyHash: string | null;
    snapshotHash: string;
    createdAt: string;
    evidence: readonly Readonly<{
      photoId: string;
      slotId: string | null;
      viewKind: string | null;
      sortOrder: number;
      sourceHash: string;
      assetRevision: string;
      capturedAt: string | null;
      uploadedAt: string;
      assets: readonly Readonly<{
        role: string;
        storageKey: string;
        publicUrl: string;
        width: number;
        height: number;
        density: 1 | 2 | null;
        mediaType: "image/webp";
        byteSize: number;
      }>[];
    }>[];
  }>;
  quantityRequested: number;
  acceptanceBatchId: string | null;
  acceptanceBatchSize: number | null;
  acceptedAt: string;
}>;

export type MarketplaceOfferSubmittedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  shippingDestinationSnapshot: AddressSnapshot;
  priceAmount: string;
  /** Absent only when decoding historical amount-only Offer events. */
  priceCurrencyCode?: string | null;
  quantityRequested: number;
}>;

export type MarketplaceOfferPriceUpdatedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  priceAmount: string;
  priceCurrencyCode: string;
}>;

export type MarketplaceListingOfferCommitmentRecordedPayload = Readonly<{
  offerId: string;
  quantity: number;
  evidenceSnapshotHash: string;
  committedAt: string;
}>;

export type MarketplaceSellerListingAvailabilityCommitmentCheckedPayload = Readonly<{
  offerId: string;
  listingId: string;
  checkedAt: string;
}>;

export type MarketplacePurchaseLimitsPayload = Readonly<{
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
}>;

export type MarketplaceListingFeeTermsSnapshotPayload = Readonly<{
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

export type MarketplaceListingFeeLockPayload = Readonly<{
  unitCount: number;
  terms: MarketplaceListingFeeTermsSnapshotPayload;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  feeQuoteFingerprint: string;
}>;

export type MarketplaceListingCreatedPayload = Readonly<{
  listingId: string;
  accountId: AccountId;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  productMeasureSnapshot?: JsonValue;
  gradedCard?: JsonValue;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress: JsonValue;
  priceAmount: string;
  /** Absent only when decoding historical amount-only listing events. */
  priceCurrencyCode?: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
  quantityCap: number;
  purchaseLimits?: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceListingPriceUpdatedPayload = Readonly<{
  priceAmount: string;
  /** Absent only when decoding historical amount-only listing events. */
  priceCurrencyCode?: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
}>;

export type MarketplaceListingQuantityCapUpdatedPayload = MarketplaceListingPriceUpdatedPayload &
  Readonly<{
    quantityCap: number;
    purchaseLimits?: MarketplacePurchaseLimitsPayload;
  }>;

export type MarketplaceListingPurchaseLimitsUpdatedPayload = Readonly<{
  purchaseLimits: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceSellerListingAvailabilityPayload = Readonly<{
  accountId: AccountId;
}>;

/** Closed provenance of a Listing Enforcement Action; the source grants no permission. */
export const marketplaceListingEnforcementSources = ["operator-unlist", "automatic-report-threshold"] as const;

export type MarketplaceListingEnforcementSource = (typeof marketplaceListingEnforcementSources)[number];

type MarketplaceListingEnforcementFields = Readonly<{
  version: 1;
  listingEnforcementActionId: ListingEnforcementActionId;
  /** The Listing owner, copied from the aggregate; never caller-supplied. */
  accountId: AccountId;
  occurredAt: string;
}>;

export type MarketplaceOperatorListingEnforcementData = MarketplaceListingEnforcementFields &
  Readonly<{ source: "operator-unlist"; sourceActionId: ReportedContentActionId }>;

export type MarketplaceAutomaticListingEnforcementData = MarketplaceListingEnforcementFields &
  Readonly<{ source: "automatic-report-threshold"; sourceActionId: TypedUlid<"rpt"> }>;

export type MarketplaceListingEnforcementData =
  | MarketplaceOperatorListingEnforcementData
  | MarketplaceAutomaticListingEnforcementData;

/** Historical auto-unlisted facts carry no `listingEnforcement`; they record no identity. */
export type MarketplaceListingAutoUnlistedLegacyPayload = Readonly<{
  reportId: string;
  reportCount: number;
  threshold: number;
  autoUnlistedAt: string;
}>;

export type MarketplaceListingAutoUnlistedEnforcedPayload = Readonly<{
  reportId: TypedUlid<"rpt">;
  reportCount: number;
  threshold: number;
  autoUnlistedAt: string;
  listingEnforcement: MarketplaceAutomaticListingEnforcementData;
}>;

export type MarketplaceListingAutoUnlistedPayload =
  | MarketplaceListingAutoUnlistedLegacyPayload
  | MarketplaceListingAutoUnlistedEnforcedPayload;

export type MarketplaceListingOperatorUnlistedPayload = Readonly<{
  listingEnforcement: MarketplaceOperatorListingEnforcementData;
}>;

/**
 * Reads a stored or candidate auto-unlisted payload. Enrichment wholly absent is
 * historical and is returned unchanged; any present enrichment must be the complete,
 * closed automatic record whose source and time equal the report fields.
 */
export function parseMarketplaceListingAutoUnlistedPayload(value: unknown): MarketplaceListingAutoUnlistedPayload {
  const input = listingEnforcementRecord(value, "Auto-unlisted payload");
  if (!Object.hasOwn(input, "listingEnforcement")) {
    return input as MarketplaceListingAutoUnlistedLegacyPayload;
  }
  assertListingEnforcementKeys(
    input,
    ["reportId", "reportCount", "threshold", "autoUnlistedAt", "listingEnforcement"],
    "Auto-unlisted payload",
  );
  const reportId = listingEnforcementTypedUlid(input.reportId, "rpt", "Auto-unlist report id");
  const reportCount = listingEnforcementPositiveInteger(input.reportCount, "Auto-unlist report count");
  const threshold = listingEnforcementPositiveInteger(input.threshold, "Auto-unlist threshold");
  if (reportCount < threshold) {
    throw new Error("Auto-unlist report count must reach the threshold.");
  }
  const autoUnlistedAt = listingEnforcementInstant(input.autoUnlistedAt, "Auto-unlist timestamp");
  const enforcement = parseMarketplaceListingEnforcementData(input.listingEnforcement);
  if (enforcement.source !== "automatic-report-threshold") {
    throw new Error("Auto-unlisted payload requires the automatic-report-threshold source.");
  }
  if (enforcement.sourceActionId !== reportId || enforcement.occurredAt !== autoUnlistedAt) {
    throw new Error("Automatic listing enforcement must equal its report id and auto-unlist timestamp.");
  }
  return { reportId, reportCount, threshold, autoUnlistedAt, listingEnforcement: enforcement };
}

export function parseMarketplaceListingOperatorUnlistedPayload(
  value: unknown,
): MarketplaceListingOperatorUnlistedPayload {
  const input = listingEnforcementRecord(value, "Operator-unlisted payload");
  assertListingEnforcementKeys(input, ["listingEnforcement"], "Operator-unlisted payload");
  const enforcement = parseMarketplaceListingEnforcementData(input.listingEnforcement);
  if (enforcement.source !== "operator-unlist") {
    throw new Error("Operator-unlisted payload requires the operator-unlist source.");
  }
  return { listingEnforcement: enforcement };
}

/** Parses one closed `listingEnforcement` record; source-to-event pairing is checked by the payload parsers. */
export function parseMarketplaceListingEnforcementData(value: unknown): MarketplaceListingEnforcementData {
  const input = listingEnforcementRecord(value, "Listing enforcement");
  assertListingEnforcementKeys(
    input,
    ["version", "listingEnforcementActionId", "accountId", "source", "sourceActionId", "occurredAt"],
    "Listing enforcement",
  );
  if (input.version !== 1) {
    throw new Error("Listing enforcement version is not supported.");
  }
  const fields = {
    version: 1,
    listingEnforcementActionId: listingEnforcementTypedUlid(
      input.listingEnforcementActionId,
      "lea",
      "Listing enforcement action id",
    ),
    accountId: listingEnforcementText(input.accountId, "Listing enforcement account id") as AccountId,
    occurredAt: listingEnforcementInstant(input.occurredAt, "Listing enforcement time"),
  } as const;
  switch (input.source) {
    case "operator-unlist":
      return {
        ...fields,
        source: input.source,
        sourceActionId: listingEnforcementTypedUlid(input.sourceActionId, "rca", "Listing enforcement source id"),
      };
    case "automatic-report-threshold":
      return {
        ...fields,
        source: input.source,
        sourceActionId: listingEnforcementTypedUlid(input.sourceActionId, "rpt", "Listing enforcement source id"),
      };
    default:
      throw new Error("Listing enforcement source is invalid.");
  }
}

function listingEnforcementRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertListingEnforcementKeys(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) {
    throw new Error(`${label} requires exactly: ${keys.join(", ")}.`);
  }
}

function listingEnforcementText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a nonempty, unpadded string.`);
  }
  return value;
}

function listingEnforcementTypedUlid<Prefix extends string>(
  value: unknown,
  prefix: Prefix,
  label: string,
): TypedUlid<Prefix> {
  try {
    return parseStrictTypedUlid(listingEnforcementText(value, label), prefix);
  } catch {
    throw new Error(`${label} must be a canonical '${prefix}_' ULID.`);
  }
}

function listingEnforcementPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return value;
}

/** A calendar-valid ISO instant with an explicit `Z` or `±hh:mm` offset; date-only text is rejected. */
function listingEnforcementInstant(value: unknown, label: string): string {
  const input = listingEnforcementText(value, label);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(input);
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = parts ?? [];
  const calendarDay = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    !parts ||
    !Number.isFinite(Date.parse(input)) ||
    calendarDay.getUTCMonth() !== Number(month) - 1 ||
    calendarDay.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  ) {
    throw new Error(`${label} must be a timezone-bearing ISO instant.`);
  }
  return input;
}

export type MarketplaceReportSubmittedPayload = Readonly<{
  reportId: string;
  targetType: "listing" | "review";
  targetId: string;
  targetOwnerAccountId: string | null;
  reporterKind: "account" | "visitor";
  reporterKey: string;
  reporterAccountId: string | null;
  reporterUserId: string | null;
  reason: string;
  details: string | null;
  sourceRoutePath: string;
  submittedAt: string;
}>;

export type MarketplaceEventPayloads = Readonly<{
  "marketplace.review-opportunity.changed.v1": ReviewOpportunityChangedV1;
  "marketplace.listing.created": MarketplaceListingCreatedPayload;
  "marketplace.listing.price-updated": MarketplaceListingPriceUpdatedPayload;
  "marketplace.listing.quantity-cap-updated": MarketplaceListingQuantityCapUpdatedPayload;
  "marketplace.listing.purchase-limits-updated": MarketplaceListingPurchaseLimitsUpdatedPayload;
  "marketplace.listing.published": EmptyEventPayload;
  "marketplace.listing.paused": EmptyEventPayload;
  "marketplace.listing.auto-unlisted": MarketplaceListingAutoUnlistedPayload;
  "marketplace.listing.operator-unlisted": MarketplaceListingOperatorUnlistedPayload;
  "marketplace.listing.withdrawn": EmptyEventPayload;
  "marketplace.seller-listing-availability.disabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.seller-listing-availability.enabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.report.submitted": MarketplaceReportSubmittedPayload;
  "platform-operations.reported-content.action-recorded": PlatformOperationsReportedContentActionRecordedPayload;
  "platform-operations.risk-alert.action-recorded": PlatformOperationsRiskAlertActionRecordedPayload;
  "marketplace.offer.accepted": MarketplaceOfferAcceptedPayload;
  "marketplace.offer.submitted": MarketplaceOfferSubmittedPayload;
  "marketplace.offer.price-updated": MarketplaceOfferPriceUpdatedPayload;
  "marketplace.listing.offer-commitment-recorded": MarketplaceListingOfferCommitmentRecordedPayload;
  "marketplace.seller-listing-availability.commitment-checked": MarketplaceSellerListingAvailabilityCommitmentCheckedPayload;
  "marketplace.review-scoring.disposition-projected.v1": MarketplaceReviewScoringDispositionProjectedV1Payload;
}>;
