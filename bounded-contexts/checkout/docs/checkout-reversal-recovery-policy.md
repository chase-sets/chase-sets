# Checkout Reversal Recovery Policy

This document defines the #1165 cancellation, refund, void, reversal, and
adjustment recovery policy for Milestone #17. The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-reversal-recovery-policy.ts`.

Reversal recovery is fresh-state only. It starts from current Checkout
confirmation, Payments, Ordering, Fulfillment, Settlement, Notifications,
Account History, Support, provider callback, or owner-rule facts. It must
not void, refund, cancel, reverse, adjust, hold, notify, or correct a downstream
fact that the owning context has not committed.

## Reversal Rules

- Before confirmation, cancellation is no-side-effect recovery back to cart,
  Sell List, or readiness. It does not create refund, void, order cancellation,
  label cancellation, payout hold, settlement adjustment, notification, support,
  or account-history facts.
- If payment is authorized and order creation fails before capture, Payments
  owns an idempotent void or provider-delayed void state.
- If payment is captured and downstream commit fails, Payments owns the refund
  or partial refund effect. Failed or delayed refund states stay support-visible.
- Buyer self-service cancellation is Ordering-owned and available only while the
  Fulfillment-owned cancellation window is open. After the Fulfillment cutoff,
  cancellation requests move to Support.
- Inventory release follows Ordering cancellation/group facts. Checkout never
  releases inventory from old session payloads or stale read models.
- Tax, marketplace fee, wallet credit, promotion, gift-card, label-fee, payout,
  and settlement adjustments link to Payments or Settlement owner facts, or to a
  owner-rule deferral.
- Seller pending activity or Marketplace handoff recorded without committed
  downstream facts produces pending, deferred, or no-side-effect status. It does
  not create fake label, payout, settlement, notification, account-history, or
  reversal facts.
- Label cancellation and postage refund state comes from Fulfillment shipment,
  label, provider refund, and callback facts.
- Payout holds, payout reversals, wallet adjustments, dispute holds, hold
  releases, and payout failure reversals are Settlement-owned ledger facts.
- Notifications and account history show canceled, refunded, voided, reversed,
  adjusted, label-canceled, payout-held, or payout-reversed states only after
  the owning fact exists.
- Duplicate customer action, provider replay, background retry, and operator
  retry use stable idempotency keys and must not duplicate refunds, voids,
  cancellations, labels, payout holds, settlement rows, notifications, or
  account-history rows.
- Buyer returns, payment disputes, chargebacks, provider-initiated reversals,
  partial refunds, and unsupported provider capabilities must be explicitly
  supported, disabled, or deferred with customer-safe copy, visual target,
  support path, observability, support path, and no manual repair path.
- Support-approved operator recovery uses support permissions, audited owner
  actions, and support-safe references. Operators do not edit database rows or
  use provider dashboards as the source of truth.
- Fresh-state scans must prove old checkout routes, old payload adapters, old
  sell execution ids, old receipt rows, migration/backfill helpers, dual writes,
  hidden repair, manual database edits, stale fixtures, cached read models,
  provider-dashboard-only recovery, and dense checkout fallback cannot make
  reversal recovery succeed.

## Control Inventory

