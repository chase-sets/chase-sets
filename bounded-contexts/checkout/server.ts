export { createCheckoutRequestApiClient } from "./support/request-support/api-client";
export type { CheckoutSessionRow } from "./support/request-support/api-client";
export { ACCOUNT_CART_ADD_LINE_HANDOFF } from "./support/request-support/account-cart-handoffs";
export { ACCOUNT_SELL_LIST_ADD_LINE_HANDOFF } from "./support/request-support/account-sell-list-handoffs";
export { createCheckoutUcpHandlers } from "./support/ucp-support/checkout";
export {
  appendAnonymousCartCookie,
  appendAnonymousSellListCookie,
  ensureAnonymousCartId,
  ensureAnonymousSellListId,
  readAnonymousCartId,
  readAnonymousSellListId,
} from "./support/request-support/guest-checkout";
/**
 * Checkout's own CSG-/CS-SL- support-reference lookup, for the unified
 * support-reference router, assembled in the `platform-api` composition
 * root behind Platform Operations' `supportReferenceLookupCrossContext`
 * host port -- Platform Operations never imports Checkout's domain code directly.
 */
export { lookupCheckoutSupportReference } from "./features/support-lookup/api/runtime";
export type { CheckoutSupportLookupResult } from "./features/support-lookup/api/runtime";
export { checkoutSeedIds } from "./support/seed-support/ids";
