import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import { MAX_MARKET_ESTIMATE_FRESH_HOURS } from "../../market-estimates/domain/estimate-policy";

/** Authorized selection terms supplied by Marketplace's buyer Offer policy boundary. */
export type BuyerOfferTargetSelection = Readonly<{
  offerId: string;
  offerVersion: number;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  quantity: number;
  maximumUnitItemAmount: string;
}>;

export type BuyerMarketPrice = Readonly<{
  catalogItemId: string;
  productId: string;
  estimateVersion: string;
  amount: string;
  currencyCode: string;
  estimatedAt: string;
  freshUntil: string;
}>;

export type BuyerOfferTargetInput = Readonly<{
  selection: BuyerOfferTargetSelection;
  currency: string;
  adjustmentBps: number;
  policyRevision: number;
  marketPrice: BuyerMarketPrice | null;
  evaluatedAt: string;
}>;

export type BuyerOfferTargetEvidence = Readonly<{
  offerId: string;
  offerVersion: number;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  quantity: number;
  currency: string;
  adjustmentBps: number;
  maximumUnitItemAmount: string;
  policyRevision: number;
  marketPrice: BuyerMarketPrice | null;
  evaluatedAt: string;
}>;

export type BuyerOfferTargetHoldReason =
  | "market-price-unavailable"
  | "market-price-invalid"
  | "market-price-product-mismatch"
  | "market-price-currency-mismatch"
  | "market-price-stale"
  | "evaluation-time-invalid"
  | "target-below-minimum";

export type BuyerOfferTargetResult =
  | Readonly<{ status: "target"; unitItemAmount: string; evidence: BuyerOfferTargetEvidence }>
  | Readonly<{
      status: "held";
      reason: BuyerOfferTargetHoldReason;
      buyerCopy: string;
      evidence: BuyerOfferTargetEvidence;
    }>;

const holdCopy: Record<BuyerOfferTargetHoldReason, string> = {
  "market-price-unavailable": "A Market Price is not available for this Product yet.",
  "market-price-invalid": "A valid Market Price is not available for this Product yet.",
  "market-price-product-mismatch": "The Market Price does not match this Product.",
  "market-price-currency-mismatch": "The Market Price currency does not match this Offer.",
  "market-price-stale": "The Market Price needs to be refreshed before this Offer can be updated.",
  "evaluation-time-invalid": "This Offer cannot be evaluated without a valid current time.",
  "target-below-minimum": "The Market Price adjustment is below the minimum unit item amount.",
};

function instant(value: string): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === `${match[1]}.${(match[2] ?? "0").padEnd(3, "0")}Z`
    ? time
    : null;
}

/** Both preview and attempted application evaluate the same complete snapshot at their own real instant. */
export function evaluateBuyerOfferTarget(input: BuyerOfferTargetInput): BuyerOfferTargetResult {
  const { selection, marketPrice } = input;
  const cap = tryMoneyToCents(selection.maximumUnitItemAmount);
  if (
    cap === null ||
    cap < 1n ||
    !Number.isSafeInteger(input.adjustmentBps) ||
    input.adjustmentBps < -2500 ||
    input.adjustmentBps > 0 ||
    !Number.isSafeInteger(input.policyRevision) ||
    input.policyRevision < 1 ||
    !Number.isSafeInteger(selection.quantity) ||
    selection.quantity < 1 ||
    !Number.isSafeInteger(selection.offerVersion) ||
    selection.offerVersion < 1 ||
    !/^[A-Z]{3}$/.test(input.currency)
  ) {
    throw new Error("Invalid authorized buyer Offer terms.");
  }

  const evidence: BuyerOfferTargetEvidence = {
    offerId: selection.offerId,
    offerVersion: selection.offerVersion,
    catalogItemId: selection.catalogItemId,
    productId: selection.productId,
    selectedOptions: selection.selectedOptions.map(({ dimensionId, optionId }) => ({ dimensionId, optionId })),
    quantity: selection.quantity,
    currency: input.currency,
    adjustmentBps: input.adjustmentBps,
    maximumUnitItemAmount: selection.maximumUnitItemAmount,
    policyRevision: input.policyRevision,
    marketPrice:
      marketPrice === null
        ? null
        : {
            catalogItemId: marketPrice.catalogItemId,
            productId: marketPrice.productId,
            estimateVersion: marketPrice.estimateVersion,
            amount: marketPrice.amount,
            currencyCode: marketPrice.currencyCode,
            estimatedAt: marketPrice.estimatedAt,
            freshUntil: marketPrice.freshUntil,
          },
    evaluatedAt: input.evaluatedAt,
  };
  const held = (reason: BuyerOfferTargetHoldReason): BuyerOfferTargetResult => ({
    status: "held",
    reason,
    buyerCopy: holdCopy[reason],
    evidence,
  });

  const now = instant(input.evaluatedAt);
  if (now === null) return held("evaluation-time-invalid");
  if (marketPrice === null) return held("market-price-unavailable");
  if (marketPrice.catalogItemId !== selection.catalogItemId || marketPrice.productId !== selection.productId) {
    return held("market-price-product-mismatch");
  }
  if (typeof marketPrice.currencyCode !== "string" || !/^[A-Za-z]{3}$/.test(marketPrice.currencyCode)) {
    return held("market-price-invalid");
  }
  if (marketPrice.currencyCode.toUpperCase() !== input.currency) return held("market-price-currency-mismatch");
  const amount = typeof marketPrice.amount === "string" ? tryMoneyToCents(marketPrice.amount) : null;
  const estimatedAt = instant(marketPrice.estimatedAt);
  const freshUntil = instant(marketPrice.freshUntil);
  if (
    typeof marketPrice.estimateVersion !== "string" ||
    !/^[1-9]\d{0,18}$/.test(marketPrice.estimateVersion) ||
    amount === null ||
    amount < 1n ||
    estimatedAt === null ||
    freshUntil === null ||
    freshUntil <= estimatedAt ||
    freshUntil - estimatedAt > MAX_MARKET_ESTIMATE_FRESH_HOURS * 60 * 60 * 1000
  )
    return held("market-price-invalid");
  if (estimatedAt > now || now >= freshUntil) return held("market-price-stale");

  const adjusted = (amount * BigInt(10_000 + input.adjustmentBps)) / 10_000n;
  if (adjusted < 1n) return held("target-below-minimum");
  return { status: "target", unitItemAmount: centsToMoneyAmount(adjusted < cap ? adjusted : cap), evidence };
}
