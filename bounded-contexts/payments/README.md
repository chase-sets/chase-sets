# Payments Bounded Context

## Purpose

Payments owns money movement with external payment rails and buyer-facing charges and refunds.

## Owns

- Payment intent and authorization
- Capture
- Refund
- Payment processor references
- Marketplace checkout fee quotes and payment snapshots
- Marketplace sales fee snapshots supplied by Ordering
- Shipping rebate calculation inputs at checkout and refund time
- Buyer-paid share refunds for self-service purchase cancellation

Buyer marketplace checkout fee policy is documented in [Marketplace Checkout Fee Policy](./docs/marketplace-checkout-fee-policy.md).

## Does Not Own

- Internal seller balance ledger
- Payout scheduling
- Order line modeling

## Ubiquitous Language

Payments terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Payment
- Refund
- Payment Reconciliation Attempt

## Incoming Dependencies

- Ordering for order references and frozen seller economics snapshots
- Fulfillment for issue signals that justify refunds

## Operations

Stripe runtime configuration, webhook setup, smoke tests, and incident workflows live in [Money Operations](../../docs/runbooks/money-operations.md).

### Card-Decline Admission

`POST /api/marketplace/account/payments` and `POST /api/marketplace/account/checkout/recover`
share the `payments.card-decline.fingerprint` window across Payments replicas and restarts.
The default is five declines per hour, with the existing rate-limit environment overrides.
The window starts at the first recorded decline, not a wall-clock boundary. Attempts already
in flight are not cancelled; unknown or blank fingerprints retain their existing behavior.

A known fingerprint at the limit returns the existing `429 rate_limited` response and
`Retry-After` header. If shared admission storage cannot be read, both endpoints return
`503` with `error.code = payment_decline_limit_unavailable`; no new provider call is made.
Other validation errors remain `400`.

Parsed card-failure webhooks commit a receipt keyed by processor and event ID together with
the fingerprint counter before payment handling. Matching retries resume payment handling
without another increment; conflicting facts fail without acknowledging the webhook.
The existing transactional inbox completes with payment handling, never at counter commit.
Reconciliation does not record declines. Counters store one-way fingerprint digests; receipts
store one-way fact digests, not provider payloads. Neither digest is logged.

Startup installs additive, ledgered tables. Each distinct recorded decline removes at most
100 expired counters through the expiry index. Receipts remain durable so late retries cannot
be counted again; cleanup never deletes active windows. No cache infrastructure or local
counter fallback is used.

## Outgoing Integration Events

- `PaymentAuthorized`
- `PaymentCaptured`
- `PaymentFailed`
- `RefundIssued`
- `RefundFailed`
- `PaymentReconciliationRecorded`

## Invariants

1. Payments owns PSP-facing state and references.
2. External money movement and internal balance accounting are separate models.
3. Payments determines whether a buyer was charged or refunded successfully.
4. Payments may carry marketplace checkout fees and rebate inputs, but Settlement owns ledger postings.
5. Self-service purchase cancellation refunds include the cancelled order total plus the allocated Marketplace Checkout Fee.

## Tests

Run `pnpm --filter @chase-sets/payments run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/payments run test` before opening a PR.

## Platform-Covered Resolutions

For platform-covered resolutions (epic #5210), Payments executes the authorized refund
exactly once and carries the remedy, coverage, and allocation references through to
Settlement — it never decides who pays. It owns `refundId`; the refund idempotency key
derives from stable domain ids (`remedyId`/`coverageId`), not request timing. Ownership,
stable ids, and versioned contracts are ratified in
[ADR 0022: Platform-Covered Resolution Ownership and Contracts](../../docs/adr/0022-platform-covered-resolution-contracts.md).

- **Consumes** — `support.support-request.refund-released.v1` (carries the allocation,
  refund amount, and coverage reference; Payments validates amount/currency against the
  authorized remedy and rejects platform-funded input lacking a coverage reference).
- **Publishes** — its refund completion fact carrying the `remedyId`/`coverageId`/
  allocation causation consumed by Settlement and Support (contract shape landed by #5215).

## Open Extraction Candidates

- Fraud review can be extracted later if authorization risk becomes a distinct workflow.
