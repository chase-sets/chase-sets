# Settlement Bounded Context

## Purpose

Settlement owns internal financial truth for marketplace balances and payouts.

## Owns

- Ledger entries
- Account balances and wallets
- Fee postings
- Rebate postings
- Payout eligibility
- Payout setup readiness
- Connected payout account references
- Payout batches
- Statements and settlement summaries
- Financial reconciliation against Payments

## Does Not Own

- Card authorization and capture mechanics
- Shipment execution
- Listing prices

## Ubiquitous Language

Settlement terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
Account-money navigation and Wallet/Payouts placement are documented in [Account Money Navigation](./docs/account-money-navigation.md).

## Core Aggregates and Process Managers

- Wallet
- Ledger Entry
- Payout
- Payout Batch

## Incoming Dependencies

- Ordering for commercial commitments
- Payments for charge and refund outcomes
- Fulfillment for delivery, return, and exception outcomes
- Identity for account-creation facts used in account-risk release inputs
- Marketplace for listing and review facts used in account-risk release inputs

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
3. Payouts are issued only after eligibility and payout-release rules are satisfied.
4. Settlement reconciles against Payments but does not own payment processor state.

## Tests

Run `pnpm --filter @chase-sets/settlement run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/settlement run test` before opening a PR.

## Operations

Stripe Connect configuration, embedded payout setup target state, payout smoke tests, reconciliation, and incident workflows live in [Money Operations](../../docs/runbooks/money-operations.md). The cross-context responsibility decision lives in [ADR 0006: Stripe Connect Custom Account Experience](../../docs/adr/0006-stripe-connect-custom-account-experience.md). The Wallet Adjustment vocabulary, cash-equivalent balance scope, and control policy decision lives in [ADR 0020: Wallet Adjustment Authority And Balance Types](../../docs/adr/0020-wallet-adjustment-authority-and-balance-types.md).

## Platform-Covered Resolutions

Settlement owns the `ProtectionCoverage` financial boundary for platform-covered
support resolutions (epic #5210): reservation, rejection, consumption, release, and
reconciliation against the protection reserve. It owns `coverageId`. Support owns the
remedy decision and `remedyId`; Payments owns the provider refund and `refundId`.
Settlement decides who is funded and posts the seller-funded portion and the
platform-funded consumption exactly once — it never charges the seller merely because
Payments reports a refund. Ownership, stable ids, and versioned contracts are ratified
in [ADR 0022: Platform-Covered Resolution Ownership and Contracts](../../docs/adr/0022-platform-covered-resolution-contracts.md);
wallet adjustment remains a correction-only path per
[ADR 0020](../../docs/adr/0020-wallet-adjustment-authority-and-balance-types.md).

- **Publishes** — `settlement.protection-coverage.reserved.v1`,
  `settlement.protection-coverage.rejected.v1`,
  `settlement.protection-coverage.settled.v1`.
- **Consumes** — `support.support-request.platform-coverage-requested.v1`,
  `support.support-request.refund-released.v1`, and Payments' refund completion fact,
  correlated by `remedyId`/`coverageId`.

## Open Extraction Candidates

- Treasury operations can be extracted later if cash management becomes materially more complex.
