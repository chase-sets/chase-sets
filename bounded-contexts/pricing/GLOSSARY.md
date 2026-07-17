# Pricing Domain Glossary

This glossary defines the canonical terminology for the Pricing bounded context.

## Price Signal

A **Price Signal** is an observed market input used to estimate fair value for a resolved product.

Examples:

- Active listings
- Accepted offers
- Completed orders

## Market Price Snapshot

A **Market Price Snapshot** is the recorded fair-value output for a resolved product over a defined time window, tied to the source signals used to calculate it.

## Market Price

**Market Price** is the wire noun for Pricing's published current fair-value estimate for one resolved Product. `MarketPriceEstimated` (`pricing.market-price.estimated`) publishes that derived answer -- one event-sourced stream per product, carrying the estimate amount, its Confidence Band, input counts, the previous published amount (so downstream tolerance filtering needs no read), and a freshness horizon; a Market Price Snapshot remains a recorded market-state input rather than the estimate itself.

## Market-Value Estimate

A **Market-Value Estimate** is the derived fair-value answer for one resolved Product, blended from Comparable Sales: platform verified trades weighted highest, platform unverified trades next, external comps by the Market-Estimate Policy's source weights, all time-decayed through the weighted-percentile algorithm ported from `getSuggestedPriceFromLatestSales`. Below the policy's minimum-input gate there is NO estimate -- never a number derived from too little evidence. The estimate is published as the Market Price fact and recomputed by a pass riding the market-rollups closer job (`features/market-estimates/`).

## Comparable Sale

A **Comparable Sale** is one completed-transaction or provider comp input selected as relevant to a product's Market-Value Estimate: a non-excluded Trades Tape trade (verified or unverified) inside the lookback window, or the latest current external price signal per provider SKU reference. Excluded trades never comp.

## Confidence Band

A **Confidence Band** is the published uncertainty range around a Market-Value Estimate -- the policy-configured low/high weighted percentiles of the same blended input set, always containing the estimate amount -- so surfaces show ranges, not false precision.

## Market-Estimate Policy

The **Market-Estimate Policy** is Pricing's m110 platform-policy declaration of every blended Market-Value Estimate algorithm parameter: decay half-life, comparable-sale lookback window, estimate and band percentiles, source weights (platform verified >= platform unverified >= external comps), the minimum-input gate, confidence sample sizes, and the published estimate's freshness horizon. Declared with a compiled fallback (`features/market-estimates/domain/estimate-policy.ts`); a revision changes estimation behavior without a deploy.

## Liquidity Estimate

A **Liquidity Estimate** is the modeled expectation of how quickly or reliably a resolved product can transact.

## Repricing Policy

A **Repricing Policy** is a seller-owned, event-sourced aggregate declaring the standing strategy that
turns pricing inputs into price changes for a scope of the seller's listings: an ordered, first-match-wins
pipeline of Repricing Rules, a change budget (max changes per day), and lifecycle state (active, paused, or
deleted). It is a domain aggregate the seller authors and revises through commands, distinct in kind from
the platform-tier `definePolicy` machinery used for operational bounds elsewhere in the system -- see this
context's README "Core Aggregates and Process Managers" note.

## Repricing Rule

A **Repricing Rule** is one ordered entry in a Repricing Policy's pipeline: a set of conditions (category,
graded/raw, quantity, listing age, cost-basis presence, competing-listing count, schedule window) paired
with a directive (Repricing Anchor Chain, offset, Floor Price, Ceiling Price, Repricing Tolerance, price
rounding, per-rule max move, and terminal behavior). Rules are evaluated first-match-wins; the pipeline's
last rule is always the unconditional default.

## Repricing Anchor Chain

A **Repricing Anchor Chain** is the ordered list of Repricing Anchors a Repricing Rule's directive tries in
sequence -- market-estimate, lowest-competing-ask, comp-percentile, or last-sold -- so a rule degrades
gracefully when its first-choice signal is unavailable, ending in a seller-chosen terminal behavior (hold,
pause, fallback-price, price-at-floor, or notify-only) if every anchor in the chain is exhausted.

## Repricing Scope

A **Repricing Scope** is the set of listings a Repricing Policy governs: all of the seller's listings, a
catalog-category filter, or an explicit listing set, with optional per-listing opt-out. When a seller's
Repricing Policies have overlapping scopes, the most specific scope wins (explicit listing set beats
catalog-category filter beats all-listings).

## Repricing Policy Assignment

A **Repricing Policy Assignment** is the resolved answer, per listing, to "which active Repricing Policy
governs this listing" after Repricing Scope precedence and opt-out are applied -- the repricing evaluation
engine's work queue input.

