# Checkout Economics Policy

This document defines the #1128 discounts, credits, gift cards, fees,
promotions, seller adjustments, payout estimates, and changed-economics policy
for Milestone #17. The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-economics-policy.ts`.

Economics handling stays simple: supported amounts appear in readiness or the
checkout summary before commitment, unsupported customer inputs stay outside
checkout until owner rules exist, and changed facts route to customer review
with no side effects. Checkout does not repair old payload totals, hide
recalculation, or continue with stale fee, tax, credit, payout, or promotion
facts.

## Economics Rules

- Buy payable totals use deterministic ordering: item subtotal, shipping, tax,
  marketplace checkout fee, discount, promo, gift card, wallet credit, payable
  total.
- Seller payout estimates use deterministic ordering: item subtotal, shipping
  allowance, marketplace sales fee, seller fee adjustment, label cost, seller
  payout.
- Buyer wallet credit is supported only through Settlement-owned available
  balance facts and Payments-owned application rules.
- Marketplace checkout fee is a Payments-owned quote and must be rejected when
  the confirmed fee quote fingerprint is stale.
- Seller marketplace sales fees come from Commercial Terms/Marketplace confirmed
  fee snapshots and are rejected when their quote fingerprint changes.
- Customer-entered promo codes stay out of checkout until Checkout owns the
  capability rule; unavailable promo entry is explicit before payment.
- Gift cards and store credit stay disabled until Payments owns issuance,
  redemption, refund, and reversal rules.
- Trusted confirmation and UCP headless completion reject customer-entered
  promo, coupon, discount, gift-card, and store-credit fields before shipping
  address persistence, order creation, payment creation, or downstream handoff.
- Optional fulfillment savings are accepted or declined in readiness. Checkout
  may show the outcome, but it does not run optimization, allocate fulfillment,
  or hide changed economics inside the form.
- Active sessions revalidate economics on render, return, wallet/provider
  return, saved-instrument edit, guest merge, duplicate submit, and final
  confirmation before side effects start.
- Changed, expired, invalid, exhausted, stale, disabled, deferred, unsupported,
  provider-unavailable, or risk-held economics states need customer-safe copy,
  visual target, support path, observability, owner rules, and fresh-state
  cleanup where customer-visible.
- Changed economics blocks must prove no payment, order, sale, label, payout,
  settlement, notification, support, account-history, refund, void, or reversal
  side effect started.
- Fresh-state cleanup must prove economics cannot succeed through old payload
  adapters, stale cached totals, hidden recalculation, migration/backfill
  helpers, stale fixtures, provider-dashboard-only fixes, or dense checkout
  fallback.

## Control Inventory

