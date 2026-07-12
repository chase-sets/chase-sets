import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId } from "@chase-sets/primitives/typed-ids";
import type { PackagePlan, ProductMeasureSnapshot } from "@chase-sets/product-measures";
import {
  assert,
  buildDemandSignature,
  normalizeMoneyAmount,
  numberToMoneyAmount,
  type ShippingOption,
  type VersionSelectedOptionEntry,
} from "./common";

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
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

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
      packagePlan?: PackagePlan;
    }>,
  ): ShippingQuoteResult;
}

export type OrderPaymentMethodCategory = "card" | "bank-account" | "platform-credit";

export type OrderPaymentDeadlinePolicyToken =
  | "ordering-payment-deadline-card-v1"
  | "ordering-payment-deadline-bank-account-v1"
  | "ordering-payment-deadline-platform-credit-v1"
  | "ordering-payment-deadline-terminal-failure-grace-v1";

export type OrderPaymentDeadlinePolicy = Readonly<{
  card: Readonly<{ token: "ordering-payment-deadline-card-v1"; durationMs: number }>;
  bankAccount: Readonly<{ token: "ordering-payment-deadline-bank-account-v1"; durationMs: number }>;
  platformCredit: Readonly<{ token: "ordering-payment-deadline-platform-credit-v1"; durationMs: number }>;
  terminalFailureGrace: Readonly<{
    token: "ordering-payment-deadline-terminal-failure-grace-v1";
    durationMs: number;
  }>;
}>;

export const defaultOrderPaymentDeadlinePolicy: OrderPaymentDeadlinePolicy = {
  card: { token: "ordering-payment-deadline-card-v1", durationMs: 60 * 60 * 1000 },
  bankAccount: { token: "ordering-payment-deadline-bank-account-v1", durationMs: 5 * 24 * 60 * 60 * 1000 },
  platformCredit: { token: "ordering-payment-deadline-platform-credit-v1", durationMs: 15 * 60 * 1000 },
  terminalFailureGrace: {
    token: "ordering-payment-deadline-terminal-failure-grace-v1",
    durationMs: 5 * 60 * 1000,
  },
};

export function normalizeOrderPaymentMethodCategory(paymentMethodCategory?: string | null): OrderPaymentMethodCategory {
  if (paymentMethodCategory === "bank-account" || paymentMethodCategory === "platform-credit") {
    return paymentMethodCategory;
  }

  return "card";
}

export function resolveOrderPaymentDeadlinePolicy(
  policy: OrderPaymentDeadlinePolicy,
  paymentMethodCategory?: string | null,
) {
  switch (normalizeOrderPaymentMethodCategory(paymentMethodCategory)) {
    case "bank-account":
      return policy.bankAccount;
    case "platform-credit":
      return policy.platformCredit;
    case "card":
      return policy.card;
  }
}

export function resolveOrderPaymentDeadline(
  pendingPaymentAt: string,
  paymentMethodCategory?: string | null,
  policy: OrderPaymentDeadlinePolicy = defaultOrderPaymentDeadlinePolicy,
) {
  const token = resolveOrderPaymentDeadlinePolicy(policy, paymentMethodCategory);
  const startedAtMs = Date.parse(pendingPaymentAt);
  assert(Number.isFinite(startedAtMs), "Payment deadline requires a valid pending-payment timestamp.");

  return {
    paymentDeadlineAt: new Date(startedAtMs + token.durationMs).toISOString(),
    paymentDeadlinePolicy: token.token,
  };
}

export function resolveTerminalPaymentFailureDeadline(
  failedAt: string,
  policy: OrderPaymentDeadlinePolicy = defaultOrderPaymentDeadlinePolicy,
) {
  const failedAtMs = Date.parse(failedAt);
  assert(Number.isFinite(failedAtMs), "Terminal payment failure grace requires a valid failure timestamp.");

  return {
    paymentDeadlineAt: new Date(failedAtMs + policy.terminalFailureGrace.durationMs).toISOString(),
    paymentDeadlinePolicy: policy.terminalFailureGrace.token,
  };
}

export const defaultShippingQuotePolicy: ShippingQuotePolicy = {
  quote({ shippingOption, itemSubtotalAmount, quantity, listingCount, packagePlan }) {
    const subtotal = Number.parseFloat(
      normalizeMoneyAmount(itemSubtotalAmount, {
        allowZero: true,
        fieldName: "Item subtotal",
      }),
    );
    if (packagePlan && packagePlan.packageCount > 0) {
      const baseAmount = packagePlan.packages.reduce((sum, pkg) => {
        if (pkg.mailpieceClass === "letter") {
          return sum + 1.49;
        }
        const perPackageBase = shippingOption === "priority" ? 9.99 : shippingOption === "expedited" ? 7.49 : 4.99;
        return sum + perPackageBase + Math.max(0, pkg.billableWeightOunces - 4) * 0.32;
      }, 0);

      return {
        shippingOption,
        baseAmount: numberToMoneyAmount(baseAmount),
        discountAmount: "0.00",
        chargeAmount: numberToMoneyAmount(baseAmount),
        packagePlan,
      };
    }

    const perOrderBase = shippingOption === "priority" ? 19.99 : shippingOption === "expedited" ? 9.99 : 4.99;
    const volumeSurcharge = Math.max(0, quantity - 1) * 0.35;
    const consolidationSurcharge = Math.max(0, listingCount - 1) * 0.5;
    const baseAmount = perOrderBase + volumeSurcharge + consolidationSurcharge;

    return {
      shippingOption,
      baseAmount: numberToMoneyAmount(baseAmount),
      discountAmount: "0.00",
      chargeAmount: numberToMoneyAmount(baseAmount),
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
