# Money Operations Runbook

This runbook covers checkout, wallet, Stripe payments, Connect payouts, transfers, provider webhooks, launch checks, and smoke tests. Settlement remains the wallet source of truth; Payments owns payment and refund state for purchasing accounts; Stripe owns payment method handling, hosted payout setup, external account collection, transfers, payouts, and provider risk controls.

## System Boundaries

- `@chase-sets/payment-processing` defines the provider-neutral payment processor port.
- `@chase-sets/money-movement` defines the provider-neutral payout and Connect money movement port.
- Fake adapters are local/test only. Production must use the Stripe payment and Stripe Connect money-movement adapters.
- Stripe adapters live in infrastructure packages. Deployables compose adapters into bounded-context runtimes.
- Bounded contexts store provider references, statuses, and support-safe failure messages, not bank account numbers, tax identity details, card data, secrets, webhook signatures, raw provider payloads, processor client secrets, hosted setup URLs after creation, or internal auth context.
- Provider webhooks use raw-body signature verification and idempotent provider event recording before state transitions.

## Charge And Funds Strategy

- Checkout creates one provider-managed payment session per internal payment, with wallet balance credit applied before the external payment amount is sent to the processor.
- Checkout defaults to embedded processor-managed confirmation and can fall back to hosted Checkout with `STRIPE_CHECKOUT_UI_MODE=hosted`.
- Platform-held funds are intentional for v1: purchase payments settle to the platform balance, settlement records sale wallet credit, and money moves to the connected payout account only when the account requests an on-demand payout.
- Sale and shipping allowance credits are pending first. Settlement releases them only after the payment is captured, Fulfillment has recorded delivery, no active support hold exists, and the applicable risk hold has elapsed.
- Standard release is the later of capture plus two days and delivery plus two days. New, unrated, untrusted, high-dollar, or manual-review accounts use delivery plus seven days. Returned shipments, fulfillment exceptions, and open support requests keep proceeds pending.
- Do not mix direct connected-account charges, destination charges, and platform-held charges in the same account wallet flow. A future charge strategy change should be a migration with explicit ledger and reconciliation rules.
- Payout requests transfer from the platform balance to the connected account first, then create the connected-account payout. The account-facing source of truth remains the settlement wallet ledger.

## Fraud And Payout Controls

