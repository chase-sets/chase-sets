import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The marketplace listing-gate policy owns anonymous-draft and evidence-asset
 * governance limits. Requirement and seller-trust outcomes belong exclusively
 * to the versioned Listing Evidence Policy. Marketplace owns this policy's
 * schema/admin routes (see
 * `../api/listing-gate-policy-route.ts`) and is its only consumer, so no
 * cross-context host port is needed -- the same same-context shape as
 * settlement's clearance-window policy
 * (`bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts`).
 */

export type MarketplaceListingGatePolicyValue = Readonly<{
  /** Maximum active (unclaimed, unexpired) anonymous listing drafts per anonymous owner. */
  maxActiveAnonymousListingDrafts: number;
  /** Days an anonymous listing draft stays active before it expires. */
  anonymousListingDraftTtlDays: number;
  /** Maximum listing-photo upload size, in bytes. */
  maxListingEvidenceUploadBytes: number;
  /** Maximum number of active listing evidence images per listing. */
  maxListingEvidenceCount: number;
  /** Maximum total stored bytes (source + variants) across a listing's active evidence. */
  maxListingEvidenceTotalBytes: number;
  /** Delay before a replaced/removed, unreferenced evidence asset becomes a garbage-collection candidate. */
  evidenceGarbageCollectionSafeDelayHours: number;
}>;

/** The launch values -- the migration's byte-identical seed and compiled fallback. */
export const MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE: MarketplaceListingGatePolicyValue = {
  maxActiveAnonymousListingDrafts: 20,
  anonymousListingDraftTtlDays: 30,
  maxListingEvidenceUploadBytes: 10 * 1024 * 1024,
  maxListingEvidenceCount: 24,
  maxListingEvidenceTotalBytes: 60 * 1024 * 1024,
  evidenceGarbageCollectionSafeDelayHours: 24 * 7,
};

export class MarketplaceListingGatePolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceListingGatePolicyError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new MarketplaceListingGatePolicyError(message);
  }
}

function normalizePositiveInteger(value: unknown, fieldName: string, options: Readonly<{ max: number }>): number {
  const numeric = Number(value);
  assert(Number.isInteger(numeric) && numeric > 0, `${fieldName} must be a positive whole number.`);
  assert(numeric <= options.max, `${fieldName} cannot exceed ${options.max}.`);
  return numeric;
}

export function decodeMarketplaceListingGatePolicyValue(raw: JsonValue): MarketplaceListingGatePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketplaceListingGatePolicyError("Marketplace listing-gate policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  return {
    maxActiveAnonymousListingDrafts: normalizePositiveInteger(
      record.maxActiveAnonymousListingDrafts,
      "Maximum active anonymous listing drafts",
      { max: 1000 },
    ),
    anonymousListingDraftTtlDays: normalizePositiveInteger(
      record.anonymousListingDraftTtlDays,
      "Anonymous listing draft TTL in days",
      { max: 365 },
    ),
    maxListingEvidenceUploadBytes: normalizePositiveInteger(
      record.maxListingEvidenceUploadBytes,
      "Maximum listing photo upload size in bytes",
      { max: 100 * 1024 * 1024 },
    ),
    maxListingEvidenceCount: normalizePositiveInteger(
      record.maxListingEvidenceCount ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingEvidenceCount,
      "Maximum listing photo count",
      { max: 200 },
    ),
    maxListingEvidenceTotalBytes: normalizePositiveInteger(
      record.maxListingEvidenceTotalBytes ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingEvidenceTotalBytes,
      "Maximum listing photo total bytes",
      { max: 1024 * 1024 * 1024 },
    ),
    evidenceGarbageCollectionSafeDelayHours: normalizePositiveInteger(
      record.evidenceGarbageCollectionSafeDelayHours ??
        MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.evidenceGarbageCollectionSafeDelayHours,
      "Evidence garbage-collection safe delay hours",
      { max: 8760 },
    ),
  };
}

export const marketplaceListingGatePolicy: PolicyDefinition<MarketplaceListingGatePolicyValue> = definePolicy({
  policyKey: "marketplace.listing-gate",
  contextName: "marketplace",
  schemaSummary:
    "{ maxActiveAnonymousListingDrafts: integer 1-1000, anonymousListingDraftTtlDays: integer 1-365, maxListingEvidenceUploadBytes: integer 1-104857600, maxListingEvidenceCount: integer 1-200, maxListingEvidenceTotalBytes: integer 1-1073741824, evidenceGarbageCollectionSafeDelayHours: integer 1-8760 }",
  defaultValue: MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketplaceListingGatePolicyValue,
});
