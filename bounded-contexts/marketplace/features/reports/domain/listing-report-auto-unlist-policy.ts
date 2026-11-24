import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * The Listing Report Auto-Unlist Policy: how many distinct reporters, inside
 * how many days, automatically unlist an active Listing. Marketplace owns the
 * rule and is its only consumer (`../api/runtime.ts`); Trust and Safety revise
 * it through the Policy Console.
 */
export type MarketplaceListingReportAutoUnlistPolicyValue = Readonly<{
  /** Distinct reporters inside the window that unlist an active Listing. */
  distinctReporterThreshold: number;
  /** Days before the evaluated Report inside which Listing Reports are counted. */
  windowDays: number;
}>;

const defaultListingReportAutoUnlistPolicyValue: MarketplaceListingReportAutoUnlistPolicyValue = {
  distinctReporterThreshold: 3,
  windowDays: 7,
};

// A threshold of 1 would let a single visitor unlist any Listing.
const MIN_DISTINCT_REPORTER_THRESHOLD = 2;
const MAX_DISTINCT_REPORTER_THRESHOLD = 100;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 90;

export class MarketplaceListingReportAutoUnlistPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MarketplaceListingReportAutoUnlistPolicyError";
  }
}

function boundedInteger(value: unknown, fieldName: string, bounds: Readonly<{ min: number; max: number }>): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new MarketplaceListingReportAutoUnlistPolicyError(`${fieldName} must be a whole number.`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new MarketplaceListingReportAutoUnlistPolicyError(
      `${fieldName} must be between ${bounds.min} and ${bounds.max}.`,
    );
  }
  return value;
}

export function decodeMarketplaceListingReportAutoUnlistPolicyValue(
  raw: JsonValue,
): MarketplaceListingReportAutoUnlistPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MarketplaceListingReportAutoUnlistPolicyError(
      "Listing Report Auto-Unlist Policy value must be an object.",
    );
  }
  const record = raw as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !Object.hasOwn(defaultListingReportAutoUnlistPolicyValue, key));
  if (unknownKey !== undefined) {
    throw new MarketplaceListingReportAutoUnlistPolicyError(
      `Listing Report Auto-Unlist Policy does not accept ${unknownKey}.`,
    );
  }

  return {
    distinctReporterThreshold: boundedInteger(record.distinctReporterThreshold, "Distinct reporter threshold", {
      min: MIN_DISTINCT_REPORTER_THRESHOLD,
      max: MAX_DISTINCT_REPORTER_THRESHOLD,
    }),
    windowDays: boundedInteger(record.windowDays, "Window in days", { min: MIN_WINDOW_DAYS, max: MAX_WINDOW_DAYS }),
  };
}

export const marketplaceListingReportAutoUnlistPolicy: PolicyDefinition<MarketplaceListingReportAutoUnlistPolicyValue> =
  definePolicy({
    policyKey: "marketplace.listing-report-auto-unlist",
    contextName: "marketplace",
    schemaSummary: `{ distinctReporterThreshold: integer ${MIN_DISTINCT_REPORTER_THRESHOLD}-${MAX_DISTINCT_REPORTER_THRESHOLD}, windowDays: integer ${MIN_WINDOW_DAYS}-${MAX_WINDOW_DAYS} }`,
    defaultValue: defaultListingReportAutoUnlistPolicyValue,
    decodeValue: decodeMarketplaceListingReportAutoUnlistPolicyValue,
  });
