# Checkout Reconciliation Policy

This document defines the #1130 payment, order, label, payout, settlement,
notification, account-history, support, and reversal reconciliation policy for
Milestone #17. The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-reconciliation-policy.ts`.

Reconciliation answers one question: what facts actually exist now? Checkout can
explain readiness rejection, confirmation recorded, pending handoff, failed
handoff, and support-safe recovery, but it cannot invent completed downstream
facts. Payments, Ordering, Fulfillment, Settlement, Notifications, Marketplace,
Support, and Account History remain the owners of their committed records.

## Reconciliation Rules

- Items without fulfillment assignment stay in cart/list readiness or a
  conditional pre-checkout step. Checkout reconciles them as no-side-effect
  recovery and must not assign fulfillment, create labels, or start payment or
  order work.
- Optional fulfillment optimization may tell a customer they can save a specific
  amount before checkout. Reconciliation records only the accepted or declined
  readiness decision; checkout does not rerun optimization or expose allocation
  machinery.
- Pre-confirmation recovery proves no payment, order, sale, label, payout,
  settlement, notification, account-history, support, refund, void, reversal, or
  adjustment side effect started.
- Confirmation and handoff records are Checkout-owned source facts. They may show
  downstream pending, delayed, failed, deferred, held, recovered, or
  owner-action-required states, but downstream committed states require
  owning-context facts.
- Reconciliation can start from checkout confirmation id, payment handoff id,
  provider callback id, order/group id, seller confirmation id, reviewed
  line/action key, Marketplace handoff id, label id, payout/hold id, settlement
  id, notification id, account-history id, support-safe reference, or
  owner rule.
- Reload, duplicate submit, redirect return, provider webhook replay,
  background retry, and operator recovery share stable idempotency keys and
  return the current state instead of duplicating money movement, orders, labels,
  payouts, settlement, notifications, account-history, support, refunds, voids,
  reversals, or adjustments.
- Support lookup exposes owner, state, next action, idempotency outcome, and
  support-safe references only. It never exposes raw provider payloads, card
  data, bank data, address detail, or raw risk signals.
- Disabled, deferred, unsupported, provider-outage, stale active-session,
  split-group, pending downstream, missing downstream record, notification
  failure, support lookup, refund, void, reversal, adjustment, and no-side-effect
  states require owner rules when customer-visible.
- Fresh-state scans must prove old checkout payloads, old session payload
  adapters, old sell execution ids, old receipt rows, old migrations,
  migration/backfill helpers, dual writes, hidden repair, manual database edits,
  stale fixtures, cached read models, provider-dashboard-only fixes, and dense
  checkout fallback cannot make reconciliation succeed.

## Control Inventory

