import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import { trySignedMoneyToCents } from "@chase-sets/primitives/money";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  CommercialTermsDomainError,
  normalizeMoneyAmount,
  normalizePercentageBps,
} from "../../../support/runtime-support/common";

/**
 * The checkout processing-fee policy: the buyer-side Marketplace Checkout
 * Fee that Payments quotes at checkout time. It is account-type-agnostic
 * (unlike Commercial Terms' schedules/agreements, which key on account
 * type) and carries its own effective windows, so it is declared as its own
 * small `definePolicy` document rather than folded into the schedule
 * aggregate. Commercial Terms owns the schema and the admin-managed
 * create/revise commands (see `api/route.ts`); Payments consumes only the
 * resolved value via the `checkoutProcessingFeePolicyResolver` host port
 * (see `../../../server.ts`).
 */

export const CHECKOUT_PROCESSING_FEE_PAYMENT_METHOD_CATEGORIES = ["card", "bank-account", "platform-credit"] as const;

export type CheckoutProcessingFeePaymentMethodCategory =
  (typeof CHECKOUT_PROCESSING_FEE_PAYMENT_METHOD_CATEGORIES)[number];

export type CheckoutProcessingFeeMethodAdjustment = Readonly<{
  paymentMethodCategory: CheckoutProcessingFeePaymentMethodCategory;
  percentageBpsDelta: number;
  fixedAmountDelta: string;
}>;

export type CheckoutProcessingFeePolicyValue = Readonly<{
  enabledJurisdictions: readonly string[];
  base: Readonly<{
    percentageBps: number;
    fixedAmount: string;
  }>;
  methodAdjustments: readonly CheckoutProcessingFeeMethodAdjustment[];
}>;

/** The launch values (290bps + $0.30 card, 50bps bank, 0bps credit) -- the migration's byte-identical seed and compiled fallback. */
export const CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE: CheckoutProcessingFeePolicyValue = {
  enabledJurisdictions: ["US"],
  base: {
    percentageBps: 290,
    fixedAmount: "0.30",
  },
  methodAdjustments: [
    { paymentMethodCategory: "card", percentageBpsDelta: 0, fixedAmountDelta: "0.00" },
    { paymentMethodCategory: "bank-account", percentageBpsDelta: -240, fixedAmountDelta: "-0.30" },
    { paymentMethodCategory: "platform-credit", percentageBpsDelta: -290, fixedAmountDelta: "-0.30" },
  ],
};

function normalizeSignedMoneyDelta(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new CommercialTermsDomainError(`${fieldName} must be a decimal string.`);
  }
  const cents = trySignedMoneyToCents(value.trim());
  if (cents === null) {
    throw new CommercialTermsDomainError(`${fieldName} must be a signed decimal.`);
  }
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function normalizeJurisdictionCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new CommercialTermsDomainError("Enabled jurisdiction codes must be strings.");
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new CommercialTermsDomainError("Enabled jurisdiction codes must be a two-letter ISO country code.");
  }
  return normalized;
}

function normalizeMethodAdjustment(value: unknown): CheckoutProcessingFeeMethodAdjustment {
  if (typeof value !== "object" || value === null) {
    throw new CommercialTermsDomainError("Checkout processing-fee method adjustment must be an object.");
  }
  const record = value as Record<string, unknown>;
  const paymentMethodCategory = record.paymentMethodCategory;
  if (
    typeof paymentMethodCategory !== "string" ||
    !CHECKOUT_PROCESSING_FEE_PAYMENT_METHOD_CATEGORIES.includes(
      paymentMethodCategory as CheckoutProcessingFeePaymentMethodCategory,
    )
  ) {
    throw new CommercialTermsDomainError(
      `Checkout processing-fee method adjustment category must be one of ${CHECKOUT_PROCESSING_FEE_PAYMENT_METHOD_CATEGORIES.join(", ")}.`,
    );
  }

  return {
    paymentMethodCategory: paymentMethodCategory as CheckoutProcessingFeePaymentMethodCategory,
    percentageBpsDelta: normalizeSignedPercentageBpsDelta(
      record.percentageBpsDelta,
      "Method adjustment percentage delta",
    ),
    fixedAmountDelta: normalizeSignedMoneyDelta(record.fixedAmountDelta, "Method adjustment fixed-amount delta"),
  };
}

function normalizeSignedPercentageBpsDelta(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new CommercialTermsDomainError(`${fieldName} must be a whole number of basis points.`);
  }
  if (value < -10_000 || value > 10_000) {
    throw new CommercialTermsDomainError(`${fieldName} must be between -10000 and 10000 basis points.`);
  }
  return value;
}

export function decodeCheckoutProcessingFeePolicyValue(raw: JsonValue): CheckoutProcessingFeePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialTermsDomainError("Checkout processing-fee policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const enabledJurisdictionsRaw = record.enabledJurisdictions;
  if (!Array.isArray(enabledJurisdictionsRaw) || enabledJurisdictionsRaw.length === 0) {
    throw new CommercialTermsDomainError("Checkout processing-fee policy must enable at least one jurisdiction.");
  }
  const enabledJurisdictions = enabledJurisdictionsRaw.map((code) => normalizeJurisdictionCode(code));

  const baseRaw = record.base;
  if (typeof baseRaw !== "object" || baseRaw === null) {
    throw new CommercialTermsDomainError("Checkout processing-fee policy base terms are required.");
  }
  const baseRecord = baseRaw as Record<string, unknown>;
  const base = {
    percentageBps: normalizePercentageBps(Number(baseRecord.percentageBps), "Checkout processing-fee base percentage"),
    fixedAmount: normalizeMoneyAmount(String(baseRecord.fixedAmount ?? ""), {
      fieldName: "Checkout processing-fee base fixed amount",
      allowZero: true,
    }),
  };

  const methodAdjustmentsRaw = record.methodAdjustments;
  if (!Array.isArray(methodAdjustmentsRaw)) {
    throw new CommercialTermsDomainError("Checkout processing-fee policy method adjustments must be a list.");
  }
  const methodAdjustments = methodAdjustmentsRaw.map((adjustment) => normalizeMethodAdjustment(adjustment));
  const seenCategories = new Set(methodAdjustments.map((adjustment) => adjustment.paymentMethodCategory));
  if (seenCategories.size !== methodAdjustments.length) {
    throw new CommercialTermsDomainError(
      "Checkout processing-fee policy method adjustments must not repeat a category.",
    );
  }

  return { enabledJurisdictions, base, methodAdjustments };
}

export const checkoutProcessingFeePolicy: PolicyDefinition<CheckoutProcessingFeePolicyValue> = definePolicy({
  policyKey: "commercial-terms.checkout-processing-fee",
  contextName: "commercial-terms",
  schemaSummary:
    "{ enabledJurisdictions: string[], base: { percentageBps, fixedAmount }, methodAdjustments: [{ paymentMethodCategory, percentageBpsDelta, fixedAmountDelta }] }",
  defaultValue: CHECKOUT_PROCESSING_FEE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeCheckoutProcessingFeePolicyValue,
});
