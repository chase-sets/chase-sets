# TCGplayer Price Signals

This note defines the Pricing-owned ingestion boundary for TCGplayer market data exposed by the read-only `todd-skelton/tcgplayer-automation-app` client at commit `bdeffa0190be035084abccb464716aaaa2541a59`.

The source surfaces are the automation-app clients, not official TCGplayer docs:

- `app/integrations/tcgplayer/client/get-price-points.server.ts`
- `app/integrations/tcgplayer/client/get-latest-sales.server.ts`
- `app/integrations/tcgplayer/client/get-listings.server.ts`
- `app/integrations/tcgplayer/client/get-price-history.server.ts`
- `app/features/pricing/algorithms/getSuggestedPriceFromLatestSales.ts`

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
- `source_payload` containing only the price point for the scheduled capture path; secondary responses are decoded and privacy-reduced into logged typed evidence tables and are never copied into this replayable JSON blob
- `recommendation_payload` containing algorithm output or diagnostics

Unmapped SKU references are not recorded as price facts. They remain unresolved ingestion outcomes until Catalog links `tcgplayer:sku:<id>` to a Catalog Product selection.

## Capture order and privacy

The scheduled runner freezes `pricing.price-signal.productsPerPass` at `signal_pass_started_at`, selects at most five mapped `product:<id>` references, and awaits every selected SKU signal write. Only then does it take one `capture_started_at` and freeze `pricing.provider-observation` plus the stat-hygiene revision for the secondary prefix. Invalid capture policy therefore records bounded configuration-invalid headers after signals and never gates a signal.

Provider seller and listing identity exists only inside the response-reduction call. Durable Listing Ask Depth retains a sequential capture-local ordinal with condition and delivered amount; the ordinal is neither a hash nor stable across captures. Coverage stays explicit: a cap, page-budget stop, total mismatch, or unsafe continuation never becomes complete. The five provider-evidence tables are logged and permanent. The Catalog product-reference input alone is replayable and unlogged; subscription version 6 replays historical links from its own checkpoint while version-5 workers remain on their disjoint checkpoint.

## Algorithm Decisions

- Port: time-decayed percentile calculation from `getSuggestedPriceFromLatestSales.ts`, after extracting it from direct TCGplayer fetching and category-filter repository calls.
- Adapt: condition normalization and supply-adjusted time-to-sell, because Chase Sets selected options and supply models must be the source of product-condition semantics.
- Retire: direct listing mutation or seller automation side effects from the automation app. Pricing recommendations must remain proposed evidence until an explicit Marketplace workflow applies them.
- Keep out of Catalog: market price, latest sales, listings, price history, seller identifiers, listing quantities, and recommendation output.
