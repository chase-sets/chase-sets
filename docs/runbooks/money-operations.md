# Money Operations Runbook

This runbook covers checkout, wallet, Stripe payments, Connect payouts, transfers, provider webhooks, launch checks, and smoke tests. Settlement remains the wallet source of truth; Payments owns buyer payment and refund state; Stripe owns payment method handling, hosted payout setup, external account collection, transfers, payouts, and provider risk controls.

## System Boundaries

- `@chase-sets/payment-processing` defines the provider-neutral buyer payment processor port.
- `@chase-sets/money-movement` defines the provider-neutral seller payout and Connect money movement port.
- Fake adapters are local/test only. Production must use the Stripe payment and Stripe Connect money-movement adapters.
- Stripe adapters live in infrastructure packages. Deployables compose adapters into bounded-context runtimes.
- Bounded contexts store provider references, statuses, and support-safe failure messages, not bank account numbers, tax identity details, card data, secrets, webhook signatures, raw provider payloads, processor client secrets, hosted setup URLs after creation, or internal auth context.
- Provider webhooks use raw-body signature verification and idempotent provider event recording before state transitions.

## Charge And Funds Strategy

- Buyer checkout creates one provider-managed payment session per internal payment, with wallet balance credit applied before the external payment amount is sent to the processor.
- Buyer checkout defaults to embedded processor-managed confirmation and can fall back to hosted Checkout with `STRIPE_CHECKOUT_UI_MODE=hosted`.
- Platform-held funds are intentional for v1: buyer payments settle to the platform balance, settlement records seller wallet credit, and money moves to the connected seller account only when the seller requests an on-demand payout.
- Seller sale credits are pending first. The default hold is two days, after which the internal funds release job marks matured sale credits available for wallet spending or payout.
- Do not mix direct connected-account charges, destination charges, and platform-held charges in the same seller wallet flow. A future charge strategy change should be a migration with explicit ledger and reconciliation rules.
- Payout requests transfer from the platform balance to the connected account first, then create the connected-account payout. The seller-facing source of truth remains the settlement wallet ledger.

## Launch Readiness

- Required environment: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, Connect onboarding return URL, and Connect onboarding refresh URL.
- `STRIPE_API_BASE_URL` is optional and should normally be unset outside adapter tests or controlled sandbox endpoints.
- Money Health must show provider diagnostics, platform balance forecast, payout issues, and reconciliation history.
- Payout Operations must show recent provider idempotency keys.
- Payment webhooks must cover checkout completion, async failure, expiration, refunds, and disputes.
- Connect webhooks must cover account/readiness updates, `payout.paid`, and `payout.failed`.
- Run `npm run verify` before deployment. DB-backed rollout checks belong in `npm run verify:db` when database compatibility is in scope.

## Stripe Test-Mode Smoke Test

Use the executable smoke test before enabling Stripe money movement in a shared or production-like environment.

Required environment:

