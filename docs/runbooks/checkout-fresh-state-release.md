# Checkout Fresh-State Release

This runbook covers Milestone #17 route activation, disablement, and smoke validation for the Shopify-simple checkout rebuild.

## Feature Key

Use Platform Operations release controls with feature key `checkout.shopify-simple`.
Use the marketplace runtime variable `CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE=true` when all customer traffic, including anonymous cart/list traffic, must fail closed immediately.

The kill switches disable fresh checkout entry. They must not restore legacy dense checkout routes or old session compatibility.

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
2. Confirm legacy customer routes are removed or hard-disabled:
   - `/checkout/start`
   - `/checkout/:sessionId`
   - `/checkout/concept` is deleted from customer route composition
3. Set `checkout.shopify-simple` to enabled for the target environment and subject set.
4. Run the smoke validation below before expanding exposure.

## Disablement

1. Set `checkout.shopify-simple` to disabled through Platform Operations release controls for signed-in rollout disablement.
2. Set `CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE=true` when anonymous, guest, and signed-in checkout entry must all fail closed.
3. Confirm buy checkout entry and active buy sessions redirect to `/account/cart?checkout=disabled`.
4. Confirm sell checkout entry and active sell sessions redirect to `/account/sell-list?checkout=disabled`.
5. Confirm cart and Sell List remain reachable for review, removal, fulfillment resolution, or save-for-later actions.
6. Confirm disabled entry does not redirect to `/checkout/start`, `/checkout/:sessionId`, the deleted `/checkout/concept` route, or any dense legacy checkout path.
7. Confirm `checkout.launch.kill_switch_unavailable` telemetry remains bounded to entry source, actor mode, scenario state, visible state, side-effect status, launch-register decision, fresh-state scan result, and release run only.

## Smoke Validation

Run these checks after activation and after disablement:

- Ready Buy Cart can enter buy checkout.
- Buy Cart with unresolved fulfillment stays in cart or `/checkout/buy/readiness`.
- Buy checkout does not expose seller allocation or fulfillment assignment controls.
- Signed-in Sell List can enter sell readiness or sell checkout only after seller readiness passes.
- Guest Sell List cannot execute an anonymous payout flow.
- Sell checkout does not expose fallback listing handoff internals in the main form.
- Buy confirmation creates or links the expected order, payment, and account-history handoff records.
- Sell confirmation creates or links the expected sale, label, payout-readiness, and account-history handoff records.
- Payment-owned guest handoff remains accessible only for valid guest payment recovery.
- Kill-switched buy and sell entry returns to cart/list recovery and emits `checkout.launch.kill_switch_unavailable` without payment, order, label, payout, notification, account-history, support, sale, or listing side effects.
- Legacy route probes are rejected, hard-disabled, or redirected to fresh recovery without compatibility adapters.

## Launch Evidence Gate

Before public production promotion, create a Checkout-owned `gates.checkoutLaunchEvidence` record and pass it through the [Marketplace Launch Evidence](./marketplace-launch-evidence.md) packet. The gate is approved only when the current release commit has fresh proof for buy-now, Buy Cart readiness, and Sell List readiness; guest and signed-in actors; desktop and mobile; visual snapshots; accessibility; E2E coverage; observability; support handoff; security posture; and kill-switch fail-closed behavior.

Items without assigned fulfillment do not enter checkout. They stay in Buy Cart, Sell List, or the conditional readiness step until assignment is resolved. A savings optimization prompt may tell the customer they can save by switching fulfillment, but that decision also happens before checkout session creation. Checkout evidence must prove no customer-committing side effects occur before confirmation and no legacy dense checkout routes, adapters, or compatibility data remain in the fresh-state path.

## Release Note Template

Use this release note when the feature moves environments:

> Enabled Shopify-simple checkout route strategy for Buy Cart and Sell List. Fresh checkout entry uses cart/list review, conditional readiness, namespaced buy/sell checkout sessions, and confirmation routes. Legacy dense checkout entry points remain disabled and are not used as customer fallback paths.
