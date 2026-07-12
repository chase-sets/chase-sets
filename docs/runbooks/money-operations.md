# Money Operations Runbook

This runbook covers checkout, wallet, Stripe payments, Connect payouts, transfers, provider webhooks, launch checks, and smoke tests. Settlement remains the wallet source of truth; Payments owns payment and refund state for purchasing accounts; Stripe owns payment method handling, embedded payout setup components, external account collection, transfers, payouts, and provider risk controls.

## System Boundaries

- `@chase-sets/payment-processing` defines the provider-neutral payment processor port.
- `@chase-sets/money-movement` defines the provider-neutral payout and Connect money movement port.
- Fake adapters are local/test only. Production must use the Stripe payment and Stripe Connect money-movement adapters.
- Stripe adapters live in infrastructure packages. Deployables compose adapters into bounded-context runtimes.
- Bounded contexts store provider references, statuses, and support-safe failure messages, not bank account numbers, tax identity details, card data, secrets, webhook signatures, raw provider payloads, processor client secrets, Account Session client secrets after response, or internal auth context.
- Provider webhooks use raw-body signature verification and idempotent provider event recording before state transitions.

## Charge And Funds Strategy

- Checkout creates one embedded provider-managed payment session per internal payment, with wallet balance credit applied before the external payment amount is sent to the processor.
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

- Required environment: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET`, and `STRIPE_CONNECT_ACCOUNTS_API`.
- Production marketplace launch additionally requires `PRODUCTION_MARKETPLACE_PROMOTION_APPROVED=true`, a `PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE` pointing to the final launch review record, `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED=true`, a `PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE` pointing to the Payments fee approval record, `PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_APPROVED=true`, a `PRODUCTION_CHECKOUT_LAUNCH_EVIDENCE_REFERENCE` pointing to the Checkout readiness record, `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true`, a `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the live Stripe money operations record, approved launch supply measurement evidence, `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, approved Tax readiness evidence, Stripe live-mode keys, embedded dashboard-none Connect payout setup proof on `https://marketplace.chasesets.com/account/payouts/setup`, EasyPost production mode, and complete Amazon SES transactional email configuration. Tax readiness may approve a no-provider launch only while state-by-state nexus tracking shows no jurisdiction requires collection; set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true` before collecting sales tax in any jurisdiction. Keep the public switch off while production remains landing-profile only.
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
- `STRIPE_CONNECT_WEBHOOK_SECRET`: distinct signing secret used to verify inbound Stripe Connect money-movement webhook payloads. Staging startup fails if this variable is missing; it must not silently reuse `STRIPE_WEBHOOK_SECRET`.
- `STRIPE_CONNECT_ACCOUNTS_API`: connected payout-account API posture. Use `v1` for launch while Accounts v2 approval is pending; use `v2` only after provider approval and migration readiness are complete.
- `STRIPE_API_BASE_URL`: optional override for Stripe API calls in non-default environments or tests.

For local development, keep real Stripe values in `deployables/platform-api/.env.local` when you want to exercise real Stripe flows. If any required Stripe value is missing, the platform API falls back to the fake payment gateway so local startup works without webhook forwarding.

Webhook callbacks are mounted by the platform API at `/api/payments/provider/webhooks`. The account payment routes stay under `/api/marketplace/account/payments`.

When the dev stack includes `platform-api`, `pnpm run dev` starts the Dockerized Stripe listener automatically if `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY` are present in `deployables/platform-api/.env.local`. The dev system waits for that listener to emit its session-specific webhook signing secret, writes `STRIPE_WEBHOOK_SECRET` and `STRIPE_CONNECT_WEBHOOK_SECRET` into the current worktree's `.env.sandbox.local`, and then starts `platform-api` so the API comes up on the real Stripe gateway. You can still run `pnpm run stripe:listen` manually if you want the listener in a separate terminal; it forwards payment events to `/api/payments/provider/webhooks` and Connect events to `/api/settlement/provider/money-movement/webhooks` by default.

