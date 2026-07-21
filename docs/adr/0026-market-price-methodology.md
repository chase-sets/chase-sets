# ADR 0026: Market-Price Methodology

## Status

Accepted. Records the ratified #5773 (participant-hygiene model) and #5774 (outlier-trim semantics)
decisions and the shipped #5775-#5779 market-stat manipulation-resistance chain (epic #5781). This ADR
does not reopen either decision; see those closed issues for the option analysis and ruling.

## Context

Pricing publishes two different kinds of market-price answer from the same underlying Trades Tape, and
callers, seller-facing surfaces, and the public `/market/{slug}` pages must not confuse them:

- **Recorded stats** -- Daily Product Rollups, Platform Daily Rollups, the Product Market Aggregate, and
  the Market-State Snapshot -- are computed entirely from already-recorded facts (trades, listings,
  offers) and are never estimates. See `bounded-contexts/pricing/GLOSSARY.md` "Daily Product Rollup",
  "Platform Daily Rollup", "Product Market Aggregate", and "Market-State Snapshot" (the m122
  snapshot-vs-estimate delineation).
- The **Market-Value Estimate** is a derived fair-value answer blended from Comparable Sales, published
  as the wire-level Market Price fact (`pricing.market-price.estimated`). See GLOSSARY "Market-Value
  Estimate" and "Market Price".

