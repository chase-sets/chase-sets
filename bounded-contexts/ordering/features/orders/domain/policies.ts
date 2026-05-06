import type { AccountId } from "@chase-sets/primitives/typed-ids";
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
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  availableQuantity: number;
  updatedAt: string;
}>;

export type ShippingQuoteResult = Readonly<{
  shippingOption: ShippingOption;
  baseAmount: string;
  discountAmount?: string;
  chargeAmount?: string;
}>;

export interface ShippingQuotePolicy {
  quote(params: Readonly<{
    sellerAccountId: string;
    shippingOption: ShippingOption;
    itemSubtotalAmount: string;
    quantity: number;
    listingCount: number;
  }>): ShippingQuoteResult;
}

export const defaultShippingQuotePolicy: ShippingQuotePolicy = {
  quote({ shippingOption, itemSubtotalAmount, quantity, listingCount }) {
    const subtotal = Number.parseFloat(
      normalizeMoneyAmount(itemSubtotalAmount, {
        allowZero: true,
        fieldName: "Item subtotal",
      }),
    );
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
