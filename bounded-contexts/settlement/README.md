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
- Recovered-return value attribution to platform-funded protection coverage

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
- ProtectionCoverage (protection-reserve pool; one event-sourced stream per currency)

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
- `settlement.protection-coverage.recovery-posted.v1`

## Invariants

1. Settlement is the source of truth for what the marketplace owes or is owed.
2. Every balance change must be explainable by ledger entries.
3. Payouts are issued only after eligibility and payout-release rules are satisfied.
4. Settlement reconciles against Payments but does not own payment processor state.
5. Recovered value is posted as an immutable gross-and-cost fact and never rewrites a refund or prior protection settlement.

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

Inventory-reported recovered value is correlated by `remedyId` to the settled coverage. Settlement preserves gross proceeds and direct costs, posts net recovery back to protection-pool availability, and publishes an immutable recovery fact. This accounting boundary is ratified in [ADR 0024: Recovered Return Inventory And Protection Recovery](../../docs/adr/0024-recovered-return-inventory-and-value.md).

- **Publishes** — `settlement.protection-coverage.reserved.v1`,
  `settlement.protection-coverage.rejected.v1`,
  `settlement.protection-coverage.settled.v1`,
  `settlement.protection-coverage.recovery-posted.v1`.
- **Consumes** — `support.support-request.platform-coverage-requested.v1`,
  `support.support-request.refund-released.v1`, and Payments' refund completion fact,
  correlated by `remedyId`/`coverageId`, plus
  `inventory.recovered-item.value-reported.v1` correlated by `remedyId`.

The reservation aggregate and read models are implemented in
`features/protection-coverage` (#5214). Availability is
`funded − outstanding-reserved − consumed + net recovered value`; the funded ceiling stays owned by the
contribution read model (`settlement_protection_reserve_facts`) and is never turned
into a transactional aggregate. Every reservation, settlement, and release for a
currency folds into a single pool stream (`settlement.protection-reserve-{currency}`),
so optimistic concurrency serializes competing reservations and two approvals cannot
overdraw. Reserve/settle are keyed by `coverageId`, so redelivery is idempotent and a
fully platform-funded refund consumes the reserve exactly once; a split refund consumes
only its platform allocation, and the seller ledger is never touched by a reservation.
Internal `settlement.protection-coverage.released.v1`/`.expired.v1` events (not
cross-context facts) return an unconsumed reservation to availability. The
`settlement_protection_coverage` read model exposes reconciliation status, blocking
reason, and lifecycle metrics for operators without exposing internal ledger postings.

## Open Extraction Candidates

- Treasury operations can be extracted later if cash management becomes materially more complex.