| Control | Owner | Checkpoints | Capability status | Components | Customer-safe outcome |
| --- | --- | --- | --- | --- | --- |
| Buy payable total ordering | Checkout | cart-list-readiness, checkout-render, final-confirmation | enabled | item-subtotal, shipping, tax, marketplace-checkout-fee, discount, promo, gift-card, wallet-credit, payable-total | Buy totals apply item subtotal, shipping, tax, marketplace checkout fee, discounts, promo, gift card, wallet credit, and payable total in a deterministic order before payment starts. |
| Seller payout estimate ordering | Checkout | cart-list-readiness, checkout-render, final-confirmation | enabled | item-subtotal, shipping, marketplace-sales-fee, seller-fee-adjustment, label-cost, seller-payout | Seller payout estimates apply item subtotal, shipping allowance, marketplace sales fee, seller adjustment, label cost, and estimated payout in a deterministic order before confirmation. |
| Buyer wallet credit application | Settlement | cart-list-readiness, checkout-render, provider-return, final-confirmation | enabled | wallet-credit, payable-total, refund, reversal | Buyer wallet credit uses Settlement-owned available balance facts and Payments-owned application rules; exhausted or changed credit requires review before payment. |
| Marketplace checkout fee quote | Payments | checkout-render, saved-instrument-edit, provider-return, final-confirmation | enabled | marketplace-checkout-fee, payable-total | Marketplace checkout fee is a Payments-owned quote shown before payment and rejected when the fee quote fingerprint is stale. |
| Promo code capability status | Checkout | cart-list-readiness, checkout-render, final-confirmation | owner-rule-required | promo, payable-total | Customer-entered promo codes stay out of checkout until Checkout owns the capability rule; unavailable promo entry is explicit before payment. |
| Gift card and store credit capability status | Payments | cart-list-readiness, checkout-render, final-confirmation | owner-rule-required | gift-card, payable-total, refund, reversal | Gift cards and store credit stay disabled until Payments owns issuance, redemption, refund, and reversal rules. |
| Supported discount revalidation | Checkout | cart-list-readiness, active-session-return, duplicate-submit, final-confirmation | enabled | discount, promo, payable-total | Supported discounts are represented in readiness or session snapshots and expire, change, or fail closed before payment or order side effects. |
| Seller sales fee snapshot | Commercial Terms | cart-list-readiness, checkout-render, final-confirmation | enabled | marketplace-sales-fee, seller-payout | Seller marketplace sales fee snapshots come from confirmed Commercial Terms/Marketplace facts and are rejected when the fee fingerprint changes. |
| Seller fee adjustment and payout deduction | Settlement | cart-list-readiness, checkout-render, final-confirmation, post-confirmation-reversal | enabled | seller-fee-adjustment, label-cost, seller-payout, reversal, adjustment | Seller adjustments, label costs, payout deductions, holds, and reversal-linked changes are visible before seller confirmation or routed to support-safe recovery. |
| Optional fulfillment optimization savings | Checkout | cart-list-readiness, checkout-session-create, final-confirmation | enabled | optional-fulfillment-savings, shipping, tax, payable-total | Optional savings are accepted or declined in readiness and checkout only displays the outcome without rerunning optimization or exposing allocation machinery. |
| Tax and shipping dependent refresh | Ordering | address-change, wallet-or-express-return, active-session-return, final-confirmation | enabled | shipping, tax, marketplace-checkout-fee, payable-total | Address, shipping, tax, fee, and payment quotes refresh together or route to customer review before payment/order work starts. |
| Active-session economics revalidation | Checkout | checkout-render, active-session-return, wallet-or-express-return, saved-instrument-edit, guest-merge, duplicate-submit, final-confirmation | enabled | item-subtotal, shipping, tax, marketplace-checkout-fee, discount, wallet-credit, seller-payout | Active sessions revalidate economics on render, return, wallet/provider return, saved-instrument edit, guest merge, duplicate submit, and final confirmation. |
| Changed economics no-side-effect recovery | Checkout | checkout-render, active-session-return, final-confirmation | enabled | discount, promo, gift-card, wallet-credit, marketplace-checkout-fee, seller-payout, payable-total | Changed economics recovery proves no payment, order, sale, label, payout, settlement, notification, support, account-history, refund, void, or reversal side effect started. |
| Reversal economics linkage | Payments | post-confirmation-reversal, operator-support | owner-rule-required | refund, void, reversal, adjustment, tax, marketplace-checkout-fee, wallet-credit, gift-card, label-cost, seller-payout | Refund, void, reversal, adjustment, tax, fee, credit, gift-card, label, and payout economics link to #1165 recovery facts and remain deferred until owner rules are enabled. |
| Support-safe economics failure | Support | operator-support | enabled | marketplace-checkout-fee, marketplace-sales-fee, discount, promo, gift-card, wallet-credit, seller-payout | Support sees masked economics category, owner, freshness status, and support-safe reference without raw provider payloads, cards, banks, or manual repair instructions. |
| Fresh-state economics cleanup | Platform | checkout-session-create, checkout-render, final-confirmation, operator-support | internal-only | discount, promo, gift-card, wallet-credit, payable-total, seller-payout | Fresh-state scans show economics cannot succeed through old payload adapters, stale cached totals, hidden recalculation, migration/backfill helpers, stale fixtures, or dense checkout fallback. |

## Remaining #1128 Work

- Runtime coverage for buy payable total ordering, seller payout
  estimate ordering, wallet credit application, marketplace checkout fee quote
  freshness, seller sales fee snapshot freshness, seller adjustment changes,
  active-session economics revalidation, changed economics recovery, and
  optional optimization accepted/declined states.
- Owner rules for promo codes, gift cards, store credit, reversal economics,
  provider-unavailable economics, disabled/deferred economics, exhausted
  credits, and unsupported customer-entered economics, with runtime coverage
  proving unsupported input fails closed before checkout side effects.
- #1102 copy and #1112 visual mappings for supported, changed, disabled,
  deferred, unavailable, exhausted, expired, invalid, risk-held, and
  no-side-effect economics states.
- #1114 observability proving category-only telemetry, support-safe references,
  freshness status, owner rule, duplicate prevention, and no raw provider
  payload, card, bank, or balance detail exposure.
- #1122 support coverage proving operators can identify the owner and safe next
  step for stale fee quote, exhausted credit, unavailable promo/gift-card,
  seller adjustment, payout estimate, refund, void, reversal, and adjustment
  economics without manual database edits.
- Fresh-state scans proving old payload adapters, stale cached totals, hidden
  recalculation, migration/backfill helpers, dual writes, stale fixtures,
  provider-dashboard-only recovery, and dense checkout fallback cannot satisfy
  economics checks.