| Control | Owner | Boundary | Checkpoints | Effects | Customer-safe outcome |
| --- | --- | --- | --- | --- | --- |
| Pre-confirmation no-side-effect recovery | Checkout | before-checkout | cart-list-readiness, checkout-session-create, customer-reload, duplicate-submit | checkout-confirmation, payment, order, inventory-reservation, marketplace-handoff, label, payout, settlement, notification, account-history, support, refund, void, reversal | Stale, blocked, superseded, old-shaped, or missing readiness sessions route to cart/list recovery and prove no payment, order, sale, label, payout, settlement, notification, account-history, support, refund, void, or reversal fact was created. |
| Unassigned fulfillment readiness reconciliation | Checkout | before-checkout | cart-list-readiness, conditional-pre-checkout, owner-rule | checkout-confirmation, payment, order, inventory-reservation, label, payout, settlement | Items without fulfillment assignment stay in cart/list readiness or a conditional pre-checkout step; checkout can reconcile the rejection as a no-side-effect outcome and must not assign fulfillment, create labels, or start payment/order work. |
| Optional fulfillment optimization reconciliation | Checkout | before-checkout | cart-list-readiness, conditional-pre-checkout, checkout-session-create | checkout-confirmation, order, payment, inventory-reservation | Optional savings prompts happen before checkout. Reconciliation records only the accepted/declined readiness decision and rejects checkout-time re-optimization or hidden allocation repair. |
| Checkout confirmation handoff ledger | Checkout | checkout-confirmation | confirmation-handoff-recorded, customer-reload, background-retry | checkout-confirmation, marketplace-handoff, payment, order, label, payout, notification | Checkout confirmation is a ledger boundary that records the source, readiness version, handoff ids, downstream status, and support-safe reference without claiming downstream owner completion. |
| Payment capture and fee reconciliation | Payments | post-confirmation | provider-callback, redirect-return, background-retry, operator-recovery | payment, refund, void, adjustment | Payment, marketplace checkout fee, provider callback, refund, void, and adjustment state comes from Payments facts and can be retried or replayed without duplicate charges or synthetic payment completion. |
| Order creation and split-group reconciliation | Ordering | post-confirmation | confirmation-handoff-recorded, background-retry, downstream-owner-commit, operator-recovery | order, inventory-reservation, account-history, notification | A single customer confirmation may create multiple internal order or fulfillment groups, but reconciliation tracks each group from Ordering facts and cannot duplicate customer money movement or communication. |
| Seller Marketplace handoff reconciliation | Marketplace | post-confirmation | confirmation-handoff-recorded, background-retry, downstream-owner-commit, operator-recovery | checkout-confirmation, marketplace-handoff, label, payout, settlement, account-history | Seller confirmations reconcile from current confirmation, reviewed line/action keys, and Marketplace handoff facts; old sell execution ids or receipt rows cannot become sources of truth. |
| Label and fulfillment reconciliation | Fulfillment | post-confirmation | downstream-owner-commit, background-retry, operator-recovery, owner-rule | label, inventory-reservation, notification, account-history, reversal | Fulfillment label creation, retry, cancellation, and deferred states reconcile only from Fulfillment facts or support-safe pending records; Checkout never fabricates a label or assignment. |
| Payout and settlement reconciliation | Settlement | post-confirmation | downstream-owner-commit, provider-callback, background-retry, operator-recovery | payout, settlement, reversal, adjustment, account-history, notification | Payout setup, settlement, holds, reversals, and adjustment state comes from Settlement facts and provider-safe references without exposing bank data or duplicate payout attempts. |
| Notification delivery reconciliation | Notifications | post-confirmation | downstream-owner-commit, background-retry, operator-recovery | notification, support, account-history | Notification send, retry, failure, suppression, and support fallback use Notifications outbox/source-owner idempotency and cannot claim an order, sale, label, payout, or refund is complete. |
| Account history reconciliation | Account History | post-confirmation | confirmation-handoff-recorded, downstream-owner-commit, background-retry, customer-reload | account-history, checkout-confirmation, order, label, payout, settlement, support | Account history can show Checkout confirmation and pending activity, but committed order, sale, fulfillment, payout, settlement, notification, support, or reversal rows require owning-context records. |
| Duplicate submit and retry idempotency | Checkout | checkout-confirmation | duplicate-submit, customer-reload, redirect-return, background-retry, operator-recovery | checkout-confirmation, payment, order, marketplace-handoff, label, payout, settlement, notification, account-history, refund, void, reversal | Reload, duplicate submit, redirect return, background retry, and operator recovery reuse stable idempotency keys and return the existing current state instead of creating duplicate side effects. |
| Provider webhook replay reconciliation | Payments | post-confirmation | provider-callback, background-retry, operator-recovery | payment, payout, settlement, refund, void, reversal, adjustment, notification | Provider callback replay is signature-checked, metadata-correlated, redacted, and idempotent; missed or delayed callbacks reconcile from owning Payments or Settlement facts. |
| Operator recovery reconciliation | Support | operator-support | operator-recovery, owner-rule | support, payment, order, label, payout, settlement, notification, account-history, refund, void, reversal, adjustment | Operator recovery starts from support-safe references, shows owner and next action, audits every recovery command, and does not instruct support to edit data or infer completion. |
| Refund, void, reversal, and adjustment reconciliation | Payments | post-confirmation | provider-callback, downstream-owner-commit, background-retry, operator-recovery | refund, void, reversal, adjustment, payment, order, label, payout, settlement | Refunds, voids, reversals, label cancellations, payout holds, fee/tax/credit adjustments, and notification updates are idempotent and link to #1165 owner facts or owner-rule deferrals. |
| Pending downstream boundary | Checkout | post-confirmation | confirmation-handoff-recorded, customer-reload, background-retry, owner-rule | checkout-confirmation, order, label, payout, settlement, notification, account-history | Checkout may explain confirmation recorded and downstream pending, delayed, failed, deferred, or owner-action-required states, but it cannot synthesize completed downstream facts. |
| Support-safe reconciliation lookup | Support | operator-support | operator-recovery, customer-reload, background-retry | checkout-confirmation, payment, order, marketplace-handoff, label, payout, settlement, notification, account-history, refund, void, reversal | Support lookup can start from any customer-safe reference and resolve the current owner/status while masking provider payloads, address detail, card data, bank data, and raw risk signals. |
| Owner rule reconciliation states | Platform | operations-status | owner-rule, operator-recovery | checkout-confirmation, payment, order, label, payout, settlement, notification, account-history, refund, void, reversal, adjustment | Disabled, deferred, unsupported, provider-outage, stale active-session, split-group, pending downstream, missing downstream, notification failure, support lookup, refund, void, reversal, adjustment, and no-side-effect states require owner rules. |
| Observability redaction | Checkout | operations-status | cart-list-readiness, confirmation-handoff-recorded, provider-callback, background-retry, operator-recovery | checkout-confirmation, payment, order, label, payout, settlement, notification, account-history, refund, void, reversal | Telemetry uses owner, state, effect, idempotency outcome, support-safe reference, and redacted source type only; it never logs raw provider payloads, addresses, cards, banks, or risk signals. |
| Fresh-state reconciliation cleanup | Platform | operations-status | cart-list-readiness, checkout-session-create, operator-recovery, owner-rule | checkout-confirmation, payment, order, marketplace-handoff, label, payout, settlement, notification, account-history, support, refund, void, reversal, adjustment | Fresh-state scans show stale fixtures, cached read models, provider sandbox leftovers, dual writes, migration/backfill helpers, old receipt fallback reads, old session payloads, manual database repair, and dense checkout fallback cannot make reconciliation succeed. |

