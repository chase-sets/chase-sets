# Pricing Bounded Context

## Purpose

Pricing owns product-scoped fair-value estimation, seller repricing intelligence, and liquidity modeling.

## Owns

- Price signals
- Market price snapshots
- Liquidity estimates
- Repricing policies
- Price recommendations
- Historical pricing snapshots
- Forecast inputs for seller automation

## Does Not Own

- Final listing acceptance state
- Orders
- Payments

## Ubiquitous Language

Pricing terminology is defined in [GLOSSARY.md](./GLOSSARY.md).
The Pricing-owned TCGplayer ingestion boundary is documented in [TCGplayer Price Signals](./docs/tcgplayer-price-signals.md), which consumes the Catalog-owned [TCGplayer Automation Client Contract](../catalog/docs/tcgplayer-automation-client-contract.md).

## Core Aggregates and Process Managers

- Price Signal Set
- Market Price Snapshot
- Repricing Policy
- Price Recommendation

### Repricing Policy is a seller-owned domain aggregate, not platform policy

`RepricingPolicy` (`features/repricing-policies/`) is an event-sourced domain aggregate the seller creates,
revises, pauses, resumes, and deletes through ordinary commands -- its rule pipeline, floors, ceilings,
tolerances, and change budgets are the seller's own standing pricing strategy. This is deliberately
different machinery from the platform-tier `definePolicy` conventions used elsewhere in the system
(`infrastructure/platform-policy/define-policy.ts`, see `docs/architecture/platform-policy-conventions.md`)
for operational/platform-wide bounds: `RepricingPolicy` is domain state with its own event stream and
lifecycle, not a resolved configuration value. The feature's rule-authoring numeric bounds (rule-count cap,
percent magnitudes, change-budget bounds) are documented compiled defaults in
`features/repricing-policies/domain/policy-bounds.ts` pending any future seller-tier policy machinery -- see
that file's header.

## Incoming Dependencies

- Catalog for canonical item identity, product resolution, and selected-option facts
- Inventory for availability and seller stock posture
- Marketplace for active listing and offer behavior
- Ordering for completed order pricing
- Fulfillment for delivered-outcome confirmation

## Outgoing Integration Events

- `MarketPriceEstimated`
- `LiquidityEstimated`
- `PriceRecommendationPublished`
- `RepricingPolicyEvaluated`

## Invariants

1. Pricing recommends but does not directly mutate Marketplace or Inventory state.
2. Market price snapshots must be tied to explicit source signals and time windows.
3. Pricing is downstream of transactional truth.
4. Forecast inputs may influence automation policies but do not become transactional commitments on their own.

## Tests

Run `pnpm --filter @chase-sets/pricing run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/pricing run test` before opening a PR.

## Open Extraction Candidates

- Seller strategy automation can be extracted later if it grows beyond recommendation generation.
