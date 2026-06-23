import type { PostWriteHandoff } from "@chase-sets/http/responses";

export const ACCOUNT_CART_ADD_LINE_HANDOFF_KIND = "checkout.cart.add-line";

export const ACCOUNT_CART_ADD_LINE_HANDOFF = {
  kind: ACCOUNT_CART_ADD_LINE_HANDOFF_KIND,
  expectation: "collection-non-empty",
  surface: "account-cart",
} as const satisfies PostWriteHandoff;

export function isAccountCartAddLineHandoff(handoff: PostWriteHandoff) {
  return handoff.kind === ACCOUNT_CART_ADD_LINE_HANDOFF_KIND && handoff.expectation === "collection-non-empty";
}

export function isEmptyAccountCartAddLineHandoff(
  cart: Readonly<{ items: readonly unknown[]; count: number }>,
  handoff: PostWriteHandoff,
) {
  return isAccountCartAddLineHandoff(handoff) && cart.items.length === 0 && cart.count === 0;
}

function stringField(source: Record<string, unknown>, ...keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function sellerOptionListingId(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return stringField(value as Record<string, unknown>, "listing_id", "listingId");
}

function selectedListingIsWaitingForCheckoutSupply(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const line = value as Record<string, unknown>;
  const lockedListingId = stringField(line, "locked_listing_id", "lockedListingId");
  const selectedListingId = stringField(line, "selected_listing_id", "selectedListingId");
  if (!lockedListingId || selectedListingId !== lockedListingId) {
    return false;
  }

  const availabilityState = stringField(line, "availability_state", "availabilityState") ?? "available";
  if (availabilityState !== "available") {
    return false;
  }

  const sellerOptions = Array.isArray(line.seller_options)
    ? line.seller_options
    : Array.isArray(line.sellerOptions)
      ? line.sellerOptions
      : [];

  return (
    sellerOptions.length === 0 || !sellerOptions.some((option) => sellerOptionListingId(option) === lockedListingId)
  );
}

export function isPendingAccountCartAddLineHandoff(
  cart: Readonly<{ items: readonly unknown[]; count: number }>,
  handoff: PostWriteHandoff,
) {
  return (
    isAccountCartAddLineHandoff(handoff) &&
    (isEmptyAccountCartAddLineHandoff(cart, handoff) ||
      cart.items.some((item) => selectedListingIsWaitingForCheckoutSupply(item)))
  );
}
