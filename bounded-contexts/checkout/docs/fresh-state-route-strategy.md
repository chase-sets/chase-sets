# Fresh-State Route Strategy

Milestone #17 uses this route strategy for the Shopify-simple Buy Cart and Sell List checkout rebuild. Chase Sets has not launched, so this is a fresh-state route map, not a compatibility migration.

## Route Map

| Surface | Route ID | Route path | Owner | Unresolved fulfillment allowed |
| --- | --- | --- | --- | --- |
| Buy Cart review | `account-cart` | `/account/cart` | Checkout | Yes |
| Buy readiness | `buy-checkout-readiness` | `/checkout/buy/readiness` | Checkout | Yes |
| Buy checkout | `buy-checkout-session` | `/checkout/buy/session/:sessionId` | Checkout | No |
| Buy confirmation | `buy-checkout-confirmation` | `/checkout/buy/session/:sessionId/confirmation` | Checkout | No |
| Sell List review | `account-sell-list` | `/account/sell-list` | Checkout | Yes |
| Sell readiness | `sell-checkout-readiness` | `/checkout/sell/readiness` | Checkout | Yes |
| Sell checkout | `sell-checkout-session` | `/checkout/sell/session/:sessionId` | Checkout | No |
| Sell confirmation | `sell-checkout-confirmation` | `/checkout/sell/session/:sessionId/confirmation` | Checkout | No |

The `checkout/buy/session/:sessionId` and `checkout/sell/session/:sessionId` namespaces avoid the broad `checkout/:sessionId` dynamic segment. Static readiness routes cannot be captured as session IDs, and buy/sell routes cannot collide with each other.

## Legacy Disposition

| Legacy route ID | Legacy path | Disposition | Replacement |
| --- | --- | --- | --- |
| `checkout-start` | `/checkout/start` | Remove before launch | `buy-checkout-readiness` for cart and buy-now entry; sell flows start from Sell List readiness |
| `checkout-session` | `/checkout/:sessionId` | Hard-disable before launch | `buy-checkout-session` or `sell-checkout-session`, depending on mode |
| `checkout-concept` | `/checkout/concept` | Removed from the customer route manifest | None |

There is no customer-facing old/new switch, old checkout URL support, old session adapter, or stale dense checkout compatibility route.

## Fulfillment Guardrail

Checkout forms accept only checkout-ready sessions. If any line lacks an assigned fulfillment path or is otherwise unresolved:

1. Keep the user in Buy Cart or Sell List, or send them to the matching readiness route.
2. Show customer-level actions such as remove, keep for later, accept an allocation, or continue with ready lines only.
3. Show optional savings when a different fulfillment allocation materially lowers the total.
4. Create or resume the checkout session only after the chosen line set is checkout-ready.

Checkout may show the resulting delivery promise and total impact, but it must not resolve seller allocation or fulfillment assignment inside the main checkout form.

## Kill Switch

Use Platform Operations release controls with feature key `checkout.shopify-simple`.

When disabled:

- Buy entry redirects to `/account/cart?checkout=disabled`.
- Sell entry redirects to `/account/sell-list?checkout=disabled`.
- Cart and Sell List remain reachable so customers can review or remove intent.
- The old dense checkout is not restored as a fallback path.

The kill switch is for operational disablement and smoke validation. It is not a public rollout selector between old and new checkout experiences.

## Route Test Expectations

Route tests must prove:

- the fresh-state route map has no dynamic collisions
- no fresh customer checkout route uses `checkout/:sessionId`
- unresolved fulfillment is accepted only by cart/list and readiness routes
- checkout and confirmation routes require checkout-ready sessions
- legacy checkout paths are removed or hard-disabled, with the deleted concept route absent from customer route composition
- disabling `checkout.shopify-simple` redirects to cart/list without restoring legacy checkout

## Implementation Order

1. Ship the route strategy contract and tests.
2. Build readiness routes before replacing checkout forms.
3. Replace buy checkout and sell checkout under the namespaced route paths.
4. Remove legacy route modules or hard-disable legacy session entry, then update route composition tests.
5. Update runbooks and release notes with activation, disablement, and smoke validation steps.
