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

export const AUTHENTICITY_FEE_CATEGORIES = ["raw", "graded", "any"] as const;

export type AuthenticityFeeCategory = (typeof AUTHENTICITY_FEE_CATEGORIES)[number];

export type AuthenticityFeeBand = Readonly<{
  /** Inclusive lower bound on the declared order value this band applies to. */
  minOrderValueAmount: string;
  /** "any" matches every category; "raw"/"graded" only match that category. */
  category: AuthenticityFeeCategory;
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
 * recommendation, tuned with data post-launch. A single "any"-category
 * band covers both raw and graded orders in v1; the schema already
 * supports category-specific bands for when per-line grading
 * classification is wired into the quote (a later platform-mandated-tier
 * follow-on).
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

function normalizeCategory(value: unknown): AuthenticityFeeCategory {
  if (typeof value !== "string" || !AUTHENTICITY_FEE_CATEGORIES.includes(value as AuthenticityFeeCategory)) {
    throw new CommercialTermsDomainError(
      `Authenticity fee band category must be one of ${AUTHENTICITY_FEE_CATEGORIES.join(", ")}.`,
    );
  }
  return value as AuthenticityFeeCategory;
}

function normalizeBand(value: unknown): AuthenticityFeeBand {
  if (typeof value !== "object" || value === null) {
    throw new CommercialTermsDomainError("Authenticity fee band must be an object.");
  }
  const record = value as Record<string, unknown>;

  return {
    minOrderValueAmount: normalizeMoneyAmount(String(record.minOrderValueAmount ?? ""), {
      fieldName: "Authenticity fee band minimum order value",
      allowZero: true,
    }),
    category: normalizeCategory(record.category),
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
  const bands = bandsRaw.map((band) => normalizeBand(band));
  const seenKeys = new Set(bands.map((band) => `${band.category}|${band.minOrderValueAmount}`));
  if (seenKeys.size !== bands.length) {
    throw new CommercialTermsDomainError(
      "Authenticity fee policy bands must not repeat a category and minimum order value pair.",
    );
  }

  return { optInThresholdAmount, bands };
}

export const authenticityFeePolicy: PolicyDefinition<AuthenticityFeePolicyValue> = definePolicy({
  policyKey: "commercial-terms.authenticity-fee",
  contextName: "commercial-terms",
  schemaSummary:
    "{ optInThresholdAmount: string, bands: [{ minOrderValueAmount, category, flatAmount, percentageBps, capAmount }] }",
  defaultValue: AUTHENTICITY_FEE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeAuthenticityFeePolicyValue,
});
