# Payments Bounded Context

## Purpose

Payments owns money movement with external payment rails and buyer-facing charges and refunds.

## Owns

- Payment intent and authorization
- Capture
- Refund
- Payment processor references
- Buyer payment fees
- Marketplace fee calculation inputs at charge time
- Shipping rebate calculation inputs at checkout and refund time

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

- Ordering for commercial terms and order references
- Fulfillment for issue signals that justify refunds

## Runtime Configuration

The marketplace API now depends on these Stripe-backed payment settings:

- `STRIPE_SECRET_KEY`: server-side Stripe API key used to create and update payment intents.
- `STRIPE_PUBLISHABLE_KEY`: buyer-facing Stripe key returned with payment intent client data.
- `STRIPE_WEBHOOK_SECRET`: signing secret used to verify inbound Stripe webhook payloads.
- `STRIPE_API_BASE_URL`: optional override for Stripe API calls in non-default environments or tests.

Webhook callbacks are mounted by the marketplace API at `/api/payments/stripe/webhooks`. The buyer-facing payment routes stay under `/api/marketplace/buyer/payments`.

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
4. Payments may calculate fee and rebate inputs, but Settlement owns ledger postings.

## Open Extraction Candidates

- Fraud review can be extracted later if authorization risk becomes a distinct workflow.
