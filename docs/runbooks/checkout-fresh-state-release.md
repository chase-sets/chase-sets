# Checkout Fresh-State Release

This runbook covers Milestone #17 route and smoke validation for the Shopify-simple checkout rebuild. Chase Sets is unreleased, so this flow ships fresh-state only: no checkout rollout switch, disablement API, old route adapter, or dense checkout fallback.

## Route Validation

1. Confirm the fresh-state route map is deployed:
   - `/account/cart`
   - `/checkout/buy/readiness`
   - `/checkout/buy/session/:sessionId`
   - `/checkout/buy/session/:sessionId/confirmation`
   - `/account/sell-list`
   - `/checkout/sell/readiness`
   - `/checkout/sell/session/:sessionId`
   - `/checkout/sell/session/:sessionId/confirmation`
2. Confirm legacy customer routes are removed or hard-disabled:
   - `/checkout/start`
   - `/checkout/:sessionId`
   - `/checkout/concept` is deleted from customer route composition
3. Run the smoke validation below before public exposure.

## Smoke Validation

Run these checks against the shipped fresh-state routes:

- Ready Buy Cart can enter buy checkout.
- Buy Cart with unresolved fulfillment stays in cart or `/checkout/buy/readiness`.
- Buy checkout does not expose seller allocation or fulfillment assignment controls.
- Signed-in Sell List can enter sell readiness or sell checkout only after seller readiness passes.
- Guest Sell List cannot execute an anonymous payout flow.
- Sell checkout does not expose fallback listing handoff internals in the main form.
- Buy confirmation creates or links the expected order, payment, and account-history handoff records.
- Sell confirmation creates or links the expected sale, label, payout-readiness, and account-history handoff records.
- Payment-owned guest handoff remains accessible only for valid guest payment recovery.
- Legacy route probes are rejected, hard-disabled, or redirected to fresh recovery without compatibility adapters.

## Fresh-State Checks

- Items without assigned fulfillment do not enter checkout. They stay in Buy
  Cart, Sell List, or the conditional readiness step until assignment is
  resolved.
- Savings optimization happens before checkout session creation. The checkout
  session consumes the accepted or declined decision.
- No customer-committing side effects occur before final confirmation.
- Legacy dense checkout routes, old session adapters, and compatibility data do
  not make a fresh checkout succeed.

## Release Note Template

Use this release note when the feature moves environments:

> Enabled Shopify-simple checkout route strategy for Buy Cart and Sell List. Fresh checkout entry uses cart/list review, conditional readiness, namespaced buy/sell checkout sessions, and confirmation routes. Legacy dense checkout entry points remain disabled and are not used as customer fallback paths.
