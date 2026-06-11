# Checkout Launch Evidence Matrix

Milestone #17 uses this matrix to prove the Shopify-simple checkout as a composite launch system. It joins the deployed copy policy, image-first visual targets, and performance budgets into the row structure #1115 and #1116 need for current-main launch evidence.

The executable contract lives in `bounded-contexts/checkout/features/sessions/api/checkout-launch-evidence-matrix.ts`.

## Evidence Rules

- Unassigned fulfillment and optional savings optimization stay before checkout in Buy Cart or Sell List readiness.
- Checkout rows consume readiness decisions and current session facts; they do not repair fulfillment selection, seller eligibility, payout, label, provider, or old payload problems.
- Split group rows consume `checkout.cart-readiness.v1` fulfillment groups and Checkout `splitGroupHandoff` facts. They must prove checkout preserves stable group references without deriving, translating, or repairing fulfillment grouping inside the checkout form.
- Recovery rows must show customer-safe no-side-effect proof before Payments, Ordering, Fulfillment, Settlement, Notifications, Support, Marketplace handoff, reversal, or account-history side effects can start.
- Production proof-mode Buy Now readiness is a separate launch-governance row. Temporary recovery proves safe waiting behavior only; promotion still requires the proof canary to reach pay-ready checkout within the ready SLO, with failed `checkout-ready-slo-exceeded` artifacts attached to the projection runtime evidence trail.
- Post-confirmation rows distinguish pending downstream handoff from committed downstream facts. Checkout may show confirmation and support-safe references, but downstream contexts own order, sale, label, payout, settlement, notification, account-history, support, and reversal completion.
- Every row requires fresh-state cleanup proof so old routes, old payload adapters, compatibility shims, hidden repair, migration/backfill helpers, dual writes, stale fixtures, cached read models, provider sandbox leftovers, localization keys, docs, runbooks, canaries, smoke data, and browser artifacts cannot make launch flows succeed.

## Required Scenario States

The matrix covers normal, loading, slow-budget, active-session stale, blocked, production proof readiness, unassigned fulfillment, optimization available, optimization accepted, optimization declined, disabled capability, deferred capability, provider outage, risk hold, split group, pending downstream, committed downstream, notification, support, reconciliation, reversal recovery, kill switch, and fresh-state cleanup states.

## Matrix

