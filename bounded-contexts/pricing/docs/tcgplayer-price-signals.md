# TCGplayer Price Signals

This note defines the Pricing-owned ingestion boundary for TCGplayer market data admitted by the `@chase-sets/tcgplayer-market-observations` contract. Pricing consumes reduced secondary product rows and never contacts TCGplayer or holds provider credentials.

The upstream extension owns provider access and reduction. Pricing receives only the contract's secondary rows, not provider response objects or seller identity:

- `contracts/tcgplayer-market-observations/index.ts`

## Ownership

Pricing owns TCGplayer market price points, latest sales, listing snapshots, price history, algorithm diagnostics, and recommendation evidence. Catalog owns item identity and external Product reference links. Marketplace and Inventory are not mutated by price signal ingestion.

## Signal Shape

Each TCGplayer signal is keyed by:

- `provider_key`: `tcgplayer`
- `external_key`: `sku:<skuId>`
- `catalog_item_id`: projected from Catalog external Product reference events
- `catalog_product_key`: derived from Catalog Item plus selected options
- `observed_at`: the ingestion observation time

The Pricing record stores:

- `status`: `current`, `stale`, or `missing-price`
- `market_price_amount`, `lowest_price_amount`, `highest_price_amount`, and `price_count` from price points
- `calculated_at` from the automation-app price point
- `source_payload` containing only the price point; admitted secondary rows are mapped into logged typed evidence tables and are never copied into this replayable JSON blob
- `recommendation_payload` containing algorithm output or diagnostics

Unmapped SKU references are not recorded as price facts. They remain unresolved ingestion outcomes until Catalog links `tcgplayer:sku:<id>` to a Catalog Product selection.

## Capture order and privacy

Pass scheduling and revision freezing belong to the Pricing pass slice, not the mapper or capture commit. The mapper receives the frozen signal, observation and stat-hygiene revisions together with Catalog-admitted secondary rows and their executed posture. Invalid observation policy produces a configuration-invalid capture header; the mapper does not schedule requests or signal writes.

The extension-assigned `sellerOrdinal` is carried through the reduced row and is the only seller grouping key Pricing uses. Durable Listing Ask Depth retains that capture-local ordinal with condition and delivered amount; it is neither a seller identity nor stable across captures. Money strings are scaled to integer cents before delivered-price comparison or dedupe. Coverage stays explicit: a cap, page-budget stop, total mismatch, or unsafe continuation never becomes complete. The five provider-evidence tables are logged and permanent. The Catalog product-reference input alone is replayable and unlogged; subscription version 6 replays historical links from its own checkpoint while version-5 workers remain on their disjoint checkpoint.

Capture headers record the executed C0 posture (without its timeout) separately from the frozen Pricing policy revision. `authenticatedRequest` is derived from endpoint `credentialsMode`, and `ownSellerExclusionApplied` is always false because Pricing does not perform provider filtering. Capture commits run on the caller's transaction, preserve immutable replay and newer-only watermarks, and do not read or advance the market-capture cursor; the pass owns cursor advancement.

Endpoint status, HTTP status class, timestamps and coverage are copied from the admitted observation. They record facts, not inferred transport or authentication causes. Pricing does not reconstruct provider response diagnostics, raw responses, seller identity, cookies or credentials.

## Algorithm Decisions

- Port: time-decayed percentile calculation from `getSuggestedPriceFromLatestSales.ts`, after extracting it from direct TCGplayer fetching and category-filter repository calls.
- Adapt: condition normalization and supply-adjusted time-to-sell, because Chase Sets selected options and supply models must be the source of product-condition semantics.
- Retire: direct listing mutation or seller automation side effects from the automation app. Pricing recommendations must remain proposed evidence until an explicit Marketplace workflow applies them.
- Keep out of Catalog: market price, latest sales, listings, price history, seller identifiers, listing quantities, and recommendation output.