| Control | Owner | Checkpoints | Effects | States | Customer-safe outcome |
| --- | --- | --- | --- | --- | --- |
| Pre-confirmation cancel no-side-effect | Checkout | pre-confirmation, duplicate-submit | no-side-effect | supported, no-side-effect | Before confirmation, cancellation is simply returning to cart/list/readiness recovery with no payment, order, label, payout, settlement, notification, support, refund, void, reversal, or adjustment side effects. |
| Payment authorization void after order failure | Payments | payment-authorized, provider-callback, background-retry, operator-recovery | payment-void, notification-correction, account-history-correction | supported, pending, committed, failed, webhook-delayed, duplicate-suppressed | If authorization exists but order creation fails before capture, Payments owns an idempotent void or provider-delayed void state; Checkout cannot create an order or refund substitute. |
| Captured payment refund after commit failure | Payments | payment-captured, order-committed, provider-callback, operator-recovery | payment-refund, tax-fee-credit-adjustment, notification-correction, account-history-correction | supported, pending, committed, failed, partial, webhook-delayed, duplicate-suppressed | Captured payment recovery uses Payments-owned refund facts and refund-effect idempotency; partial, delayed, or failed refunds stay support-visible and cannot be hidden by checkout repair. |
| Self-service buy cancellation window | Ordering | order-committed, shipment-or-label-committed | order-cancel, payment-refund, inventory-release, notification-correction | supported, pending, committed, duplicate-suppressed | Buyer self-service cancellation is available only while Ordering and Fulfillment facts show the cancellation window is open; Payments refunds a captured payment idempotently after the Ordering cancellation fact exists. |
| Post-cutoff support cancel request | Support | order-committed, shipment-or-label-committed, operator-recovery, owner-rule | support-review, payment-refund, notification-correction, account-history-correction | support-only, pending, held, deferred, recovered | After Fulfillment closes the cancellation window, cancellation is Support-owned and may resolve to refund, no action, or review without direct Checkout cancellation or database repair. |
| Inventory reservation release | Ordering | order-committed, background-retry, operator-recovery | inventory-release, order-cancel, account-history-correction | supported, pending, committed, failed, duplicate-suppressed | Inventory or reservation release follows Ordering cancellation/group facts and is idempotent per order group; Checkout does not release inventory from stale session data. |
| Tax, fee, and credit adjustment | Payments | payment-captured, order-committed, provider-callback, operator-recovery | tax-fee-credit-adjustment, payment-refund, settlement-adjustment | supported, pending, committed, failed, partial, deferred | Tax, marketplace fee, wallet credit, promo, gift-card, label-fee, payout, and settlement adjustments link to Payments/Settlement owner facts or an owner-rule deferral. |
| Seller pending handoff no fake reversal | Checkout | seller-confirmation-recorded, marketplace-handoff-recorded, owner-rule | support-review, no-side-effect | pending, deferred, no-side-effect | When seller activity shows only confirmation or pending handoff, reversal records customer-safe pending/deferred/no-side-effect status and must not create fake label, payout, settlement, notification, or account-history correction facts. |
| Label cancellation and refund | Fulfillment | shipment-or-label-committed, provider-callback, background-retry, operator-recovery | label-cancel, label-refund, notification-correction, account-history-correction | supported, pending, committed, failed, webhook-delayed, duplicate-suppressed | Label cancellation and postage refund state comes from Fulfillment label/shipment/provider refund facts; failed or delayed provider refund remains support-visible and idempotent. |
| Payout hold and reversal | Settlement | payout-or-settlement-committed, provider-callback, background-retry, operator-recovery | payout-hold, payout-reversal, settlement-adjustment, notification-correction | supported, pending, committed, failed, held, webhook-delayed, duplicate-suppressed | Payout holds and reversals are Settlement-owned, provider-safe, and idempotent; Checkout cannot bypass payout readiness or expose bank/provider details. |
| Settlement reversal and wallet adjustment | Settlement | payout-or-settlement-committed, operator-recovery, provider-callback | settlement-adjustment, payout-reversal, payment-refund, tax-fee-credit-adjustment | supported, pending, committed, failed, partial, duplicate-suppressed | Seller refund debits, dispute holds, hold releases, payout failure reversals, and wallet adjustments are Settlement-owned ledger facts with exactly-once reversal records. |
| Notification and account-history correction | Notifications | order-committed, shipment-or-label-committed, payout-or-settlement-committed, background-retry | notification-correction, account-history-correction, support-review | supported, pending, committed, failed, duplicate-suppressed | Cancellation, refund, void, reversal, adjustment, label-canceled, payout-held, and payout-reversed copy appears in notifications and account history only after the owning fact exists. |
| Duplicate reversal prevention | Checkout | duplicate-submit, background-retry, provider-callback, operator-recovery | payment-void, payment-refund, order-cancel, label-cancel, payout-reversal, settlement-adjustment | supported, duplicate-suppressed, recovered, pending, committed | Duplicate customer action, provider replay, background retry, and operator retry all resolve to the same owner effect id without duplicate refunds, voids, labels, holds, payouts, notifications, or account-history rows. |
| Provider replay and webhook reconciliation | Payments | provider-callback, background-retry, operator-recovery | payment-void, payment-refund, label-refund, payout-reversal, dispute-hold | supported, webhook-delayed, failed, recovered, duplicate-suppressed | Provider refund, void, dispute, label refund, and payout webhook replay is signature-checked, metadata-correlated, redacted, and reconciled without duplicate owner effects. |
| Support-approved operator recovery | Support | operator-recovery, owner-rule | support-review, payment-refund, order-cancel, label-cancel, payout-hold, settlement-adjustment | support-only, pending, failed, recovered, held, deferred | Approved operator recovery uses support permissions, audited owner actions, support-safe references, and owner-rule deferrals; support never edits rows or uses provider dashboards as the source of truth. |
| Return, dispute, and chargeback owner rule status | Support | operator-recovery, provider-callback, owner-rule | support-review, payment-refund, dispute-hold, settlement-adjustment, notification-correction | support-only, disabled, deferred, unsupported, held, partial | Buyer returns, payment disputes, chargebacks, provider-initiated reversals, partial refunds, and unsupported provider capabilities are explicitly supported, disabled, or deferred with copy, visual, support, observability, and follow-up coverage. |
| Owner rule reversal states | Platform | owner-rule, operator-recovery | payment-void, payment-refund, order-cancel, label-cancel, payout-hold, payout-reversal, settlement-adjustment, support-review | support-only, disabled, deferred, unsupported, provider-outage, webhook-delayed, failed, held, partial, no-side-effect | Supported, disabled, deferred, unsupported, provider-outage, webhook-delayed, support-only, pending, failed, recovered, held, duplicate, partial, and no-side-effect reversal states have owner rules wherever they are customer-visible. |
| Observability redaction | Checkout | pre-confirmation, provider-callback, background-retry, operator-recovery, owner-rule | payment-void, payment-refund, order-cancel, label-cancel, payout-reversal, settlement-adjustment, notification-correction, account-history-correction | supported, pending, committed, failed, held, duplicate-suppressed, no-side-effect | Reversal telemetry reports owner, state, effect kind, duplicate-prevention outcome, support-safe reference, and owner-rule state without raw provider payloads, card data, bank data, addresses, or risk signals. |
| Fresh-state reversal cleanup | Platform | pre-confirmation, operator-recovery, owner-rule | no-side-effect, payment-void, payment-refund, order-cancel, label-cancel, payout-reversal, settlement-adjustment | supported, disabled, deferred, unsupported, no-side-effect | Fresh-state scans prove cancellation, refund, void, reversal, and adjustment paths cannot succeed through old routes, old payload adapters, old sell execution ids, old receipt rows, migrations, hidden repair, stale fixtures/read models, provider-dashboard-only recovery, or dense checkout fallback. |

