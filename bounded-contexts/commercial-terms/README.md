# Commercial Terms Bounded Context

## Purpose

Commercial Terms owns the marketplace sales fee policy that determines seller-side marketplace economics.

## Owns

- The single published Marketplace Sales Fee Schedule
- Dormant account-type schedule machinery retained for future differentiation
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

- Marketplace Sales Fee Schedule -- the single account-type-agnostic published `definePolicy` document (`commercial-terms.marketplace-sales-fee-schedule`) containing the percentage, fixed amount, per-item cap, and shipping allowance.
- Legacy Commercial Terms Schedule -- dormant account-type-targeted `definePolicy` documents retained as inactive history so future tier work can reuse the targeting machinery without publishing multiple launch schedules. Existing pre-convergence events remain readable via an upcast, never rewritten.
- Commercial Agreement -- likewise a `definePolicy` document, keyed by account id (`commercial-terms.agreement.<accountId>`). Converged in #4299 alongside schedules.
- Commercial Terms Resolver

## Incoming Dependencies

- Identity for account references and account type projections
- Public Presence for the compiled `/sales-fees` article and its strictly whitelisted live policy-value contract; Commercial Terms retains ownership of the public route and loader.

## Outgoing Integration Events

- `platform-policy.document.created` / `platform-policy.document.revised` (shared platform-policy event vocabulary, adopted by schedules and agreements in #4299)
- Historical: `commercial-terms.schedule.created`/`.revised`, `commercial-terms.agreement.created`/`.revised` (immutable pre-#4299 events, still present in existing streams)

## Invariants

1. Commercial Terms resolution is deterministic for an account and timestamp.
2. Account-specific agreements override the published schedule when both are active.
3. Marketplace consumes resolved snapshots for seller confirmation and emits locked snapshots for downstream ordering.
4. Active policies for the same policy key never overlap; resolution fails closed and alerts operators if overlapping projections are observed.

## Tests

Run `pnpm --filter @chase-sets/commercial-terms run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/commercial-terms run test` before opening a PR.
