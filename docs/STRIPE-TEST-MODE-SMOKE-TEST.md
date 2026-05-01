# Stripe Test-Mode Money Smoke Test

Use this headless smoke test before enabling Stripe money movement in a shared environment. It verifies that the platform is running with Stripe test-mode credentials, provider webhook routing rejects unsigned payloads, and seller payout setup endpoints can create Stripe-hosted onboarding sessions without exposing Stripe-specific behavior to settlement.

## Required Environment

- `PLATFORM_API_BASE_URL`
- `STRIPE_SECRET_KEY` using a `sk_test` key
- `STRIPE_PUBLISHABLE_KEY` using a `pk_test` key
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_RETURN_URL`
- `STRIPE_CONNECT_REFRESH_URL`

For authenticated seller-flow checks, set one of:

- `PLATFORM_API_AUTHORIZATION`
- `PLATFORM_API_COOKIE`

Optional:

- `SMOKE_PAYOUT_AMOUNT`, default `1.00`

## Commands

Check whether the environment is ready:

```bash
npm run stripe:money-smoke -- --check-env
```

Check the deployed API edge and webhook signature gate:

```bash
npm run stripe:money-smoke -- --edge-check
```

Run the seller payout setup smoke:

```bash
npm run stripe:money-smoke -- --seller-flow
```

The seller-flow smoke intentionally creates a hosted payout setup URL and refreshes setup readiness. It previews a payout, but does not submit a payout. Submit real on-demand payouts only through normal authenticated seller or operator workflows after confirming wallet balance, platform balance, and payout setup readiness.

## Expected Results

- `/health` returns `200`.
- Unsigned money movement webhooks return `400`.
- Payout readiness returns `200` for an authenticated seller.
- Hosted payout setup returns a one-time HTTPS URL from Stripe.
- Payout setup refresh returns the provider-neutral readiness shape.
- Payout preview returns either `200` with `can_request` details or a validation `400` with a user-safe reason.

## Stripe Dashboard Checks

- Confirm Connect is enabled for Accounts v2 and recipient onboarding.
- Confirm webhook endpoint points at `/api/settlement/provider/money-movement/webhooks`.
- Confirm payment webhook endpoint points at `/api/payments/provider/webhooks`.
- Confirm required webhook events match `REQUIRED_STRIPE_WEBHOOK_EVENTS` in the platform API config.
- Use Stripe-hosted onboarding and Checkout or Stripe-managed confirmation surfaces for sensitive payment and payout setup details.
