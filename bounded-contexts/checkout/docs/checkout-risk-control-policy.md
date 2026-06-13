# Checkout Risk Control Policy

This document defines the #1131 fraud, abuse, inventory-hoarding, and risk
control policy for Milestone #17. The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-risk-control-policy.ts`.

Risk, fraud, abuse, inventory-hoarding, and provider-risk states stay simple:
they resolve in Buy Cart, Sell List, current checkout recovery, support, or an
owned risk status state. Checkout does not expose raw risk signals or repair
old checkout state to keep a customer moving.

## Control Rules

- Guest checkout remains available, but velocity, bot, duplicate-attempt, and
  final-confirmation checks can fail closed before any customer-committing side
  effect starts.
- Inventory hoarding and reservation abuse are handled in readiness. Checkout
  never assigns fulfillment, extends hidden holds, or repairs unassigned
  fulfillment during confirmation.
- Seller readiness, listing abuse, payout risk, and label/payout provider holds
  stay in Sell List readiness or owned hold states until the owning
  contexts clear them.
- Payment, payout, provider, wallet, identity, address, contact, and mismatch
  risk outcomes use customer-safe copy, support references, and redacted
  observability only.
- Blocked, held, challenged, disabled, deferred, unsupported, and
  provider-unavailable states require owner-scoped handling before they can
  affect checkout behavior.
- Risk blocks must prove no payment, order, sale, label, payout, settlement,
  notification, support, account-history, refund, void, or reversal side effect
  started.
- Fresh-state cleanup must prove risk handling cannot succeed through old
  routes, payload adapters, migration/backfill helpers, dual writes, hidden
  repair, stale fixtures, provider-dashboard-only fixes, or dense checkout
  fallback.

## Control Inventory

