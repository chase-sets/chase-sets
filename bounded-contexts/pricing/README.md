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
- Repricing Halt
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

Candidate Repricing Dry Runs use the same `planRepricingRound` as preview and live execution.
The page loader captures listings, competing asks, estimates, and last sold in four set-based queries,
then plans in memory. Each nonempty page has at most 500 Product keys and seven statements: keyset,
four inputs, one idempotent trace insert, and a cursor/claim-generation-fenced advance. Live admission,
including budget, revision checks, pause recovery, cooldown and Spiral Breaker, is unchanged.

Dry runs never request a Marketplace gateway or append domain events. Their outcomes are `changed`,
`pause-requested`, `notify-only`, and `skipped`; skip reasons come only from evaluation, not live
admission (`budget-exhausted`, `manual-edit-conflict`, `domain-no-op`, `policy-precondition-failed`,
`resume-hysteresis`, `repause-cooldown`, `command-error`, or `spiral-breaker-frozen`).
Completion aggregates every retained trace in SQL, including outcomes, reasons, flags, within-tolerance
count and percent-delta buckets. Bucket keys 0 through 8 use edges -20, -10, -5, -1, +1, +5, +10, +20;
each lower edge is inclusive and each upper edge exclusive.

`/account/repricing-policies/dry-runs` supports creation (`pricing.manage`) and account-scoped status,
list, trace and SSE reads (`pricing.view`). Lists and keyset-paged traces are bounded to 100 rows.
Missing and foreign IDs both return `404 not_found`; SSE connections share the actor's account limit.
The worker's `PRICING_REPRICING_DRY_RUN_JOB_LANE_COUNT` defaults to 1. Requests and traces are
durable across worker lease expiry; a replacement claim resumes the persisted cursor. Hashing uses
recursively sorted object keys, preserves array order, and includes only scope, exclusions, rules and
maxChangesPerDay. First activation consumes one completed exact-body-hash run atomically with policy
creation from its stored body. Validity is indefinite; revise, resume, pause and delete are ungated.
UI, outcome projections and digest remain separate slices.

`/account/repricing-policies` exposes account-scoped policy controls, scope preview, daily budget use,
category names and a Repricing Halt (`pricing.view` reads, `pricing.manage` writes). ID-addressed foreign
and missing objects return the same 404; self-scoped reads isolate account data without foreign IDs.
Commands check ownership on the folded aggregate, not its lagging projection, and return folded state.
Creation accepts `{ dryRunId, name }`; invalid, failed, cancelled, consumed or hash-mismatched runs
return `409 dry_run_required`, while foreign or absent runs return 404.

| Policy control | System behavior |
| --- | --- |
| Repricing Halt | One audited account aggregate, released (steady) to engaged and back. Repeats emit nothing. Engaged excludes assignments before selection and fails the post-plan policy precondition. Release re-includes the account on the next signal or daily drift sweep without resuming individually paused policies. |
| Scope Preview | Uses the dry-run candidate assignment SQL to report matching and governed listings, plus counts shadowed by existing policies and taken from them. |
| Categories | Catalog category events maintain names, status and account-scoped listing counts; subscription version 7 replays historical names and revisions. |

The dry-run migration creates new, empty tables, so their initial indexes are built with those tables.
The listing-inputs index also has a concurrent ledgered migration for an already-populated source table.
Retry-exhaustion status comes from the durable-job ledger in account reads; operation failures update the
request only while its captured state and claim generation still match.

| Repricing term | System behavior |
| --- | --- |
| Repricing Listing Outcome | Current listing activity is derived from retained evaluation facts ordered by evaluation instant and ID, not delivery position. Floor-binding starts at the trailing uninterrupted binding run; freeze expiry comes from the current fact. Activity pages and filter counts share current-state predicates. |
| Repricing Management Policy | `pricing.repricing-management` bounds `floorBindingAlertDays` to integer days 1-90, default 7. Account attention counts aged floor binding, active missing-input pauses, today's budget-exhausted outcomes, halt state and frozen listings. |
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

Listing outcome facts are inserted idempotently and recomputed under listing row locks in the projection
transaction. A late fact at or below the compaction boundary remains available to its digest window but
does not change current state. `compactListingOutcomeFacts` accepts trusted per-fact `digestedSql` over
alias `fact` and `retainFrom = now - 90 days`. It deletes only the consecutive eligible prefix strictly
below the greatest fact, retaining the boundary and any open binding-run start without changing the
visible outcome. A single greatest fact survives every pass until a newer fact arrives. No compaction
caller, digest, notification or UI is wired by this slice.
Compaction takes listing row locks first and recomputes in a second statement of the same caller transaction.

`GET /account/repricing-policies/:policyId/activity` uses account-owned policy resolution, listing-ID
keyset paging (at most 50 rows), and returns `rows`, `next` and `filterCounts`.
`GET /account/repricing-policies/attention-summary` is self-scoped to the authenticated account.
Foreign and absent activity policies return the same 404. Freeze counts never read the live breaker.

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
