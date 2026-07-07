export type CheckoutFulfillmentPreview = Readonly<{
  revision: string;
  optimizationGoal: "lowest-total" | "fewest-shipments";
  readyLineKeys: readonly string[];
  unavailableLineKeys: readonly string[];
  sellerGroups: readonly Readonly<{
    sellerAccountId: string;
    sellerDisplayName: string | null;
    itemSubtotalAmount: string;
    shippingChargeAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    postageRequirements: Readonly<{
      policyVersion: string;
      parcelRequired: boolean;
      parcelReasons: readonly string[];
      signatureRequired: boolean;
      signatureReasons: readonly string[];
      insuranceRequired: boolean;
      insuranceReasons: readonly string[];
      insuredValueAmount: string | null;
      shippingEvidenceTier: string;
    }>;
    deliveryEstimate: Readonly<{
      earliestDate: string;
      latestDate: string;
      minimumTransitDays: number;
      maximumTransitDays: number;
      handlingDays: number;
      packageCount: number;
      shipFromRegion: string;
      serviceLevel: string;
      promiseOwner: "fulfillment";
      promiseSource: "fulfillment-promise-policy";
      promiseConfidence: "estimated";
      cutoffTimeLocal: string;
      packingStartDate: string;
      carrierHandoffDate: string;
      basis: string;
    }>;
    lines: readonly Readonly<{
      lineKey: string;
      listingId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      productSummary: string | null;
      quantity: number;
      estimatedUnitPriceAmount: string;
      estimatedLineTotalAmount: string;
      priceState: "available" | "changed" | "unavailable" | "locked";
      materialChangeReasons: readonly string[];
    }>[];
  }>[];
  totals: Readonly<{
    itemSubtotalAmount: string;
    shippingAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    packageCount: number;
  }>;
  unavailableLines: readonly Readonly<{
    lineKey: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    productSummary: string | null;
    quantity: number;
    reason: string;
  }>[];
  materialChangeReasons: readonly string[];
}>;

export function readCheckoutFulfillmentPreview(value: unknown): CheckoutFulfillmentPreview | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<CheckoutFulfillmentPreview>;
  if (
    typeof candidate.revision !== "string" ||
    (candidate.optimizationGoal !== "lowest-total" && candidate.optimizationGoal !== "fewest-shipments") ||
    !Array.isArray(candidate.readyLineKeys) ||
    !Array.isArray(candidate.unavailableLineKeys) ||
    !Array.isArray(candidate.sellerGroups) ||
    !Array.isArray(candidate.unavailableLines) ||
    !Array.isArray(candidate.materialChangeReasons) ||
    !candidate.totals ||
    typeof candidate.totals !== "object"
  ) {
    return null;
  }

  return candidate as CheckoutFulfillmentPreview;
}