## Stripe Connect Notes

- The target account experience is documented in [ADR 0006: Stripe Connect Custom Account Experience](../adr/0006-stripe-connect-custom-account-experience.md). The Accounts API boundary is documented in [ADR 0014: Stripe Connect Accounts API Boundary](../adr/0014-stripe-connect-accounts-api-boundary.md). Chase Sets uses embedded payout setup and payout account management for launch.
- Target connected accounts use dashboard-none, application-collected payout setup. With `STRIPE_CONNECT_ACCOUNTS_API=v1`, proof must show `controller[stripe_dashboard][type]=none`, `controller[losses][payments]=application`, `controller[fees][payer]=application`, and `controller[requirement_collection]=application`. With `v2`, the equivalent proof is Accounts v2 recipient configuration with `dashboard: "none"` and `defaults.responsibilities.* = "application"`.
- The Stripe Connect adapter creates payout accounts with `dashboard: "none"` and returns embedded Account Session client secrets for payout setup and payout account management.
- Payout setup and payout account management should be Chase Sets-hosted pages that create Stripe Account Sessions and render Connect embedded components. Account Session client secrets are response-only browser credentials and must not be persisted.
- Configure platform API with `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, and `STRIPE_CONNECT_ACCOUNTS_API` for Stripe Connect money movement; production startup fails without the separate Payments and Connect webhook secrets, and invalid Accounts API values fail closed.
- Hosted Account Links and Express login links are not launch-supported payout setup or account-management paths.
- Existing connected accounts whose provider posture reports `dashboard: "express"` or `dashboard: "full"` are launch blockers until Support and Operations either clean them up or approve a fresh dashboard-none connected payout account outside checkout.
- Settlement records provider-neutral account posture from Stripe readiness refreshes and account webhooks: dashboard access, losses collector, fees collector, and requirements collector. Target custom accounts report `dashboard: "none"` and all collectors as `application`. `express`, `full`, and `unknown` are migration/manual-review signals.
- Settlement never collects or stores payout destination account numbers, tax identity details, verification documents, Account Session client secrets after response, webhook signatures, raw provider payloads, or provider dashboard credentials.
- Stripe-connected accounts are configured for manual payout schedules by the Stripe adapter so marketplace payouts remain account-requested and settlement-triggered.
- Buyer payments remain platform-held: payment creation must not set Stripe `transfer_data`, `on_behalf_of`, direct connected-account charge headers, or destination-charge behavior. On-demand payouts move funds later through a platform-balance transfer to the connected account followed by a connected-account payout in that account context.
- Public account payout APIs can create embedded setup/account-management sessions, refresh readiness, preview payouts, and request payouts. Provider readiness cannot be manually overwritten through public account routes.
- Payout requests use a preview/confirmation step, enforce USD-only amount policy, and keep payout destination details inside Stripe embedded components.
- Provider webhook signatures are verified with a timestamp tolerance to reduce replay risk.
- Processed provider webhook event ids are stored so duplicate provider events are ignored and auditable.
- Stripe stays behind the money movement adapter. Settlement owns wallet debits, payout requests, failure reversals, read models, and reconciliation decisions; Stripe owns embedded payout setup components, external payout destination collection, transfer execution, connected-account payout execution, and webhook signing.
- Register provider webhooks for the selected Connect Accounts API plus `payout.paid` and `payout.failed`. Accounts v1 requires `account.updated`; Accounts v2 requires `v2.core.account[requirements].updated` and `v2.core.account.updated`. Settlement consumes them through the unauthenticated provider webhook mount and maps them into provider-neutral payout/readiness events.
- Existing payout readiness and payout read models backfill provider fields with nullable references and conservative setup defaults, so old rows remain readable.

### Fresh Launch Provider Posture

Default policy: launch only with embedded dashboard-none connected payout accounts. Chase Sets is unreleased, so there is no customer-visible hosted account base to preserve.

Do not replace or mutate a provider account automatically during checkout or payout setup. If a connected account reports `dashboard: "express"`, `dashboard: "full"`, or responsibility collectors outside the target `application` posture, treat it as launch cleanup outside checkout. Support and Operations can either retire the test account, create a fresh dashboard-none connected payout account for the account, or block production money operations approval until the posture is resolved.

Operator flow:

1. Refresh payout readiness or replay recent Connect account webhooks so provider posture facts are current.
2. Review any non-dashboard-none or responsibility-mismatch posture in the private money operations evidence workspace.
3. Keep checkout, cart, Sell List, and payout setup from becoming a migration surface; provider cleanup happens before launch approval, not during customer checkout.

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
| `staging` | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` using a dedicated Stripe test-mode sandbox configuration | Optional `STAGING_SMOKE_ORDER_IDS`, `STAGING_SMOKE_BALANCE_CREDIT_AMOUNT`, `STAGING_SMOKE_PAYMENT_METHOD_CATEGORY`, `STAGING_SMOKE_CREATE_PAYMENT`, `STAGING_SMOKE_PAYOUT_AMOUNT`, `STAGING_SMOKE_REQUEST_PAYOUT` | The staging deploy validates runtime Stripe configuration and seller-flow smoke only. Stripe Dashboard-delivered webhook proof is launch evidence, not deploy configuration. |
| `production` | Stripe live-mode secrets only when production marketplace proof or public marketplace traffic is enabled | Production launch evidence and Stripe money operations approval variables | Live proof only under the production proof controls below. |

