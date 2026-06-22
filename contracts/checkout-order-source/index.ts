export type CheckoutSessionSourceType = "cart" | "buy-now" | "offer-intent";
export type CheckoutOrderCreationSourceType = Exclude<CheckoutSessionSourceType, "offer-intent">;

export type OrderingOrderSourceType = "cart-checkout" | "buy-now" | "offer-acceptance";
export type CheckoutOrderingSourceType = Extract<OrderingOrderSourceType, "cart-checkout" | "buy-now">;
export type MarketplaceOfferAcceptanceOrderingSourceType = Extract<OrderingOrderSourceType, "offer-acceptance">;

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
