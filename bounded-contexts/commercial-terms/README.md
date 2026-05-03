# Commercial Terms Bounded Context

## Purpose

Commercial Terms owns the marketplace fee policy that determines seller-side marketplace economics.

## Owns

- Default Commercial Terms schedules by account type
- Account-specific commercial agreements
- Commercial Terms resolution for seller-confirmed listing and offer fee previews
- Seller-side marketplace fee amounts
- Seller net calculations

## Does Not Own

- Listing lifecycle
- Checkout orchestration
- Buyer payment fees and payment processor state
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