## Remaining #1165 Work

- Payment authorization void, captured payment refund, duplicate refund
  prevention, provider refund/void webhook replay, and support-safe refund
  lookup are covered by executable policy and focused tests.
- Ordering and Fulfillment cover buyer self-service cancellation windows,
  post-cutoff support routing, order cancellation, inventory release, shipment
  cancellation, label cancellation, and label refund callback handling.
- Settlement covers seller refund debit, payout hold, payout reversal, payout
  failure reversal, dispute hold, hold release, and wallet adjustment
  idempotency.
- Notifications and account history cover canceled, refunded, voided, reversed,
  adjusted, label-canceled, payout-held, payout-reversed, pending, and failed
  states.
- Owner rules cover disabled, deferred, unsupported, provider-outage,
  webhook-delayed, support-only, held, partial, failed, and no-side-effect
  reversal states.
- #1102 copy and #1112 visual mappings for customer-visible cancellation,
  refund, void, reversal, adjustment, hold, support-only, disabled, deferred,
  pending, failed, recovered, and partial states.
- #1114 observability coverage proves redacted owner/status/effect telemetry,
  duplicate-prevention outcomes, support-safe references, and no raw provider
  payload, card, bank, address, or risk-signal exposure.
- #1122 support coverage proves operators can inspect or initiate only
  approved reversal actions through audited support flows, without manual
  database edits or provider-dashboard-only fixes.
- Fresh-state scans proving old checkout routes, old checkout payload adapters,
  old sell execution ids, old receipt rows, migration/backfill helpers, dual
  writes, hidden repair, stale fixtures, cached read models, provider-dashboard
  fixes, and dense checkout fallback cannot satisfy reversal recovery.
