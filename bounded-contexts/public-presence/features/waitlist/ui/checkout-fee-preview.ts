import { formatBpsPercent, formatMoney, type TranslationValues } from "@chase-sets/localization";
import { centsToMoneyAmount, grossUpMoneyAmountByBasisPoints, moneyToCents } from "@chase-sets/primitives/money";

/**
 * The landing preview's illustrative sample order, in integer cents. The
 * static locale copy for the sample listing/breakdown ($83.40 item, $0.48
 * shipping after credit) must stay consistent with these constants; the
 * checkout-fee-preview test pins that consistency.
 */
export const checkoutFeePreviewSampleOrderCents = {
  itemCents: 8340n,
  shippingCents: 48n,
  taxCents: 0n,
} as const;

export type CheckoutProcessingTerms = Readonly<{
  percentageBps: number;
  fixedAmount: string;
}>;

export type CheckoutProcessingTermsByMethod = Readonly<{
  card: CheckoutProcessingTerms;
  bankAccount: CheckoutProcessingTerms;
}>;

/**
 * The compiled launch checkout processing terms (card 2.9% + $0.30, bank
 * 0.5%), used only when the live public policy read is unavailable. This is
 * the same compiled-fallback doctrine Payments applies to its checkout-fee
 * policy: the live effective policy document wins whenever it can be read.
 */
export const compiledCheckoutProcessingTerms: CheckoutProcessingTermsByMethod = {
  card: { percentageBps: 290, fixedAmount: "0.30" },
  bankAccount: { percentageBps: 50, fixedAmount: "0.00" },
};

export type CheckoutFeePreview = Readonly<{
  /** e.g. "2.9%" */
  cardRate: string;
  /** e.g. "$0.30" */
  cardFixed: string;
  /** e.g. "0.5%" */
  bankRate: string;
  /** e.g. "$0.00" */
  bankFixed: string;
  /** The card processing fee on the sample order, e.g. "$2.82". */
  cardFeeAmount: string;
  /** The sample order total when paying by card, e.g. "$86.70". */
  cardTotalAmount: string;
  /** The sample order total when paying with Chase Sets balance, e.g. "$83.88". */
  balanceTotalAmount: string;
}>;

/**
 * Derives the concrete buyer-side checkout-fee presentation for the landing
 * preview from checkout processing terms, using the same gross-up
 * (fee covers its own processing, ceil rounding) that Payments applies when
 * quoting the Marketplace Checkout Fee, over integer cents throughout.
 */
export function buildCheckoutFeePreview(terms: CheckoutProcessingTermsByMethod): CheckoutFeePreview {
  const { itemCents, shippingCents, taxCents } = checkoutFeePreviewSampleOrderCents;
  const basisCents = itemCents + shippingCents + taxCents;
  const basisAmount = centsToMoneyAmount(basisCents);
  const cardFeeAmount = grossUpMoneyAmountByBasisPoints({
    basisAmount,
    percentageBps: terms.card.percentageBps,
    fixedAmount: terms.card.fixedAmount,
    roundingMode: "ceil",
  });
  const cardTotalCents = basisCents + moneyToCents(cardFeeAmount);

  return {
    cardRate: formatBpsPercent(terms.card.percentageBps),
    cardFixed: formatMoney(terms.card.fixedAmount, "USD"),
    bankRate: formatBpsPercent(terms.bankAccount.percentageBps),
    bankFixed: formatMoney(terms.bankAccount.fixedAmount, "USD"),
    cardFeeAmount: formatMoney(cardFeeAmount, "USD"),
    cardTotalAmount: formatMoney(centsToMoneyAmount(cardTotalCents), "USD"),
    balanceTotalAmount: formatMoney(basisAmount, "USD"),
  };
}

/** The preview rendered from the compiled launch terms when no live read is available. */
export const fallbackCheckoutFeePreview: CheckoutFeePreview = buildCheckoutFeePreview(compiledCheckoutProcessingTerms);

/**
 * Extracts the whitelisted checkout processing terms from the public policy
 * values response (`/api/public-presence/policy-values`). Throws when a
 * required key is missing or malformed so the caller can fall back loudly.
 */
export function selectCheckoutProcessingTerms(
  values: Readonly<Record<string, Readonly<{ value: string | number }>>>,
): CheckoutProcessingTermsByMethod {
  return {
    card: {
      percentageBps: requireBps(values, "checkout-processing-fee.card.bps"),
      fixedAmount: requireMoney(values, "checkout-processing-fee.card.fixed"),
    },
    bankAccount: {
      percentageBps: requireBps(values, "checkout-processing-fee.bank-account.bps"),
      fixedAmount: requireMoney(values, "checkout-processing-fee.bank-account.fixed"),
    },
  };
}

/** The translation values the checkout-fee copy interpolates. */
export function checkoutFeeTranslationValues(preview: CheckoutFeePreview): TranslationValues {
  return {
    checkoutCardRate: preview.cardRate,
    checkoutCardFixed: preview.cardFixed,
    checkoutBankRate: preview.bankRate,
    checkoutCardFee: preview.cardFeeAmount,
    checkoutCardTotal: preview.cardTotalAmount,
    checkoutBalanceTotal: preview.balanceTotalAmount,
  };
}

function requireBps(values: Readonly<Record<string, Readonly<{ value: string | number }>>>, key: string): number {
  const bps = Number(values[key]?.value);
  if (!Number.isSafeInteger(bps) || bps < 0) {
    throw new Error(`Public policy value '${key}' is not a valid basis-points amount.`);
  }
  return bps;
}

function requireMoney(values: Readonly<Record<string, Readonly<{ value: string | number }>>>, key: string): string {
  const amount = values[key]?.value;
  if (typeof amount !== "string") {
    throw new Error(`Public policy value '${key}' is not a valid money amount.`);
  }
  return amount;
}