| Control | Owner | Checkpoints | Protected actions | Capability status | Surface | Customer-safe outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Guest velocity and bot protection | Checkout | cart-list-readiness, checkout-session-create, final-confirmation | buy-cart-line-capture, buy-checkout-session-create, buy-final-confirmation | enabled | cart-list-readiness | Guest buy velocity and bot limits block excessive line capture or checkout entry before any payment, order, support, notification, or reservation side effect starts. |
| Signed-in velocity and duplicate attempts | Checkout | checkout-session-create, duplicate-submit, final-confirmation | buy-checkout-session-create, buy-final-confirmation, sell-checkout-session-create, sell-final-confirmation | enabled | checkout-recovery | Signed-in duplicate submit and repeated confirmation attempts are idempotent and cannot create duplicate payments, orders, sales, labels, payouts, notifications, support requests, or reversal work. |
| Inventory hoarding and reservation limits | Inventory | cart-list-readiness, reservation-renew-or-expire, final-confirmation | buy-readiness-evaluation, inventory-reservation, buy-final-confirmation | owner-rule-required | cart-list-readiness | Reservation limits and expiration prevent supply starvation in readiness; checkout never assigns fulfillment, extends hidden holds, or repairs unassigned fulfillment during confirmation. |
| Payment provider risk decline or hold | Payments | provider-or-wallet-return, final-confirmation, operator-support | payment-authorization-or-capture, buy-final-confirmation, support-escalation | enabled | provider-return-recovery | Provider risk declines, holds, outages, and wallet return failures block or hold buy confirmation with customer-safe copy and no synthetic order/refund/reversal facts. |
| Payout provider risk hold | Settlement | cart-list-readiness, provider-or-wallet-return, final-confirmation, operator-support | sell-readiness-evaluation, payout-setup-or-eligibility, sell-final-confirmation | owner-rule-required | cart-list-readiness | Payout risk holds stay in Sell List readiness or owned hold states and cannot be bypassed by seller checkout confirmation. |
| Seller readiness and listing abuse | Marketplace | cart-list-readiness, checkout-session-create, final-confirmation | sell-list-line-capture, sell-readiness-evaluation, sell-final-confirmation | enabled | cart-list-readiness | Suspicious seller readiness, listing abuse, and offer-term risk stop in Sell List readiness before Marketplace handoff, fallback listing creation, sale, label, payout, notification, or account-history work starts. |
| Address, contact, payment, and payout mismatch | Identity | cart-list-readiness, active-session-return, provider-or-wallet-return, final-confirmation | buy-readiness-evaluation, sell-readiness-evaluation, payment-authorization-or-capture, payout-setup-or-eligibility | enabled | checkout-recovery | Identity and instrument mismatch outcomes use customer-safe recovery or hold states and never expose addresses, emails, provider payloads, card/bank data, or raw risk signals. |
| Active-session risk revalidation | Checkout | active-session-return, provider-or-wallet-return, final-confirmation | buy-final-confirmation, sell-final-confirmation | enabled | checkout-recovery | Existing sessions revalidate current account, source, economics, provider, inventory, and risk facts on return and final confirmation instead of repairing stale state inside checkout. |
| Guest merge abuse | Identity | guest-merge, active-session-return, final-confirmation | buy-checkout-session-create, buy-final-confirmation | enabled | checkout-recovery | Guest-to-signed-in merge supersedes stale guest sessions and blocks mismatched source facts before payment, order, notification, support, or account-history side effects. |
| Duplicate submit idempotency | Checkout | duplicate-submit, final-confirmation | buy-final-confirmation, sell-final-confirmation | enabled | confirmation-hold | Duplicate submit, reload, provider retry, and background retry share stable confirmation idempotency and cannot duplicate downstream work. |
| Support-safe risk escalation | Support | operator-support | support-escalation | enabled | support-runbook | Support can distinguish customer error from risk hold using masked status, support-safe references, and owning-context escalation without raw signals or manual data edits. |
| Owner rule risk states | Platform | cart-list-readiness, provider-or-wallet-return, final-confirmation, operator-support | buy-final-confirmation, sell-final-confirmation, payment-authorization-or-capture, payout-setup-or-eligibility, inventory-reservation | owner-rule-required | operations-status | Blocked, held, challenged, disabled, deferred, unsupported, and provider-unavailable risk states have owner, copy, support path, observability, and visual target coverage. |
| Observability redaction | Checkout | cart-list-readiness, active-session-return, provider-or-wallet-return, final-confirmation | buy-readiness-evaluation, sell-readiness-evaluation, payment-authorization-or-capture, payout-setup-or-eligibility, support-escalation | enabled | operations-status | Risk telemetry uses categories and support-safe references only; logs, metrics, canaries, and runbooks never expose raw addresses, emails, provider payloads, card/bank data, or sensitive risk signals. |
| No-side-effect risk blocks | Checkout | cart-list-readiness, checkout-session-create, final-confirmation | buy-final-confirmation, sell-final-confirmation, payment-authorization-or-capture, payout-setup-or-eligibility, inventory-reservation | enabled | checkout-recovery | Risk blocks prove no payment, order, sale, label, payout, settlement, notification, support, account-history, refund, void, or reversal side effect started. |
| Fresh-state risk cleanup | Platform | cart-list-readiness, checkout-session-create, final-confirmation, operator-support | buy-checkout-session-create, sell-checkout-session-create, buy-final-confirmation, sell-final-confirmation, support-escalation | enabled | operations-status | Fresh-state scans prove risk handling cannot succeed through old routes, payload adapters, migration/backfill helpers, dual writes, hidden repair, stale fixtures, or dense checkout fallback. |

## Remaining #1131 Work

- Add targeted checks for guest velocity, signed-in duplicate attempt,
  reservation abuse, provider risk decline/hold, payout risk hold, seller
  readiness abuse, mismatch recovery, guest merge abuse, and duplicate submit
  idempotency.
- Owner-scoped handling for blocked, held, challenged, disabled, deferred,
  unsupported, provider-unavailable, and manually-reviewable risk states.
- #1102 copy and #1112 visual mappings for every customer-visible block, hold,
  challenge, recovery, and support path.
- #1114 observability for categories, support-safe references, no-side-effect
  status, owner rules, and duplicate prevention without sensitive risk details.
- #1122 support handling that distinguishes customer error from risk hold
  without raw provider payloads, sensitive account data, or manual database
  edits.
- Fresh-state scans proving old checkout payloads, old sell executions, old
  receipt rows, migration/backfill helpers, hidden repair, stale fixtures,
  provider-dashboard-only recovery, and dense checkout fallback cannot satisfy
  risk controls.
