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
- `source_payload` containing only the price point for the scheduled capture path; secondary responses are decoded and privacy-reduced into logged typed evidence tables and are never copied into this replayable JSON blob
- `recommendation_payload` containing algorithm output or diagnostics

Unmapped SKU references are not recorded as price facts. They remain unresolved ingestion outcomes until Catalog links `tcgplayer:sku:<id>` to a Catalog Product selection.

## Capture order and privacy

The scheduled runner freezes `pricing.price-signal.productsPerPass` at `signal_pass_started_at`, selects at most five mapped `product:<id>` references, and awaits every selected SKU signal write. Only then does it take one `capture_started_at` and freeze `pricing.provider-observation` plus the stat-hygiene revision for the secondary prefix. Invalid capture policy therefore records bounded configuration-invalid headers after signals and never gates a signal.

The extension-assigned `sellerOrdinal` is carried through the reduced row and is the only seller grouping key Pricing uses. Durable Listing Ask Depth retains that capture-local ordinal with condition and delivered amount; it is neither a seller identity nor stable across captures. Money strings are scaled to integer cents before delivered-price comparison or dedupe. Coverage stays explicit: a cap, page-budget stop, total mismatch, or unsafe continuation never becomes complete. The five provider-evidence tables are logged and permanent. The Catalog product-reference input alone is replayable and unlogged; subscription version 6 replays historical links from its own checkpoint while version-5 workers remain on their disjoint checkpoint.

Capture headers record the executed C0 posture (without its timeout) separately from the frozen Pricing policy revision. `authenticatedRequest` is derived from endpoint `credentialsMode`, and `ownSellerExclusionApplied` is always false because Pricing does not perform provider filtering. Capture commits run on the caller's transaction, preserve immutable replay and newer-only watermarks, and do not read or advance the market-capture cursor; the pass owns cursor advancement.

The private `tcgplayer-market-capture-v1` receipt combines field-presence/type summaries captured before decoding with post-reduction counts, retained after the immutable capture commits. Its first optional nested member, `responseSummary.endpointDiagnostics`, is absent as a whole when diagnostics were not retained; absence never means success. When present, the typed object has exactly `sales`, `listings`, and `history`, each with `failurePhase`, `httpStatusClass`, optional `stageTrace`, `lastHttpStatus`, and `failureClass`; the producer emits all three. `failurePhase` is `transport` for rejection before parsed return, `response-processing` for failure after return during summarizing, decoding, or page processing, and null on success. It resets before every page request, independently for each endpoint and capture pass. These are code locations, not causes: transport failures cannot distinguish HTTP, request, configuration, throttle, cancellation, or JSON errors, and 403 remains ambiguous between authentication and rate limiting. `httpStatusClass` copies the observation's `none`, `4xx`, `5xx`, or `other` class; null means no observation in direct sanitizer use (configuration-invalid captures exit before the sink). Diagnostics retain no exception text, body, cookie, unexpected field name, provider identity, or URL. A numeric `count` shape supplies no live count or completeness claim; null history remains a decode failure, distinct from a valid empty array. Existing receipt bytes are not read, defaulted, or backfilled.

Diagnostics additionally retain the last integer HTTP status and a closed `failureClass` derived from the pinned terminal entry. Old receipts and terminals without the optional fields decode as `unknown`; no status, headers, body, URL, or exception text is inferred.

## Algorithm Decisions

- Port: time-decayed percentile calculation from `getSuggestedPriceFromLatestSales.ts`, after extracting it from direct TCGplayer fetching and category-filter repository calls.
- Adapt: condition normalization and supply-adjusted time-to-sell, because Chase Sets selected options and supply models must be the source of product-condition semantics.
- Retire: direct listing mutation or seller automation side effects from the automation app. Pricing recommendations must remain proposed evidence until an explicit Marketplace workflow applies them.
- Keep out of Catalog: market price, latest sales, listings, price history, seller identifiers, listing quantities, and recommendation output.
