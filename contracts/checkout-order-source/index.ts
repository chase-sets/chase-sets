export type CheckoutSessionSourceType = "cart" | "buy-now" | "offer-intent";
export type CheckoutOrderCreationSourceType = Exclude<CheckoutSessionSourceType, "offer-intent">;

export type OrderingOrderSourceType = "cart-checkout" | "buy-now" | "offer-acceptance";
export type CheckoutOrderingSourceType = Extract<OrderingOrderSourceType, "cart-checkout" | "buy-now">;
export type MarketplaceOfferAcceptanceOrderingSourceType = Extract<OrderingOrderSourceType, "offer-acceptance">;
export type CheckoutSourceContractMatrixSourceType =
  | "locked-listing-direct-buy-now"
  | "product-level-cart-line"
  | "accepted-offer"
  | "offer-intent"
  | "sell-list-selected-offer-line"
  | "sell-list-product-line";
export type CheckoutSourceContractOwner = "checkout" | "marketplace";
export type CheckoutSourceSessionReadinessPosture =
  | "requires-marketplace-locked-listing-before-session"
  | "requires-cart-readiness-before-session"
  | "accepted-offer-commits-through-marketplace"
  | "requires-marketplace-offer-submission-before-commitment"
  | "requires-sell-list-readiness-and-marketplace-offer-evidence"
  | "requires-sell-list-readiness-and-marketplace-listing-evidence";
export type CheckoutSourceOrderingPosture =
  | "checkout-session-confirmation"
  | "marketplace-accepted-offer"
  | "not-an-ordering-source"
  | "sell-list-readiness-only";

export type CheckoutSourceContractMatrixEntry = Readonly<{
  sourceType: CheckoutSourceContractMatrixSourceType;
  sourceOwner: CheckoutSourceContractOwner;
  checkoutSessionSource: CheckoutSessionSourceType | null;
  sessionReadinessPosture: CheckoutSourceSessionReadinessPosture;
  orderingOrderSource: OrderingOrderSourceType | null;
  orderingPosture: CheckoutSourceOrderingPosture;
}>;

export const checkoutSourceContractMatrix = {
  lockedListingBuyNow: {
    sourceType: "locked-listing-direct-buy-now",
    sourceOwner: "marketplace",
    checkoutSessionSource: "buy-now",
    sessionReadinessPosture: "requires-marketplace-locked-listing-before-session",
    orderingOrderSource: "buy-now",
    orderingPosture: "checkout-session-confirmation",
  },
  productLevelCartLine: {
    sourceType: "product-level-cart-line",
    sourceOwner: "checkout",
    checkoutSessionSource: "cart",
    sessionReadinessPosture: "requires-cart-readiness-before-session",
    orderingOrderSource: "cart-checkout",
    orderingPosture: "checkout-session-confirmation",
  },
  acceptedOffer: {
    sourceType: "accepted-offer",
    sourceOwner: "marketplace",
    checkoutSessionSource: null,
    sessionReadinessPosture: "accepted-offer-commits-through-marketplace",
    orderingOrderSource: "offer-acceptance",
    orderingPosture: "marketplace-accepted-offer",
  },
  offerIntent: {
    sourceType: "offer-intent",
    sourceOwner: "checkout",
    checkoutSessionSource: "offer-intent",
    sessionReadinessPosture: "requires-marketplace-offer-submission-before-commitment",
    orderingOrderSource: null,
    orderingPosture: "not-an-ordering-source",
  },
  sellListSelectedOfferLine: {
    sourceType: "sell-list-selected-offer-line",
    sourceOwner: "marketplace",
    checkoutSessionSource: null,
    sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-offer-evidence",
    orderingOrderSource: null,
    orderingPosture: "sell-list-readiness-only",
  },
  sellListProductLine: {
    sourceType: "sell-list-product-line",
    sourceOwner: "checkout",
    checkoutSessionSource: null,
    sessionReadinessPosture: "requires-sell-list-readiness-and-marketplace-listing-evidence",
    orderingOrderSource: null,
    orderingPosture: "sell-list-readiness-only",
  },
} as const satisfies Record<string, CheckoutSourceContractMatrixEntry>;

export const checkoutSourceContractMatrixSourceTypes = [
  "locked-listing-direct-buy-now",
  "product-level-cart-line",
  "accepted-offer",
  "offer-intent",
  "sell-list-selected-offer-line",
  "sell-list-product-line",
] as const satisfies readonly CheckoutSourceContractMatrixSourceType[];

export const checkoutOrderSourceContract = {
  cart: {
    checkoutSessionSource: "cart",
    orderingOrderSource: "cart-checkout",
    commitmentOwner: "checkout",
  },
  buyNow: {
    checkoutSessionSource: "buy-now",
    orderingOrderSource: "buy-now",
    commitmentOwner: "checkout",
  },
  offerIntent: {
    checkoutSessionSource: "offer-intent",
    orderingOrderSource: null,
    commitmentOwner: "marketplace-offer-acceptance",
  },
} as const satisfies Record<
  string,
  Readonly<{
    checkoutSessionSource: CheckoutSessionSourceType;
    orderingOrderSource: OrderingOrderSourceType | null;
    commitmentOwner: "checkout" | "marketplace-offer-acceptance";
  }>
>;

export const checkoutOrderCreationSources = [
  "cart",
  "buy-now",
] as const satisfies readonly CheckoutOrderCreationSourceType[];

const checkoutOrderCreationOrderingSources = {
  cart: "cart-checkout",
  "buy-now": "buy-now",
} as const satisfies Record<CheckoutOrderCreationSourceType, CheckoutOrderingSourceType>;

export function checkoutSessionSourceCreatesOrders(
  source: CheckoutSessionSourceType,
): source is CheckoutOrderCreationSourceType {
  return source === "cart" || source === "buy-now";
}

export function toOrderingSourceForCheckoutOrderCreation(
  source: CheckoutOrderCreationSourceType,
): CheckoutOrderingSourceType {
  return checkoutOrderCreationOrderingSources[source];
}

export function parseCheckoutOrderingSourceType(value: unknown): CheckoutOrderingSourceType {
  if (value === "cart-checkout" || value === "buy-now") {
    return value;
  }

  throw new Error("Ordering checkout source must be cart-checkout or buy-now.");
}
