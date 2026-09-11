import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  addMoneyAmounts,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  compareMoneyAmounts,
  moneyToCents,
  subtractNonNegativeMoneyAmounts,
  tryMoneyToCents,
  trySignedMoneyToCents,
} from "@chase-sets/primitives/money";
import {
  assert,
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeRequiredText,
  SettlementDomainError,
  type CurrencyCode,
} from "../../../support/runtime-support/common";

/**
 * The settlement payout-bounds policy: the minimum and maximum amount a
 * seller may request in a single payout. Settlement both owns this policy's
 * schema/admin routes (see `../api/payout-bounds-policy-route.ts`) and is its
 * only consumer, so no cross-context host port is needed -- domain functions
 * below take the resolved policy as an optional trailing parameter, defaulting
 * to the compiled launch value so existing call sites keep working unchanged.
 */

export type SettlementPayoutBoundsPolicyValue = Readonly<{
  currencyCode: CurrencyCode;
  minimumAmount: string;
  maximumAmount: string;
}>;

/** The launch bounds ($5 minimum / $10,000 maximum) -- the migration's byte-identical seed and compiled fallback. */
export const payoutAmountPolicy: SettlementPayoutBoundsPolicyValue = {
  currencyCode: "usd",
  minimumAmount: "5.00",
  maximumAmount: "10000.00",
};

export function decodeSettlementPayoutBoundsPolicyValue(raw: JsonValue): SettlementPayoutBoundsPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Settlement payout-bounds policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;

  const currencyCode = normalizeCurrencyCode(String(record.currencyCode ?? "usd"));
  const minimumAmount = normalizeMoneyAmount(String(record.minimumAmount ?? ""), {
    fieldName: "Payout minimum amount",
    allowZero: true,
  });
  const maximumAmount = normalizeMoneyAmount(String(record.maximumAmount ?? ""), {
    fieldName: "Payout maximum amount",
  });
  if (compareMoney(minimumAmount, maximumAmount) > 0) {
    throw new SettlementDomainError("Payout minimum amount must not exceed the payout maximum amount.");
  }

  return { currencyCode, minimumAmount, maximumAmount };
}

export const settlementPayoutBoundsPolicy: PolicyDefinition<SettlementPayoutBoundsPolicyValue> = definePolicy({
  policyKey: "settlement.payout-bounds",
  contextName: "settlement",
  schemaSummary:
    "{ currencyCode: 'usd', minimumAmount: decimal string >= 0, maximumAmount: decimal string >= minimumAmount }",
  defaultValue: payoutAmountPolicy,
  decodeValue: decodeSettlementPayoutBoundsPolicyValue,
});

export type SettlementPayoutFeePolicyValue = Readonly<{
  label: string;
  percentageBps: number;
  fixedAmount: string;
  firstPayoutOfMonthFixedAmount: string;
}>;

export type PayoutFeeQuote = Readonly<{
  feeAmount: string;
  netAmount: string;
}>;

export const SETTLEMENT_PAYOUT_FEE_POLICY_KEY = "settlement.payout-fee";

/**
 * Compiled payout-fee fallback until #7810 captures the provider pricing.
 * The monthly component ships absorbed and can be revised through the policy console.
 */
export const SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE: SettlementPayoutFeePolicyValue = {
  label: "Payout fee",
  percentageBps: 25,
  fixedAmount: "0.25",
  firstPayoutOfMonthFixedAmount: "0.00",
};

const payoutFeePolicyFields = ["label", "percentageBps", "fixedAmount", "firstPayoutOfMonthFixedAmount"] as const;
const maximumPayoutFeeFixedAmountCents = 500n;

export function decodeSettlementPayoutFeePolicyValue(raw: JsonValue): SettlementPayoutFeePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Settlement payout-fee policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const actualFields = Object.keys(record).sort();
  const expectedFields = [...payoutFeePolicyFields].sort();
  assert(
    actualFields.length === expectedFields.length &&
      actualFields.every((field, index) => field === expectedFields[index]),
    `Settlement payout-fee policy value must contain exactly: ${payoutFeePolicyFields.join(", ")}.`,
  );
  assert(typeof record.label === "string", "Payout fee label must be a string.");
  assert(typeof record.percentageBps === "number", "Payout fee percentage must be a number.");
  assert(
    Number.isInteger(record.percentageBps) && record.percentageBps >= 0 && record.percentageBps <= 1_000,
    "Payout fee percentage must be a whole number between 0 and 1000 basis points.",
  );
  assert(typeof record.fixedAmount === "string", "Payout fee fixed amount must be a money string.");
  assert(
    typeof record.firstPayoutOfMonthFixedAmount === "string",
    "First-payout-of-month fixed amount must be a money string.",
  );

  const fixedAmount = normalizeBoundedPayoutFeeAmount(record.fixedAmount, "Payout fee fixed amount");
  const firstPayoutOfMonthFixedAmount = normalizeBoundedPayoutFeeAmount(
    record.firstPayoutOfMonthFixedAmount,
    "First-payout-of-month fixed amount",
  );
  return {
    label: normalizeRequiredText(record.label, "Payout fee label is required."),
    percentageBps: record.percentageBps,
    fixedAmount,
    firstPayoutOfMonthFixedAmount,
  };
}

