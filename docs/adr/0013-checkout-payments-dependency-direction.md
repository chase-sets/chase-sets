# ADR 0013: Checkout Payments Dependency Direction

## Status

Accepted.

## Context

The Checkout and Payments bounded contexts currently form a workspace package cycle. The cycle is the architecture problem, not every dependency between the contexts.

The mapped source edges are:

- Checkout -> Payments: `bounded-contexts/checkout/support/request-support/checkout-confirmation.ts` imports `createPaymentsRequestApiClient` from `@chase-sets/payments/server`. Runtime flow: after Checkout has validated the checkout session, created or reused orders through Ordering, and confirmed a fresh marketplace checkout fee quote, Checkout asks Payments to create the buyer payment. Checkout passes `sourceContext: "checkout"` and `sourceReferenceId: <checkout-session-id>` so the handoff is idempotent by source.
- Checkout -> Payments: `bounded-contexts/checkout/support/request-support/balance-credit.ts` imports `normalizeRequestedBalanceCreditAmount` from `@chase-sets/payments/server`. Runtime flow: Checkout accepts buyer balance-credit input on the checkout review page and reuses Payments' money-input normalization before asking Payments for preview or payment creation.
- Checkout -> Payments: `bounded-contexts/checkout/routes/checkout-session.tsx` imports `createPaymentsRequestApiClient` and Payments UI DTO types from `@chase-sets/payments/server`. Runtime flow: Checkout renders saved checkout instruments and payment previews during review, then redirects to the Payments-owned payment detail route once `payment_id` exists.
- Payments -> Checkout: `bounded-contexts/payments/routes/marketplace/account-payment.tsx` imports `appendClearedGuestCheckoutCookie` from `@chase-sets/checkout/server`. Runtime flow: after a guest buyer claims a completed guest checkout payment through magic link or passkey, the Payments route clears the guest checkout browser cookie before redirecting to the signed-in account payment page.

Tests mock the same server imports. They are coverage for these runtime flows, not separate architecture edges.

The business handoff is already modeled in both contexts:

- Checkout records `checkout.session.payment-started` after Payments returns a payment id.
- Payments records `payments.payment-created` with `sourceContext: "checkout"` and `sourceReferenceId: <checkout-session-id>`, and projects those fields into `payments_payment_pages`.

The missing rule is which fact is stable enough for cross-context use and which context owns the behavior that creates it.

## Decision

Checkout owns the checkout-to-payment handoff behavior. The stable published fact is:

`checkout.session.payment-started`: a Checkout session has started a Payment, with `sessionId`, `paymentId`, and `recordedAt`.

The event payload belongs in `@chase-sets/event-core/public-event-payloads` because it is a cross-context fact, not a route helper and not Payments-owned behavior. Payments may also keep its own projected source linkage (`source_context`, `source_reference_id`) because Payments owns the payment read model and needs idempotent lookup by payment source.

The allowed package direction is Checkout -> Payments for request-time orchestration into Payments-owned APIs. Payments must not import Checkout. If Payments needs Checkout-originated facts, it consumes a published event payload or a Payments-owned projection. If Payments needs browser authentication or guest-claim cleanup, it uses Auth-owned server helpers because Auth owns browser authentication credentials.

## Alternatives Considered

### Reverse the dependency so Payments owns the handoff

Rejected. Payments owns money movement, fee quotes, saved instruments, PSP references, authorization, capture, refunds, and payment read models. It does not own checkout session readiness, shipping selection, order handoff timing, offer-intent exclusion, guest checkout route choice, or the decision that a checkout session is ready to start payment. Moving the handoff into Payments would require Payments to ask Checkout whether a session is ready or import Checkout session modules. That preserves or recreates the same unclear behavior ownership.

### Remove Checkout's dependency on Payments by introducing an intermediate orchestration package

Rejected. The handoff behavior is Checkout-owned, and the callee behavior is Payments-owned. A neutral orchestrator would hide ownership rather than clarify it, and it would invite deployables or shared packages to accumulate domain rules.

### Duplicate the guest checkout cookie clearing logic in Payments

Rejected. Copying cookie names and serialization into Payments removes the package edge but leaves a hidden cross-context contract. The browser credential belongs with Auth's browser-session helpers, so Payments should depend on Auth for the guest claim cleanup it already performs through Auth APIs.

## Consequences

- The Checkout/Payments package graph must be a DAG: Checkout may depend on Payments, Payments must not depend on Checkout.
- `@chase-sets/payments` must remove `@chase-sets/checkout` from `package.json` and `context.json`.
- `@chase-sets/auth/server` must expose the guest checkout cookie clearing helper used after guest claim. Payments already depends on Auth for the claim flow.
- `checkout.session.payment-started` is the public event contract for the checkout-session/payment linkage. The existing Checkout event and read model stay the source of truth for Checkout's view.
- `payments_payment_pages.source_context/source_reference_id` remains a Payments-owned projection for payment lookup and display. It is not a reason for Payments to import Checkout.
- The inventory/ordering/marketplace cycle should use the same rule: pick one behavior owner, publish one stable fact from that owner, let consumers project it, and remove only the back-edge that makes the package graph cyclic.

## Invariants

- A bounded context may call another context's stable server API when it is orchestrating behavior that it owns.
- A bounded context must not import another context to read private state, reuse private helpers, or clear browser state that belongs to a third context.
- Cross-context event facts belong in `@chase-sets/event-core/public-event-payloads`.
- Consumer-specific query needs belong in the consumer's projected read model.
- Deployables stay composition roots and must not become the place where checkout/payment behavior is decided.
