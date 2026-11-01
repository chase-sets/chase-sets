// Marketplace-owned public event payloads.
//
// `MarketplaceEventPayloads` also registers the two Platform Operations action-recorded
// facts under their `platform-operations.*` stream keys. That cross-registration is the
// published contract: the types are Platform-Operations-owned, their membership here is not.
import type { AddressSnapshot } from "../../primitives/address-snapshot";
import type { JsonValue } from "../../primitives/json";
import { centsToMoneyAmount, tryMoneyToCents } from "../../primitives/money";
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
  PlatformOperationsListingRemovalDirectedPayload,
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

/** Shared by `marketplace.offer.paused`, `.resumed` and `.withdrawn`; the event type carries the new Offer Status. */
export type MarketplaceOfferLifecyclePayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  at: string;
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
  schemaVersion?: 2;
  /** Added in the channel-only Listing schema; absent historical events replay as native. */
  publicationScope?: "native" | "channel-only";
  nativeVisibility?: "enabled" | "disabled";
  nativeFeeState?: "enrolled" | "not-enrolled";
  listingId: string;
  accountId: AccountId;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemLanguageCode?: string | null;
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
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeQuoteFingerprint?: string | null;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
  quantityCap: number;
  purchaseLimits?: MarketplacePurchaseLimitsPayload;
  evidenceRequirements?: JsonValue | null;
  evidence?: readonly JsonValue[];
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

/** Historical creation facts are unchanged; channel-only facts use a closed, versioned record. */
export function parseMarketplaceListingCreatedPayload(value: unknown): MarketplaceListingCreatedPayload {
  const input = listingEnforcementRecord(value, "Listing creation");
  const versionFields = ["schemaVersion", "publicationScope", "nativeVisibility", "nativeFeeState"];
  if (!versionFields.some((key) => Object.hasOwn(input, key))) {
    return input as MarketplaceListingCreatedPayload;
  }
  assertListingEnforcementKeys(
    input,
    [
      ...versionFields,
      "listingId",
      "accountId",
      "inventoryItemId",
      "catalogItemId",
      "productId",
      "itemLanguageCode",
      "itemTitle",
      "itemSubtitle",
      "selectedOptions",
      "productSummary",
      "productMeasureSnapshot",
      "gradedCard",
      "storageLocationName",
      "shipFromCode",
      "shipFromAddress",
      "priceAmount",
      "priceCurrencyCode",
      "marketplaceSalesFeeUnitAmount",
      "sellerNetUnitAmount",
      "shippingAllowancePercentageBps",
      "termsScheduleId",
      "termsAgreementId",
      "termsResolvedAt",
      "feeQuoteFingerprint",
      "feeLocks",
      "quantityCap",
      "purchaseLimits",
      "evidenceRequirements",
      "evidence",
    ],
    "Channel-only Listing creation",
  );
  if (
    input.schemaVersion !== 2 ||
    input.publicationScope !== "channel-only" ||
    input.nativeVisibility !== "disabled" ||
    input.nativeFeeState !== "not-enrolled"
  ) {
    throw new Error("Channel-only Listing creation requires schema 2, disabled visibility and not-enrolled fee state.");
  }
  for (const key of [
    "marketplaceSalesFeeUnitAmount",
    "sellerNetUnitAmount",
    "termsScheduleId",
    "termsAgreementId",
    "termsResolvedAt",
    "feeQuoteFingerprint",
    "evidenceRequirements",
  ]) {
    if (input[key] !== null) throw new Error(`Channel-only Listing creation cannot carry ${key}.`);
  }
  if (!Array.isArray(input.feeLocks) || input.feeLocks.length !== 0 || input.shippingAllowancePercentageBps !== 0) {
    throw new Error("Channel-only Listing creation cannot carry native fee locks or shipping allowance.");
  }
  const cents = typeof input.priceAmount === "string" ? tryMoneyToCents(input.priceAmount) : null;
  if (
    cents === null ||
    cents <= 0n ||
    centsToMoneyAmount(cents) !== input.priceAmount ||
    typeof input.priceCurrencyCode !== "string" ||
    !Intl.supportedValuesOf("currency").includes(input.priceCurrencyCode)
  ) {
    throw new Error("Channel-only Listing creation requires a normalized reference amount and ISO-4217 currency.");
  }
  for (const key of ["listingId", "accountId", "inventoryItemId", "catalogItemId", "productId"]) {
    listingEnforcementText(input[key], `Listing creation ${key}`);
  }
  listingEnforcementPositiveInteger(input.quantityCap, "Listing quantity cap");
  const limits = listingEnforcementRecord(input.purchaseLimits, "Listing purchase limits");
  assertListingEnforcementKeys(
    limits,
    ["maxUnitsPerOrder", "maxUnitsPerDay", "maxUnitsPerCustomerAccount"],
    "Listing purchase limits",
  );
  for (const limit of Object.values(limits)) {
    if (
      limit !== null &&
      (!Number.isSafeInteger(limit) || Number(limit) <= 0 || Number(limit) > Number(input.quantityCap))
    )
      throw new Error("Listing purchase limits must be safe positive integers within the quantity cap.");
  }
  if (!Array.isArray(input.selectedOptions) || !Array.isArray(input.evidence))
    throw new Error("Listing selections and evidence must be arrays.");
  for (const option of input.selectedOptions) {
    const selected = listingEnforcementRecord(option, "Listing selected option");
    assertListingEnforcementKeys(selected, ["dimensionId", "optionId"], "Listing selected option");
    listingEnforcementText(selected.dimensionId, "Listing dimension id");
    listingEnforcementText(selected.optionId, "Listing option id");
  }
  assertListingCreationSafeNumbers(input);
  assertClosedListingCreationDetails(input);
  return input as MarketplaceListingCreatedPayload;
}