function normalizeBoundedPayoutFeeAmount(value: string, fieldName: string): string {
  const normalized = normalizeMoneyAmount(value, { fieldName, allowZero: true });
  assert(moneyToCents(normalized) <= maximumPayoutFeeFixedAmountCents, `${fieldName} cannot exceed 5.00 USD.`);
  return normalized;
}

export const settlementPayoutFeePolicy: PolicyDefinition<SettlementPayoutFeePolicyValue> = definePolicy({
  policyKey: SETTLEMENT_PAYOUT_FEE_POLICY_KEY,
  contextName: "settlement",
  schemaSummary:
    "{ label: non-empty string, percentageBps: integer 0-1000, fixedAmount: USD 0.00-5.00, firstPayoutOfMonthFixedAmount: USD 0.00-5.00 }",
  defaultValue: SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeSettlementPayoutFeePolicyValue,
});

export function quotePayoutFee(
  requestedAmount: string,
  policy: Pick<
    SettlementPayoutFeePolicyValue,
    "percentageBps" | "fixedAmount" | "firstPayoutOfMonthFixedAmount"
  > = SETTLEMENT_PAYOUT_FEE_LAUNCH_POLICY_VALUE,
  options: Readonly<{ isFirstPayoutOfMonth: boolean }> = { isFirstPayoutOfMonth: false },
): PayoutFeeQuote {
  const normalizedRequestedAmount = normalizeMoneyAmount(requestedAmount, { fieldName: "Payout requested amount" });
  const percentageAmount = applyBasisPointsToMoneyAmount(normalizedRequestedAmount, policy.percentageBps, "ceil");
  const recurringAmount = addMoneyAmounts(percentageAmount, policy.fixedAmount);
  const feeAmount = options.isFirstPayoutOfMonth
    ? addMoneyAmounts(recurringAmount, policy.firstPayoutOfMonthFixedAmount)
    : recurringAmount;

  assert(
    moneyToCents(normalizedRequestedAmount) > moneyToCents(feeAmount),
    "Payout requested amount must exceed the payout fee.",
  );
  return {
    feeAmount,
    netAmount: subtractNonNegativeMoneyAmounts(normalizedRequestedAmount, feeAmount),
  };
}

export function capPayoutAmountToPolicy(
  amount: string,
  policy: Pick<SettlementPayoutBoundsPolicyValue, "maximumAmount"> = payoutAmountPolicy,
) {
  const maximumCents = tryMoneyToCents(policy.maximumAmount);
  assert(maximumCents !== null, "Payout maximum amount must be a valid decimal.");
  assert(maximumCents > 0n, "Payout maximum amount must be greater than zero.");

  const requestedCents = trySignedMoneyToCents(amount);
  if (requestedCents === null || requestedCents <= 0n) {
    return "0.00";
  }

  const normalizedAmount = centsToMoneyAmount(requestedCents);
  const normalizedMaximum = centsToMoneyAmount(maximumCents);
  return compareMoneyAmounts(normalizedAmount, normalizedMaximum) > 0 ? normalizedMaximum : normalizedAmount;
}

export function resolvePayoutAmountSelection(
  params: Readonly<{
    amount: string;
    shortcut?: string | null;
    availableAmount?: string | null;
  }>,
  policy: Pick<SettlementPayoutBoundsPolicyValue, "minimumAmount" | "maximumAmount"> = payoutAmountPolicy,
) {
  switch (params.shortcut) {
    case "minimum":
      return policy.minimumAmount;
    case "available":
      return capPayoutAmountToPolicy(params.availableAmount ?? "0", policy);
    default:
      return params.amount;
  }
}

export function assertPayoutAmountWithinPolicy(
  amount: string,
  currencyCode: string,
  policy: Pick<SettlementPayoutBoundsPolicyValue, "minimumAmount" | "maximumAmount"> = payoutAmountPolicy,
) {
  const normalizedCurrencyCode = normalizeCurrencyCode(currencyCode);
  const normalizedAmount = normalizeMoneyAmount(amount, {
    fieldName: "Payout amount",
  });

  if (compareMoney(normalizedAmount, policy.minimumAmount) < 0) {
    throw new SettlementDomainError(
      `Payout amount must be at least ${policy.minimumAmount} ${normalizedCurrencyCode.toUpperCase()}.`,
    );
  }

  if (compareMoney(normalizedAmount, policy.maximumAmount) > 0) {
    throw new SettlementDomainError(
      `Payout amount cannot exceed ${policy.maximumAmount} ${normalizedCurrencyCode.toUpperCase()}.`,
    );
  }

  return normalizedAmount;
}