- Marketplace blocks high-dollar listing publication for accounts without listing photo evidence and trusted seller status or established reputation. High-dollar drafts can exist, but they cannot become active buyer-visible listings until the publication policy clears.
- Identity owns `trusted-seller` and `manual-payout-review` Account Badges. Use `trusted-seller` only after operational review. Use `manual-payout-review` when Stripe, support, fulfillment, or operations finds seller-risk signals that should force enhanced payout holds.
- Payments sends non-PII marketplace risk metadata to Stripe Checkout Sessions and PaymentIntents: internal payment/order ids, buyer account id, seller account ids/count, max seller order amount, high-dollar flag, platform-held funds strategy, fulfillment-required flag, and whether client IP/user-agent were collected.
- In Stripe Dashboard, enable [Radar](https://docs.stripe.com/radar), [Radar rules](https://docs.stripe.com/radar/rules), and [metadata-backed Radar rules](https://docs.stripe.com/metadata) for high-dollar orders, repeated failed attempts, risky payment methods, and suspicious account/order patterns. Keep automatic 3DS enabled for card payments.
- For Connect risk, use [Radar with Connect](https://docs.stripe.com/connect/radar) and enable [Radar for Platforms](https://docs.stripe.com/radar/radar-for-platforms) when available. Use connected-account rules and reviews to pause payouts, request identity document/selfie verification, set reserves, or reject accounts that show card-cashing, no-intent-to-fulfill, or related-account fraud patterns.
- Stripe Radar checks external charges and can block or review payments, but it does not prove possession, carrier handoff, delivery, or buyer satisfaction. Settlement release gates remain mandatory even when Stripe reports normal payment risk.

## Launch Readiness

- Required environment: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, Connect onboarding return URL, and Connect onboarding refresh URL.
- Production marketplace launch additionally requires `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true`, a `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE` pointing to the final launch review record, `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED=true`, a `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE` pointing to the Payments fee approval record, `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true`, a `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the live Stripe money operations record, approved launch supply measurement evidence, `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, approved Tax readiness evidence, Stripe live-mode keys, production Connect return and refresh URLs on `https://marketplace.chasesets.com`, EasyPost production mode, and complete Amazon SES transactional email configuration. Tax readiness may approve a no-provider launch only while state-by-state nexus tracking shows no jurisdiction requires collection; set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` before collecting sales tax in any jurisdiction. Keep the public switch off while production remains landing/admin-support only and run the [Marketplace Launch Evidence](./marketplace-launch-evidence.md) verifier before setting approval variables.
- `STRIPE_API_BASE_URL` is optional and should normally be unset outside adapter tests or controlled sandbox endpoints.
- Money Health must show provider diagnostics, platform balance forecast, payout issues, and reconciliation history.
- Payout Operations must show recent provider idempotency keys.
- Payment webhooks must cover checkout completion, async failure, expiration, refunds, and disputes.
- Connect webhooks must cover account/readiness updates, `payout.paid`, and `payout.failed`.
- Support must be able to open structured buyer and seller order issues before production marketplace launch, because support holds can block settlement release and support resolutions can produce refunds.
- Run `pnpm run verify` before deployment. DB-backed rollout checks belong in `pnpm run verify:db` when database compatibility is in scope.

## Local Stripe Runtime

The platform API can run with either the real Stripe gateway or the fake local payment gateway.

Stripe mode uses:

- `STRIPE_SECRET_KEY`: server-side Stripe API key used to create and update payment intents.
- `STRIPE_PUBLISHABLE_KEY`: buyer-facing Stripe key returned with payment intent client data.
- `STRIPE_WEBHOOK_SECRET`: signing secret used to verify inbound Stripe webhook payloads.
- `STRIPE_API_BASE_URL`: optional override for Stripe API calls in non-default environments or tests.

For local development, keep real Stripe values in `deployables/platform-api/.env.local` when you want to exercise real Stripe flows. If any required Stripe value is missing, the platform API falls back to the fake payment gateway so local startup works without webhook forwarding.

Webhook callbacks are mounted by the platform API at `/api/payments/provider/webhooks`. The account payment routes stay under `/api/marketplace/account/payments`.

When the dev stack includes `platform-api`, `pnpm run dev` starts the Dockerized Stripe listener automatically if `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` are present in `deployables/platform-api/.env.local`. The dev system waits for that listener to emit its session-specific webhook signing secret, writes `STRIPE_WEBHOOK_SECRET` into the current worktree's `.env.sandbox.local`, and then starts `platform-api` so the API comes up on the real Stripe gateway. You can still run `pnpm run stripe:listen` manually if you want the listener in a separate terminal; it forwards to the sandbox platform API URL by default.

## Stripe Connect Notes

- Configure platform API with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for Stripe Connect money movement; production startup fails without both.
- Optional onboarding URLs are `STRIPE_CONNECT_RETURN_URL` and `STRIPE_CONNECT_REFRESH_URL`; account payout routes can also pass request-specific return and refresh URLs when creating setup sessions.
- Payout setup and account management use hosted provider sessions. Settlement never collects or stores payout destination account numbers, tax identity details, or hosted-dashboard credentials.
- Stripe-connected accounts are configured for manual payout schedules by the Stripe adapter so marketplace payouts remain account-requested and settlement-triggered.
- Public account payout APIs can start onboarding, open hosted account management, refresh readiness, and request payouts. Provider readiness cannot be manually overwritten through public account routes.
- Payout requests use a preview/confirmation step, enforce USD-only amount policy, and keep payout destination details in hosted account management.
- Hosted setup redirects must stay on the marketplace origin, and provider webhook signatures are verified with a timestamp tolerance to reduce replay risk.
- Processed provider webhook event ids are stored so duplicate provider events are ignored and auditable.
- Stripe stays behind the money movement adapter. Settlement owns wallet debits, payout requests, failure reversals, read models, and reconciliation decisions; Stripe owns hosted onboarding, external payout destination collection, transfer execution, connected-account payout execution, and webhook signing.
- Register provider webhooks for `v2.core.account[requirements].updated`, `v2.core.account.updated`, `payout.paid`, and `payout.failed`. Settlement consumes them through the unauthenticated provider webhook mount and maps them into provider-neutral payout/readiness events.
- Existing payout readiness and payout read models backfill provider fields with nullable references and conservative setup defaults, so old rows remain readable.

## Stripe Test-Mode Smoke Test

Use the executable smoke test before enabling Stripe money movement in a shared or production-like environment.

Required environment:

- `PLATFORM_API_BASE_URL`
- `STRIPE_SECRET_KEY` using a `sk_test` key
- `STRIPE_PUBLISHABLE_KEY` using a `pk_test` key
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_RETURN_URL`
- `STRIPE_CONNECT_REFRESH_URL`

For authenticated payout-flow checks, set one of:

- `PLATFORM_API_AUTHORIZATION`
- `PLATFORM_API_COOKIE`

If a bearer token or cookie is not already available, the smoke test can sign in
with `SMOKE_SELLER_EMAIL`, `SMOKE_SELLER_PASSWORD`, and
`PLATFORM_AUTH_BASE_URL`. In disposable preview environments, set
`SMOKE_REGISTER_SELLER=true` with those credentials to create a
throwaway owner account before running payout checks. The legacy
`PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` fallback is only useful
when that account has payout permissions.

Optional authenticated preview checks:

- `SMOKE_REGISTER_SELLER=true`: legacy smoke variable name; registers a new owner account before checking payout flows.
- `SMOKE_AUTH_READY_ATTEMPTS`: number of sign-in retries after disposable account registration. Defaults to `24`.
- `SMOKE_AUTH_READY_RETRY_DELAY_MS`: delay between post-registration sign-in retries. Defaults to `5000`.
- `SMOKE_SELLER_EMAIL`: legacy smoke variable name for the preview account email used for sign-in or registration.
- `SMOKE_SELLER_PASSWORD`: legacy smoke variable name for the preview account password used for sign-in or registration.
- `SMOKE_SELLER_ACCOUNT_ID`: legacy smoke variable name for the account to select when the user has multiple memberships.
- `SMOKE_ORDER_IDS`: comma-separated pending-payment order ids to probe checkout payment status.
- `SMOKE_BALANCE_CREDIT_AMOUNT`: wallet credit amount to apply in checkout status and optional payment creation.
- `SMOKE_PAYMENT_METHOD_CATEGORY`: `card`, `bank-account`, or `platform-credit`.
- `SMOKE_CREATE_PAYMENT=true`: creates a payment from `SMOKE_ORDER_IDS` using the returned Marketplace Checkout Fee fingerprint.
- `SMOKE_PAYOUT_AMOUNT`: payout amount for preview and optional request checks. Defaults to `1.00`.
- `SMOKE_REQUEST_PAYOUT=true`: requests a test-mode payout only when payout preview returns `can_request: true`.

Commands:

```bash
pnpm run stripe:money-smoke -- --check-env
pnpm run stripe:money-smoke -- --edge-check
pnpm run stripe:money-smoke -- --seller-flow
```

`--seller-flow` is the existing command name for the authenticated payout-readiness smoke path; it does not create a separate seller account identity.

Expected results:

- `/health` returns `200`.
- Unsigned payment and money movement webhooks return `400`.
- Payment and settlement provider health both report Stripe.
- Payment and payout provider idempotency surfaces return successfully.
- Settlement account status reports whether wallet balance credit can be used.
- Marketplace Checkout Fee policy returns successfully.
- When `SMOKE_ORDER_IDS` is set, checkout status returns wallet credit and Marketplace Checkout Fee details.
- When `SMOKE_CREATE_PAYMENT=true`, payment creation returns `201`.
- Payout readiness returns `200` for an authenticated account with payout permissions.
- Hosted payout setup returns a one-time HTTPS URL from Stripe.
- Payout setup refresh returns the provider-neutral readiness shape.
- Payout preview returns either `200` with `can_request` details or a validation `400` with a user-safe reason.
- When `SMOKE_REQUEST_PAYOUT=true`, payout request returns `201` after a successful `can_request` preview.

Stripe Dashboard checks:

- Confirm the platform account is pinned to API version `2026-02-25.clover`.
- Confirm Connect is enabled for Accounts v2 and recipient onboarding.
- Configure payment webhook delivery for `checkout.session.completed`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, and `charge.dispute.created`.
- Configure Connect webhook delivery for `account.updated`, `payout.paid`, and `payout.failed`.
- Create a test checkout and confirm the internal payment id appears in Stripe Checkout Session and PaymentIntent metadata.
- Request a payout and confirm Stripe shows a transfer with transfer group `payout:<internal payout id>` followed by a connected-account payout.
- Replay the same webhook event from the Stripe Dashboard and confirm the API reports it as ignored without duplicate ledger entries.

## Production Stripe Money Operations Proof

Set `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true` only after the production GitHub Environment has live-mode Stripe keys, production Connect URLs, and a non-empty `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the approved launch evidence record. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` until this record and every other production gate are complete.

The evidence record must include:

- Stripe account and Dashboard posture: API version `2026-02-25.clover`, live-mode keys scoped to production, Connect enabled for Accounts v2 recipient onboarding, manual payout schedules, webhook endpoints registered on production domains, Radar/Radar for Platforms rules reviewed, and no `STRIPE_API_BASE_URL` override unless an approved provider endpoint exception exists.
- Live checkout proof: a controlled production checkout or provider-approved live-mode rehearsal showing internal payment id metadata on the Checkout Session and PaymentIntent, successful authorization/capture mapping into Payments, correct Marketplace Checkout Fee allocation, and no raw card data stored in Chase Sets.
- Refund and dispute proof: at least one controlled refund path, replay-safe refund webhook handling, `charge.dispute.created` coverage, and Finance-owned accounting notes for partial refunds, lost disputes, and recovered disputes.
- Connect onboarding proof: hosted onboarding/account-management URLs on `https://marketplace.chasesets.com`, requirement/readiness refresh, account/readiness webhook handling, and provider-neutral readiness status shown to the account.
- Payout proof: payout preview, platform balance forecast, transfer with transfer group `payout:<internal payout id>`, connected-account payout creation, `payout.paid`, `payout.failed`, failure reversal, and idempotent retry evidence.
- Reconciliation proof: payment reconciliation, payout reconciliation, duplicate provider webhook replay, provider event inbox idempotency, and ledger entries matching provider balances and wallet timelines.
- Operations proof: Money Health, Payout Operations, support escalation, platform balance funding, provider outage rollback, and disabled/frozen payout actions rehearsed with named operators.

Do not commit live payment IDs tied to private buyers, connected-account IDs tied to real sellers, card/bank details, webhook signatures, Stripe payload bodies, Dashboard screenshots with sensitive account data, or secret values. Store redacted evidence in the external launch record referenced by `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE`.

## Ownership

- Product owns account-facing payout copy, natural-language status labels, and support escalation paths.
- Support owns first-response triage using account payment, payout, wallet, and money health views.
- Operations owns reconciliation runs, platform balance monitoring, and Stripe Dashboard checks.
- Engineering owns adapter behavior, webhook signature verification, idempotency, schema rollout, and incident fixes.
- Finance owns Stripe balance funding decisions, payout release policies, refunds, disputes, and accounting reconciliation.

## Triage Order

1. Identify the account, payment, payout, order, and provider references involved.
2. Check the provider-neutral timeline before opening Stripe payload details.
3. Check idempotency records before retrying any payment, transfer, payout, refund, or dispute action.
4. Use reconciliation before manual correction when provider state is already available.
5. Use wallet operator actions only with a target account, idempotency key, and audit reason.

## Failed Payout

1. Open the payout timeline and confirm whether failure came from transfer submission, connected-account payout submission, or a provider webhook.
2. Confirm the payout has exactly one reversal ledger entry.
3. Run payout reconciliation if the provider payout reference exists and the local status is stale.
4. If Stripe reports an external account or requirement issue, ask the account operator to continue payout setup through the hosted setup action.
5. Retry only after readiness shows transfer capability, payout capability, and payout destination are ready.

## Duplicate Webhook

1. Look up the provider event id.
2. Confirm the webhook event inbox table has only one processed row for that id.
3. Confirm no duplicate payout reversal or payment status transition was posted.
4. If a duplicate changed state, freeze payout retries for the affected account and escalate to engineering.

## Insufficient Platform Balance

1. Confirm the payout preview platform balance forecast.
2. Confirm the Stripe Dashboard available balance for the payout currency.
3. Do not debit the account wallet if platform balance is already insufficient.
4. If a payout failed after debit, confirm the fail-fast reversal restored wallet available balance.
5. Finance decides whether to fund Stripe balance or ask the account operator to retry later.

## Stuck Payout Setup

1. Refresh payout setup readiness.
2. If requirements remain missing, create a fresh hosted setup session.
3. If the setup URL expired, send the account operator through the refresh URL flow so a new account link is generated after authentication.
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

- Disable payout request actions first.
- Keep webhook endpoints online.
- Keep reconciliation available.
- Do not remove read-model columns during rollback.
- Do not replace Stripe adapters with fake adapters in production.