function assertClosedListingCreationDetails(input: Readonly<Record<string, unknown>>): void {
  function nullableText(value: unknown) {
    if (value !== null && typeof value !== "string") throw new Error("Listing detail must be text or null.");
  }
  function record(value: unknown, required: readonly string[], optional: readonly string[] = []) {
    const result = listingEnforcementRecord(value, "Listing creation detail");
    if (
      required.some((key) => !Object.hasOwn(result, key)) ||
      Reflect.ownKeys(result).some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
    )
      throw new Error("Listing creation detail has missing or unknown fields.");
    return result;
  }
  function address(value: unknown, withVerification: boolean) {
    const result = record(
      value,
      ["name", "company", "line1", "line2", "city", "state", "postalCode", "country", "phone", "email"],
      withVerification ? ["verification"] : [],
    );
    for (const [key, field] of Object.entries(result)) {
      if (key !== "verification" && field !== null && typeof field !== "string")
        throw new Error("Listing address fields must be text or null.");
    }
    for (const key of ["name", "line1", "city", "state", "postalCode", "country"])
      listingEnforcementText(result[key], `Listing address ${key}`);
    if (result.verification !== undefined && result.verification !== null) {
      const verification = record(
        result.verification,
        ["status", "source", "checkedAt"],
        ["buyerDecision", "suggestedAddress", "messages"],
      );
      for (const key of ["status", "source", "checkedAt"])
        listingEnforcementText(verification[key], `Listing address verification ${key}`);
      if (verification.buyerDecision !== undefined)
        listingEnforcementText(verification.buyerDecision, "Listing address buyer decision");
      if (verification.suggestedAddress !== undefined) address(verification.suggestedAddress, false);
      if (
        verification.messages !== undefined &&
        (!Array.isArray(verification.messages) || verification.messages.some((value) => typeof value !== "string"))
      )
        throw new Error("Listing address messages must be text.");
    }
  }
  function selections(value: unknown) {
    if (!Array.isArray(value)) throw new Error("Listing selections must be an array.");
    for (const option of value) {
      const selected = record(option, ["dimensionId", "optionId"]);
      listingEnforcementText(selected.dimensionId, "Listing dimension id");
      listingEnforcementText(selected.optionId, "Listing option id");
    }
  }
  for (const key of [
    "itemLanguageCode",
    "itemTitle",
    "itemSubtitle",
    "productSummary",
    "storageLocationName",
    "shipFromCode",
  ]) {
    if (input[key] !== null && typeof input[key] !== "string") throw new Error(`Listing ${key} must be text or null.`);
  }
  address(input.shipFromAddress, true);
  selections(input.selectedOptions);
  if (input.productMeasureSnapshot !== null) {
    const measure = record(input.productMeasureSnapshot, [
      "catalogItemId",
      "productId",
      "selectedOptions",
      "measureVersion",
      "unitLengthInches",
      "unitWidthInches",
      "unitHeightInches",
      "unitWeightOunces",
      "physicalFlags",
      "stackBehavior",
      "source",
      "confidence",
    ]);
    selections(measure.selectedOptions);
    for (const key of ["unitLengthInches", "unitWidthInches", "unitHeightInches", "unitWeightOunces"])
      if (typeof measure[key] !== "number" || Number(measure[key]) <= 0)
        throw new Error("Listing measures must be positive numbers.");
    if (!Array.isArray(measure.physicalFlags) || measure.physicalFlags.some((value) => typeof value !== "string"))
      throw new Error("Listing physical flags must be text.");
    for (const key of ["catalogItemId", "productId", "measureVersion", "stackBehavior", "source", "confidence"])
      listingEnforcementText(measure[key], `Listing measure ${key}`);
  }
  if (input.gradedCard !== null) {
    const graded = record(input.gradedCard, [
      "gradingCompany",
      "grade",
      "certificationNumber",
      "population",
      "conditionDescriptors",
    ]);
    for (const key of ["gradingCompany", "grade"]) listingEnforcementText(graded[key], `Listing graded card ${key}`);
    nullableText(graded.certificationNumber);
    if (graded.population !== null) {
      const population = record(graded.population, ["populationAtGrade", "populationHigher", "source", "asOf"]);
      nullableText(population.source);
      nullableText(population.asOf);
      for (const key of ["populationAtGrade", "populationHigher"])
        if (population[key] !== null && (!Number.isSafeInteger(population[key]) || Number(population[key]) < 0))
          throw new Error("Listing populations must be safe nonnegative integers.");
    }
    if (
      !Array.isArray(graded.conditionDescriptors) ||
      graded.conditionDescriptors.some((value) => typeof value !== "string")
    )
      throw new Error("Listing condition descriptors must be text.");
  }
  if (!Array.isArray(input.evidence)) throw new Error("Listing evidence must be an array.");
  for (const value of input.evidence) {
    const photo = record(value, [
      "photoId",
      "originalFilename",
      "altText",
      "slotId",
      "viewKind",
      "status",
      "sortOrder",
      "capturedAt",
      "uploadedAt",
      "assetRevision",
      "replacesPhotoId",
      "assetSet",
    ]);
    for (const key of ["originalFilename", "altText", "slotId", "viewKind", "capturedAt", "replacesPhotoId"])
      nullableText(photo[key]);
    for (const key of ["photoId", "status", "uploadedAt", "assetRevision"])
      listingEnforcementText(photo[key], `Listing evidence ${key}`);
    if (!Number.isSafeInteger(photo.sortOrder) || Number(photo.sortOrder) < 0)
      throw new Error("Listing evidence order must be a safe nonnegative integer.");
    const assets = record(photo.assetSet, ["kind", "sourceHash", "source", "variants"]);
    listingEnforcementText(assets.sourceHash, "Listing asset source hash");
    if (assets.kind !== "listing-photo" || !Array.isArray(assets.variants))
      throw new Error("Listing photo assets are invalid.");
    for (const variant of [assets.source, ...assets.variants]) {
      const asset = record(variant, [
        "role",
        "width",
        "height",
        "density",
        "mediaType",
        "storageKey",
        "publicUrl",
        "byteSize",
        "generatedAt",
      ]);
      for (const key of ["width", "height", "byteSize"])
        listingEnforcementPositiveInteger(asset[key], `Listing asset ${key}`);
      if (asset.density !== null && asset.density !== 1 && asset.density !== 2)
        throw new Error("Listing asset density is invalid.");
      for (const key of ["role", "mediaType", "storageKey", "publicUrl", "generatedAt"])
        listingEnforcementText(asset[key], `Listing asset ${key}`);
    }
  }
}

