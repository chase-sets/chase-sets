# Commercial Terms Bounded Context

## Purpose

Commercial Terms owns the marketplace sales fee policy that determines seller-side marketplace economics.

## Owns

- Default Commercial Terms schedules by account type
- Account-specific commercial agreements
- Commercial Terms resolution for seller-confirmed listing and offer fee previews
- Seller-side marketplace sales fee amounts
- Seller net calculations
- The checkout processing-fee policy (buyer-side Marketplace Checkout Fee values: base bps/fixed terms, per-payment-method-category adjustments, enabled jurisdictions) via the shared `@chase-sets/platform-policy` machinery -- see `features/checkout-processing-fee`. Payments quotes against the resolved value through the `checkoutProcessingFeePolicyResolver` host port; it never reads Commercial Terms storage directly.

## Does Not Own

- Listing lifecycle
- Checkout orchestration
- Buyer marketplace checkout fee quoting, confirmation, or payment processor state (Payments owns the quote math and the fingerprint/staleness flow; Commercial Terms only owns the policy *values* it quotes against)
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
