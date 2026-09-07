import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { boundedPassSize, closedRecord, requiredInstant } from "./price-signal-policy";

export type ProviderObservationPolicyValue = Readonly<{
  capturesPerPass: number;
  currency: string;
  freeShippingThreshold: string;
  secondaryTimeoutMs: number;
  listings: Readonly<{
    pageSize: number;
    pageBudget: number;
    deliveredCeiling: string;
    verifiedSellersOnly: boolean;
    excludeOwnSeller: boolean;
  }>;
  sales: Readonly<{
    pageSize: number;
    pageBudget: number;
    limit: number;
    conditions: readonly number[];
    languages: readonly number[];
    variants: readonly number[];
    listingType: "ListingWithoutPhotos" | "ListingWithPhotos" | "All";
  }>;
}>;

export const PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE: ProviderObservationPolicyValue = {
  capturesPerPass: 5,
  currency: "usd",
  freeShippingThreshold: "5.00",
  secondaryTimeoutMs: 15_000,
  listings: {
    pageSize: 50,
    pageBudget: 10,
    deliveredCeiling: "1000.00",
    verifiedSellersOnly: true,
    excludeOwnSeller: true,
  },
  sales: {
    pageSize: 25,
    pageBudget: 4,
    limit: 100,
    conditions: [],
    languages: [],
    variants: [],
    listingType: "All",
  },
};

const ROOT_KEYS = [
  "capturesPerPass",
  "currency",
  "freeShippingThreshold",
  "secondaryTimeoutMs",
  "listings",
  "sales",
] as const;
const LISTING_KEYS = ["pageSize", "pageBudget", "deliveredCeiling", "verifiedSellersOnly", "excludeOwnSeller"] as const;
const SALES_KEYS = ["pageSize", "pageBudget", "limit", "conditions", "languages", "variants", "listingType"] as const;

export function decodeProviderObservationPolicyValue(raw: JsonValue): ProviderObservationPolicyValue {
  const record = closedRecord(raw, ROOT_KEYS, "Provider-observation policy");
  const listings = closedRecord(record.listings, LISTING_KEYS, "Listings policy");
  const sales = closedRecord(record.sales, SALES_KEYS, "Sales policy");
  const currency = requiredCurrency(record.currency);
  const listingType = recordListingType(sales.listingType);
  return {
    capturesPerPass: boundedPassSize(record.capturesPerPass, "capturesPerPass"),
    currency,
    freeShippingThreshold: money(record.freeShippingThreshold, "freeShippingThreshold"),
    secondaryTimeoutMs: integer(record.secondaryTimeoutMs, "secondaryTimeoutMs", 1, 120_000),
    listings: {
      pageSize: integer(listings.pageSize, "listings.pageSize", 1, 250),
      pageBudget: integer(listings.pageBudget, "listings.pageBudget", 1, 100),
      deliveredCeiling: money(listings.deliveredCeiling, "listings.deliveredCeiling"),
      verifiedSellersOnly: boolean(listings.verifiedSellersOnly, "listings.verifiedSellersOnly"),
      excludeOwnSeller: boolean(listings.excludeOwnSeller, "listings.excludeOwnSeller"),
    },
    sales: {
      pageSize: integer(sales.pageSize, "sales.pageSize", 1, 250),
      pageBudget: integer(sales.pageBudget, "sales.pageBudget", 1, 100),
      limit: integer(sales.limit, "sales.limit", 1, 10_000),
      conditions: integerArray(sales.conditions, "sales.conditions"),
      languages: integerArray(sales.languages, "sales.languages"),
      variants: integerArray(sales.variants, "sales.variants"),
      listingType,
    },
  };
}

export const providerObservationPolicy: PolicyDefinition<ProviderObservationPolicyValue> = definePolicy({
  policyKey: "pricing.provider-observation",
  contextName: "pricing",
  schemaSummary:
    "{ capturesPerPass: integer 1-5, currency: lowercase ISO alpha-3, freeShippingThreshold: money, secondaryTimeoutMs, listings, sales }",
  defaultValue: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE,
  decodeValue: decodeProviderObservationPolicyValue,
});

export type ProviderObservationPolicyRevision = Readonly<{
  revisionId: string;
  value: ProviderObservationPolicyValue;
}>;

type RevisionRow = Readonly<{ event_id: string; value: JsonValue }>;

export async function resolveProviderObservationPolicyRevisionAsOf(
  db: PgQueryable,
  instant: string,
): Promise<ProviderObservationPolicyRevision | null> {
  const result = await db.query<RevisionRow>(
    `SELECT event_id, value
     FROM platform_policy_document_history
     WHERE policy_key = 'pricing.provider-observation'
       AND status = 'active'
       AND effective_from <= $1
       AND (effective_until IS NULL OR effective_until > $1)
       AND recorded_at <= $1
     ORDER BY effective_from DESC, recorded_at DESC, history_id DESC
     LIMIT 1`,
    [requiredInstant(instant)],
  );
  const row = result.rows[0];
  return row ? { revisionId: row.event_id, value: decodeProviderObservationPolicyValue(row.value) } : null;
}

function requiredCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{3}$/.test(value))
    throw new Error("currency must be lowercase ISO alpha-3.");
  return value;
}

function money(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d+\.\d{2}$/.test(value)) throw new Error(`${name} must be two-decimal money.`);
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean.`);
  return value;
}

function integerArray(value: unknown, name: string): readonly number[] {
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error(`${name} must be an array of non-negative integers.`);
  }
  return value;
}

function recordListingType(value: unknown): ProviderObservationPolicyValue["sales"]["listingType"] {
  if (value !== "ListingWithoutPhotos" && value !== "ListingWithPhotos" && value !== "All") {
    throw new Error("sales.listingType is invalid.");
  }
  return value;
}