function assertListingCreationSafeNumbers(value: unknown): void {
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))
    throw new Error("Listing creation numbers must be finite and safe.");
  if (Array.isArray(value)) value.forEach(assertListingCreationSafeNumbers);
  else if (value !== null && typeof value === "object") Object.values(value).forEach(assertListingCreationSafeNumbers);
}

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

const marketplaceReportSubmittedKeys = [
  "reportId",
  "targetType",
  "targetId",
  "targetOwnerAccountId",
  "reporterKind",
  "reporterKey",
  "reporterAccountId",
  "reporterUserId",
  "reason",
  "details",
  "sourceRoutePath",
  "submittedAt",
] as const;

/**
 * Reads a stored Marketplace Report. The record is closed to the twelve keys every
 * historical report carries; the reason vocabulary stays Marketplace-owned, so any
 * nonempty reason is returned unchanged.
 */
export function parseMarketplaceReportSubmittedPayload(value: unknown): MarketplaceReportSubmittedPayload {
  const input = listingEnforcementRecord(value, "Marketplace Report");
  if (
    Reflect.ownKeys(input).length !== marketplaceReportSubmittedKeys.length ||
    marketplaceReportSubmittedKeys.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new Error(`Marketplace Report requires exactly: ${marketplaceReportSubmittedKeys.join(", ")}.`);
  }
  if (input.targetType !== "listing" && input.targetType !== "review") {
    throw new Error("Marketplace Report target type must be listing or review.");
  }
  if (input.reporterKind !== "account" && input.reporterKind !== "visitor") {
    throw new Error("Marketplace Report reporter kind must be account or visitor.");
  }
  for (const key of ["reportId", "targetId", "reporterKey", "reason", "sourceRoutePath"] as const) {
    if (typeof input[key] !== "string" || input[key].length === 0) {
      throw new Error(`Marketplace Report ${key} must be a nonempty string.`);
    }
  }
  for (const key of ["targetOwnerAccountId", "reporterAccountId", "reporterUserId", "details"] as const) {
    if (input[key] !== null && (typeof input[key] !== "string" || input[key].length === 0)) {
      throw new Error(`Marketplace Report ${key} must be a nonempty string or null.`);
    }
  }
  return {
    reportId: input.reportId as string,
    targetType: input.targetType,
    targetId: input.targetId as string,
    targetOwnerAccountId: input.targetOwnerAccountId as string | null,
    reporterKind: input.reporterKind,
    reporterKey: input.reporterKey as string,
    reporterAccountId: input.reporterAccountId as string | null,
    reporterUserId: input.reporterUserId as string | null,
    reason: input.reason as string,
    details: input.details as string | null,
    sourceRoutePath: input.sourceRoutePath as string,
    submittedAt: listingEnforcementInstant(input.submittedAt, "Marketplace Report time"),
  };
}

