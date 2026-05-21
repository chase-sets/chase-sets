import {
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  SettlementDomainError,
  type CurrencyCode,
} from "../../../support/runtime-support/common";

export const payoutAmountPolicy = {
  currencyCode: "usd" as CurrencyCode,
  minimumAmount: "5.00",
  maximumAmount: "10000.00",
} as const;

export function capPayoutAmountToPolicy(amount: string) {
  const numericAmount = Number.parseFloat(amount);
  const maximumAmount = Number.parseFloat(payoutAmountPolicy.maximumAmount);

  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return "0.00";
  }

  return Math.min(numericAmount, maximumAmount).toFixed(2);
}

export function resolvePayoutAmountSelection(
  params: Readonly<{
    amount: string;
    shortcut?: string | null;
    availableAmount?: string | null;
  }>,
) {
  switch (params.shortcut) {
    case "minimum":
      return payoutAmountPolicy.minimumAmount;
    case "available":
      return capPayoutAmountToPolicy(params.availableAmount ?? "0");
    default:
      return params.amount;
  }
}

export function assertPayoutAmountWithinPolicy(amount: string, currencyCode: string) {
  const normalizedCurrencyCode = normalizeCurrencyCode(currencyCode);
  const normalizedAmount = normalizeMoneyAmount(amount, {
    fieldName: "Payout amount",
  });

  if (compareMoney(normalizedAmount, payoutAmountPolicy.minimumAmount) < 0) {
    throw new SettlementDomainError(
      `Payout amount must be at least ${payoutAmountPolicy.minimumAmount} ${normalizedCurrencyCode.toUpperCase()}.`,
    );
  }

  if (compareMoney(normalizedAmount, payoutAmountPolicy.maximumAmount) > 0) {
    throw new SettlementDomainError(
      `Payout amount cannot exceed ${payoutAmountPolicy.maximumAmount} ${normalizedCurrencyCode.toUpperCase()}.`,
    );
  }

  return normalizedAmount;
}
