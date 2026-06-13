# Checkout Transactional Notification Policy

This document defines the #1129 notification trigger policy for Milestone #17.
The executable contract lives in
`bounded-contexts/checkout/features/sessions/api/checkout-transactional-notification-policy.ts`.

No transactional message is sent before explicit checkout confirmation or an
owning context commit. Checkout may record confirmation, pending downstream
handoff, and support-safe references, but Ordering, Payments, Fulfillment,
Settlement, Notifications, and Support own their own committed facts and
message delivery consequences.

## Launch Rules

- Pre-confirmation recovery never sends abandoned-checkout, old-link, old-session,
  or dense-checkout compatibility messages.
- Buy confirmation communication waits for Ordering and Payments facts.
- Sell confirmation recorded by Checkout is pending handoff evidence only until
  downstream owners commit sale, label, payout, settlement, notification, and
  account-history facts.
- Guest receipts use the order confirmation and support-safe lookup path.
  Account-claim links remain launch-disabled when not enabled.
- Missing contact fallback routes to account/support evidence, not old checkout
  recovery emails.
- Every sent transactional message needs source-owner idempotency and durable
  outbox duplicate-prevention evidence.
- Failed handoff communication is support-safe and must not synthesize completed
  downstream facts.

## Trigger Inventory

| Trigger | Source owner | Timing | Launch decision | Channels | Message types | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-confirmation recovery does not send | Checkout | before-confirmation | not-customer-facing | none | none | Recovery evidence proves no payment, order, sale, label, payout, settlement, notification, account-history, support, refund, void, or reversal side effect started. |
| Buyer order confirmation | Ordering | after-owning-context-commit | required-for-launch | transactional-email, notification-center | `ordering.order.created` | Order confirmation includes totals and support reference after Ordering commits the order; guest receipt uses contact email or web receipt lookup without old checkout links. |
| Buyer payment captured | Payments | after-owning-context-commit | required-for-launch | transactional-email | `payments.payment-captured` | Payment captured notification is idempotent by payment id and does not resend on confirmation page reload. |
| Buyer payment failed | Payments | failure-recovery | required-for-launch | transactional-email, support-evidence | `payments.payment-failed` | Payment failure communication is customer-safe, support-visible, and does not imply an order or refund exists unless Payments records it. |
| Guest receipt and account claim | Checkout | after-owning-context-commit | required-for-launch | transactional-email, support-evidence | `ordering.order.created` | Guest receipts use order confirmation and support-safe lookup; account claim/link behavior is launch-disabled if not enabled. |
| Seller confirmation recorded | Checkout | on-checkout-confirmation | launch-disabled | support-evidence | none | Checkout records seller confirmation and support reference, but does not send sale-complete copy before downstream owners commit sale, label, payout, settlement, notification, or account-history facts. |
| Seller sale committed | Settlement | after-owning-context-commit | launch-disabled | support-evidence | none | Seller sale communication needs owned launch status before public launch; until then account activity/support evidence must not imply completed downstream facts. |
| Label or shipping next step | Fulfillment | after-owning-context-commit | launch-disabled | support-evidence | none | Shipping next-step communication waits for Fulfillment-owned label/tracking facts and must handle split-group shipments without exposing seller allocation internals. |
| Downstream handoff failed | Checkout | failure-recovery | required-for-launch | support-evidence | none | Failed handoff communication is support-safe and routes to the owning context without synthesizing order, sale, label, payout, settlement, notification, or account-history completion. |
| Support request opened | Support | operator-support | required-for-launch | transactional-email, support-evidence | `support.support-request.opened` | Support request opened notification is tied to a support request id and an existing order source; pre-confirmation checkout recovery does not create fake support requests. |
| Support request resolved | Support | operator-support | required-for-launch | transactional-email, support-evidence | `support.support-request.resolved` | Support resolution notification waits for Support lifecycle evidence and downstream refund/hold facts where relevant. |
| Refund issued | Payments | after-owning-context-commit | required-for-launch | transactional-email, support-evidence | `payments.refund-issued` | Refund issued communication is idempotent by refund id and does not duplicate across provider webhook replay or support recovery. |
| Refund failed | Payments | failure-recovery | required-for-launch | transactional-email, support-evidence | `payments.refund-failed` | Refund failed communication is support-safe and does not claim refund completion before Payments records it. |
| Missing contact fallback | Checkout | failure-recovery | required-for-launch | support-evidence | none | Missing contact evidence routes to account/support surfaces and never falls back to old checkout recovery emails or raw provider/customer data. |
| Duplicate prevention | Notifications | after-owning-context-commit | required-for-launch | support-evidence | none | Launch checks cover reload, duplicate submit, job retry, provider webhook replay, and operator recovery without duplicate messages. |

## Evidence Required Before #1129 Closes

- Release run or staging evidence for buy order confirmation, payment
  captured, payment failed, refund issued, refund failed, support opened, and
  support resolved message idempotency.
- Explicit launch decisions for seller sale committed and label or shipping
  next-step communication while those remain deferred.
- Guest receipt behavior proving support-safe lookup and the account-claim
  launch decision.
- Missing contact fallback evidence.
- Duplicate-prevention evidence across reload, duplicate submit, job retry,
  provider webhook replay, and operator recovery.
- Observability for sent, failed, suppressed, and duplicate-prevented outcomes.