Before this epic (#5781), neither concept resisted a small number of colluding accounts: the estimate's
comp weighting had no participant identity (three wash prints from one buyer->seller pair could set the
published price), the declared rollup outlier-trim dial had no call site, the Trades Tape's `self-dealing`
exclusion reason had no writer, and Market-State Snapshot bid stats counted every submitted offer
regardless of counterparty. Origin: Todd's 2026-07-19 fair-value review -- "market isn't about one person,
it's about many." This ADR is the single decision record that makes the resulting model coherent and
externally defensible; it is intentionally silent on anything the GLOSSARY already defines and points to
those entries instead of restating them.

## Decision

### Two-concept delineation

Recorded stats and the Market-Value Estimate stay two distinct concepts with two distinct integrity
regimes. Recorded stats resist manipulation only through **exclusion** (a trade is either in the tape or
it is not) and, for medians only, **trimming** (below). They never editorialize a genuinely recorded
extreme by clamping it. The Market-Value Estimate resists manipulation through participant hygiene and
**winsorizing** (clamping, not dropping) -- because it is already a derived answer, bounding an input's
influence on it is in-model, not a rewrite of a recorded fact. Conflating the two regimes -- e.g. winsorizing
a recorded min/max, or excluding an input from the estimate blend instead of bounding it -- was rejected in
both #5773 and #5774; see their per-issue rationale.

### Blend algorithm and guard stack (Market-Value Estimate)

`calculateBlendedMarketValueEstimate` (`bounded-contexts/pricing/features/market-estimates/domain/blended-estimate.ts`)
applies its guards in this fixed order, each one capable of independently producing `no-estimate`:

1. **Pair deduplication.** Repeat platform trades between one buyer->seller pair collapse to the latest
   print before anything else runs (GLOSSARY "Comparable Sale", "Market Participant"). A wash pair
   trading back and forth cannot manufacture volume.
2. **Distinct-Participant Gate.** The minimum-input gate and the confidence ladder count distinct buyer
   accounts plus already-deduplicated external comps, not platform prints (GLOSSARY "Distinct-Participant
   Gate"). Three prints from one buyer clear nothing; three buyers do.
3. **Participant Weight Cap.** Time-decayed, source-weighted blend inputs are capped per buyer account at
   the Market-Estimate Policy's `maximumParticipantWeightShare` (launch 30% of the post-cap total) via
   `capParticipantWeights`, so one participant's legitimate volume cannot compound without limit
   (GLOSSARY "Participant Weight Cap"). External comps have no participant identity and are exempt.
4. **Effective-sample-size gate.** After decay and source weighting, `(sum(w))^2 / sum(w^2)` must clear
   `minimumEffectiveSampleSize` or there is no estimate -- a raw count that is really concentrated in one
   fresh comparable next to stale ones does not count as real evidence.
5. **Winsorize (outlier guard).** Every surviving price is clamped into
   `[core / outlierPriceRatio, core * outlierPriceRatio]` around the weighted median of the platform-trade
   core (falling back to all usable inputs when there is no platform trade comp). The observation still
   counts; its magnitude cannot dominate the weighted-percentile blend or the Confidence Band.

Every guard is a `Market-Estimate Policy` dial (`estimate-policy.ts`), resolved once per closer pass
through Pricing's mounted `PolicyRuntime` -- the domain calculation itself stays pure and
policy-machinery-free. Source weighting (platform verified >= platform unverified >= external comp) and
the weighted-percentile blend and band are the ported `getSuggestedPriceFromLatestSales` core; see that
module's header for the algorithm-decisions cross-reference.

### Tape integrity model and exclusion-reason taxonomy

The Trades Tape (GLOSSARY "Trades Tape") carries one `excluded` boolean and one `exclusion_reason`, `CHECK`-
constrained to exactly four values, in fixed precedence:

| Reason | Writer | Scope | Terminal? |
| --- | --- | --- | --- |
| `refunded` | `fulfillment.shipment.returned` reaction | order/shipment | Yes |
| `cancelled` | `ordering.order.cancelled` reaction | order | Yes |
| `fraud-flagged` | Identity `manual-payout-review` badge assignment; Payments Stripe early-fraud-warning receipt | account (badge) or order (EFW) | Yes |
| `self-dealing` | Settlement `settlement.account-linkage.flagged`/`.cleared` reaction | counterparty pair, both sides in one active linkage cluster | No -- reversible |

Precedence is enforced at the SQL layer, not by convention: every terminal-reason writer's `UPDATE`
matches `WHERE (excluded = false OR exclusion_reason = 'self-dealing')`, so a terminal reason always
overwrites a pair-scoped `self-dealing` flag but a terminal reason is never overwritten by anything.
Restoration on `settlement.account-linkage.cleared` (or a flag event's cluster shrinking) only restores
rows whose `exclusion_reason = 'self-dealing'` and whose pair is no longer covered by any other active
cluster -- a `refunded`, `cancelled`, or `fraud-flagged` row never comes back through the linkage path.

`self-dealing` is the linkage->self-dealing writer this epic ships: Settlement owns the pair-scoped
authority (both counterparties in one active account-linkage cluster), distinct from and additional to
Identity's pre-existing account-scoped `manual-payout-review` badge path, which stays untouched (see
epic #5781's prior-art boundary). Every retroactive exclusion or restoration enqueues its affected
sold-day tuples for bounded asynchronous rollup re-derivation so Daily Product Rollups, window stats, and
downstream Market-Value Estimate inputs converge without a manual backfill.

### Trim semantics (recorded rollup stats)

Per the #5774 ruling (Option 1, approved): the declared `outlierTrimPercentile` (Stat-Hygiene Policy,
launch default 5, bounds 0-25) trims **medians only** -- the Daily Product Rollup's daily median and the
30/90-day window medians (`rollup-maintenance.ts`, `percentile_cont` trim bounds). First/last/min/max,
unit volume, trade count, and verified-trade count are never trimmed; they remain untouched recorded
facts, because rollup stats are recorded facts, not estimates (m122 snapshot-vs-estimate delineation) and
clamping a min/max that genuinely happened would edit the record. The trim floor rule from the ruling is
explicit in code: a window is trimmed only when it can address at least one trade per tail
(`tradeCount * outlierTrimPercentile / 100 >= 1`); thinner windows retain every included trade rather than
being trimmed to nothing. Linkage-flagged and other excluded trades are removed from the tape before the
included window is formed, so trimming and exclusion never double-count the same defense.

### Snapshot bid hygiene

The Market-State Snapshot's open-offer count, maximum bid, and Spread (GLOSSARY "Market-State Snapshot",
"Spread") are recomputed over an `eligible_offers` CTE (`recomputeMarketStateSnapshot`,
`market-rollups/read-model/rollup-maintenance.ts`, shipped in #5779/PR #5844) that screens out a submitted
offer whenever its buyer is linked to the relevant seller in an active linkage cluster:

- **Seller-targeted offers** (`seller_account_id` present on the offer) screen directly against that
  seller.
- **Product-scoped offers** (`seller_account_id IS NULL`) screen against every active listing's seller for
  that catalog item/product -- an offer is excluded if the buyer is linked to *any* seller currently
  listing the product, since the offer could clear against any of them.
- The active listing (ask) side is **deliberately unscreened** -- see Deliberate Non-Defenses below.

The screen reads Pricing's own local, replayable linkage projection (the same
`pricing_market_trade_linkage_clusters` table the Trades Tape integrity reactions maintain); it never
calls out to a live policy or to Settlement at recompute time, so a snapshot recompute stays a pure
function of already-projected local state and remains idempotent under repeated daily-closer passes.

## Deliberate Non-Defenses

These were considered and rejected; each rejection is a decision, not an omission, and none is re-litigated
here -- see the cited issue for the full option analysis.

- **No z-score/IQR anomaly detection.** Per #5773's option analysis: bounding (Participant Weight Cap,
  winsorizing) and exclusion (linkage-flagged tape removal) are the chosen defenses because they act on
  identified counterparties and identified extremes, not on a statistical shape assumption. A pure
  anomaly-detection layer over price distribution would flag legitimate thin-market volatility as often as
  real manipulation, with no participant-identity signal to distinguish them.
