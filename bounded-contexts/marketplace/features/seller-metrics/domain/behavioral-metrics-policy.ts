import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The marketplace seller-behavioral-metrics policy (m108 reputation): the
 * windowing and display-gating dials for the objective, event-derived
 * seller reliability signals -- on-time-shipment rate, seller-caused
 * cancellation rate, and the seller-responsible issue rate (published under
 * the "dispute rate" product name) -- plus the rollout gate for buyer-facing
 * qualitative chips built from them.
 *
 * Scoped interpretation -- no persisted "promised ship-by" deadline exists
 * anywhere in `ordering` or `fulfillment` today (neither context stores a
 * per-order dispatch SLA; `ordering`'s `createFulfillmentDeliveryPromise` is
 * a checkout-preview ETA estimate, never persisted onto the order or emitted
 * in a domain event). Rather than expand this slice into a cross-context
 * ask to persist a new promise field, `dispatchWindowHours` stands in as a
 * platform-wide "on time" dispatch window measured from
 * `ordering.order.ready-for-fulfillment-recorded` (the point the order
 * actually becomes actionable by the seller) to
 * `fulfillment.shipment.dispatched`. This is a documented scoped deviation,
 * not a discovered domain concept -- see the PR description for the full
 * reasoning; revisit if/when a per-listing shipping promise is introduced
 * upstream.
 *
 * `minDisplayOrderCount` is the AC's "no metric shown under N=10" gate,
 * applied per-metric at query time (read-model/queries.ts) against each
 * metric's own denominator -- not a single blended order count -- so a
 * seller with 12 shipments but only 3 support-request outcomes sees an
 * on-time-shipment rate but not a seller-responsible issue rate yet.
 *
 * `buyerFacingChipsEnabled` is the AC's "buyer-facing chips ... flag-gated"
 * requirement. This codebase has no feature-flag system pre-launch (m114 is
 * explicitly post-launch, per the m108 epic's own convention: business
 * windows and thresholds are platform-policy, not flags -- see
 * `docs/architecture/platform-policy-conventions.md`'s flags-vs-policy
 * boundary). A policy-tier boolean is the correct, available mechanism: an
 * operator can flip buyer-facing display without a deploy, with audit
 * history, exactly like every other rollout dial on this machinery.
 */

export type MarketplaceSellerBehavioralMetricsPolicyValue = Readonly<{
  /** Rolling window, in days, over which every metric is computed. */
  windowDays: number;
  /** Minimum denominator (orders considered) before a metric is shown at all, per metric. */
  minDisplayOrderCount: number;
  /** Hours from ready-for-fulfillment to dispatch that count as "on time" (see class doc comment). */
  dispatchWindowHours: number;
  /** Rollout gate for buyer-facing qualitative chips (public profile, item-detail seller block). Seller's own dashboard is never gated by this. */
  buyerFacingChipsEnabled: boolean;
}>;

export const MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE: MarketplaceSellerBehavioralMetricsPolicyValue =
  {
    windowDays: 90,
    minDisplayOrderCount: 10,
    dispatchWindowHours: 48,
    buyerFacingChipsEnabled: false,
  };

export class MarketplaceSellerBehavioralMetricsPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceSellerBehavioralMetricsPolicyError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new MarketplaceSellerBehavioralMetricsPolicyError(message);
  }
}

function normalizeBoundedInteger(
  value: unknown,
  fieldName: string,
  options: Readonly<{ min: number; max: number }>,
): number {
  const numeric = Number(value);
  assert(Number.isInteger(numeric), `${fieldName} must be a whole number.`);
  assert(
    numeric >= options.min && numeric <= options.max,
    `${fieldName} must be between ${options.min} and ${options.max}.`,
  );
  return numeric;
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  assert(typeof value === "boolean", `${fieldName} must be a boolean.`);
  return value;
}

export function decodeMarketplaceSellerBehavioralMetricsPolicyValue(
  raw: JsonValue,
): MarketplaceSellerBehavioralMetricsPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketplaceSellerBehavioralMetricsPolicyError(
      "Marketplace seller-behavioral-metrics policy value must be an object.",
    );
  }
  const record = raw as Record<string, unknown>;

  return {
    windowDays: normalizeBoundedInteger(record.windowDays, "Window days", { min: 7, max: 365 }),
    minDisplayOrderCount: normalizeBoundedInteger(record.minDisplayOrderCount, "Minimum display order count", {
      min: 1,
      max: 1000,
    }),
    dispatchWindowHours: normalizeBoundedInteger(record.dispatchWindowHours, "Dispatch window hours", {
      min: 1,
      max: 24 * 30,
    }),
    buyerFacingChipsEnabled: normalizeBoolean(record.buyerFacingChipsEnabled, "Buyer-facing chips enabled"),
  };
}

export const marketplaceSellerBehavioralMetricsPolicy: PolicyDefinition<MarketplaceSellerBehavioralMetricsPolicyValue> =
  definePolicy({
    policyKey: "marketplace.seller-behavioral-metrics",
    contextName: "marketplace",
    schemaSummary:
      "{ windowDays: integer 7-365, minDisplayOrderCount: integer 1-1000, dispatchWindowHours: integer 1-720, buyerFacingChipsEnabled: boolean }",
    defaultValue: MARKETPLACE_SELLER_BEHAVIORAL_METRICS_LAUNCH_POLICY_VALUE,
    decodeValue: decodeMarketplaceSellerBehavioralMetricsPolicyValue,
  });
