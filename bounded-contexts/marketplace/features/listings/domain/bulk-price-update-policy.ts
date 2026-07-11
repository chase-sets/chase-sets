import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The marketplace bulk listing price-update throughput policy, part of the
 * m113 (repricing at scale) throughput lane: the chunk size and inter-chunk
 * yield interval for the chunked multi-listing append path
 * (`../api/runtime.ts`'s `applyBulkListingPriceUpdates`, built on
 * `infrastructure/platform-runtime/bulk-append-lane.ts`).
 *
 * These numbers govern how long a bulk repricing run holds the store-wide
 * event-store advisory lock per chunk, and how much room interactive
 * appends get between chunks -- an operator needs to be able to tune them
 * without a deploy if a staged run's lock-hold or interactive-latency
 * numbers drift from the bound (see m106's lock-hold rules and lock/replay
 * telemetry, which this policy's consumers report against). Marketplace
 * owns this dial because the chunked stream category being appended is
 * `marketplace.listing-*`; the future bulk ingestion on-ramp and the policy
 * evaluation engine both resolve the SAME policy rather than compiling
 * their own chunk size.
 */

export type MarketplaceListingBulkPriceUpdatePolicyValue = Readonly<{
  /** Maximum listing streams appended in one transaction / advisory-lock window. */
  chunkSize: number;
  /** Milliseconds the lane yields between chunks so interactive appends get a fair turn. */
  yieldIntervalMs: number;
}>;

/** The launch values -- the migration's byte-identical seed and compiled fallback. */
export const MARKETPLACE_LISTING_BULK_PRICE_UPDATE_LAUNCH_POLICY_VALUE: MarketplaceListingBulkPriceUpdatePolicyValue = {
  chunkSize: 50,
  yieldIntervalMs: 25,
};

const MIN_CHUNK_SIZE = 1;
const MAX_CHUNK_SIZE = 500;
const MIN_YIELD_INTERVAL_MS = 0;
const MAX_YIELD_INTERVAL_MS = 60_000;

export class MarketplaceListingBulkPriceUpdatePolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceListingBulkPriceUpdatePolicyError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new MarketplaceListingBulkPriceUpdatePolicyError(message);
  }
}

function normalizeBoundedInteger(
  value: unknown,
  fieldName: string,
  bounds: Readonly<{ min: number; max: number }>,
): number {
  const numeric = Number(value);
  assert(Number.isInteger(numeric), `${fieldName} must be a whole number.`);
  assert(
    numeric >= bounds.min && numeric <= bounds.max,
    `${fieldName} must be between ${bounds.min} and ${bounds.max}.`,
  );
  return numeric;
}

export function decodeMarketplaceListingBulkPriceUpdatePolicyValue(
  raw: JsonValue,
): MarketplaceListingBulkPriceUpdatePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketplaceListingBulkPriceUpdatePolicyError(
      "Marketplace bulk listing price-update policy value must be an object.",
    );
  }
  const record = raw as Record<string, unknown>;

  return {
    chunkSize: normalizeBoundedInteger(record.chunkSize, "Chunk size", {
      min: MIN_CHUNK_SIZE,
      max: MAX_CHUNK_SIZE,
    }),
    yieldIntervalMs: normalizeBoundedInteger(record.yieldIntervalMs, "Yield interval in milliseconds", {
      min: MIN_YIELD_INTERVAL_MS,
      max: MAX_YIELD_INTERVAL_MS,
    }),
  };
}

export const marketplaceListingBulkPriceUpdatePolicy: PolicyDefinition<MarketplaceListingBulkPriceUpdatePolicyValue> =
  definePolicy({
    policyKey: "marketplace.listing-bulk-price-update",
    contextName: "marketplace",
    schemaSummary: `{ chunkSize: integer ${MIN_CHUNK_SIZE}-${MAX_CHUNK_SIZE}, yieldIntervalMs: integer ${MIN_YIELD_INTERVAL_MS}-${MAX_YIELD_INTERVAL_MS} }`,
    defaultValue: MARKETPLACE_LISTING_BULK_PRICE_UPDATE_LAUNCH_POLICY_VALUE,
    decodeValue: decodeMarketplaceListingBulkPriceUpdatePolicyValue,
  });
