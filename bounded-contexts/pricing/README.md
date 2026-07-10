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

## Core Aggregates and Process Managers

- Price Signal Set
- Market Price Snapshot
- Repricing Policy
- Price Recommendation

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
