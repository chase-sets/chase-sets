# Wallet, Payments, And Stripe Responsibilities

## Decision

Settlement owns wallet truth, seller payout setup state, payout requests, payout reversals, payout read models, and payout reconciliation decisions. Payments owns buyer payment intent state, balance-credit application, payment read models, and refund state. Stripe integrations stay behind provider adapters.

## Provider Boundaries

- `@chase-sets/payment-processing` defines the provider-neutral buyer payment processor port.
- `@chase-sets/money-movement` defines the provider-neutral seller payout and Connect money movement port.
- Fake adapters live in infrastructure testing packages.
- Stripe payment and Stripe Connect adapters live in infrastructure packages.
- Deployables compose adapters into bounded-context runtimes; bounded contexts do not own Stripe API request shapes.

## Risk And Data Handling

- Buyer card details are collected through Stripe.js Payment Element, not marketplace-owned inputs.
- Seller payout destination, identity, and account requirements are collected through hosted Connect setup or account management.
- The marketplace stores provider references, statuses, and failure messages, not bank account numbers, tax identity details, or card data.
- Provider webhooks use raw-body signature verification and idempotent provider event recording before state transitions.
- Settlement fails fast when platform balance cannot support a payout request, and provider transfer or payout failures post a single wallet reversal.

## Operational Model

- Sellers see natural payout setup language and a single recovery action for incomplete or restricted setup.
- Operators use payout operations filters and reconciliation to review stale requested payouts, in-transit payouts, failed payouts, and missing provider references.
- Stripe remains responsible for hosted onboarding, external payment destination collection, Payment Element handling, transfer execution, payout execution, and webhook signatures.
