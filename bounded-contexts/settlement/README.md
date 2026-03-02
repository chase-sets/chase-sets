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

## Open Extraction Candidates

- Treasury operations can be extracted later if cash management becomes materially more complex.
