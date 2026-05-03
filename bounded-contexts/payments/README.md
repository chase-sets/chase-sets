# Payments Bounded Context

## Purpose

Payments owns money movement with external payment rails and buyer-facing charges and refunds.

## Owns

- Payment intent and authorization
- Capture
- Refund
- Payment processor references
- Marketplace checkout fee values until buyer marketplace checkout fee policy is introduced
- Marketplace sales fee snapshots supplied by Ordering
- Shipping rebate calculation inputs at checkout and refund time

Buyer marketplace checkout fee policy is tracked separately in [Buyer Marketplace Checkout Fee Policy Future Work](../../docs/BUYER-PAYMENT-FEE-POLICY-FUTURE-WORK.md).

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

## Runtime Configuration

The platform API can run with either the real Stripe gateway or the fake local payment gateway.

Stripe mode uses these settings:

- `STRIPE_SECRET_KEY`: server-side Stripe API key used to create and update payment intents.
- `STRIPE_PUBLISHABLE_KEY`: buyer-facing Stripe key returned with payment intent client data.
- `STRIPE_WEBHOOK_SECRET`: signing secret used to verify inbound Stripe webhook payloads.
- `STRIPE_API_BASE_URL`: optional override for Stripe API calls in non-default environments or tests.

For local development, keep real Stripe values in `deployables/platform-api/.env.local` when you want to exercise real Stripe flows. If any of the required Stripe values are missing, the platform API falls back to the fake payment gateway so local startup still works without webhook forwarding. The platform API scripts load safe defaults from `deployables/platform-api/.env.example` and then apply `.env.local` if it exists, so secrets stay out of git.

Webhook callbacks are mounted by the platform API at `/api/payments/stripe/webhooks`. The account payment routes stay under `/api/marketplace/account/payments`.

When the dev stack includes `platform-api`, `npm run dev` starts the Dockerized Stripe listener automatically if `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` are present in `deployables/platform-api/.env.local`. The dev system waits for that listener to emit its session-specific webhook signing secret, writes `STRIPE_WEBHOOK_SECRET` into `deployables/platform-api/.env.local`, and then starts `platform-api` so the API comes up on the real Stripe gateway. You can still run `npm run stripe:listen` manually if you want the listener in a separate terminal.

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

## Open Extraction Candidates

- Fraud review can be extracted later if authorization risk becomes a distinct workflow.
