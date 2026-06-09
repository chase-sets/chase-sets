# Checkout Fresh-State Release

This runbook covers Milestone #17 route activation, disablement, and smoke validation for the Shopify-simple checkout rebuild.

## Feature Key

Use Platform Operations release controls with feature key `checkout.shopify-simple`.

The kill switch disables fresh checkout entry. It must not restore legacy dense checkout routes or old session compatibility.

## Activation

1. Confirm the fresh-state route map is deployed:
   - `/account/cart`
   - `/checkout/buy/readiness`
   - `/checkout/buy/session/:sessionId`
   - `/checkout/buy/session/:sessionId/confirmation`
   - `/account/sell-list`
   - `/checkout/sell/readiness`
   - `/checkout/sell/session/:sessionId`
   - `/checkout/sell/session/:sessionId/confirmation`
2. Confirm legacy customer routes are removed, hard-disabled, or internal-only:
   - `/checkout/start`
   - `/checkout/:sessionId`
   - `/checkout/concept`
3. Set `checkout.shopify-simple` to enabled for the target environment and subject set.
4. Run the smoke validation below before expanding exposure.

## Disablement

1. Set `checkout.shopify-simple` to disabled through Platform Operations release controls.
2. Confirm buy checkout entry redirects to `/account/cart?checkout=disabled`.
3. Confirm sell checkout entry redirects to `/account/sell-list?checkout=disabled`.
4. Confirm cart and Sell List remain reachable for review, removal, or save-for-later actions.
5. Confirm disabled entry does not redirect to `/checkout/start`, `/checkout/:sessionId`, `/checkout/concept`, or any dense legacy checkout path.

## Smoke Validation

Run these checks after activation and after disablement:

- Ready Buy Cart can enter buy checkout.
- Buy Cart with unresolved fulfillment stays in cart or `/checkout/buy/readiness`.
- Buy checkout does not expose seller allocation or fulfillment assignment controls.
- Signed-in Sell List can enter sell readiness or sell checkout only after seller readiness passes.
- Guest Sell List cannot execute an anonymous payout flow.
- Sell checkout does not expose fallback listing execution internals in the main form.
- Buy confirmation creates or links the expected order, payment, and account-history handoff records.
- Sell confirmation creates or links the expected sale, label, payout-readiness, and account-history handoff records.
- Payment-owned guest handoff remains accessible only for valid guest payment recovery.
- Legacy route probes are rejected, hard-disabled, or redirected to fresh recovery without compatibility adapters.

## Release Note Template

Use this release note when the feature moves environments:

> Enabled Shopify-simple checkout route strategy for Buy Cart and Sell List. Fresh checkout entry uses cart/list review, conditional readiness, namespaced buy/sell checkout sessions, and confirmation routes. Legacy dense checkout entry points remain disabled and are not used as customer fallback paths.
