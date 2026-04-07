import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  buildDemandSignature,
  normalizeMoneyAmount,
  numberToMoneyAmount,
  type ShippingOption,
  type VersionSelectionEntry,
} from "./common";

export type MarketplaceDemand = Readonly<{
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  quantity: number;
}>;

export type MarketplaceSupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: AccountId;
  inventoryRecordId: string;
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly VersionSelectionEntry[];
  versionSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  priceAmount: string;
  availableQuantity: number;
  updatedAt: string;
}>;

export type ShippingQuoteResult = Readonly<{
  shippingOption: ShippingOption;
  baseAmount: string;
  discountAmount: string;
  chargeAmount: string;
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

    const discountAmount =
      shippingOption === "standard"
        ? subtotal >= 50
          ? baseAmount
          : subtotal >= 25
            ? Math.min(baseAmount, 2.5)
            : 0
        : shippingOption === "expedited"
          ? subtotal >= 100
            ? Math.min(baseAmount, 5)
            : 0
          : 0;

    return {
      shippingOption,
      baseAmount: numberToMoneyAmount(baseAmount),
      discountAmount: numberToMoneyAmount(discountAmount),
      chargeAmount: numberToMoneyAmount(Math.max(0, baseAmount - discountAmount)),
    };
  },
};

export function tieBreakPlanKey(orderIds: readonly string[]) {
  return [...orderIds].sort().join("|");
}

export function demandKeyForLine(
  line: Pick<MarketplaceDemand, "catalogVersionKey">,
) {
  return buildDemandSignature(line.catalogVersionKey);
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

