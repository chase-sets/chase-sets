import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import {
  addMoneyAmounts,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  moneyToCents,
  subtractMoneyAmounts,
} from "@chase-sets/primitives/money";
import type { PackagePlan, ProductMeasureSnapshot } from "@chase-sets/product-measures";
import {
  assert,
  buildDemandSignature,
  normalizeMoneyAmount,
  type ShippingOption,
  type VersionSelectedOptionEntry,
} from "./common";
import type { ShippingRates } from "./shipping-rates";

export type MarketplaceDemand = Readonly<{
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  quantity: number;
}>;

export type MarketplaceSupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: AccountId;
  sellerDisplayName: string | null;
  inventoryItemId: string;
  catalogItemId: CatalogItemId;
  productId: ProductKey;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  productMeasureSnapshot: ProductMeasureSnapshot | null;
  gradedCard: Readonly<{
    gradingCompany: string;
    grade: string;
    certificationNumber: string | null;
  }> | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress: AddressSnapshot;
  priceAmount: string;
  priceCurrencyCode: string;
  listingStreamVersion: number;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeLocks?: readonly MarketplaceSupplyFeeLock[];
  availableQuantity: number;
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
  updatedAt: string;
}>;

export type MarketplaceSupplyFeeLock = Readonly<{
  unitCount: number;
  marketplaceSalesFeePercentageBps?: number;
  marketplaceSalesFeeFixedAmount?: string;
  marketplaceSalesFeeCapAmount?: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

export type MarketplaceSalesFeeTermsSnapshot = Readonly<{
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
}>;

export function quoteMarketplaceSalesFeeFromSnapshot(unitPriceAmount: string, terms: MarketplaceSalesFeeTermsSnapshot) {
  const percentageAmount = applyBasisPointsToMoneyAmount(
    unitPriceAmount,
    terms.marketplaceSalesFeePercentageBps,
    "ceil",
  );
  const uncappedFee = addMoneyAmounts(percentageAmount, terms.marketplaceSalesFeeFixedAmount);
  const feeCents =
    terms.marketplaceSalesFeeCapAmount === null
      ? moneyToCents(uncappedFee)
      : [moneyToCents(uncappedFee), moneyToCents(terms.marketplaceSalesFeeCapAmount)].reduce((minimum, value) =>
          value < minimum ? value : minimum,
        );
  const marketplaceSalesFeeUnitAmount = centsToMoneyAmount(feeCents);
  return {
    marketplaceSalesFeeUnitAmount,
    sellerNetUnitAmount: subtractMoneyAmounts(unitPriceAmount, marketplaceSalesFeeUnitAmount),
  };
}

export type ShippingQuoteResult = Readonly<{
  shippingOption: ShippingOption;
  baseAmount: string;
  discountAmount?: string;
  chargeAmount?: string;
  packagePlan?: PackagePlan;
}>;

export interface ShippingQuotePolicy {
  quote(
    params: Readonly<{
      sellerAccountId: string;
      shippingOption: ShippingOption;
      itemSubtotalAmount: string;
      quantity: number;
      listingCount: number;
      packagePlan: PackagePlan;
      shippingRates: ShippingRates;
    }>,
  ): ShippingQuoteResult;
}

export const ORDER_PROTECTION_PERCENTAGE_BPS = 100;

export type OrderFulfillmentEconomics = Readonly<{
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingAllowanceAmount: string;
  shippingOverageAmount: string;
  sellerShippingPayoutAmount: string;
  protectionAmount: string;
  protectionAllowanceAmount: string;
  protectionOverageAmount: string;
  shippingChargeAmount: string;
}>;

/**
 * Allocates the seller-funded fulfillment allowance to Order Protection first,
 * then shipping. The buyer sees the two overflow shares combined as Shipping.
 */
export function calculateOrderFulfillmentEconomics(
  params: Readonly<{
    itemSubtotalAmount: string;
    shippingBaseAmount: string;
    shippingAllowancePercentageBps: number;
  }>,
): OrderFulfillmentEconomics {
  const shippingBaseAmount = normalizeMoneyAmount(params.shippingBaseAmount, {
    fieldName: "Shipping base amount",
    allowZero: true,
  });
  const allowanceLimitAmount = applyBasisPointsToMoneyAmount(
    params.itemSubtotalAmount,
    params.shippingAllowancePercentageBps,
    "floor",
  );
  // Ceil preserves the ratified "always collected" invariant for sub-dollar
  // item subtotals whose exact 1% is less than one cent.
  const protectionAmount = applyBasisPointsToMoneyAmount(
    params.itemSubtotalAmount,
    ORDER_PROTECTION_PERCENTAGE_BPS,
    "ceil",
  );
  const allowanceLimitCents = moneyToCents(allowanceLimitAmount);
  const protectionCents = moneyToCents(protectionAmount);
  const shippingBaseCents = moneyToCents(shippingBaseAmount);
  const protectionAllowanceCents = protectionCents < allowanceLimitCents ? protectionCents : allowanceLimitCents;
  const remainingAllowanceCents = allowanceLimitCents - protectionAllowanceCents;
  const shippingAllowanceCents =
    shippingBaseCents < remainingAllowanceCents ? shippingBaseCents : remainingAllowanceCents;
  const protectionOverageCents = protectionCents - protectionAllowanceCents;
  const shippingOverageCents = shippingBaseCents - shippingAllowanceCents;

  return {
    shippingBaseAmount,
    shippingDiscountAmount: centsToMoneyAmount(shippingAllowanceCents),
    shippingAllowanceAmount: centsToMoneyAmount(shippingAllowanceCents),
    shippingOverageAmount: centsToMoneyAmount(shippingOverageCents),
    sellerShippingPayoutAmount: centsToMoneyAmount(shippingOverageCents),
    protectionAmount,
    protectionAllowanceAmount: centsToMoneyAmount(protectionAllowanceCents),
    protectionOverageAmount: centsToMoneyAmount(protectionOverageCents),
    shippingChargeAmount: centsToMoneyAmount(shippingOverageCents + protectionOverageCents),
  };
}

export type OrderPaymentMethodCategory = "card" | "bank-account" | "platform-credit";

export type OrderPaymentDeadlinePolicyToken =
  | "ordering-payment-deadline-card-v1"
  | "ordering-payment-deadline-bank-account-v1"
  | "ordering-payment-deadline-platform-credit-v1"
  | "ordering-payment-deadline-terminal-failure-grace-v1";

type OrderPaymentDeadline = Readonly<{ token: OrderPaymentDeadlinePolicyToken; durationMs: number }>;

// Compiled on purpose: each token names its duration, so a new duration is a new token and a code change.
const orderPaymentDeadlines = {
  card: { token: "ordering-payment-deadline-card-v1", durationMs: 60 * 60 * 1000 },
  bankAccount: { token: "ordering-payment-deadline-bank-account-v1", durationMs: 5 * 24 * 60 * 60 * 1000 },
  platformCredit: { token: "ordering-payment-deadline-platform-credit-v1", durationMs: 15 * 60 * 1000 },
  terminalFailureGrace: {
    token: "ordering-payment-deadline-terminal-failure-grace-v1",
    durationMs: 5 * 60 * 1000,
  },
} as const satisfies Record<string, OrderPaymentDeadline>;

export function normalizeOrderPaymentMethodCategory(paymentMethodCategory?: string | null): OrderPaymentMethodCategory {
  if (paymentMethodCategory === "bank-account" || paymentMethodCategory === "platform-credit") {
    return paymentMethodCategory;
  }

  return "card";
}

function orderPaymentDeadlineFor(paymentMethodCategory?: string | null): OrderPaymentDeadline {
  switch (normalizeOrderPaymentMethodCategory(paymentMethodCategory)) {
    case "bank-account":
      return orderPaymentDeadlines.bankAccount;
    case "platform-credit":
      return orderPaymentDeadlines.platformCredit;
    case "card":
      return orderPaymentDeadlines.card;
  }
}

export function resolveOrderPaymentDeadline(pendingPaymentAt: string, paymentMethodCategory?: string | null) {
  const token = orderPaymentDeadlineFor(paymentMethodCategory);
  const startedAtMs = Date.parse(pendingPaymentAt);
  assert(Number.isFinite(startedAtMs), "Payment deadline requires a valid pending-payment timestamp.");

  return {
    paymentDeadlineAt: new Date(startedAtMs + token.durationMs).toISOString(),
    paymentDeadlinePolicy: token.token,
  };
}

export function resolveTerminalPaymentFailureDeadline(failedAt: string) {
  const failedAtMs = Date.parse(failedAt);
  assert(Number.isFinite(failedAtMs), "Terminal payment failure grace requires a valid failure timestamp.");

  return {
    paymentDeadlineAt: new Date(failedAtMs + orderPaymentDeadlines.terminalFailureGrace.durationMs).toISOString(),
    paymentDeadlinePolicy: orderPaymentDeadlines.terminalFailureGrace.token,
  };
}

export const defaultShippingQuotePolicy: ShippingQuotePolicy = {
  quote({ shippingOption, itemSubtotalAmount, packagePlan, shippingRates }) {
    normalizeMoneyAmount(itemSubtotalAmount, {
      allowZero: true,
      fieldName: "Item subtotal",
    });
    assert(packagePlan.packages.length > 0, "A shipping quote requires a package plan with at least one package.");

    const letterCents = moneyToCents(shippingRates.letterAmount);
    const parcelCents = moneyToCents(
      shippingOption === "priority"
        ? shippingRates.priorityParcelAmount
        : shippingOption === "expedited"
          ? shippingRates.expeditedParcelAmount
          : shippingRates.standardParcelAmount,
    );
    const parcelIncludedOunces = BigInt(shippingRates.parcelIncludedOunces);
    const parcelAdditionalOunceCents = moneyToCents(shippingRates.parcelAdditionalOunceAmount);
    const baseCents = packagePlan.packages.reduce((sum, pkg) => {
      if (pkg.mailpieceClass === "letter") {
        return sum + letterCents;
      }
      const ouncesOverIncluded = BigInt(pkg.billableWeightOunces) - parcelIncludedOunces;
      const additionalOunces = ouncesOverIncluded > 0n ? ouncesOverIncluded : 0n;
      return sum + parcelCents + additionalOunces * parcelAdditionalOunceCents;
    }, 0n);
    const baseAmount = centsToMoneyAmount(baseCents);

    return {
      shippingOption,
      baseAmount,
      discountAmount: "0.00",
      chargeAmount: baseAmount,
      packagePlan,
    };
  },
};

export function tieBreakPlanKey(orderIds: readonly string[]) {
  return [...orderIds].sort().join("|");
}

export function demandKeyForLine(line: Pick<MarketplaceDemand, "productId">) {
  return buildDemandSignature(line.productId);
}

export function assertSupplyAvailable(
  candidates: readonly MarketplaceSupplyCandidate[],
  quantity: number,
  message: string,
) {
  const totalAvailable = candidates.reduce((sum, candidate) => sum + candidate.availableQuantity, 0);
  assert(totalAvailable >= quantity, message);
}