For staging, create or confirm the two Stripe Dashboard test-mode webhook
destinations above, trigger one representative Payments event and one Connect
money-movement event, confirm the matching provider event rows in Chase Sets,
then store the Stripe `evt_...` ids, destination configuration, provider row
query output, checked-at timestamp, operator, and commit/run reference in the
private evidence store and reference that record from the staging sandbox smoke
or launch readiness records. Do not store raw Stripe event ids or one-time webhook
delivery references as GitHub Environment variables; they are evidence facts,
not deploy configuration. For a private evidence-only smoke run, set
`STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS=true` and pass the record through
the ephemeral `STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE` process environment.
The smoke test records the reference under `webhookChecks.stripeDelivered`; its
`webhookChecks.signedProbe` object is only a local signature and routing probe.

## Stripe Money Smoke Test

Use the executable smoke test before enabling Stripe money movement in a shared or production-like environment. It runs with Stripe test keys by default. Live-key runs are allowed only for approved production proof collection and require an explicit launch evidence reference.

Required environment:

- `PLATFORM_API_BASE_URL`
- `STRIPE_SECRET_KEY` using a `sk_test` key, or a `sk_live` key only when `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`
- `STRIPE_PUBLISHABLE_KEY` using a matching `pk_test` key, or a `pk_live` key only when `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CONNECT_WEBHOOK_SECRET`

Optional shared-environment proof variables:

- `STRIPE_MONEY_SMOKE_ENVIRONMENT`: `preview`, `staging`, `production-proof`, or another operator label printed in the smoke output.
- `STRIPE_MONEY_SMOKE_REQUIRE_DELIVERED_WEBHOOKS=true`: requires recorded Stripe-delivered webhook proof before the smoke run proceeds.
- `STRIPE_WEBHOOK_DELIVERY_EVIDENCE_REFERENCE`: private evidence record that ties the delivered Stripe `evt_...` ids to the Stripe Dashboard destination configuration and Chase Sets provider event rows.

For live production smoke, set `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`, point `PLATFORM_API_BASE_URL` and `MARKETPLACE_WEB_BASE_URL` at the approved production host, authenticate with an operator-controlled seller session, run `pnpm run stripe:money-smoke -- --check-env`, then run the approved live smoke command. Final launch evidence uses the embedded payout setup page.

