import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
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
  catalogItemId: string;
  productId: string;
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
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly VersionSelectedOptionEntry[];
  productSummary: string | null;
  productMeasureSnapshot: ProductMeasureSnapshot | null;
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
  availableQuantity: number;
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
  updatedAt: string;
}>;

export type ShippingQuoteResult = Readonly<{
  shippingOption: ShippingOption;
  baseAmount: string;
  discountAmount?: string;
  chargeAmount?: string;
  packagePlan?: PackagePlan;
}>;

export interface ShippingQuotePolicy {
  quote(params: Readonly<{
    sellerAccountId: string;
    shippingOption: ShippingOption;
    itemSubtotalAmount: string;
    quantity: number;
    listingCount: number;
    packagePlan?: PackagePlan;
  }>): ShippingQuoteResult;
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
        const perPackageBase =
          shippingOption === "priority"
            ? 9.99
            : shippingOption === "expedited"
              ? 7.49
              : 4.99;
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

    const perOrderBase =
      shippingOption === "priority"
        ? 19.99
        : shippingOption === "expedited"
          ? 9.99
          : 4.99;
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

export function demandKeyForLine(
  line: Pick<MarketplaceDemand, "productId">,
) {
  return buildDemandSignature(line.productId);
}

export function assertSupplyAvailable(
  candidates: readonly MarketplaceSupplyCandidate[],
  quantity: number,
  message: string,
) {
  const totalAvailable = candidates.reduce(
    (sum, candidate) => sum + candidate.availableQuantity,
    0,
  );
  assert(totalAvailable >= quantity, message);
}