export type MarketplaceEventPayloads = Readonly<{
  "marketplace.review-opportunity.changed.v1": ReviewOpportunityChangedV1;
  "marketplace.listing.created": MarketplaceListingCreatedPayload;
  "marketplace.listing.price-updated": MarketplaceListingPriceUpdatedPayload;
  "marketplace.listing.quantity-cap-updated": MarketplaceListingQuantityCapUpdatedPayload;
  "marketplace.listing.purchase-limits-updated": MarketplaceListingPurchaseLimitsUpdatedPayload;
  "marketplace.listing.published": EmptyEventPayload;
  "marketplace.listing.paused": Readonly<{
    reason?: "seller" | "policy-input-missing" | "channel-inbound-dark" | "inventory-capacity";
    inventoryCapacityRecoveryBlock?:
      | "evidence-incomplete"
      | "publication-unavailable"
      | "seller-away"
      | "native-visibility-disabled"
      | "shipping-measure-missing"
      | "price-incomplete"
      | null;
  }>;
  "marketplace.listing.auto-unlisted": MarketplaceListingAutoUnlistedPayload;
  "marketplace.listing.operator-unlisted": MarketplaceListingOperatorUnlistedPayload;
  "marketplace.listing.withdrawn": EmptyEventPayload;
  "marketplace.seller-listing-availability.disabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.seller-listing-availability.enabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.report.submitted": MarketplaceReportSubmittedPayload;
  "platform-operations.reported-content.action-recorded": PlatformOperationsReportedContentActionRecordedPayload;
  "platform-operations.reported-content.listing-removal-directed": PlatformOperationsListingRemovalDirectedPayload;
  "platform-operations.risk-alert.action-recorded": PlatformOperationsRiskAlertActionRecordedPayload;
  "marketplace.offer.accepted": MarketplaceOfferAcceptedPayload;
  "marketplace.offer.submitted": MarketplaceOfferSubmittedPayload;
  "marketplace.offer.price-updated": MarketplaceOfferPriceUpdatedPayload;
  "marketplace.offer.paused": MarketplaceOfferLifecyclePayload;
  "marketplace.offer.resumed": MarketplaceOfferLifecyclePayload;
  "marketplace.offer.withdrawn": MarketplaceOfferLifecyclePayload;
  "marketplace.listing.offer-commitment-recorded": MarketplaceListingOfferCommitmentRecordedPayload;
  "marketplace.seller-listing-availability.commitment-checked": MarketplaceSellerListingAvailabilityCommitmentCheckedPayload;
  "marketplace.review-scoring.disposition-projected.v1": MarketplaceReviewScoringDispositionProjectedV1Payload;
}>;
