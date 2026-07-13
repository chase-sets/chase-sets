import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";

/**
 * The marketplace listing-gate policy: the trust and abuse-resistance dials
 * that decide whether a listing needs extra seller-trust evidence before
 * publication, and the caps on anonymous listing drafts and listing-photo
 * uploads. Marketplace both owns this policy's schema/admin routes (see
 * `../api/listing-gate-policy-route.ts`) and is its only consumer, so no
 * cross-context host port is needed -- the same same-context shape as
 * settlement's clearance-window policy
 * (`bounded-contexts/settlement/features/wallets/domain/clearance-policy.ts`).
 *
 * The qualifying LOGIC that decides trust (seller badges, review counts,
 * photo evidence) stays domain code in `../api/runtime.ts`'s
 * `assertListingPublicationRiskAccepted` -- only the NUMBERS below move onto
 * this policy.
 *
 * m108 interaction note: `minTrustedReputationReviews` currently compares
 * against the blended review count read off `marketplace_account_pages`
 * (see `getMarketplaceAccountRisk` in `../read-model/queries.ts`). Once m108
 * lands role-split reputation aggregates, this gate should read the
 * as-seller review count instead of the blended one -- a query-source
 * change at the call site, not a change to this policy's shape. Referenced
 * here; not implemented by this change.
 *
 * Threshold-relationship decision: `highDollarListingAmount` ($250 at
 * launch) is the same conceptual tier as settlement's clearance high-value
 * threshold (`settlement.clearance-window`'s `highValueThresholdAmount`,
 * also $250 at launch) and m107's delivery-signature threshold. All three
 * independently gate a different moment in the sale lifecycle -- listing
 * publication (marketplace, this policy), payout clearance (settlement),
 * and delivery signature (fulfillment/trust & safety) -- for a different
 * actor, using a different data source. Decision: keep them as INDEPENDENT
 * dials, each on its own context-owned policy, rather than one shared
 * value. Collapsing them would force marketplace, settlement, and trust &
 * safety to co-schedule every threshold change even when only one context's
 * risk posture moved, and would need a cross-context policy-sharing
 * primitive the shared platform-policy machinery deliberately does not have
 * (policies are context-owned schemas on shared machinery, not a shared
 * value -- see `infrastructure/platform-policy`). They launch at the same
 * value by coincidence, not by a shared source; this comment is the
 * recorded cross-pointer for that decision.
 */

export type MarketplaceListingGatePolicyValue = Readonly<{
  /** Listing price at or above which publication requires trusted-seller evidence (a decimal money string). */
  highDollarListingAmount: string;
  /** Minimum account review count (absent a trusted-seller badge) that counts as established reputation for the high-dollar gate. */
  minTrustedReputationReviews: number;
  /** Maximum active (unclaimed, unexpired) anonymous listing drafts per anonymous owner. */
  maxActiveAnonymousListingDrafts: number;
  /** Days an anonymous listing draft stays active before it expires. */
  anonymousListingDraftTtlDays: number;
  /** Maximum listing-photo upload size, in bytes. */
  maxListingPhotoUploadBytes: number;
  /** Maximum number of active listing evidence images per listing. */
  maxListingPhotoCount: number;
  /** Maximum total stored bytes (source + variants) across a listing's active evidence. */
  maxListingPhotoTotalBytes: number;
  /** Delay before a replaced/removed, unreferenced evidence asset becomes a garbage-collection candidate. */
  evidenceGarbageCollectionSafeDelayHours: number;
}>;

/** The launch values -- the migration's byte-identical seed and compiled fallback. */
export const MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE: MarketplaceListingGatePolicyValue = {
  highDollarListingAmount: "250.00",
  minTrustedReputationReviews: 3,
  maxActiveAnonymousListingDrafts: 20,
  anonymousListingDraftTtlDays: 30,
  maxListingPhotoUploadBytes: 10 * 1024 * 1024,
  maxListingPhotoCount: 24,
  maxListingPhotoTotalBytes: 60 * 1024 * 1024,
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

function normalizeGateMoneyAmount(value: unknown, fieldName: string): string {
  const cents = tryMoneyToCents(String(value ?? "").trim());
  assert(cents !== null && cents >= 0n, `${fieldName} must be a valid, non-negative decimal amount.`);
  return centsToMoneyAmount(cents);
}

function normalizePositiveInteger(value: unknown, fieldName: string, options: Readonly<{ max: number }>): number {
  const numeric = Number(value);
  assert(Number.isInteger(numeric) && numeric > 0, `${fieldName} must be a positive whole number.`);
  assert(numeric <= options.max, `${fieldName} cannot exceed ${options.max}.`);
  return numeric;
}

function normalizeNonNegativeInteger(value: unknown, fieldName: string): number {
  const numeric = Number(value);
  assert(Number.isInteger(numeric) && numeric >= 0, `${fieldName} must be zero or a positive whole number.`);
  return numeric;
}

export function decodeMarketplaceListingGatePolicyValue(raw: JsonValue): MarketplaceListingGatePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketplaceListingGatePolicyError("Marketplace listing-gate policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  return {
    highDollarListingAmount: normalizeGateMoneyAmount(record.highDollarListingAmount, "High-dollar listing amount"),
    minTrustedReputationReviews: normalizeNonNegativeInteger(
      record.minTrustedReputationReviews,
      "Minimum trusted reputation reviews",
    ),
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
    maxListingPhotoUploadBytes: normalizePositiveInteger(
      record.maxListingPhotoUploadBytes,
      "Maximum listing photo upload size in bytes",
      { max: 100 * 1024 * 1024 },
    ),
    maxListingPhotoCount: normalizePositiveInteger(
      record.maxListingPhotoCount ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingPhotoCount,
      "Maximum listing photo count",
      { max: 200 },
    ),
    maxListingPhotoTotalBytes: normalizePositiveInteger(
      record.maxListingPhotoTotalBytes ?? MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE.maxListingPhotoTotalBytes,
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
    "{ highDollarListingAmount: decimal string >= 0, minTrustedReputationReviews: integer >= 0, maxActiveAnonymousListingDrafts: integer 1-1000, anonymousListingDraftTtlDays: integer 1-365, maxListingPhotoUploadBytes: integer 1-104857600, maxListingPhotoCount: integer 1-200, maxListingPhotoTotalBytes: integer 1-1073741824, evidenceGarbageCollectionSafeDelayHours: integer 1-8760 }",
  defaultValue: MARKETPLACE_LISTING_GATE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeMarketplaceListingGatePolicyValue,
});