| State | Scenarios | Copy surface | Visual target | Performance surface | Launch register | Evidence expectation |
| --- | --- | --- | --- | --- | --- | --- |
| Buy Cart review ready | normal | `cart-list-review` | `buy-cart-review-ready` | `cart-list-initial-render` | Not required | Buy Cart review shows mutable intent and no checkout repair machinery. |
| Buy readiness attention | blocked, unassigned-fulfillment | `readiness-unassigned-fulfillment` | `buy-readiness-unassigned-fulfillment` | `buy-cart-readiness-evaluation` | Required | Unassigned fulfillment is resolved or removed before checkout starts. |
| Buy readiness savings optimization | optimization-available, optimization-accepted, optimization-declined | `readiness-optimization-offer` | `buy-readiness-optimization` | `fulfillment-optimization-decision` | Not required | Accepted and declined savings decisions are recorded before checkout consumes readiness. |
| Guest Buy Checkout | normal | `checkout-review` | `guest-buy-checkout` | `checkout-entry-review-render` | Not required | Guest buy checkout renders form-first Shopify-simple review from current readiness only. |
| Signed-in Buy Checkout | normal | `checkout-saved-info-rows` | `signed-in-buy-checkout` | `mobile-sticky-action-interaction` | Not required | Signed-in buy checkout uses editable saved rows without stale account facts. |
| Sell List review ready | normal | `cart-list-review` | `sell-list-review-ready` | `cart-list-initial-render` | Not required | Sell List review shows seller intent before sale action commitment. |
| Sell List readiness blocked | blocked | `readiness-blocked-or-unavailable` | `sell-list-readiness-blocked` | `sell-list-readiness-evaluation` | Required | Seller eligibility, sale action, payout, label, and provider blockers stay in readiness. |
| Guest Sell Checkout | normal, deferred-capability | `checkout-review` | `guest-sell-checkout` | `checkout-entry-review-render` | Required | Guest sell checkout is launch-registered if seller account or payout setup is deferred. |
| Signed-in Sell Checkout | normal | `checkout-saved-info-rows` | `signed-in-sell-checkout` | `checkout-entry-review-render` | Not required | Signed-in sell checkout consumes seller readiness without rebuilding provider diagnostics. |
| Seller confirmation activity | pending-downstream | `seller-pending-activity` | `seller-confirmation-activity` | `final-confirmation-visible-state` | Required | Seller activity says confirmation is recorded without implying downstream completion. |
| Active-session stale recovery | active-session-stale, blocked | `active-session-stale-recovery` | `active-session-stale-recovery` | `active-session-reload` | Required | Reload, provider return, guest merge, and final submit revalidate source facts before side effects. |
| Address or serviceability failure | blocked | `address-correction` | `address-serviceability-failure` | `totals-refresh` | Required | Invalid address and serviceability failures stop checkout without hidden fulfillment repair. |
| Changed economics review | blocked | `economics-discount-credit-promo` | `changed-economics-review` | `totals-refresh` | Required | Changed price, tax, fee, promo, credit, or payout facts require review before confirmation. |
| Risk hold or provider-return failure | risk-hold, provider-outage, blocked | `risk-hold-or-block` | `risk-hold-provider-return-failure` | `provider-return-confirmation` | Required | Risk and provider-return failures are customer-safe and do not expose diagnostics. |
| Split package summary | split-group | `split-group-summary` | `split-group-summary` | `checkout-entry-review-render` | Required | Multi-group buy checkout consumes readiness-produced fulfillment groups, keeps one customer-facing confirmation action, and preserves stable group/support references without checkout-time regrouping. |
| Checkout unavailable | kill-switch | `kill-switch-disabled-checkout` | `kill-switch-checkout-unavailable` | `checkout-entry-permanent-recovery-render` | Required | Kill switches fail closed without restoring dense checkout or old payload adapters. |
| Temporary recovery loading | loading, slow-budget | `checkout-temporary-recovery` | `temporary-recovery-loading` | `checkout-entry-temporary-recovery-render` | Required | Slow but valid fresh-write paths show bounded recovery instead of ambiguous no-state UI. |
| Production proof Buy Now readiness | production-proof-readiness, slow-budget | `checkout-review` | `production-proof-buy-now-readiness` | `checkout-entry-review-render` | Required | Production proof-mode Buy Now must reach pay-ready checkout within the ready SLO; temporary recovery is safety evidence only, and `checkout-ready-slo-exceeded` artifacts remain launch blockers tied to projection runtime evidence. |
| Disabled accelerated or saved instrument | disabled-capability, deferred-capability | `accelerated-saved-instrument-fallback` | `disabled-accelerated-saved-instrument` | `payment-payout-setup-handoff` | Required | Accelerated, saved payment, and payout setup shortcuts cannot bypass readiness or final review. |
| Promo, credit, gift card, and fee state | deferred-capability, blocked | `economics-discount-credit-promo` | `promo-credit-gift-card-state` | `totals-refresh` | Required | Discount, credit, gift-card, promo, and fee support is explicit, disabled, or deferred. |
| Notification expectation and support reference | notification, support, pending-downstream | `notification-expectation` | `notification-support-reference` | `final-confirmation-visible-state` | Required | Notification expectation is support-safe and does not imply delivery before Notifications commits. |
| Account history handoff | committed-downstream, support | `account-history-handoff` | `account-history-handoff` | `account-history-handoff` | Required | Account history shows links only for committed downstream records and source references. |
| Reconciliation pending | reconciliation, pending-downstream | `account-history-handoff` | `reconciliation-pending` | `support-lookup` | Required | Reconciliation states remain support-safe and distinguish pending from committed records. |
| Reversal and adjustment recovery | reversal-recovery, support | `cancellation-refund-reversal` | `reversal-recovery-status` | `reversal-recovery-status-refresh` | Required | Refund, void, label cancellation, payout hold, and reversal status is audited and support-safe. |
| Fresh-state cleanup absence | fresh-state-cleanup, kill-switch | `fresh-state-localization-cleanup` | `fresh-state-cleanup-absence` | `checkout-entry-permanent-recovery-render` | Required | Fresh-state proof deletes or hard-disables old routes, payloads, shims, fixtures, docs, and runbooks. |

## Launch Consumption

#1115 should use this table as the acceptance matrix seed for E2E, visual, mobile, accessibility, localization, no-side-effect, no-compatibility, and measured performance evidence.

#1116 should use rows with a required launch register to attach owner, launch decision, customer-safe copy, support path, observability, expiration or follow-up, current-main no-side-effect proof, and fresh-state cleanup proof.

#1227, #1228, and #1237 should be linked from the production proof Buy Now readiness evidence when projection runtime, checkout readiness freshness, or proof-mode canary behavior affects whether the pay-ready SLO passed. A temporary recovery artifact can close safe-recovery work, but it cannot satisfy this promotion row unless the same production proof run also reaches checkout review within the ready SLO.