## Price Recommendation

A **Price Recommendation** is the suggested listing or offer strategy generated by Pricing.

## Bulk Reprice Job

A **Bulk Reprice Job** is a durable, per-account job that diffs an uploaded CSV or JSON batch of
`(sellerSku or listingId, newPrice)` rows against current listing prices and applies only the changed rows
through Marketplace's chunked bulk price-update path. It is the on-ramp of the m113 repricing-at-scale
initiative -- an explicitly removable feature (`features/bulk-reprice-ingestion/`), not the destination;
Repricing Policy is the destination.

## Historical Price Trend

A **Historical Price Trend** is an analysis view over prior Market Price Snapshots used for trend analysis and forecasting.

## Trades Tape

The **Trades Tape** is the normalized, ordered history of completed marketplace trades used as pricing evidence: one row per order line that reaches a sale, backfilled in full by projection replay over Ordering and Fulfillment events. Each entry carries the sale channel, the payment (`sold_at`) and delivery (`settled_at`) timestamps, a verified-sale marker, and an exclusion flag with reason. Refunded and cancelled exclusions come from order/shipment facts; fraud-flagged exclusions come from m107 risk-flag events (Identity's `manual-payout-review` badge assignment, Payments' Stripe early-fraud-warning receipt) reacting retroactively against every historical trade for the flagged account or order (#4304); the verified marker is set by an m109 authenticity case's "passed" verdict on the trade's order. Self-dealing trades never reach the tape at all -- m107 #4250 hard-blocks same-account orders at creation -- so the reserved `self-dealing` exclusion reason has no writer.

## Stat-Hygiene Policy

The **Stat-Hygiene Policy** is Pricing's m110 platform-policy declaration of the Trades Tape's manipulation-resistance dials: the minimum trade sample before a median displays, the short/long convenience lookback windows, the outlier-trimming percentile applied to each tail of an aggregate stats window, and the daily closer job's trailing re-derive window. Declared as a runtime-configurable policy with a compiled fallback (#4304); the Daily Product Rollup's query and maintenance call sites resolve this policy live through Pricing's mounted platform-policy runtime (#4310) -- a revision (e.g. raising the minimum sample) changes suppression behavior without a deploy. `outlierTrimPercentile` remains declared-but-unconsumed: no flagged-outlier input exists yet to trim.

## Market Analytics Display Policy

The **Market Analytics Display Policy** is Pricing's m110 platform-policy declaration of the market-rollups query API's presentation dials, as distinct from the Stat-Hygiene Policy's computation dials: whether verified-sale chart markers render, the Public Market Page's charted history window, and its JSON API's shared (CDN) cache lifetime. Declared with a compiled fallback (#4310); the item-detail market panel and Public Market Page share one Stat-Hygiene Policy minimum-sample gate rather than a per-surface override -- see the policy's own file header for why.

## Daily Product Rollup

A **Daily Product Rollup** is the computed snapshot of a resolved product's Trades Tape activity for one UTC calendar day: first/last/min/max/median trade price, unit volume, trade count, and verified-trade count, with excluded trades omitted. It is derived entirely from already-recorded trades and is never an estimate -- see Market Price Snapshot and Market-Value Estimate for the distinct estimate concepts. Days with too few trades still carry their counts; only the median is suppressed for display below the minimum-sample threshold.

## Platform Daily Rollup

A **Platform Daily Rollup** is the computed snapshot of platform-wide Trades Tape activity for one UTC calendar day, summed across every product: Gross Merchandise Value, trade count, unit volume, order count, and verified-trade count, with excluded trades omitted. It is the platform-wide sibling of the Daily Product Rollup and the sole source pricing publishes for platform-operations' GMV/liquidity ops dashboards (#4309) -- there is no second GMV computation path.

## Gross Merchandise Value

**Gross Merchandise Value** (GMV) is the total dollar value of completed, non-excluded trades over a period -- unit price times quantity, summed -- computed from the Trades Tape and its Platform Daily Rollup. It is a gross figure (before platform fees), distinct from any net settlement amount recorded downstream.

## Market-State Snapshot

A **Market-State Snapshot** is the recorded end-of-day supply/demand state for a resolved product: active listing count and lowest ask, open offer count and highest bid, and the Spread between them, captured from the already-projected listing/offer state.

## Product Market Aggregate

A **Product Market Aggregate** is the denormalized, always-current summary for a resolved product -- last-sold trade, 30/90-day median price and volume, and Sell-Through Rate -- maintained for cheap surface reads without querying the Trades Tape or Daily Product Rollups directly.

## Spread

**Spread** is the recorded distance between a resolved product's lowest active ask and highest open bid, captured on its Market-State Snapshot.

## Sell-Through Rate

**Sell-Through Rate** is the ratio of a resolved product's sold quantity to its available quantity (sold plus still-listed) over a trailing pricing window, recorded on its Product Market Aggregate.

## Public Market Page

A **Public Market Page** is the unauthenticated, SEO-indexable page published per catalog item at `/market/{slug}` on public-web: a public-safe view over that catalog item's Daily Product Rollup series, Product Market Aggregate, and Market-State Snapshot for its most-traded resolved product. It never carries account identifiers or individual buyer/seller attribution -- see Trades Tape, whose per-trade counterparty detail never reaches this surface. Noindex-gated behind public-web's sitewide indexing flag until the launch decision.

## Planned Market Analytics And Repricing

These planned terms pre-register upcoming market, analytics, and repricing language. They are not shipped behavior until Pricing adds the corresponding projections, policies, commands, and UI.

### Price Observation

A **Price Observation** is a planned Pricing input captured from a marketplace, provider, or commerce fact before it becomes a Price Signal.

### Active Ask

An **Active Ask** is a planned current listing-price input used to evaluate seller-side market position.

### Demand Bid

A **Demand Bid** is a planned offer-price input used to evaluate buyer-side demand.

### Market Depth

**Market Depth** is the planned estimate of available supply and demand across price levels.

### Liquidity Score

A **Liquidity Score** is the planned normalized expression of a Liquidity Estimate.

### Price Volatility

**Price Volatility** is the planned measure of how much Market Price Snapshots change over time.

### Market Segment

A **Market Segment** is the planned product, condition, channel, or time grouping used for pricing analysis.

### Price Index

A **Price Index** is the planned normalized trend line for a Market Segment.

### Price Benchmark

A **Price Benchmark** is the planned reference price used to compare listings, offers, or recommendations.

### Repricing Run

A **Repricing Run** is the planned batch evaluation of Repricing Candidates under a Repricing Policy.

### Repricing Candidate

A **Repricing Candidate** is the planned listing, offer, or inventory item considered for a Price Recommendation.

### Repricing Recommendation

A **Repricing Recommendation** is the planned suggested price change produced by a Repricing Run.

### Repricing Guardrail

A **Repricing Guardrail** is the set of schema-level protections a Repricing Rule's directive enforces so no
evaluated price can violate account constraints: its Floor Price (a hard invariant), optional Ceiling Price,
Repricing Tolerance band, per-rule max-move percent, and the policy-level daily change budget.

### Repricing Anchor

A **Repricing Anchor** is one reference-price source a Repricing Rule's directive may try, in order, via its
Repricing Anchor Chain: `market-estimate`, `lowest-competing-ask`, `comp-percentile`, or `last-sold`.

### Repricing Tolerance

A **Repricing Tolerance** is a Repricing Rule directive's allowed movement range around its resolved anchor
price (percent or absolute) below which the evaluation engine leaves the listing's price untouched.

### Terminal Price

A **Terminal Price** is the planned final bounded price the repricing evaluation engine produces after
applying a Repricing Rule's directive (Repricing Anchor Chain resolution, offset, rounding, and Repricing
Guardrail clamps) -- not yet shipped; see Repricing Run.

### Floor Price

A **Floor Price** is a Repricing Rule directive's hard-invariant minimum: an absolute amount, or a
cost-basis-plus-margin amount (from Inventory's acquisition cost fact) that always carries a seller-authored
absolute fallback for when that fact is missing. The evaluated price never crosses it.

### Ceiling Price

A **Ceiling Price** is a Repricing Rule directive's optional maximum: an absolute amount or a percent above
its resolved anchor.

### Target Margin

**Target Margin** is the margin percent a Floor Price's cost-basis-plus-margin mode applies on top of
Inventory's acquisition cost fact.

### Margin Band

A **Margin Band** is the planned acceptable range around Target Margin for margin-aware repricing beyond a
single floor -- not yet shipped.

### Markdown

A **Markdown** is the planned intentional price reduction used to improve sell-through or inventory freshness.

### Price Experiment

A **Price Experiment** is the planned controlled pricing test for a product, segment, or account inventory group.

### Pricing Alert

A **Pricing Alert** is the planned notification-worthy pricing condition produced by Pricing.

### Competitive Position

**Competitive Position** is the planned comparison between an account's price and relevant Price Benchmarks.

### Market Movement

**Market Movement** is the planned material change in pricing inputs over a defined window.
