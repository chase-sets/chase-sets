import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  centsToMoneyAmount,
  compareMoneyAmounts,
  tryMoneyToCents,
  trySignedMoneyToCents,
} from "@chase-sets/primitives/money";
import {
  assert,
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
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
