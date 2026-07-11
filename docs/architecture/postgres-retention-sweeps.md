# Postgres Retention Sweeps

Retention is context-owned policy executed by shared platform machinery. A bounded-context module declares each sweep with a stable name, table, trusted predicate, ordering, interval, and batch limit. `platform-runtime` composes those declarations with shared event-store and notification-outbox policies and runs one maintenance runner through `platform_scheduled_runners`; no separate cron topology is required.

Every delete selects a bounded candidate batch with `FOR UPDATE SKIP LOCKED`, deletes only those rows, and commits before the next batch. One pass drains at most ten batches. A table failure is observed and isolated, `last_completed_at` remains unchanged, and that sweep retries on its next interval without terminating the worker.

## Windows

| Class | Window | Tables |
| --- | ---: | --- |
| Expired Auth secrets/session ephemera | 7 days after expiry | Auth sessions/lookups, magic links, phone codes, challenges, session/account-selection/guest tokens, social-login state, OAuth authorization codes |
| Shared terminal notification outbox | 30 days | `notification_outbox` rows in `sent`/`failed` |
| Provider webhook inbox/payload events | 90 days | Payments, Settlement, Notifications email/mobile, Fulfillment postage provider events |
| Provider/idempotency safety records | 90 days | Payments and Settlement provider keys, terminal payment-creation reservations, completed inventory adjustment keys |
| Terminal anonymous intents and claims | 30 days | Marketplace listing drafts, Discovery product-alert intents, released Ordering purchase-limit claims |
| Checkout JSONB session snapshots | 30 days after terminal update | Cancelled sessions or sessions with committed order IDs |
| Cache | At `stale_until` | Catalog provider option-query cache |
| Terminal background work | 30 days | Catalog alias recompute work, resolved/ignored projection poison rows, resolved blocked streams |
| Platform control history | Events 30 days; terminal operations 90 days; stale status snapshots 7 days | Projection operation events/operations and runner status snapshots |

Auth row deletion is the retention action required by the PII policy: expired magic-link and phone-code rows are removed, so a separate pass to null `delivery_token` or `delivery_code` is intentionally not added.

## Explicit exemptions

- `payments_saved_checkout_instrument_audit`: consent/security audit history requires an archive policy.
- `payments_reconciliation_runs`, `payments_provider_operations`, `payments_payment_pages`: money-relevant evidence is not deleted without an accounting archive decision.
- `settlement_reconciliation_runs`, `settlement_provider_operations`: payout/accounting evidence requires an archive policy.
- `fulfillment_postage_label_operations`: purchase/void reconciliation evidence requires an archive policy.
- `identity_invitations`: durable Identity history, not ephemeral Auth token data.
- `auth_identity_invitations`, `inventory_holds`, `marketplace_supply_holds`: mutable event projections that must remain present for later lifecycle events.
- `event_store_events`: the canonical event ledger remains permanent under its separate partitioning/retention decision.
- `pricing_market_trades` (the Trades Tape, #4303): permanent product/market data, not ephemeral request history -- explicitly out of scope for m84 #3625 sweeps.
- Platform lease, work-signal, post-write-token, realtime-lease, and UCP idempotency tables retain their purpose-built cleanup paths. Fencing tokens and UCP agent profiles are durable authorization/control state.

The structure gate scans new `expires_at`, terminal-state, and insert-only timestamped table shapes. A new candidate must appear in a context retention policy or receive a justified exemption; silent unbounded growth fails `check:structure`.
