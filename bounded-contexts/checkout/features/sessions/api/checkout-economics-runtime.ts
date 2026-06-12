import { CheckoutDomainError } from "../../../support/runtime-support/common";

export const unsupportedCustomerEconomicsInputKeys = [
  "promoCode",
  "promo_code",
  "promotionCode",
  "promotion_code",
  "couponCode",
  "coupon_code",
  "discountCode",
  "discount_code",
  "giftCardCode",
  "gift_card_code",
  "storeCreditCode",
  "store_credit_code",
] as const;

export const unsupportedCustomerEconomicsInputCode = "checkout_economics_unsupported" as const;
export const unsupportedCustomerEconomicsInputMessage =
  "Promo codes, gift cards, and store credit are not available in launch checkout.";

export function findUnsupportedCustomerEconomicsInput(body: unknown): string | null {
  const source = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  return unsupportedCustomerEconomicsInputKeys.find((key) => hasCustomerProvidedValue(source[key])) ?? null;
}

export function assertNoUnsupportedCustomerEconomicsInput(body: unknown): void {
  if (findUnsupportedCustomerEconomicsInput(body)) {
    throw new CheckoutDomainError(unsupportedCustomerEconomicsInputMessage, unsupportedCustomerEconomicsInputCode);
  }
}

function hasCustomerProvidedValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }

  return true;
}