The authenticated seller-flow smoke creates an embedded payout setup Account
Session and then refreshes provider-neutral payout readiness. The smoke fails
unless the refreshed readiness matches the Account Session provider reference,
reports `payout_account_dashboard: "none"`, and reports
`losses_collector`, `fees_collector`, and `requirements_collector` as
`application`. Passing output includes `sellerFlow.embeddedDashboardNone` as
the sandbox proof summary for embedded dashboard-none setup over
hosted setup. The smoke still redacts Account Session client secrets
and reports only `clientSecretPresent: true`.

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

- `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`: permits a live-key production proof run only when `PLATFORM_API_BASE_URL` is `https://chasesets.com` or `https://admin.chasesets.com` and `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` or `PRODUCTION_MARKETPLACE_PROOF_REFERENCE` is set.
- `SMOKE_REGISTER_SELLER=true`: legacy smoke variable name; registers a new owner account before checking payout flows.
- `SMOKE_AUTH_READY_ATTEMPTS`: number of sign-in retries after disposable account registration. Defaults to `24`.
- `SMOKE_AUTH_READY_RETRY_DELAY_MS`: delay between post-registration sign-in retries. Defaults to `5000`.
- `SMOKE_SELLER_EMAIL`: legacy smoke variable name for the preview account email used for sign-in or registration.
- `SMOKE_SELLER_PASSWORD`: legacy smoke variable name for the preview account password used for sign-in or registration.
- `SMOKE_SELLER_ACCOUNT_ID`: legacy smoke variable name for the account to select when the user has multiple memberships.
- `SMOKE_PAYOUT_READINESS_ATTEMPTS`: number of payout setup readiness refresh attempts after embedded Account Session creation. Defaults to `12`.
- `SMOKE_PAYOUT_READINESS_RETRY_DELAY_MS`: delay between payout setup readiness refresh attempts. Defaults to `5000`.
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

For live-key proof, the `--check-env` output must show `"ok": true` and an empty `readinessErrors` array before running `--edge-check` or `--seller-flow`. The preflight reports readiness errors for mismatched Stripe key modes, missing live-proof references, missing `STRIPE_MONEY_SMOKE_ALLOW_LIVE=true`, and non-production live API origins.

The smoke JSON distinguishes webhook coverage:

- `webhookChecks.signedProbe`: the script posted signed and unsigned probe payloads directly to Chase Sets endpoints. This proves route reachability and signature validation only.
- `webhookChecks.stripeDelivered`: operator-supplied evidence that Stripe delivered real test-mode or live-mode events to the configured webhook destinations. Staging requires this proof; PR previews do not.

For live-key proof, create any `SMOKE_ORDER_IDS` through the normal controlled checkout path. Do not use deferred-payment or helper-only checkout payloads; final confirmation must use the same payment quote and confirmation behavior as the product flow.

`--seller-flow` is the existing command name for the authenticated payout-readiness smoke path; it does not create a separate seller account identity.

Expected results:

- `/health` returns `200`.
- Unsigned payment and money movement webhooks return `400`.
- Settlement provider health reports Stripe.
- Payout provider idempotency surfaces return successfully.
- Settlement account status reports whether wallet balance credit can be used.
- Marketplace Checkout Fee policy returns successfully.
- When `SMOKE_ORDER_IDS` is set, checkout status returns wallet credit and Marketplace Checkout Fee details.
- When `SMOKE_CREATE_PAYMENT=true`, payment creation returns `201`.
- Payout readiness returns `200` for an authenticated account with payout permissions.
- Embedded payout setup returns a short-lived Account Session client secret for dashboard-none accounts.
- Payout setup refresh returns the provider-neutral readiness shape.
- Payout preview returns either `200` with `can_request` details or a validation `400` with a user-safe reason.
- When `SMOKE_REQUEST_PAYOUT=true`, payout request returns `201` after a successful `can_request` preview.

Stripe Dashboard checks:

