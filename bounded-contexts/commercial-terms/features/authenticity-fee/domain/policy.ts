import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  CommercialTermsDomainError,
  normalizeMoneyAmount,
  normalizePercentageBps,
} from "../../../support/runtime-support/common";

/**
 * The authenticity-check fee policy (m109): the buyer-opt-in fee that
 * Ordering quotes when a buyer opts into routing an order through the
 * authenticity checkpoint (seller -> facility -> buyer). It is
 * declared as its own small `definePolicy` document -- exactly the pattern
 * `checkout-processing-fee` established -- rather than folded into the
 * schedule/agreement aggregates, because it carries its own effective
 * windows and is account-type-agnostic. Commercial Terms owns the schema
 * and the admin-managed create/revise commands (see `api/route.ts`);
 * Ordering consumes only the resolved value via the
 * `authenticityFeePolicyResolver` host port (see `../../../server.ts`).
 */

export type AuthenticityFeeBand = Readonly<{
  /** Inclusive lower bound on the declared order value this band applies to. */
  minOrderValueAmount: string;
  /**
   * Always "any": the band is chosen by order value alone. The key stays on
   * the stored band so a build that requires it decodes every document.
   */
  category: "any";
  flatAmount: string;
  percentageBps: number;
  /** The maximum fee this band can produce, regardless of order value. */
  capAmount: string;
}>;

export type AuthenticityFeePolicyValue = Readonly<{
  /** The order value at/above which the authenticity check opt-in is offered at checkout. */
  optInThresholdAmount: string;
  bands: readonly AuthenticityFeeBand[];
}>;

/**
 * The launch values: $8 flat + 2% of the declared order value, capped at
 * $50, offered once the order value reaches $100 -- the epic's launch
 * recommendation, tuned with data post-launch. A single band covers every
 * order value.
 */
export const AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE: AuthenticityFeePolicyValue = {
  optInThresholdAmount: "100.00",
  bands: [
    {
      minOrderValueAmount: "0.00",
      category: "any",
      flatAmount: "8.00",
      percentageBps: 200,
      capAmount: "50.00",
    },
  ],
};

/**
 * Categories a band could be stored with before bands were chosen by order
 * value alone. Ordering never quoted a band stored with one, so decoding
 * drops it rather than letting it start to match.
 */
const RETIRED_BAND_CATEGORIES = ["raw", "graded"] as const;

type RetiredBandCategory = (typeof RETIRED_BAND_CATEGORIES)[number];

type StoredBand = Omit<AuthenticityFeeBand, "category"> & Readonly<{ category: "any" | RetiredBandCategory }>;

function isRetiredBandCategory(value: unknown): value is RetiredBandCategory {
  return RETIRED_BAND_CATEGORIES.some((category) => category === value);
}

export function normalizeAuthenticityFeeBandCategory(value: unknown): "any" {
  if (value !== "any") {
    throw new CommercialTermsDomainError('Authenticity fee band category must be "any".');
  }
  return value;
}

/** Validates every field of a band as stored, a band with a retired category included. */
function normalizeStoredBand(value: unknown): StoredBand {
  if (typeof value !== "object" || value === null) {
    throw new CommercialTermsDomainError("Authenticity fee band must be an object.");
  }
  const record = value as Record<string, unknown>;

  return {
    minOrderValueAmount: normalizeMoneyAmount(String(record.minOrderValueAmount ?? ""), {
      fieldName: "Authenticity fee band minimum order value",
      allowZero: true,
    }),
    category: isRetiredBandCategory(record.category)
      ? record.category
      : normalizeAuthenticityFeeBandCategory(record.category),
    flatAmount: normalizeMoneyAmount(String(record.flatAmount ?? ""), {
      fieldName: "Authenticity fee band flat amount",
      allowZero: true,
    }),
    percentageBps: normalizePercentageBps(Number(record.percentageBps), "Authenticity fee band percentage"),
    capAmount: normalizeMoneyAmount(String(record.capAmount ?? ""), {
      fieldName: "Authenticity fee band cap amount",
      allowZero: false,
    }),
  };
}

export function decodeAuthenticityFeePolicyValue(raw: JsonValue): AuthenticityFeePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialTermsDomainError("Authenticity fee policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const optInThresholdAmount = normalizeMoneyAmount(String(record.optInThresholdAmount ?? ""), {
    fieldName: "Authenticity fee opt-in threshold",
    allowZero: true,
  });

  const bandsRaw = record.bands;
  if (!Array.isArray(bandsRaw) || bandsRaw.length === 0) {
    throw new CommercialTermsDomainError("Authenticity fee policy must declare at least one band.");
  }
  // Every band is validated and the category and minimum order value pair is checked across all of them,
  // retired bands included, so a document this decoder accepts also decodes on a build that predates it.
  // Among the bands that remain, the pair rule is uniqueness by minimum order value.
  const storedBands = bandsRaw.map((band) => normalizeStoredBand(band));
  const pairs = new Set(storedBands.map((band) => `${band.category}|${band.minOrderValueAmount}`));
  if (pairs.size !== storedBands.length) {
    throw new CommercialTermsDomainError("Authenticity fee policy bands must not repeat a minimum order value.");
  }
  const bands = storedBands.filter((band): band is AuthenticityFeeBand => band.category === "any");

  return { optInThresholdAmount, bands };
}

export const authenticityFeePolicy: PolicyDefinition<AuthenticityFeePolicyValue> = definePolicy({
  policyKey: "commercial-terms.authenticity-fee",
  contextName: "commercial-terms",
  schemaSummary:
    '{ optInThresholdAmount: string, bands: [{ minOrderValueAmount, category: "any", flatAmount, percentageBps, capAmount }] }',
  defaultValue: AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeAuthenticityFeePolicyValue,
});
