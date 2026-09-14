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
- Repricing evaluation engine
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

`features/repricing-engine/` reacts to changed Market Price and competing-ask facts by enqueueing replay-safe,
Product-scoped Repricing Runs. Worker lanes evaluate every assigned policy listing against one captured input
snapshot, then send only beyond-tolerance targets through Marketplace's existing chunked price-update command
path. The same evaluator powers dry-run preview; live execution adds daily-budget admission and publishes
`RepricingPolicyEvaluated` facts.

| Repricing term | System behavior |
| --- | --- |
| Any-Mode Anchor | Seller opt-in `lowest-competing-ask` with `strata: "any"` considers both ask modes; absent strata and `comp-percentile` stay hard-only. Traces expose `any-ask` and counts, not competitor identities or modes. |
| Anchor Band | Required market-estimate ground and seller-chosen `minPercentOfGround` from 50 through 100; clamps the anchor upward, marking `band-binding` when lifted. Unavailable, stale, or currency-mismatched ground exhausts the anchor and continues the chain. Offsets and existing price clamps apply afterward. |
| Spiral Breaker | Three consecutive same-direction product rounds freeze repricing across sellers for 120 minutes. Direction is the sign of the sum of applied target-minus-current changes; opposite direction starts at one, and an undirected round clears the count. The trip clears the count and retains the expiry in every policy fact and listing trace. |

The platform `pricing.repricing-engine` policy bounds `spiralBreakerRounds` to integers 2-10 and
`spiralBreakerFreezeMinutes` to 60-1440. Only these two keys default when absent from stored revisions.
The existing product cooldown ledger owns both damping and the breaker, with generation-fenced writes.

| Product state | Admission and next transition |
| --- | --- |
| Open | No row, or both horizons have passed. Normal rounds retain their direction/count; opposite and undirected rounds reset it. Competing-ask admission starts Cooling. |
| Cooling | Future `next_eligible_at` suppresses competing-ask admission and the daily drift sweep; moved estimates can still run. Reaching the direction threshold enters Frozen. |
| Frozen | Future `frozen_until` rejects every signal and sweep. Previously claimed work records `spiral-breaker-frozen` without Marketplace commands. |
| Open after expiry | Release is automatic at `frozen_until`, with a zero counter. The next normal round starts counting anew; no seller release control or cleanup job is required. |

The worker logs one structured `pricing.repricing-spiral-breaker.tripped` record per tripped product round,
including direction, round count, and affected seller count. It does not page or implement seller attention;
downstream activity reads retained facts and trace expiry, never a live ledger lookup.

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
