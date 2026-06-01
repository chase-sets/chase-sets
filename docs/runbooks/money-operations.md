# Money Operations Runbook

This runbook covers checkout, wallet, Stripe payments, Connect payouts, transfers, provider webhooks, launch checks, and smoke tests. Settlement remains the wallet source of truth; Payments owns payment and refund state for purchasing accounts; Stripe owns payment method handling, embedded payout setup components, external account collection, transfers, payouts, and provider risk controls.

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
- Checkout uses explicit payment method selection for launch (`card`, `us_bank_account`, or platform credit) so Marketplace Checkout Fee quotes match the provider request. Do not claim dynamic payment methods are active until fee quotes, settlement timing, and buyer UX are redesigned for Stripe-selected methods.
- In Stripe Dashboard, enable [Radar](https://docs.stripe.com/radar), [Radar rules](https://docs.stripe.com/radar/rules), and [metadata-backed Radar rules](https://docs.stripe.com/metadata) for high-dollar orders, repeated failed attempts, risky payment methods, and suspicious account/order patterns. Keep automatic 3DS enabled for card payments.
- For Connect risk, use [Radar with Connect](https://docs.stripe.com/connect/radar) and enable [Radar for Platforms](https://docs.stripe.com/radar/radar-for-platforms) when available. Use connected-account rules and reviews to pause payouts, request identity document/selfie verification, set reserves, or reject accounts that show card-cashing, no-intent-to-fulfill, or related-account fraud patterns.
- Stripe Radar checks external charges and can block or review payments, but it does not prove possession, carrier handoff, delivery, or buyer satisfaction. Settlement release gates remain mandatory even when Stripe reports normal payment risk.

## Launch Readiness

- Required environment: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_CONNECT_WEBHOOK_SECRET`. Legacy Connect return/refresh URLs are compatibility-only smoke variables until the hosted Account Link path is retired.
- Production marketplace launch additionally requires `PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE` pointing to the passing packet, `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true`, a `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE` pointing to the final launch review record, `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED=true`, a `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE` pointing to the Payments fee approval record, `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true`, a `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the live Stripe money operations record, approved launch supply measurement evidence, `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, approved Tax readiness evidence, Stripe live-mode keys, embedded dashboard-none Connect payout setup proof on `https://marketplace.chasesets.com/account/payouts/setup`, EasyPost production mode, and complete Amazon SES transactional email configuration. Tax readiness may approve a no-provider launch only while state-by-state nexus tracking shows no jurisdiction requires collection; set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` before collecting sales tax in any jurisdiction. Keep the public switch off while production remains landing/admin-support only and run the [Marketplace Launch Evidence](./marketplace-launch-evidence.md) verifier before setting approval variables.
- `STRIPE_API_BASE_URL` is optional and should normally be unset outside adapter tests or controlled sandbox endpoints.
- Money Health must show provider diagnostics, platform balance forecast, payout issues, and reconciliation history.
- Payout Operations must show recent provider idempotency keys.
- Payment webhooks must cover checkout completion, async failure, expiration, refunds, and disputes.
- Stored-payment webhooks must cover setup success, setup failure, payment-method detach, and saved-during-payment capture facts. Reconciliation must compare Payments-owned Saved Checkout Instruments with Stripe PaymentMethod state and mark stale methods `setup-required` or `removed` without deleting historical payment references.
- Connect webhooks must cover account/readiness updates, `payout.paid`, and `payout.failed`.
- Support must be able to open structured buyer and seller order issues before production marketplace launch, because support holds can block settlement release and support resolutions can produce refunds.
- Run `pnpm run verify` before deployment. DB-backed rollout checks belong in `pnpm run verify:db` when database compatibility is in scope.

## Local Stripe Runtime

The platform API can run with either the real Stripe gateway or the fake local payment gateway.

Stripe mode uses:

- `STRIPE_SECRET_KEY`: server-side Stripe API key used to create and update payment intents.
- `STRIPE_PUBLISHABLE_KEY`: buyer-facing Stripe key returned with payment intent client data.
- `STRIPE_WEBHOOK_SECRET`: signing secret used to verify inbound Stripe Payments webhook payloads.
- `STRIPE_CONNECT_WEBHOOK_SECRET`: signing secret used to verify inbound Stripe Connect money-movement webhook payloads.
- `STRIPE_API_BASE_URL`: optional override for Stripe API calls in non-default environments or tests.

For local development, keep real Stripe values in `deployables/platform-api/.env.local` when you want to exercise real Stripe flows. If any required Stripe value is missing, the platform API falls back to the fake payment gateway so local startup works without webhook forwarding.

Webhook callbacks are mounted by the platform API at `/api/payments/provider/webhooks`. The account payment routes stay under `/api/marketplace/account/payments`.

When the dev stack includes `platform-api`, `pnpm run dev` starts the Dockerized Stripe listener automatically if `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` are present in `deployables/platform-api/.env.local`. The dev system waits for that listener to emit its session-specific webhook signing secret, writes `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` into the current worktree's `.env.sandbox.local`, and then starts `platform-api` so the API comes up on the real Stripe gateway. You can still run `pnpm run stripe:listen` manually if you want the listener in a separate terminal; it forwards payment events to `/api/payments/provider/webhooks` and Connect events to `/api/settlement/provider/money-movement/webhooks` by default.

## Stripe Connect Notes

- The target account experience is documented in [ADR 0006: Stripe Connect Custom Account Experience](../adr/0006-stripe-connect-custom-account-experience.md). Chase Sets is migrating from Express-dashboard hosted setup to embedded payout setup and payout account management.
- Target connected accounts use Stripe Accounts v2 recipient configuration with no Stripe-hosted dashboard access. In Stripe terms, accounts should resolve to `dashboard: "none"`, `defaults.responsibilities.losses_collector: "application"`, `defaults.responsibilities.fees_collector: "application"`, and `defaults.responsibilities.requirements_collector: "application"`.
- The Stripe Connect adapter creates new payout accounts with `dashboard: "none"` and returns embedded Account Session client secrets for payout setup and payout account management. Hosted Account Links and Express login links are compatibility paths only during migration.
- Payout setup and payout account management should be Chase Sets-hosted pages that create Stripe Account Sessions and render Connect embedded components. Account Session client secrets are response-only browser credentials and must not be persisted.
- Configure platform API with `STRIPE_SECRET_KEY` and `STRIPE_CONNECT_WEBHOOK_SECRET` for Stripe Connect money movement; production startup fails without the separate Payments and Connect webhook secrets.
- Legacy hosted Account Link compatibility URLs are `STRIPE_CONNECT_RETURN_URL` and `STRIPE_CONNECT_REFRESH_URL`; embedded setup and account-management sessions should use Chase Sets payout setup pages instead.
- During the migration, hosted Account Links and Express login links may remain as compatibility paths for existing connected accounts. New account-facing product copy should use payout setup and payout account management rather than Express Dashboard terminology.
- Existing connected accounts whose provider posture reports `dashboard: "express"` or `dashboard: "full"` are grandfathered until Support and Operations review the account. Do not automatically mutate dashboard access or create replacement connected accounts for a payout-ready account.
- Settlement records provider-neutral account posture from Stripe readiness refreshes and account webhooks: dashboard access, losses collector, fees collector, and requirements collector. Target custom accounts report `dashboard: "none"` and all collectors as `application`. `express`, `full`, and `unknown` are migration/manual-review signals.
- Settlement never collects or stores payout destination account numbers, tax identity details, verification documents, Account Session client secrets after response, webhook signatures, raw provider payloads, or hosted-dashboard credentials.
- Stripe-connected accounts are configured for manual payout schedules by the Stripe adapter so marketplace payouts remain account-requested and settlement-triggered.
- Public account payout APIs can create embedded setup/account-management sessions, refresh readiness, preview payouts, and request payouts. Provider readiness cannot be manually overwritten through public account routes.
- Payout requests use a preview/confirmation step, enforce USD-only amount policy, and keep payout destination details inside Stripe embedded components.
- Legacy hosted setup redirects must stay on the marketplace origin while that compatibility path exists, and provider webhook signatures are verified with a timestamp tolerance to reduce replay risk.
- Hosted onboarding Account Links are compatibility-only and single-use. Every legacy onboarding start, retry, browser refresh, or Stripe refresh-url return must create a fresh Account Link; do not reuse an idempotency key that is scoped only to the seller account.
- Processed provider webhook event ids are stored so duplicate provider events are ignored and auditable.
- Stripe stays behind the money movement adapter. Settlement owns wallet debits, payout requests, failure reversals, read models, and reconciliation decisions; Stripe owns embedded payout setup components, external payout destination collection, transfer execution, connected-account payout execution, and webhook signing.
- Register provider webhooks for `v2.core.account[requirements].updated`, `v2.core.account.updated`, `payout.paid`, and `payout.failed`. Settlement consumes them through the unauthenticated provider webhook mount and maps them into provider-neutral payout/readiness events.
- Existing payout readiness and payout read models backfill provider fields with nullable references and conservative setup defaults, so old rows remain readable.

### Existing Express Account Migration Policy

Default policy: grandfather existing hosted-dashboard connected accounts and keep compatibility paths available while all new payout accounts use the embedded custom account experience. This protects accounts that are already payout-ready from losing payout ability during the migration.

Do not replace or mutate an existing Stripe connected account automatically. A replacement account can strand readiness history, payout destination state, and support context; an in-place dashboard/responsibility change is not assumed safe unless Stripe confirms it for the specific account class and the result is captured in the external operations record.

Operator flow:

1. Deploy the provider-posture read-model columns before running the report.
2. Refresh payout readiness or replay recent Connect account webhooks so the report has current dashboard/responsibility facts.
3. Run the read-only report against preview or staging:

```bash
pnpm run settlement:payout-account-migration-report -- --database-url "$SETTLEMENT_DATABASE_URL" --environment staging --checked-at "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

4. Review every `legacy-hosted-dashboard`, `manual-review-provider-posture`, and `responsibility-mismatch` candidate before enabling broad custom-account rollout.
5. For payout-ready legacy accounts, keep hosted setup/account-management compatibility available until the support-approved migration path is complete.
6. Store the report output in the external Stripe money operations evidence record; do not commit provider account ids tied to real accounts to the repository.

## Shared Stripe Sandbox Environments

Staging is the complete Stripe sandbox proof environment. PR previews and remote
dev sessions are useful for API, browser, Connect setup-session, and synthetic
webhook-signature checks, but they are not complete Stripe-delivered webhook
proof unless their dynamic webhook endpoint lifecycle is automated.

Staging Stripe webhook endpoints:

- Payments: `https://marketplace.staging.chasesets.com/api/payments/provider/webhooks`
- Connect money movement: `https://marketplace.staging.chasesets.com/api/settlement/provider/money-movement/webhooks`

GitHub environment configuration:

| Environment | Required Stripe secrets | Required Stripe variables | Webhook proof expectation |
| --- | --- | --- | --- |
| `preview` | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` using Stripe test-mode values | none | Signed webhook probes and seller-flow smoke only. No Stripe Dashboard endpoint is created for dynamic PR domains. |
| `staging` | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` using a dedicated Stripe test-mode sandbox configuration | `STAGING_STRIPE_PAYMENT_WEBHOOK_DELIVERY_EVENT_ID`, `STAGING_STRIPE_CONNECT_WEBHOOK_DELIVERY_EVENT_ID`, `STAGING_STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE`; optional `STAGING_SMOKE_ORDER_IDS`, `STAGING_SMOKE_BALANCE_CREDIT_AMOUNT`, `STAGING_SMOKE_PAYMENT_METHOD_CATEGORY`, `STAGING_SMOKE_CREATE_PAYMENT`, `STAGING_SMOKE_PAYOUT_AMOUNT`, `STAGING_SMOKE_REQUEST_PAYOUT` | Required. The staging deploy refuses to pass without recorded Stripe-delivered Payments and Connect webhook evidence references. |
| `production` | Stripe live-mode secrets only when production marketplace proof or public marketplace traffic is enabled | Production launch evidence and Stripe money operations approval variables | Live proof only under the production proof controls below. |

For staging, create or confirm the two Stripe Dashboard test-mode webhook
destinations above, trigger one representative Payments event and one Connect
money-movement event, confirm the matching provider event rows in Chase Sets,
then update the staging GitHub Environment variables with the redacted event ids
and external evidence record reference. The smoke test records those references
under `webhookChecks.stripeDelivered`; its `webhookChecks.signedProbe` object is
only a local signature and routing probe.

## Stripe Money Smoke Test

Use the executable smoke test before enabling Stripe money movement in a shared or production-like environment. It runs with Stripe test keys by default. Live-key runs are allowed only for approved production proof collection and require an explicit launch evidence reference.

Required environment:

- `PLATFORM_API_BASE_URL`
- `STRIPE_SECRET_KEY` using a `sk_test` key, or a `sk_live` key only when `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`
- `STRIPE_PUBLISHABLE_KEY` using a matching `pk_test` key, or a `pk_live` key only when `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`
- `STRIPE_CONNECT_RETURN_URL`
- `STRIPE_CONNECT_REFRESH_URL`

Optional shared-environment proof variables:

- `STRIPE_MONEY_SMOKE_ENVIRONMENT`: `preview`, `staging`, `production-proof`, or another operator label printed in the smoke output.
- `STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS=true`: requires recorded Stripe-delivered webhook proof before the smoke run proceeds.
- `STRIPE_PAYMENT_WEBHOOK_DELIVERY_EVENT_ID`: redacted Stripe `evt_` id observed through the Payments provider webhook destination.
- `STRIPE_CONNECT_WEBHOOK_DELIVERY_EVENT_ID`: redacted Stripe `evt_` id observed through the Connect money-movement webhook destination.
- `STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE`: external evidence record that ties the delivered event ids to the Stripe Dashboard destination configuration and Chase Sets provider event rows.

For private production proof with live keys, use `operatorSetup.stripeMoneySmokeEnvironmentCommands` from `pnpm run marketplace:production-proof-readiness` for the private live smoke shell, choose one `operatorSetup.stripeMoneySmokeAuthenticationOptions` entry for seller-flow authentication, then run `operatorSetup.stripeMoneySmokeCheckCommand` before the live smoke command. If the current smoke command still checks legacy hosted Connect return/refresh variables, set `operatorSetup.stripeMoneySmokeLegacyHostedCompatibilityCommands` as compatibility inputs only; final launch evidence uses the embedded payout setup page and not Connect return/refresh URLs.

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

- `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`: permits a live-key production proof run only when `PLATFORM_API_BASE_URL` is `https://chasesets.com` or `https://admin.chasesets.com`, `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` or `PRODUCTION_MARKETPLACE_PROOF_REFERENCE` is set, and the Connect return/refresh URLs are on the same origin as `PLATFORM_API_BASE_URL`.
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

For live-key proof, the `--check-env` output must show `"ok": true` and an empty `readinessErrors` array before running `--edge-check` or `--seller-flow`. The preflight reports readiness errors for mismatched Stripe key modes, missing live-proof references, missing `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`, non-production live API origins, and Connect return/refresh URLs that do not match the private proof API origin.

The smoke JSON distinguishes webhook coverage:

- `webhookChecks.signedProbe`: the script posted signed and unsigned probe payloads directly to Chase Sets endpoints. This proves route reachability and signature validation only.
- `webhookChecks.stripeDelivered`: operator-supplied evidence that Stripe delivered real test-mode or live-mode events to the configured webhook destinations. Staging requires this proof; PR previews do not.

For private production proof, create the pending-payment order ids before running the live-key payment smoke:

```bash
pnpm run marketplace:deferred-checkout-order-proof -- --request ./redacted-live-checkout-request.json --reference STRIPE-MONEY-OPS-2026-05-30 --operator ops@chasesets.com
```

The command requires `PLATFORM_API_AUTHORIZATION` or `PLATFORM_API_COOKIE`, `DEFERRED_CHECKOUT_ORDER_PROOF_ALLOW_PRODUCTION=true`, a production proof reference, an operator, and a request JSON with `proofInputReference`. The request JSON contains the operator-controlled buy-now `source` and `shippingAddress`; the command starts the checkout session, confirms it with `deferPayment: true`, and prints `orderIdsCsv` for `SMOKE_ORDER_IDS`. The evidence fails closed unless the proof reference and proof input reference are real evidence records, `checkedAt` is an ISO timestamp, the target is `https://chasesets.com` or `https://admin.chasesets.com`, the checkout session id is present, returned order ids are non-empty and unique, and confirmation returns `orders-created`. Run `pnpm run marketplace:production-proof-topology-evidence` first; it must prove both the checkout session create route and the dynamic confirm route no longer return `404`.

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
- Embedded payout setup returns a short-lived Account Session client secret for dashboard-none accounts; hosted setup remains a compatibility path for grandfathered legacy accounts.
- Payout setup refresh returns the provider-neutral readiness shape.
- Payout preview returns either `200` with `can_request` details or a validation `400` with a user-safe reason.
- When `SMOKE_REQUEST_PAYOUT=true`, payout request returns `201` after a successful `can_request` preview.

Stripe Dashboard checks:

- Confirm the platform account is pinned to API version `2026-03-25.dahlia`.
- Confirm Connect is enabled for Accounts v2 and recipient onboarding.
- Configure payment webhook delivery for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.processing`, `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, and `charge.dispute.closed`.
- Configure Connect webhook delivery for `v2.core.account[requirements].updated`, `v2.core.account.updated`, `payout.paid`, and `payout.failed`.
- Create a test checkout and confirm the internal payment id appears in Stripe Checkout Session and PaymentIntent metadata.
- Request a payout and confirm Stripe shows a transfer with transfer group `payout:<internal payout id>` followed by a connected-account payout.
- Replay the same webhook event from the Stripe Dashboard and confirm the API reports it as ignored without duplicate ledger entries.

## Production Stripe Money Operations Proof

Set `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true` only after the production GitHub Environment has live-mode Stripe keys, production Connect URLs, and a non-empty `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the approved launch evidence record. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` until this record and every other production gate are complete.

The evidence record must include:

- Stripe account and Dashboard posture: API version `2026-03-25.dahlia`, live-mode keys scoped to production, Connect enabled for Accounts v2 recipient onboarding, manual payout schedules, payment webhooks registered at `/api/payments/provider/webhooks`, Connect money-movement webhooks registered at `/api/settlement/provider/money-movement/webhooks`, Radar/Radar for Platforms rules reviewed, and no `STRIPE_API_BASE_URL` override unless an approved provider endpoint exception exists.
- Live checkout proof: a controlled production checkout or provider-approved live-mode rehearsal showing internal payment id metadata on the Checkout Session and PaymentIntent, successful authorization/capture mapping into Payments, correct Marketplace Checkout Fee allocation, and no raw card data stored in Chase Sets.
- Refund and dispute proof: at least one controlled refund path, replay-safe refund webhook handling, `charge.dispute.created` and `charge.dispute.closed` coverage, seller refund debit evidence in Settlement, seller dispute hold evidence, dispute hold release evidence for a won dispute, and Finance-owned accounting notes for partial refunds, lost disputes, and recovered disputes.
- Connect account proof: embedded dashboard-none payout setup and payout account management on `https://marketplace.chasesets.com`, short-lived Account Session creation, Connect.js/component rendering, requirement/readiness refresh, account/readiness webhook handling, provider-neutral readiness status shown to the account, and a separate legacy hosted-dashboard migration report reference for any existing Express/full-dashboard accounts.
- Payout proof: payout preview, platform balance forecast, transfer with transfer group `payout:<internal payout id>`, connected-account payout creation, `payout.paid`, `payout.failed`, failure reversal, and idempotent retry evidence.
- Reconciliation proof: payment reconciliation, payout reconciliation, duplicate provider webhook replay, provider event inbox idempotency, at least five redacted `payments_provider_webhook_events` rows covering checkout completion/failure/expiration/refund/dispute, at least two redacted `settlement_money_movement_webhook_events` rows covering readiness and payout failure or completion, and ledger entries matching provider balances and wallet timelines.
- Operations proof: Money Health, Payout Operations, support escalation, platform balance funding, provider outage rollback, and disabled/frozen payout actions rehearsed with named operators.

Do not commit live payment IDs tied to private buyers, connected-account IDs tied to real sellers, card/bank details, webhook signatures, Stripe payload bodies, Dashboard screenshots with sensitive account data, or secret values. Store redacted evidence in the external launch record referenced by `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE`.

Use `pnpm run marketplace:stripe-money-operations-evidence` with the redacted live proof record to produce the `gates.stripeMoneyOperations` fields for the launch evidence packet. The proof record must include `proofCompletedAt` and `connectCustomAccountProofCompletedAt`; rerun the live Stripe or custom Connect proof when either timestamp is older than 30 days at launch review. The command fails the gate unless Stripe proof is live-mode, current, uses the pinned `2026-03-25.dahlia` API version, includes separate production Chase Sets payment and Connect webhook destinations, proves the production embedded payout setup page at `/account/payouts/setup` with a screenshot or redacted run output, has at least one live connected account and at least one live `dashboard: "none"` connected account, proves dashboard access `none`, fees/losses/requirement collection all owned by `application`, includes at least two fresh embedded setup sessions for the same account, confirms no raw sensitive provider data is stored, includes legacy hosted-dashboard account counts from the migration report, includes concrete live Stripe object IDs for the PaymentIntent, Checkout Session, refund, dispute, connected account, payout-failure payout, payout-failure balance transaction, and platform-funding balance transaction, includes at least five Payments `evt_` IDs and at least two Settlement money-movement `evt_` IDs matched to the provider webhook rows, includes concrete evidence references for checkout, refund, dispute, embedded custom Connect proof, setup sessions, payout setup page, readiness refresh, account webhook rows, sensitive-data review, legacy migration report, payout readiness, payout preview/request, transfer plus connected-account payout, payout failure reversal, reconciliation, platform balance funding, webhook replay, Payments provider event query, Settlement money-movement provider event query, and Radar/risk posture, includes the required provider webhook row counts from both bounded contexts, and proves every required money workflow.

When `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true` and `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`, broad marketplace traffic stays closed, but production root/admin domains route the narrow authenticated Checkout, Ordering, Payments, and Settlement proof APIs needed for this record to `platform-api`. Use those private proof APIs only with operator-controlled accounts and orders tied to the external evidence record; they are not public launch surfaces. To create live `SMOKE_ORDER_IDS` without charging a buyer first, create an operator-controlled buy-now checkout session from a recorded proof input, confirm it with `deferPayment: true`, attach the returned order ids and command output to the external proof record, then run the Stripe money smoke with those order ids, `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`, and `SMOKE_CREATE_PAYMENT=true` only when the approved live payment rehearsal is ready.

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
4. If Stripe reports an external account or requirement issue, ask the account operator to continue payout setup through the embedded payout setup page.
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
2. If requirements remain missing, create a fresh embedded setup session.
3. If the embedded Account Session expired, send the account operator through the payout setup page again so a new session is generated after authentication.
4. Do not collect bank account, tax, identity, or other sensitive payout details in the app.

## Stuck Checkout

1. Check checkout status for blocking reason codes.
2. Check the payment timeline and provider event record.
3. Use deterministic checkout recovery for duplicate or interrupted submits.
4. Run payment reconciliation for stale provider status.
5. Keep card, bank, and wallet payment details inside Stripe-hosted or Stripe-managed confirmation surfaces.

## Refunds And Disputes

1. Confirm the provider event and provider object reference.
2. Confirm the wallet timeline shows the expected seller refund debit, dispute hold, dispute release, or reversal.
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
