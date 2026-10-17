# ADR 0028: Own-Sale Evidence Boundary

## Status

Accepted. Records Todd's #7780 F1 and F3 Option A rulings without reopening them.

## Context

Pricing workflows need a seller's own realized sales for seller-scoped floors, turnaround, forecast grading, realized outcomes, and channel analytics. Those facts differ from the many-participant market evidence governed by [ADR 0026](./0026-market-price-methodology.md). Inventory publishes both externally recorded channel sales and denomination-free offline sales, while Pricing owns the query model consumed by pricing workflows.

## Decision

Pricing projects both Inventory sale facts into one sale-event-keyed Own-Sale Observation read model. External observations preserve their optional gross per-unit item price, currency, line-level shipping collected, and line-level channel fee exactly as published; line totals are never prorated to the applied quantity. Offline observations retain their optional sale amount but carry null currency and null provider sale time. Their sale time is therefore the event's recorded time.

Own-Sale Observations are seller evidence only. They never enter the Comparable Sale set, the published Market-Value Estimate, recorded market rollups, Market Price snapshots, or the Trades Tape. Currency-keyed reads require exact currency equality and exclude undenominated observations; no currency conversion or default currency is applied. Count-and-quantity consumers may still read offline and zero-applied observations through the unaggregated list query.

Pricing consumes both sale event types in its existing ordered Inventory input projection. A subscription-version bump creates a new checkpoint at position zero so historical item inputs precede historical sales whenever Inventory recorded them in that order. Existing item and hold inputs retain their newer stream-version guards and are not reset while this checkpoint catches up. A sale whose item input is genuinely absent remains unresolved rather than borrowing identity from another source.

## Alternatives Considered

- Feeding own sales into the Market-Value Estimate was rejected because seller-authored evidence cannot establish a many-participant market value and would let one account move the published answer.
- Defaulting offline sales to a platform currency was rejected because the Inventory fact carries no denomination; a default would invent money provenance.
- Deferring offline observations or creating a second subscription group was rejected because both sale facts share the same ordering requirement and would otherwise require another full Inventory replay.

## Consequences

Future Pricing consumers receive one stable seller-evidence contract across channel and offline activity, including refused or unresolved sales. Money-keyed consumers remain denomination-safe. The model deliberately does not provide FX, retention, provider calls, channel classification, UI, or a pricing-engine policy.