- Confirm the platform account is pinned to the shared `STRIPE_API_VERSION` from `infrastructure/stripe-config`.
- Confirm Connect is enabled for the selected Accounts API posture and embedded recipient onboarding. For v1 launch proof, capture the dashboard-none controller-property evidence; for v2 migration proof, capture the recipient configuration evidence.
- Configure payment webhook delivery for the events in `STRIPE_PAYMENT_WEBHOOK_EVENTS` from `infrastructure/stripe-config`.
- Configure Connect webhook delivery for `payout.paid`, `payout.failed`, and the account-readiness event names selected by `STRIPE_CONNECT_ACCOUNTS_API`: `account.updated` for Accounts v1; `v2.core.account[requirements].updated` and `v2.core.account.updated` for Accounts v2.
- Create a test checkout and confirm the internal payment id appears in Stripe Checkout Session and PaymentIntent metadata.
- Request a payout and confirm Stripe shows a transfer with transfer group `payout:<internal payout id>` followed by a connected-account payout.
- Replay the same webhook event from the Stripe Dashboard and confirm the API reports it as ignored without duplicate ledger entries.

## Custom Connect Release Hardening

Before approving production Stripe money operations, run a private release-hardening pass against the release commit and record the outcome in the external Stripe money operations evidence record. The record must show `connectReleaseHardeningOpenP0P2FindingCount: 0`, `connectReleaseHardeningFindingsResolved: true`, `stagingCustomConnectSandboxSmokeProven: true`, and `connectRollbackRehearsalProven: true`.

Use staging with Stripe test-mode keys as the complete sandbox proof environment. PR previews can prove routing, auth, embedded session creation, signed webhook probes, and UI behavior, but staging is the required environment for Stripe-delivered Payments and Connect webhook evidence.

| Stress case | Expected production behavior | Evidence to attach |
| --- | --- | --- |
| New account starts setup and abandons it | Readiness remains pending/restricted, no sensitive provider data is stored, and a later setup visit creates a fresh embedded Account Session. | Payout setup page output, readiness row, and setup session telemetry. |
| Account refreshes expired embedded session | Browser/session refresh requests a new Account Session; no stored client secret is reused. | Two fresh setup sessions for the same account and no persisted client secret evidence. |
| Provider webhook arrives before UI refresh | Provider event inbox records the webhook and payout readiness reflects provider-neutral status before the user reloads. | Settlement provider event row and payout readiness snapshot. |
| Duplicate webhook arrives | Duplicate event id is ignored without duplicate ledger entries, reversals, or readiness transitions. | Webhook replay output plus event inbox/idempotency query. |
| Provider requirement remains pending | Payout preview/request stay blocked with support-safe requirement groups; no raw requirement ids appear in account copy. | Payout readiness panel or operations screenshot/redacted output. |
| Connected-account payout fails after transfer | Payout failure is recorded, wallet debit is reversed exactly once, and support directs the account back to payout setup/account management. | Payout timeline, reversal ledger entry, and `payout.failed` webhook evidence. |
| Platform balance is insufficient | Payout request fails before wallet debit when possible; operators see platform balance forecast and funding evidence. | Money Health platform balance forecast and blocked request output. |
| User loses `payouts.setup` permission mid-flow | Setup APIs reject the action and no new Account Session is issued for the unauthorized actor. | Authz failure output from the setup route/API. |
| Provider posture is not dashboard-none or responsibility collectors are not application-owned | Launch approval stays blocked until Support and Operations resolve the provider account outside checkout. | Readiness refresh output plus cleanup decision in the private money operations evidence record. |
| Stripe outage during setup/session creation | Setup/session creation returns a user-safe recovery path; webhooks and readiness refresh remain safe to retry after recovery. | Provider outage drill notes plus setup failure telemetry category. |
| PR preview passes but staging webhook delivery proof fails | Production approval remains blocked until staging Stripe-delivered webhook proof is restored in the private evidence workspace. | Failed evidence-only smoke output or provider/dashboard observation, plus a follow-up passing webhook delivery record. |