- **No ask-side screening.** The Market-State Snapshot's bid (demand) side is screened for linkage per
  #5779; the ask (supply) side is not. An inflated ask a linked account posts does not, by itself, move
  the recorded Spread the way an inflated bid does, and every ask is already a public, priced, cancellable
  commitment to sell -- unlike a bid, it carries no side that benefits from being seen without also being
  transactable against. Filed as an explicit design boundary in #5779/epic #5781, not an oversight.
  Ask-side wash trades that actually execute remain caught by the Trades Tape's `self-dealing` exclusion.
- **Last-print-only rejected.** #5773's Option 1 (hard last-print-per-buyer) was rejected in favor of
  Option 2 (pair dedup + weight cap + distinct-participant gates): last-print-only discards legitimate
  repeat-buyer volume (a store restocking ten copies is real demand), thins already-thin comp sets toward
  the no-estimate gate, and does not by itself address multi-account rings -- which the linkage-exclusion
  chain (#5776/#5777) handles instead.

## Alternatives Considered

- **Trimming or clamping recorded min/max** (per-window, alongside the median) was rejected in #5774: it
  would fabricate a "recorded" extreme that a buyer who watched the trade happen would see denied, and
  the m111 pillar treats rollup stats as neutral-factual.
- **Retiring the `outlierTrimPercentile` dial entirely** (#5774 Option 3) was rejected: medians already
  resist single prints, but the dial's removal would leave no defense between "excluded" and "fully
  counted" for extreme legitimate prints inside a window.
- **Cluster-collapsed participant identity in the estimate gates** (counting a whole linkage cluster as
  one Market Participant) was deliberately not filed as a follow-on. Epic #5781 records it as parked:
  account-level identity (#5775) plus pair exclusion (#5777) already cover every known vector; file it
  only if linkage flags prove common after #5777's production experience.

## Consequences

The Market-Value Estimate and every recorded rollup/snapshot stat now resist a single account, and a
small colluding cluster of accounts, moving a published number -- the "integrity before audience" pillar
(#4321) extended from single-trade integrity (m111) to participant-level integrity (this epic). The public
`/market/{slug}` pages, seller repricing recommendations, and collection valuation all inherit this
resistance without their own callers needing to re-implement any guard. The cost is legibility: a
comp set, a rollup window, or a snapshot's bid count can now differ from a naive `COUNT(*)` over raw rows,
and that gap is deliberate and load-bearing rather than a bug -- this ADR, not tribal knowledge, is the
reference for why. Nothing here changes the shipped code; it is a decision record only.
