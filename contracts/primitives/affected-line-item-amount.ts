import { centsToMoneyAmount, tryMoneyToCents, type MoneyAmount } from "./money";

export type AffectedLineItemAmountInput = Readonly<{
  lineId: string;
  amount: string;
  currencyCode: string;
}>;

export type AffectedLineItemAmount = Readonly<{
  lineId: string;
  amount: MoneyAmount;
  currencyCode: string;
}>;

export function normalizeAffectedLineItemAmount(input: AffectedLineItemAmountInput) {
  const lineId = input.lineId.trim();
  if (lineId.length === 0) {
    throw new Error("Affected line item must include a line id.");
  }

  const cents = tryMoneyToCents(input.amount);
  if (cents === null) {
    throw new Error("Affected line-item amount must be a valid decimal.");
  }

  const currencyCode = input.currencyCode.trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(currencyCode)) {
    throw new Error("Affected line-item currency must be a three-letter code.");
  }

  return {
    lineId,
    amount: centsToMoneyAmount(cents),
    currencyCode,
  } satisfies AffectedLineItemAmount;
}

export function normalizeAffectedLineItemAmounts(
  inputs: readonly AffectedLineItemAmountInput[],
): readonly AffectedLineItemAmount[] {
  const lineIds = new Set<string>();
  return inputs.map((input) => {
    const normalized = normalizeAffectedLineItemAmount(input);
    if (lineIds.has(normalized.lineId)) {
      throw new Error(`Affected line item '${normalized.lineId}' is duplicated.`);
    }
    lineIds.add(normalized.lineId);
    return normalized;
  });
}
