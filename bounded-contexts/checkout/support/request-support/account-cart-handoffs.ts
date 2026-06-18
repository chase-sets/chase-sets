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

export function isPendingAccountCartAddLineHandoff(
  cart: Readonly<{ items: readonly unknown[]; count: number }>,
  handoff: PostWriteHandoff,
) {
  return isAccountCartAddLineHandoff(handoff) && cart.items.length === 0 && cart.count === 0;
}
