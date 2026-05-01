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
- `PayoutScheduled`
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
- Register provider webhooks for `v2.core.account[requirements].updated`, `v2.core.account.updated`, `payout.paid`, and `payout.failed`. Settlement consumes them through the unauthenticated provider webhook mount and maps them into provider-neutral payout/readiness events.
- Smoke test in Stripe test mode by starting payout setup for a seller, completing hosted onboarding, refreshing payout setup, requesting a small payout from an available wallet balance, and replaying payout paid/failed webhooks.
- Existing payout readiness and payout read models backfill provider fields with nullable references and conservative setup defaults, so old rows remain readable.

## Open Extraction Candidates

- Treasury operations can be extracted later if cash management becomes materially more complex.
