# Stripe Money Launch Readiness

This checklist keeps checkout, wallet, payout, transfer, and webhook operations headless and adapter-driven.

## Provider Mode

- Production must use the Stripe payment and Stripe Connect money-movement adapters.
- Fake payment or money-movement adapters are local/test only.
- Provider diagnostics are available through the headless provider-health endpoints and the Money Health operator view.
- Sensitive payment details must stay with Stripe-hosted or Stripe-managed confirmation surfaces.

## Required Environment

- `STRIPE_SECRET_KEY`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_API_BASE_URL`
- Connect onboarding return URL
- Connect onboarding refresh URL

## Checkout Smoke Test

1. Start a checkout with unpaid orders.
2. Confirm the checkout status endpoint returns no blocking reason codes.
3. Create a payment through the payment adapter.
4. Confirm the payment timeline includes payment creation and provider operation submission.
5. Send a duplicate recovery request and confirm it resolves through the deterministic recovery reference.

## Payout Smoke Test

1. Start hosted payout setup.
2. Return from onboarding and refresh payout setup.
3. Confirm payout setup progress shows hosted setup, transfer capability, payout capability, and payout destination as ready.
4. Preview a payout before submission.
5. Confirm preview checks wallet balance and platform balance before final request.
6. Request the payout.
7. Confirm the payout timeline includes wallet debit, platform transfer, connected payout, and final provider status.

## Webhook Events

- Payments: checkout completion, checkout async failure, checkout expiration, payment intent success/failure, refunds, disputes.
- Money movement: account requirement updates, payout paid, payout failed.
- Webhooks must use raw body signature verification and provider event idempotency.

## Operator Checks

- Money Health shows provider diagnostics, platform balance forecast, payout issues, and reconciliation history.
- Payout Operations shows recent provider idempotency keys.
- Refund and dispute wallet actions use explicit headless commands:
  - refund debit
  - dispute hold
  - dispute release

## Rollback

- Do not switch production to fake adapters.
- Disable seller payout requests before disabling webhooks.
- Reconciliation can be run after webhook recovery to replay provider status into read models.
