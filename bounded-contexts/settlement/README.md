# Settlement Bounded Context

## Purpose

Settlement owns internal financial truth for marketplace balances and payouts.

## Owns

- Ledger entries
- Account balances and wallets
- Fee postings
- Rebate postings
- Payout eligibility
- Payout batches
- Statements and settlement summaries
- Financial reconciliation against Payments

## Does Not Own

- Card authorization and capture mechanics
- Shipment execution
- Listing prices

## Ubiquitous Language

Settlement terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Wallet
- Ledger Entry
- Payout
- Payout Batch

## Incoming Dependencies

- Ordering for commercial commitments
- Payments for charge and refund outcomes

## Outgoing Integration Events

- `LedgerEntryPosted`
- `AccountBalanceUpdated`
- `PayoutEligible`
- `PayoutRequested`
- `PayoutCompleted`
- `StatementPublished`

## Invariants

1. Settlement is the source of truth for what the marketplace owes or is owed.
2. Every balance change must be explainable by ledger entries.
3. Payouts are issued only after eligibility rules are satisfied.
4. Settlement reconciles against Payments but does not own payment processor state.

## Stripe Connect Rollout Notes

- Configure platform API with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` for Stripe Connect money movement; production startup fails without both.
- Optional onboarding URLs are `STRIPE_CONNECT_RETURN_URL` and `STRIPE_CONNECT_REFRESH_URL`; seller routes can also pass request-specific return and refresh URLs when creating setup sessions.
- Seller setup and account management use hosted provider sessions. Settlement never collects or stores payout destination account numbers, tax identity details, or hosted-dashboard credentials.
- Stripe-connected accounts are configured for manual payout schedules by the Stripe adapter so marketplace payouts remain seller-requested and settlement-triggered.
- Public seller APIs can start onboarding, open hosted account management, refresh readiness, and request payouts. Provider readiness cannot be manually overwritten through public seller routes.
- Payout requests use a preview/confirmation step, enforce USD-only amount policy, and keep payout destination details in hosted account management.
- Internal reconciliation can list stale requested payouts and in-transit payouts through the payout runtime before retrieving provider status. The operator page exposes only provider-neutral references and statuses needed for support review.
- Hosted setup redirects must stay on the marketplace origin, and provider webhook signatures are verified with a timestamp tolerance to reduce replay risk.
- Processed provider webhook event ids are stored so duplicate provider events are ignored and auditable.
- Stripe stays behind the money movement adapter. Settlement owns wallet debits, payout requests, failure reversals, read models, and reconciliation decisions; Stripe owns hosted onboarding, external payout destination collection, transfer execution, connected-account payout execution, and webhook signing.
- Register provider webhooks for `v2.core.account[requirements].updated`, `v2.core.account.updated`, `payout.paid`, and `payout.failed`. Settlement consumes them through the unauthenticated provider webhook mount and maps them into provider-neutral payout/readiness events.
- Smoke test in Stripe test mode by starting payout setup for a seller, completing hosted onboarding, refreshing payout setup, requesting a small payout from an available wallet balance, and replaying payout paid/failed webhooks.
- Existing payout readiness and payout read models backfill provider fields with nullable references and conservative setup defaults, so old rows remain readable.

## Open Extraction Candidates

- Treasury operations can be extracted later if cash management becomes materially more complex.