Treat any P0-P2 finding from this pass as a release blocker. Fix the behavior, rerun the relevant focused test or smoke path, and update the hardening evidence record before setting `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true`.

## Production Stripe Money Operations Proof

Set `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true` only after the production GitHub Environment has live-mode Stripe keys, production Connect URLs, and a non-empty `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE` pointing to the approved launch evidence record. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` until this record and every other production gate are complete.

The evidence record must include `connectAccountsApi: "v1"` or `"v2"`. A v1 record is acceptable for launch when the same dashboard-none/application-owned posture is proven through controller properties; a v2 record remains the future migration target.

The evidence record must include:

- Stripe account and Dashboard posture: the shared `STRIPE_API_VERSION`, live-mode keys scoped to production, `STRIPE_CONNECT_ACCOUNTS_API` selected intentionally, Connect enabled for the selected Accounts API posture, manual payout schedules, payment webhooks registered at `/api/payments/provider/webhooks`, Connect money-movement webhooks registered at `/api/settlement/provider/money-movement/webhooks`, Radar/Radar for Platforms rules reviewed, and no `STRIPE_API_BASE_URL` override in production.
- Verify the Stripe Dashboard account-level statement descriptor prefix before launch; Payments sends the configured `CHASESETS` suffix on every card payment.
- Live checkout proof: a controlled production checkout or provider-approved live-mode rehearsal showing internal payment id metadata on the Checkout Session and PaymentIntent, successful authorization/capture mapping into Payments, correct Marketplace Checkout Fee allocation, and no raw card data stored in Chase Sets.
- Refund and dispute proof: at least one controlled refund path, replay-safe refund webhook handling, `charge.dispute.created` and `charge.dispute.closed` coverage, seller refund debit evidence in Settlement, seller dispute hold evidence, dispute hold release evidence for a won dispute, and Finance-owned accounting notes for partial refunds, lost disputes, and recovered disputes.
- Connect account proof: embedded dashboard-none payout setup and payout account management on `https://marketplace.chasesets.com`, short-lived Account Session creation, Connect.js/component rendering, requirement/readiness refresh, account/readiness webhook handling, and provider-neutral readiness status shown to the account.
- Payout proof: payout preview, platform balance forecast, transfer with transfer group `payout:<internal payout id>`, connected-account payout creation, `payout.paid`, `payout.failed`, failure reversal, and idempotent retry evidence.
- Reconciliation proof: payment reconciliation, payout reconciliation, duplicate provider webhook replay, provider event inbox idempotency, at least five redacted `payments_provider_webhook_events` rows covering checkout completion/failure/expiration/refund/dispute, at least two redacted `settlement_money_movement_webhook_events` rows covering readiness and payout failure or completion, and ledger entries matching provider balances and wallet timelines.
- Operations proof: Money Health, Payout Operations, support escalation, platform balance funding, custom Connect stress-case hardening with zero open P0-P2 findings, staging Stripe sandbox smoke, provider outage rollback, and disabled/frozen payout actions rehearsed with named operators.

Do not commit live payment IDs tied to private buyers, connected-account IDs tied to real sellers, card/bank details, webhook signatures, Stripe payload bodies, Dashboard screenshots with sensitive account data, or secret values. Store redacted evidence in the external launch record referenced by `PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE`.

Before assembling or refreshing the Stripe money operations record, run the read-only provider proof status report against the target bounded-context databases and attach the redacted output to the private evidence record:

```powershell
pnpm run marketplace:provider-proof-status -- --environment production --payments-database-url "$env:PAYMENTS_DATABASE_URL" --settlement-database-url "$env:SETTLEMENT_DATABASE_URL" --fulfillment-database-url "$env:FULFILLMENT_DATABASE_URL"
```

The report summarizes Payments provider webhook rows, Settlement money-movement rows, payout readiness posture, payout rows, and provider operations. It is status evidence only; it does not approve `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true` and does not replace the live Stripe money operations proof command.

