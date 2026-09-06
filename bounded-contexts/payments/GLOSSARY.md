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

## Payment Disputed

A **Payment Disputed** event records that the payment processor reported a chargeback or dispute against a captured Payment.

Notes:

- Payments owns the processor dispute identifier, lifecycle state, evidence deadline, charge reference, and affected Payment references.
- Settlement consumes this fact to hold pending seller funds, claw back released seller funds, or release chargeback holds when the dispute is won.

## Payment Dispute Evidence

**Payment Dispute Evidence** is the support-safe fulfillment and order proof that Payments submits to the payment processor for a processor dispute.

Notes:

- Payments owns the processor submission state and idempotency key for dispute evidence.
- Fulfillment remains the source of truth for shipment tracking, carrier, delivery confirmation, and shipping address facts; Payments consumes those facts through its own replayable projection.
- A Payment Dispute Evidence unavailable event records that no tracking proof was available from the Payments-owned projection when the dispute evidence workflow ran.

## Payment Fraud Warning Received

A **Payment Fraud Warning Received** event records that the payment processor reported an early fraud warning for a Payment.

Notes:

- Payments owns the processor fraud signal and its normalized buyer, order, and provider references.
- Consumer contexts may hold fulfillment or seller funds from this fact, but they do not reinterpret the processor signal.

## Payment Fraud Review Opened

A **Payment Fraud Review Opened** event records that the payment processor opened a fraud review for a Payment.

Notes:

- Payments owns the fraud review identifier and the affected Payment, buyer, and order references.
- Consumer contexts use this fact to pause dependent workflows while the processor review is open.

## Payment Fraud Review Closed

A **Payment Fraud Review Closed** event records that the payment processor closed a fraud review for a Payment.

Notes:

- Payments owns the normalized processor review outcome.
- Consumer contexts use this fact to release or retain their own holds according to their local rules.

## Payment Liability Shift Recorded

A **Payment Liability Shift Recorded** event records the processor-reported card-authentication liability-shift outcome for a Payment.

Notes:

- Payments owns the 3DS request decision and the support-safe provider outcome.
- Liability-shift facts are used for payment risk review and dispute posture; they do not change Settlement-owned payout-release decisions.
- Risk-based 3DS should be requested only when card-payment risk warrants step-up, not for every checkout.

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

## Saved Checkout Instrument

A **Saved Checkout Instrument** is Payments-owned metadata for a reusable provider payment credential or token reference that Checkout can present during review without seeing raw card or bank details.

Notes:

- Checkout may compose Saved Checkout Instrument labels and selected payment-method category.
- Payments owns credential readiness, provider references, confirmation requirements, and any token exchange.
- A missing Saved Checkout Instrument keeps checkout on the trusted payment-step path.

## Provider Customer

A **Provider Customer** is the Payments-owned mapping between a Chase Sets account and a payment processor customer identity used for reusable payment credentials.

Notes:

- Payments creates and stores Provider Customer references before saving or charging stored payment methods.
- Checkout may request a Saved Checkout Instrument by Chase Sets id, but Checkout must not call provider customer APIs or receive raw provider payment method ids.
- Provider Customer records store provider references and support-safe audit metadata only.

## Stored Payment Consent

**Stored Payment Consent** is the buyer's explicit authorization for Payments to attach a provider payment method to their account for future Chase Sets checkout.

Notes:

- Guest checkout must not create reusable stored payment credentials without account claim or sign-in and explicit consent.
- If payment capture succeeds but stored-payment persistence fails, the Payment remains valid and the saved-method issue is handled as a non-blocking Payments reconciliation concern.

## Saved Checkout Instrument Readiness

**Saved Checkout Instrument Readiness** describes whether a Saved Checkout Instrument can be offered as a fast checkout option.

Readiness states:

- `ready`: Payments has a provider customer reference and a provider payment method reference that can be used for eligible checkout.
- `setup-required`: The provider method exists in history but needs buyer action, mandate repair, or provider reconciliation before reuse.
- `removed`: The buyer or provider detached the credential; Checkout must not offer it, but historical Payments keep their Saved Checkout Instrument reference.

## Provider Object Class

A **Provider Object Class** is one of the six governed categories of Stripe test-mode object that an Ink & Foil evidence window may create, fixed by Decision #6728: captured PaymentIntent, uncaptured PaymentIntent, SetupIntent, Stripe Checkout Session, Stripe Customer, and Stripe Account Session.

Notes:

- The class list, per-class Residue Budget, and per-class Disposition Terminal are immutable under `provider-object-disposition/v1` (issue #6733); no caller input may override them.

## Provider Object Disposition

A **Provider Object Disposition** is the bounded outcome recorded for one Provider Object Class in a single evidence window: whether disposition was not attempted, ambiguous, or reached its class-specific Disposition Terminal, and how many objects were observed.

Notes:

- Recorded only in the `provider-object-disposition/v1` receipt; it never carries a provider identifier, raw provider response, or free-text diagnostic.
- An unattempted or ambiguous disposition never counts as satisfying a Residue Budget.

## Residue Budget

A **Residue Budget** is the maximum known count of a Provider Object Class permitted to remain in a non-terminal provider state at the end of one evidence window, fixed per class and scope by Decision #6728.

Notes:

- Every Residue Budget is a stated number, never a range; class 5 (Stripe Customer) is measured per e2e identity and persists across windows, every other class is measured per window.
- An unknown or not-attempted disposition never satisfies a Residue Budget, even at zero.

## Disposition Terminal

A **Disposition Terminal** is the class-specific final state a `provider-object-disposition/v1` receipt may represent for one Provider Object Class, fixed by Decision #6728's Option B (for example `not-created` for a Stripe Checkout Session or `retained-reused` for a Stripe Customer).

## Stripe Checkout Session

A **Stripe Checkout Session** (`cs_`) is the Stripe-hosted, non-embedded payment or setup session object created at `/v1/checkout/sessions`.

Notes:

- Distinct from the product checkout session, which is Chase Sets' own buyer-facing checkout flow and is not a Stripe object; the two must never be conflated in Payments terminology or evidence.
- Option B's evidence windows use the embedded setup path only, so no Stripe Checkout Session is created; its Disposition Terminal is `not-created`.

## AP2 Mandate

An **AP2 Mandate** is verifiable autonomous-payment authority that may allow a trusted agent to complete checkout without manual buyer UI confirmation.

Notes:

- AP2 Mandates are accepted for headless UCP checkout completion only when a production verifier is configured and a supported payment handler is present.
- Without a verified AP2 Mandate, UCP checkout completion must use Trusted Checkout Handoff.

## Payment Provider Mode

A **Payment Provider Mode** is the boot-time effective classification of the platform payment provider configuration, one of `unconfigured`, `test` or `live`.

Notes:

- The classification is decided solely by the shared platform Stripe key classification; Payments transports the result and never re-derives it from a key, a prefix or an environment variable.
- The mode reports locally configured authority, never the payment provider's own opinion about the account.

## Provider Mode Observation

A **Provider Mode Observation** is the immutable configuration-time record of the Payment Provider Mode together with the payment-processor gateway kind, the money-movement gateway kind and the deployment environment.

Notes:

- The record is loaded once per process by the API host; the observation endpoint reports it with one request-time `observedAt` instant.
- `observedAt` carries no uniqueness guarantee: two requests served while the clock has not advanced legitimately report the same instant.