- `PLATFORM_API_BASE_URL`
- `STRIPE_SECRET_KEY` using a `sk_test` key
- `STRIPE_PUBLISHABLE_KEY` using a `pk_test` key
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_RETURN_URL`
- `STRIPE_CONNECT_REFRESH_URL`

For authenticated seller-flow checks, set one of:

- `PLATFORM_API_AUTHORIZATION`
- `PLATFORM_API_COOKIE`

Commands:

```bash
npm run stripe:money-smoke -- --check-env
npm run stripe:money-smoke -- --edge-check
npm run stripe:money-smoke -- --seller-flow
```

Expected results:

- `/health` returns `200`.
- Unsigned money movement webhooks return `400`.
- Payout readiness returns `200` for an authenticated seller.
- Hosted payout setup returns a one-time HTTPS URL from Stripe.
- Payout setup refresh returns the provider-neutral readiness shape.
- Payout preview returns either `200` with `can_request` details or a validation `400` with a user-safe reason.

Stripe Dashboard checks:

- Confirm the platform account is pinned to API version `2026-02-25.clover`.
- Confirm Connect is enabled for Accounts v2 and recipient onboarding.
- Configure payment webhook delivery for `checkout.session.completed`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, and `charge.dispute.created`.
- Configure Connect webhook delivery for `account.updated`, `payout.paid`, and `payout.failed`.
- Create a test checkout and confirm the internal payment id appears in Stripe Checkout Session and PaymentIntent metadata.
- Request a seller payout and confirm Stripe shows a transfer with transfer group `payout:<internal payout id>` followed by a connected-account payout.
- Replay the same webhook event from the Stripe Dashboard and confirm the API reports it as ignored without duplicate ledger entries.

## Ownership

- Product owns seller-facing copy, natural-language status labels, and support escalation paths.
- Support owns first-response triage using account payment, payout, wallet, and money health views.
- Operations owns reconciliation runs, platform balance monitoring, and Stripe Dashboard checks.
- Engineering owns adapter behavior, webhook signature verification, idempotency, schema rollout, and incident fixes.
- Finance owns Stripe balance funding decisions, payout release policies, refunds, disputes, and accounting reconciliation.

## Triage Order

1. Identify the account, payment, payout, order, and provider references involved.
2. Check the provider-neutral timeline before opening Stripe payload details.
3. Check idempotency records before retrying any payment, transfer, payout, refund, or dispute action.
4. Use reconciliation before manual correction when provider state is already available.
5. Use wallet operator actions only with a target seller account, idempotency key, and audit reason.

## Failed Payout

1. Open the payout timeline and confirm whether failure came from transfer submission, connected-account payout submission, or a provider webhook.
2. Confirm the payout has exactly one reversal ledger entry.
3. Run payout reconciliation if the provider payout reference exists and the local status is stale.
4. If Stripe reports an external account or requirement issue, ask the seller to continue payout setup through the hosted setup action.
5. Retry only after readiness shows transfer capability, payout capability, and payout destination are ready.

## Duplicate Webhook

1. Look up the provider event id.
2. Confirm the webhook event inbox table has only one processed row for that id.
3. Confirm no duplicate payout reversal or payment status transition was posted.
4. If a duplicate changed state, freeze payout retries for the affected account and escalate to engineering.

## Insufficient Platform Balance

1. Confirm the payout preview platform balance forecast.
2. Confirm the Stripe Dashboard available balance for the payout currency.
3. Do not debit the seller wallet if platform balance is already insufficient.
4. If a payout failed after debit, confirm the fail-fast reversal restored wallet available balance.
5. Finance decides whether to fund Stripe balance or ask the seller to retry later.

## Stuck Payout Setup

1. Refresh payout setup readiness.
2. If requirements remain missing, create a fresh hosted setup session.
3. If the setup URL expired, send the seller through the refresh URL flow so a new account link is generated after authentication.
4. Do not collect bank account, tax, identity, or other sensitive payout details in the app.

## Stuck Checkout

1. Check checkout status for blocking reason codes.
2. Check the payment timeline and provider event record.
3. Use deterministic checkout recovery for duplicate or interrupted submits.
4. Run payment reconciliation for stale provider status.
5. Keep card, bank, and wallet payment details inside Stripe-hosted or Stripe-managed confirmation surfaces.

## Refunds And Disputes

1. Confirm the provider event and provider object reference.
2. Confirm the wallet timeline shows the expected refund debit, dispute hold, dispute release, or reversal.
3. Use operator wallet actions only when provider reconciliation cannot express the required adjustment.
4. Finance owns the final accounting decision for partial refunds, lost disputes, and recovered disputes.

## Provider Outage

1. Check provider health endpoints and Stripe status.
2. Disable payout submissions before disabling webhook processing.
3. Keep accepting webhooks if signature verification is healthy.
4. Run reconciliation after recovery.
5. Do not switch production to fake adapters.

## Rollback

- Disable seller payout request actions first.
- Keep webhook endpoints online.
- Keep reconciliation available.
- Do not remove read-model columns during rollback.
- Do not replace Stripe adapters with fake adapters in production.
