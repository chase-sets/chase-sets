# Commercial Terms Bounded Context

## Purpose

Commercial Terms owns the marketplace fee and payment fee policies that determine seller-side transaction economics.

## Owns

- Default Commercial Terms schedules by account type
- Account-specific commercial agreements
- Commercial Terms resolution for listings and orders
- Seller-side marketplace fee amounts
- Seller-side payment fee amounts
- Seller net calculations

## Does Not Own

- Listing lifecycle
- Checkout orchestration
- Payment processor state
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

1. Commercial Terms resolution is deterministic for a seller account and timestamp.
2. Account-specific agreements override default schedules when both are active.
3. Marketplace and Payments consume resolved snapshots but do not own the underlying policy.