## Remaining #1130 Work

- Runtime coverage for duplicate submit, reload, redirect return, provider
  callback replay, missed callback recovery, background retry, operator
  recovery, and support lookup.
- Runtime coverage for buy reconciliation: payment handoff, payment
  capture/failure, order/group creation, split-group partial failure,
  notification send/failure, account-history handoff, refund, void, and
  adjustment paths.
- Runtime coverage for sell reconciliation: seller confirmation, reviewed
  line/action key, Marketplace handoff, label creation/failure, payout
  setup/hold, settlement, notification, account-history, support lookup, and
  reversal paths.
- Owner-rule rows for disabled, deferred, unsupported, provider-outage,
  stale active-session, split-group, pending downstream, missing downstream,
  notification failure, support lookup, refund, void, reversal, adjustment, and
  no-side-effect states.
- #1102 copy and #1112 visual mappings for customer-visible pending,
  committed, failed, held, recovered, reversed, deferred, unsupported,
  provider-outage, and support states.
- #1114 observability proving owner/status/idempotency telemetry, support-safe
  references, redaction, owner-rule outcomes, and no raw provider payload,
  card, bank, address, or risk-signal exposure.
- #1122 support coverage proving operators can start from support-safe
  references and determine owner, state, safe next step, and audited recovery
  without manual database edits.
- Fresh-state scans proving old checkout payloads, old session payload adapters,
  old sell execution ids, old receipt rows, stale fixtures, cached read models,
  provider sandbox leftovers, migration/backfill helpers, dual writes, hidden
  repair, manual database repair, provider-dashboard-only fixes, and dense
  checkout fallback cannot satisfy reconciliation.
