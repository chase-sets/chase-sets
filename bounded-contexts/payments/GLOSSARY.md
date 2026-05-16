# Payments Domain Glossary

This glossary defines the canonical terminology for the Payments bounded context.

## Payment

A **Payment** is the external charge workflow associated with one or more orders.

## Payment Intent

A **Payment Intent** is the buyer-facing authorization attempt created before capture.

## Capture

A **Capture** is the successful completion of a previously authorized charge.

## Refund

A **Refund** is the reversal of captured buyer funds through an external payment rail.

## Payment Processor Reference

A **Payment Processor Reference** is the external identifier returned by the payment service provider.

## Marketplace Checkout Fee

A **Marketplace Checkout Fee** is the buyer-side payment-level marketplace fee quoted and confirmed by Payments before payment creation.

## Shipping Rebate Calculation

A **Shipping Rebate Calculation** is the payment-time computation used to reduce the buyer's effective shipping cost under marketplace rules.

## Buyer-Paid Share

A **Buyer-Paid Share** is the portion of a captured payment attributable to one cancelled order, including that order's total and allocated Marketplace Checkout Fee.

Notes:

- Payments owns buyer-paid share refund execution.
- Ordering owns the order cancellation fact.
- Allocation must be replay-safe so a cancellation cannot create duplicate refunds.

## Payment Handler

A **Payment Handler** is a UCP-facing declaration of how an external platform can collect or provide a payment instrument that Payments can process.

Notes:

- Payments owns payment-handler declaration, instrument validation, and provider references.
- Payment Handlers must keep Chase Sets out of raw card handling unless a future provider contract explicitly changes that scope.

## Shared Payment Token

A **Shared Payment Token** is a provider-scoped payment credential grant from an agent that Payments can submit to a payment processor without receiving raw card credentials.

Notes:

- Stripe Shared Payment Tokens are processed through a PaymentIntent handoff and require AP2 verification before headless UCP completion.
- Payments stores the resulting processor payment reference and metadata, not the token as durable customer payment data.

## AP2 Mandate

An **AP2 Mandate** is verifiable autonomous-payment authority that may allow a trusted agent to complete checkout without manual buyer UI confirmation.

Notes:

- AP2 Mandates are accepted for headless UCP checkout completion only when a production verifier is configured and a supported payment handler is present.
- Without a verified AP2 Mandate, UCP checkout completion must use Trusted Checkout Handoff.
