# Commercial Terms Bounded Context

## Purpose

Commercial Terms owns the marketplace sales fee policy that determines seller-side marketplace economics.

## Owns

- Default Commercial Terms schedules by account type
- Account-specific commercial agreements
- Commercial Terms resolution for seller-confirmed listing and offer fee previews
- Seller-side marketplace sales fee amounts
- Seller net calculations

## Does Not Own

- Listing lifecycle
- Checkout orchestration
- Buyer marketplace checkout fees and payment processor state
- Ledger postings

## Ubiquitous Language

Commercial terms terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Commercial Terms Schedule
- Commercial Agreement
- Commercial Terms Resolver

## Incoming Dependencies

- Identity for account references and account type projections

## Outgoing Integration Events

- `CommercialTermsScheduleCreated`
- `CommercialAgreementCreated`

## Invariants

1. Commercial Terms resolution is deterministic for an account and timestamp.
2. Account-specific agreements override default schedules when both are active.
3. Marketplace consumes resolved snapshots for seller confirmation and emits locked snapshots for downstream ordering.

## Tests

Run `pnpm --filter @chase-sets/commercial-terms run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/commercial-terms run test` before opening a PR.
