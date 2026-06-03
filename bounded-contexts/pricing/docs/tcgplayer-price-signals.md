# TCGplayer Price Signals

This note defines the Pricing-owned ingestion boundary for TCGplayer market data exposed by the `todd-skelton/tcgplayer-automation-app` client at commit `bf42aa8`.

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
- `source_payload` containing price point, latest sales, listings, and price history evidence
- `recommendation_payload` containing algorithm output or diagnostics

Unmapped SKU references are not recorded as price facts. They remain unresolved ingestion outcomes until Catalog links `tcgplayer:sku:<id>` to a Catalog Product selection.

## Algorithm Decisions

- Port: time-decayed percentile calculation from `getSuggestedPriceFromLatestSales.ts`, after extracting it from direct TCGplayer fetching and category-filter repository calls.
- Adapt: condition normalization and supply-adjusted time-to-sell, because Chase Sets selected options and supply models must be the source of product-condition semantics.
- Retire: direct listing mutation or seller automation side effects from the automation app. Pricing recommendations must remain proposed evidence until an explicit Marketplace workflow applies them.
- Keep out of Catalog: market price, latest sales, listings, price history, seller identifiers, listing quantities, and recommendation output.