Use `pnpm run ops marketplace:stripe-money-operations-evidence` with the redacted live proof record before setting `PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED=true`. The proof record must include `proofCompletedAt`, `connectCustomAccountProofCompletedAt`, and `connectAccountsApi`; rerun the live Stripe or custom Connect proof when either timestamp is older than 30 days at launch review. The command fails unless Stripe proof is live-mode, current, uses the shared `STRIPE_API_VERSION`, identifies `connectAccountsApi` as `v1` or `v2`, includes separate production Chase Sets payment and Connect webhook destinations, proves the production embedded payout setup page at `/account/payouts/setup` with a screenshot or redacted run output, has at least one live connected account and at least one live `dashboard: "none"` connected account, proves dashboard access `none`, fees/losses/requirement collection all owned by `application`, includes at least two fresh embedded setup sessions for the same account, confirms no raw sensitive provider data is stored, includes zero open P0-P2 custom Connect release-hardening findings, proves staging custom Connect sandbox smoke, proves custom Connect rollback rehearsal, includes concrete live Stripe object IDs for the PaymentIntent, Checkout Session, refund, dispute, connected account, payout-failure payout, payout-failure balance transaction, and platform-funding balance transaction, includes at least five Payments `evt_` IDs and at least two Settlement money-movement `evt_` IDs matched to the provider webhook rows, includes concrete evidence references for checkout, refund, dispute, embedded custom Connect proof, setup sessions, payout setup page, readiness refresh, account webhook rows, sensitive-data review, custom Connect release hardening, staging custom Connect sandbox smoke, custom Connect rollback rehearsal, payout readiness, payout preview/request, transfer plus connected-account payout, payout failure reversal, reconciliation, platform balance funding, webhook replay, Payments provider event query, Settlement money-movement provider event query, and Radar/risk posture, includes the required provider webhook row counts from both bounded contexts, and proves every required money workflow.

When `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true` and `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`, broad marketplace traffic stays closed, but production root/admin domains route the narrow authenticated Checkout, Ordering, Payments, and Settlement proof APIs needed for this record to `platform-api`. The same proof posture routes only `/account/payouts/setup` to marketplace-web so the live embedded dashboard-none Connect setup page can be proven before `marketplace.chasesets.com` is promoted. Use those private proof APIs and the proof payout setup page only with operator-controlled accounts and orders tied to the external evidence record; they are not public launch surfaces. Live `SMOKE_ORDER_IDS` must come from a controlled normal checkout path, and `SMOKE_CREATE_PAYMENT=true` should be used only when the approved live payment rehearsal is ready.

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

1. Check Settlement provider health and Stripe status.
2. Disable payout submissions before disabling webhook processing.
3. Keep accepting webhooks if signature verification is healthy.
4. Run reconciliation after recovery.
5. Do not switch production to fake adapters.

## Rollback

- Disable new payout setup/session creation first by turning off the account-facing setup entry point or guarding the setup-session endpoints; leave existing payout-ready accounts readable and do not delete provider references.
- Keep Stripe Payments and Connect webhook ingestion online as long as signature verification is healthy, even while setup/session creation or payout submission is disabled.
- Keep payout readiness refresh and reconciliation available for support/operator use; refreshes must remain provider-neutral and must not collect bank, tax, identity, or document data in Chase Sets.
- Do not mutate dashboard access, responsibilities, or connected-account ids as a rollback shortcut; disable setup/session creation or payout submission first.
- Disable payout request/submission actions before disabling webhook processing, and confirm any wallet debit that already happened has either an in-transit provider payout or an exactly-once reversal.
- Do not remove read-model columns during rollback.
- Do not switch production to fake payment, fake money movement, noop email, or sandbox postage adapters.
- After recovery, rerun staging Stripe money smoke, refresh provider readiness for canary accounts, replay/verify the provider event ids involved in the incident, and attach the rollback rehearsal result to the Stripe money operations record.
